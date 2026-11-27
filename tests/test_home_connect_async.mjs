import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resetHomeConnect,
  runLocal,
  runLocalBinary,
} from "../plugins/home-connect/src/connection.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_SERVER = join(ROOT, "plugins", "home-connect", "src", "server.ts");

function startHomeMcp(envOverrides = {}) {
  const env = { ...process.env };
  delete env.HOME_CONNECT_AGY_ASYNC;
  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, [HOME_SERVER], {
    cwd: join(ROOT, "plugins", "home-connect"),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buf = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const res = pending.get(msg.id);
        pending.delete(msg.id);
        res(msg);
      }
    }
  });

  const request = (method, params = {}) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const close = () => new Promise((res) => {
    child.once("close", (code) => res(code));
    child.stdin.end();
  });

  return { request, close };
}

test("test_home_connect_hides_bg_tools_and_keeps_instructions_clean_without_agy_flag", async () => {
  const client = startHomeMcp();
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.instructions.includes("home_exec_bg"), false);
    assert.equal(init.result.instructions.includes("home_copy_bg"), false);

    const list = await client.request("tools/list");
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      ["home_status", "home_exec", "home_copy", "home_wake", "home_reset"],
    );

    const callExecBg = await client.request("tools/call", {
      name: "home_exec_bg",
      arguments: { target: "mac", command: "echo hi" },
    });
    assert.equal(callExecBg.result.isError, true);

    const callCopyBg = await client.request("tools/call", {
      name: "home_copy_bg",
      arguments: { target: "mac", direction: "put", localPath: "/a", remotePath: "/b" },
    });
    assert.equal(callCopyBg.result.isError, true);
  } finally {
    await client.close();
  }
});

test("test_home_connect_exposes_bg_tools_with_agy_flag_and_validates_args", async () => {
  const client = startHomeMcp({ HOME_CONNECT_AGY_ASYNC: "1" });
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.match(init.result.instructions, /home_exec_bg/);

    const list = await client.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("home_exec_bg"));
    assert.ok(names.includes("home_copy_bg"));

    const execBgTool = list.result.tools.find((t) => t.name === "home_exec_bg");
    assert.equal(execBgTool.inputSchema.properties.timeoutSec.minimum, 0);
    assert.equal(execBgTool.inputSchema.properties.timeoutSec.maximum, undefined);

    // 参数校验失败不触发真实 SSH
    for (const badCall of [
      { name: "home_exec_bg", arguments: { target: "invalid", command: "echo hi" } },
      { name: "home_exec_bg", arguments: { target: "mac", command: "   " } },
      { name: "home_exec_bg", arguments: { target: "mac", command: "echo hi", timeoutSec: -5 } },
      { name: "home_copy_bg", arguments: { target: "mac", direction: "bad", localPath: "/a", remotePath: "/b" } },
      { name: "home_copy_bg", arguments: { target: "mac", direction: "put" } },
    ]) {
      const res = await client.request("tools/call", badCall);
      assert.equal(res.result.isError, true, `expected isError for ${JSON.stringify(badCall)}`);
    }
  } finally {
    await client.close();
  }
});

test("test_connection_settle_zero_timeout_and_reset", async () => {
  // timeoutSec = 0 不应设置本地 1s 截断，能正常完成 > 1.2s 的命令
  const res = await runLocal("sleep 1.2 && echo ok-zero-timeout", 0);
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.match(res.stdout, /ok-zero-timeout/);

  // timeoutSec = 0 运行中的命令依然受 resetHomeConnect() 管控可终止
  const longPromise = runLocal("sleep 30", 0);
  await new Promise((r) => setTimeout(r, 150));
  const resetRes = await resetHomeConnect();
  assert.ok(resetRes.terminated >= 1);
  const longRes = await longPromise;
  assert.notEqual(longRes.code, 0);
});

test("settle escalates SIGTERM to SIGKILL for signal-ignoring child and clears timers on normal exit", async () => {
  const started = Date.now();
  const ignored = await runLocal("trap '' TERM; sleep 30", 1);
  const elapsedMs = Date.now() - started;
  assert.equal(ignored.timedOut, true);
  assert.notEqual(ignored.code, 0);
  assert.ok(elapsedMs < 6000, `expected SIGKILL escalation within 6s, took ${elapsedMs}ms`);

  const quick = await runLocal("echo fast-exit", 2);
  assert.equal(quick.code, 0);
  assert.equal(quick.timedOut, false);
  assert.match(quick.stdout, /fast-exit/);
});

test("settle decodes split multi-byte UTF-8 cleanly and caps runaway stdout", async () => {
  const splitScript = [
    'const b = Buffer.from("你好中文世界\\n", "utf8");',
    'process.stdout.write(b.subarray(0, 4));',
    'setTimeout(() => {',
    '  process.stdout.write(b.subarray(4, 7));',
    '  setTimeout(() => process.stdout.write(b.subarray(7)), 20);',
    '}, 20);',
  ].join("");
  const utf8Res = await runLocalBinary(process.execPath, ["-e", splitScript], { timeoutSec: 5 });
  assert.equal(utf8Res.code, 0);
  assert.equal(utf8Res.stdout.includes("\uFFFD"), false);
  assert.equal(utf8Res.stdout.trim(), "你好中文世界");

  const runawayRes = await runLocalBinary(
    process.execPath,
    ["-e", 'process.stdout.write("A".repeat(65536));'],
    { timeoutSec: 5, maxCaptureBytes: 1024 },
  );
  assert.equal(runawayRes.code, 0);
  assert.ok(
    Buffer.byteLength(runawayRes.stdout, "utf8") < 2048,
    `expected stdout capped near 1024 bytes, got ${Buffer.byteLength(runawayRes.stdout, "utf8")}`,
  );
  assert.match(runawayRes.stdout, /输出截断/);
});

test("mac.sh status cleans previous temp files instead of leaking", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "home-mac-test-"));
  try {
    const isolatedTmp = join(sandbox, "tmp");
    const binDir = join(sandbox, "bin");
    const keyFile = join(sandbox, "dummy-key");
    const configFile = join(sandbox, "mac-tunnel.env");
    mkdirSync(isolatedTmp, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(keyFile, "dummy\n");
    writeFileSync(
      configFile,
      [
        "RELAY_SSH_ALIAS=relay",
        "RELAY_HOST=127.0.0.1",
        "RELAY_ADMIN_USER=admin",
        `RELAY_IDENTITY=${keyFile}`,
        "HOME_SSH_ALIAS=home-mac",
        "REMOTE_BIND_HOST=127.0.0.1",
        "REMOTE_PORT=2222",
        "HOME_MAC_USER=user",
        "HOME_MAC_LAN_HOST=127.0.0.1",
        `HOME_MAC_IDENTITY=${keyFile}`,
        "HOME_HOST_KEY_ALIAS=home-mac",
      ].join("\n"),
    );
    const fakeSsh = join(binDir, "ssh");
    writeFileSync(fakeSsh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeSsh, 0o755);

    const macSh = join(ROOT, "plugins", "home-connect", "scripts", "mac.sh");
    const runRes = spawnSync("bash", [macSh, "status"], {
      env: {
        ...process.env,
        TMPDIR: isolatedTmp,
        HOME_TUNNEL_CONFIG: configFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    assert.equal(runRes.status, 0, `mac.sh status failed: ${runRes.stderr}`);
    const leftover = readdirSync(isolatedTmp).filter((name) => name.startsWith("home-mac-err."));
    assert.deepEqual(leftover, [], `expected 0 leftover home-mac-err files, got ${leftover.join(", ")}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("lanAvailable caches 8s TTL, coalesces in-flight probes, and passes HOME_CONNECT_LAN_STATE to connect.sh", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "home-lan-cache-"));
  try {
    const binDir = join(sandbox, "bin");
    const rootDir = join(sandbox, "plugins", "home-connect");
    const cfgDir = join(rootDir, "config");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });

    const keyFile = join(sandbox, "dummy-key");
    writeFileSync(keyFile, "dummy\n");
    writeFileSync(join(cfgDir, "lan.env"), "LAN_HOST=127.0.0.1\nLAN_CIDR=127.0.0.0/8\nLAN_WINDOWS_SSH_PORT=22\n");
    writeFileSync(join(cfgDir, "wsl.env"), "WSL_HOST=127.0.0.1\nWSL_PORT=22\nWSL_USER=u\n");
    writeFileSync(join(cfgDir, "relay.env"), "RELAY_HOST=127.0.0.1\nRELAY_ADMIN_USER=admin\nWSL_RELAY_PORT=2223\n");
    writeFileSync(join(cfgDir, "wsl-known-hosts"), "127.0.0.1 ssh-ed25519 AAAA\n");
    writeFileSync(
      join(cfgDir, "mac-tunnel.env"),
      [
        "RELAY_SSH_ALIAS=relay",
        "RELAY_HOST=127.0.0.1",
        "RELAY_ADMIN_USER=admin",
        `RELAY_IDENTITY=${keyFile}`,
        "HOME_SSH_ALIAS=home-mac",
        "REMOTE_BIND_HOST=127.0.0.1",
        "REMOTE_PORT=2222",
        "HOME_MAC_USER=user",
        "HOME_MAC_LAN_HOST=127.0.0.1",
        `HOME_MAC_IDENTITY=${keyFile}`,
        "HOME_HOST_KEY_ALIAS=home-mac",
      ].join("\n"),
    );

    const routeLog = join(sandbox, "route-calls.log");
    const sshLog = join(sandbox, "ssh-calls.log");
    const fakeRoute = join(binDir, "route");
    writeFileSync(fakeRoute, `#!/bin/sh\necho call >> "${routeLog}"\nsleep 0.15\necho "interface: en0"\n`);
    const fakeIpconfig = join(binDir, "ipconfig");
    writeFileSync(fakeIpconfig, "#!/bin/sh\necho 127.0.0.1\n");
    const fakeNc = join(binDir, "nc");
    writeFileSync(fakeNc, "#!/bin/sh\nexit 0\n");
    const fakeSsh = join(binDir, "ssh");
    writeFileSync(fakeSsh, `#!/bin/sh\necho "$*" >> "${sshLog}"\necho ok\n`);
    for (const f of [fakeRoute, fakeIpconfig, fakeNc, fakeSsh]) chmodSync(f, 0o755);

    const connUrl = pathToFileURL(join(ROOT, "plugins", "home-connect", "src", "connection.ts")).href;
    const script = `
      import assert from "node:assert/strict";
      import { execRemote, invalidateLanCache } from ${JSON.stringify(connUrl)};
      const results = await Promise.all([
        execRemote("mac", "echo 1", 5),
        execRemote("mac", "echo 2", 5),
        execRemote("mac", "echo 3", 5),
        execRemote("mac", "echo 4", 5),
      ]);
      for (const r of results) {
        assert.equal(r.result.code, 0);
        assert.equal(r.channel, "lan");
      }
      await execRemote("mac", "echo 5", 5);
      invalidateLanCache();
      await execRemote("mac", "echo 6", 5);
    `;
    const childRes = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HARNESS_CONFIG_ROOT: sandbox,
        ROUTE_BIN: fakeRoute,
        IPCONFIG_BIN: fakeIpconfig,
        NC_BIN: fakeNc,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    assert.equal(childRes.status, 0, `lanAvailable subprocess failed: ${childRes.stderr}`);
    const calls = readFileSync(routeLog, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(calls, 2, `expected 1 coalesced/TTL probe + 1 post-invalidate probe, got ${calls}`);

    // connect.sh wsl 在透传 HOME_CONNECT_LAN_STATE=available/unavailable 时均应跳过 lan.sh require
    const connectSh = join(ROOT, "plugins", "home-connect", "scripts", "connect.sh");
    const wslAvail = spawnSync("bash", [connectSh, "wsl", "status"], {
      env: {
        ...process.env,
        HOME_CONNECT_ROOT: rootDir,
        HOME_CONNECT_LAN_STATE: "available",
        ROUTE_BIN: fakeRoute,
        IPCONFIG_BIN: fakeIpconfig,
        NC_BIN: fakeNc,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    assert.equal(wslAvail.status, 0, `connect.sh available failed: ${wslAvail.stderr}`);

    const wslRelay = spawnSync("bash", [connectSh, "wsl", "status"], {
      env: {
        ...process.env,
        HOME_CONNECT_ROOT: rootDir,
        HOME_CONNECT_LAN_STATE: "unavailable",
        ROUTE_BIN: fakeRoute,
        IPCONFIG_BIN: fakeIpconfig,
        NC_BIN: fakeNc,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    assert.equal(wslRelay.status, 0, `connect.sh unavailable relay fallback failed: ${wslRelay.stderr}`);
    const callsAfterConnect = readFileSync(routeLog, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(callsAfterConnect, 2, "connect.sh should skip lan.sh require when HOME_CONNECT_LAN_STATE is set");
    const sshOutput = readFileSync(sshLog, "utf8");
    assert.match(sshOutput, /wsl-relay-ssh/, "unavailable should route through wsl relay");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("comfyuiList fetches object_info nodes concurrently via Promise.all", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createHttpServer((req, res) => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/object_info/CheckpointLoaderSimple") {
        res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["modelA.safetensors"]] } } } }));
      } else {
        res.end(JSON.stringify({}));
      }
    }, 150);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");

  try {
    const toolsUrl = pathToFileURL(join(ROOT, "plugins", "home-connect", "src", "tools-comfyui.ts")).href;
    const script = `
      import assert from "node:assert/strict";
      import { callComfyuiTool } from ${JSON.stringify(toolsUrl)};
      const res = await callComfyuiTool("comfyui_list", {});
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.models[0].name, "modelA.safetensors");
    `;
    const childRes = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          HOME_CONNECT_HOST: "mac",
          COMFYUI_URL: `http://127.0.0.1:${addr.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(childRes.status, 0, `comfyuiList subprocess failed: ${childRes.stderr}`);
    assert.ok(maxInFlight >= 2, `expected concurrent comfyuiList requests, maxInFlight=${maxInFlight}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
