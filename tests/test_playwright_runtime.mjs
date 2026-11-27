import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { RuntimeFault } from "../plugins/playwright/src/runtime/contracts.ts";
import {
  listRuntimeInstances,
  serveRuntime,
  startRuntime,
  stopRuntime,
} from "../plugins/playwright/src/runtime/lifecycle.ts";

function makeSandboxScope() {
  const baseRaw = mkdtempSync("/tmp/pw-");
  const base = realpathSync(baseRaw);
  chmodSync(base, 0o700);
  const stateRoot = join(base, "instances");
  const profileRoot = join(base, "profiles");
  const artifactRoot = join(base, "artifacts");
  for (const dir of [stateRoot, profileRoot, artifactRoot]) {
    mkdirSync(dir, { mode: 0o700 });
  }
  return {
    base,
    scope: { stateRoot, profileRoot, artifactRoot },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function makeFakeAdapter(version = "Chrome/130.0.0.0") {
  return {
    async launch(options, _profile, artifactRoot) {
      return {
        page: {},
        context: {},
        authMode: options.authMode,
        artifactRoot,
        async smoke() {
          return { version };
        },
        async close() {},
      };
    },
  };
}

const fakeDispatcher = async () => ({ kind: "status", value: "ok" });

function getLstart(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
  }).trim();
}

test("startRuntime startup timeout waits for SIGTERM/SIGKILL termination before rejecting", async () => {
  const sandbox = makeSandboxScope();
  const pidFile = join(sandbox.base, "daemon.pid");
  const daemonPath = join(sandbox.base, "stubborn-daemon.mjs");
  writeFileSync(daemonPath, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), { mode: 0o600 });
    process.on("SIGTERM", () => {});
    process.on("message", () => {});
    setInterval(() => {}, 1000);
  `, { mode: 0o600 });

  let daemonPid;
  try {
    await assert.rejects(
      () => startRuntime(
        sandbox.scope,
        {
          instance: "timeout-inst",
          headless: true,
          channel: "chrome",
          authMode: false,
          startupTimeoutMs: 200,
          idleTimeoutMs: 5000,
        },
        { daemonPath },
      ),
      (err) => err instanceof RuntimeFault && err.stage === "browser" && err.code === "startup-timeout",
    );

    daemonPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 0, "假 daemon 应已记录 PID");
    assert.throws(
      () => process.kill(daemonPid, 0),
      (err) => err.code === "ESRCH",
      `startRuntime 在 reject startup-timeout 时假 daemon (pid=${daemonPid}) 必须已终止`,
    );
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, "SIGKILL"); } catch {}
    }
    sandbox.cleanup();
  }
});

test("listRuntimeInstances skips dotfiles and isolates broken/dead instance directories with warning", async () => {
  const sandbox = makeSandboxScope();
  const origConsoleError = console.error;
  const warnings = [];
  console.error = (...args) => warnings.push(args.map(String).join(" "));

  try {
    writeFileSync(join(sandbox.scope.stateRoot, ".DS_Store"), "junk", { mode: 0o600 });

    const brokenDir = join(sandbox.scope.stateRoot, "broken-inst");
    mkdirSync(brokenDir, { mode: 0o700 });
    writeFileSync(join(brokenDir, "ready.json"), "{not-valid-json", { mode: 0o600 });

    const healthyReady = await serveRuntime(
      sandbox.scope,
      {
        instance: "healthy-inst",
        headless: true,
        channel: "chrome",
        authMode: false,
        startupTimeoutMs: 2000,
        idleTimeoutMs: 60_000,
      },
      makeFakeAdapter("Chrome/131.0.0.0"),
      fakeDispatcher,
    );
    assert.equal(healthyReady.instance, "healthy-inst");

    const instances = await listRuntimeInstances(sandbox.scope);
    assert.equal(instances.length, 1, "应跳过点文件与损坏目录并返回健康实例");
    assert.equal(instances[0].instance, "healthy-inst");
    assert.equal(instances[0].browserVersion, "Chrome/131.0.0.0");
    assert.ok(
      warnings.some((line) => line.includes("broken-inst")),
      `跳过损坏实例时应向 stderr 记录告警，实际: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      !warnings.some((line) => line.includes(".DS_Store")),
      ".DS_Store 点文件应静默跳过不产生告警",
    );
  } finally {
    console.error = origConsoleError;
    await stopRuntime({ scope: sandbox.scope, instance: "healthy-inst" }).catch(() => {});
    sandbox.cleanup();
  }
});

test("serveRuntime safely reclaims stale instance dir and .sdk-lease from dead daemon via reclaim mutex, and preserves live/unknown leases", async () => {
  const sandbox = makeSandboxScope();
  const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    // 1. 已死 daemon 留下的 stale 实例目录 + stale .sdk-lease + 死 SingletonLock 应安全自愈并正常启动与 stopRuntime 清理
    const staleDir = join(sandbox.scope.stateRoot, "stale-inst");
    mkdirSync(staleDir, { mode: 0o700 });
    writeFileSync(join(staleDir, "owner.json"), JSON.stringify({
      nonce: "dead-nonce-1",
      instance: "stale-inst",
      daemonPid: 99999999,
      daemonSignature: "Mon Jan  1 00:00:00 2024",
    }), { mode: 0o600 });

    const namedProfileDir = join(sandbox.scope.profileRoot, "named-prof");
    mkdirSync(namedProfileDir, { mode: 0o700 });
    const staleLeaseDir = join(namedProfileDir, ".sdk-lease");
    mkdirSync(staleLeaseDir, { mode: 0o700 });
    writeFileSync(join(staleLeaseDir, "owner.json"), JSON.stringify({
      nonce: "dead-nonce-1",
      instance: "stale-inst",
      kind: "named",
      profile: namedProfileDir,
      daemonPid: 99999999,
      daemonSignature: "Mon Jan  1 00:00:00 2024",
    }), { mode: 0o600 });
    symlinkSync("testhost-99999999", join(namedProfileDir, "SingletonLock"));

    const ready = await serveRuntime(
      sandbox.scope,
      {
        instance: "stale-inst",
        profile: "named-prof",
        headless: true,
        channel: "chrome",
        authMode: false,
        startupTimeoutMs: 2000,
        idleTimeoutMs: 60_000,
      },
      makeFakeAdapter(),
      fakeDispatcher,
    );
    assert.equal(ready.instance, "stale-inst");
    assert.equal(ready.daemonPid, process.pid);

    const newOwner = JSON.parse(readFileSync(join(staleDir, "owner.json"), "utf8"));
    assert.equal(newOwner.daemonPid, process.pid);
    assert.ok(typeof newOwner.daemonSignature === "string" && newOwner.daemonSignature.length > 0);

    const stopped = await stopRuntime({ scope: sandbox.scope, instance: "stale-inst" });
    assert.equal(stopped.stopped, true);
    assert.equal(existsSync(staleDir), false, "stopRuntime 后实例目录应已清理");
    assert.equal(existsSync(staleLeaseDir), false, "stopRuntime 后 .sdk-lease 应已清理");

    // 2. 损坏 owner.json 保守按 instance-in-use 拒绝，不误删目录
    const corruptDir = join(sandbox.scope.stateRoot, "corrupt-inst");
    mkdirSync(corruptDir, { mode: 0o700 });
    writeFileSync(join(corruptDir, "owner.json"), "{broken", { mode: 0o600 });
    await assert.rejects(
      () => serveRuntime(
        sandbox.scope,
        {
          instance: "corrupt-inst",
          headless: true,
          channel: "chrome",
          authMode: false,
          startupTimeoutMs: 2000,
          idleTimeoutMs: 60_000,
        },
        makeFakeAdapter(),
        fakeDispatcher,
      ),
      (err) => err instanceof RuntimeFault && err.code === "instance-in-use",
    );
    assert.equal(existsSync(join(corruptDir, "owner.json")), true, "损坏 owner.json 目录不得被误删");

    // 3. 存活 daemonPid（且签名一致）保守拒绝 instance-in-use
    const liveDir = join(sandbox.scope.stateRoot, "live-inst");
    mkdirSync(liveDir, { mode: 0o700 });
    writeFileSync(join(liveDir, "owner.json"), JSON.stringify({
      nonce: "live-nonce",
      instance: "live-inst",
      daemonPid: liveChild.pid,
      daemonSignature: getLstart(liveChild.pid),
    }), { mode: 0o600 });
    await assert.rejects(
      () => serveRuntime(
        sandbox.scope,
        {
          instance: "live-inst",
          headless: true,
          channel: "chrome",
          authMode: false,
          startupTimeoutMs: 2000,
          idleTimeoutMs: 60_000,
        },
        makeFakeAdapter(),
        fakeDispatcher,
      ),
      (err) => err instanceof RuntimeFault && err.code === "instance-in-use",
    );

    // 4. named profile 缺失 owner.json 或 SingletonLock 指向存活 PID 时保守拒绝 profile-in-use
    const missingLeaseProfile = join(sandbox.scope.profileRoot, "missing-owner-prof");
    mkdirSync(missingLeaseProfile, { mode: 0o700 });
    mkdirSync(join(missingLeaseProfile, ".sdk-lease"), { mode: 0o700 });
    await assert.rejects(
      () => serveRuntime(
        sandbox.scope,
        {
          instance: "fresh-inst-1",
          profile: "missing-owner-prof",
          headless: true,
          channel: "chrome",
          authMode: false,
          startupTimeoutMs: 2000,
          idleTimeoutMs: 60_000,
        },
        makeFakeAdapter(),
        fakeDispatcher,
      ),
      (err) => err instanceof RuntimeFault && err.code === "profile-in-use",
    );

    const singletonLiveProfile = join(sandbox.scope.profileRoot, "singleton-live-prof");
    mkdirSync(singletonLiveProfile, { mode: 0o700 });
    const singletonLeaseDir = join(singletonLiveProfile, ".sdk-lease");
    mkdirSync(singletonLeaseDir, { mode: 0o700 });
    writeFileSync(join(singletonLeaseDir, "owner.json"), JSON.stringify({
      nonce: "dead-nonce-2",
      instance: "fresh-inst-2",
      kind: "named",
      profile: singletonLiveProfile,
      daemonPid: 99999999,
      daemonSignature: "Mon Jan  1 00:00:00 2024",
    }), { mode: 0o600 });
    symlinkSync(`testhost-${liveChild.pid}`, join(singletonLiveProfile, "SingletonLock"));

    await assert.rejects(
      () => serveRuntime(
        sandbox.scope,
        {
          instance: "fresh-inst-2",
          profile: "singleton-live-prof",
          headless: true,
          channel: "chrome",
          authMode: false,
          startupTimeoutMs: 2000,
          idleTimeoutMs: 60_000,
        },
        makeFakeAdapter(),
        fakeDispatcher,
      ),
      (err) => err instanceof RuntimeFault && err.code === "profile-in-use",
    );
  } finally {
    try { liveChild.kill("SIGKILL"); } catch {}
    await stopRuntime({ scope: sandbox.scope, instance: "stale-inst" }).catch(() => {});
    sandbox.cleanup();
  }
});
