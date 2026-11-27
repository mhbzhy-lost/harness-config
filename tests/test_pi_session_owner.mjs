import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_SESSION_HEADER_BYTES, readSessionHeaderBytes } from "../pi/extensions/session-owner/contract.ts";
import { createRegistryStore, listLiveRecords, prepareLaunch } from "../pi/extensions/session-owner/registry.ts";

const REGISTRY_URL = pathToFileURL(resolve(process.cwd(), "pi/extensions/session-owner/registry.ts")).href;

function makeStoreRoot() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "so-reg-")));
  const root = join(base, "registry");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return { base, root };
}

function writeGuardFile(root, payload) {
  const path = join(root, ".guard");
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function getDeadPid() {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(res.status, 0);
  assert.ok(res.pid && res.pid > 0);
  return res.pid;
}

function runPrepareChild(root, ownerId) {
  return new Promise((resolvePromise, rejectPromise) => {
    const script = `
      import { createRegistryStore, prepareLaunch } from ${JSON.stringify(REGISTRY_URL)};
      const store = createRegistryStore(${JSON.stringify(root)}, 1500);
      const result = await prepareLaunch({
        store,
        pid: process.pid,
        ownerId: ${JSON.stringify(ownerId)},
        startedAt: new Date().toISOString(),
        reservation: { kind: "new" },
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("prepareLaunch resolves reservation outside .guard lock", async () => {
  const { base, root } = makeStoreRoot();
  try {
    const store = createRegistryStore(root, 80);
    let listElapsedMs = -1;
    let listCount = -1;

    const launchPromise = prepareLaunch({
      store,
      pid: process.pid,
      ownerId: "owner-outside-guard-001",
      startedAt: new Date().toISOString(),
      resolveReservation: async () => {
        const started = Date.now();
        const records = await listLiveRecords(store);
        listElapsedMs = Date.now() - started;
        listCount = records.length;
        await new Promise((r) => setTimeout(r, 120));
        return { kind: "new" };
      },
    });

    const result = await launchPromise;
    assert.equal(result.decision, "allow", `prepareLaunch 应成功，实际: ${JSON.stringify(result)}`);
    assert.equal(listCount, 0);
    assert.ok(listElapsedMs >= 0 && listElapsedMs < 50, `listLiveRecords 应在 <50ms 内返回，实际 ${listElapsedMs}ms`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("acquireGuard reclaims dead-PID stale .guard across 3 concurrent child processes without breaking live lock", async () => {
  const { base, root } = makeStoreRoot();
  try {
    // 1. 预置已死 PID 的陈旧 .guard，并发派生 3 个独立子进程竞争 prepareLaunch
    const deadPid = getDeadPid();
    writeGuardFile(root, { protocol: "pi-session-owner.guard.v1", pid: deadPid, token: randomUUID() });

    const ownerIds = ["child-owner-0001", "child-owner-0002", "child-owner-0003"];
    const results = await Promise.all(ownerIds.map((ownerId) => runPrepareChild(root, ownerId)));

    results.forEach((res, idx) => {
      assert.equal(res.code, 0, `子进程退出异常: ${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.decision, "allow", `子进程应回收陈旧 .guard 并成功，实际: ${res.stdout} stderr: ${res.stderr}`);
      assert.equal(parsed.record?.ownerId, ownerIds[idx]);
    });

    assert.equal(existsSync(join(root, ".guard")), false, ".guard 最终应被清理");
    assert.equal(existsSync(join(root, ".guard.reclaim")), false, ".guard.reclaim 最终应被清理");
    const leftoverEntries = readdirSync(root);
    assert.equal(leftoverEntries.some((name) => name.endsWith(".tmp")), false, `不应残留临时文件: ${leftoverEntries}`);

    // 2. 持锁者为存活 PID 时，绝不误删 .guard，且按退避返回 registry-busy
    const liveToken = randomUUID();
    const guardPath = writeGuardFile(root, { protocol: "pi-session-owner.guard.v1", pid: process.pid, token: liveToken });
    const store = createRegistryStore(root, 50);
    const blocked = await prepareLaunch({
      store,
      pid: process.pid,
      ownerId: "live-blocked-0001",
      startedAt: new Date().toISOString(),
      reservation: { kind: "new" },
    });
    assert.deepEqual(blocked, { decision: "blocked", reason: "registry-busy" });
    assert.equal(existsSync(guardPath), true, "存活 PID 的 .guard 不得被误删");
    assert.equal(JSON.parse(readFileSync(guardPath, "utf8")).token, liveToken);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("acquireGuard uses backoff instead of hot fsync spin", async () => {
  const { base, root } = makeStoreRoot();
  try {
    writeGuardFile(root, { protocol: "pi-session-owner.guard.v1", pid: process.pid, token: randomUUID() });
    let attempts = 0;
    const sleeps = [];
    const store = createRegistryStore(root, 60, {
      onGuardAttempt: () => { attempts += 1; },
      sleepMs: (ms) => {
        sleeps.push(ms);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      },
    });

    const result = await prepareLaunch({
      store,
      pid: process.pid,
      ownerId: "owner-backoff-001",
      startedAt: new Date().toISOString(),
      reservation: { kind: "new" },
    });

    assert.deepEqual(result, { decision: "blocked", reason: "registry-busy" });
    assert.ok(attempts >= 1 && attempts <= 10, `退避重试次数应 <= 10，实际 ${attempts}`);
    assert.ok(sleeps.length >= 1, `应通过 sleepMs 退避等待，实际 sleeps=${JSON.stringify(sleeps)}`);
    assert.ok(sleeps.every((ms) => ms > 0), `退避时长应 > 0，实际 ${JSON.stringify(sleeps)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readSessionHeaderBytes reads first line in bounded bulk readSync loop", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hdr-")));
  try {
    const file4k = join(dir, "session-4k.jsonl");
    const firstLine = `${JSON.stringify({ type: "session", version: 3, id: "sess-4k", cwd: dir, pad: "x".repeat(4000) })}\n`;
    const body = `${JSON.stringify({ type: "message", text: "hello" })}\n`.repeat(50);
    writeFileSync(file4k, firstLine + body, "utf8");

    const headerBuf = readSessionHeaderBytes(file4k);
    assert.equal(headerBuf.toString("utf8"), firstLine);

    const oversizeFile = join(dir, "oversize.jsonl");
    writeFileSync(oversizeFile, "a".repeat(MAX_SESSION_HEADER_BYTES + 2048), "utf8");
    const oversizeBuf = readSessionHeaderBytes(oversizeFile);
    assert.equal(oversizeBuf.length, MAX_SESSION_HEADER_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
