import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(ROOT, "plugins", "pi-worker", "src", "server.ts");

function createFakePiForMcp(dir, countFile, pidFile) {
  const scriptPath = join(dir, "fake-pi-mcp.mjs");
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
if (process.env.FAKE_MCP_MODE === "sleep") {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8");
  setInterval(() => {}, 1000);
} else {
  appendFileSync(${JSON.stringify(countFile)}, "1\\n", "utf8");
  const round = readFileSync(${JSON.stringify(countFile)}, "utf8").trim().split("\\n").length;
  if (round === 1) {
    writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
      status: "needs_input",
      summary: "待确认接口字段名",
      question: "字段用 camelCase 还是 snake_case？",
      options: ["camelCase", "snake_case"],
      verifiedCommands: [],
      stopReason: null,
      error: null,
    }), { mode: 0o600 });
  } else {
    writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
      status: "done",
      summary: "已按 camelCase 完成并测试通过",
      question: null,
      options: [],
      verifiedCommands: ["node --test"],
      stopReason: null,
      error: null,
    }), { mode: 0o600 });
  }
  process.exit(0);
}
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function startMcpClient(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
        const { resolve: res } = pending.get(msg.id);
        pending.delete(msg.id);
        res(msg);
      }
    }
  });

  const request = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const close = () => new Promise((res) => {
    child.once("close", (code) => res(code));
    child.stdin.end();
  });

  return { child, request, close };
}

test("test_mcp_full_lifecycle_validation_and_graceful_shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const stateDir = join(dir, "state");
    const countFile = join(dir, "rounds.txt");
    const pidFile = join(dir, "sleep.pid");
    const fakePi = createFakePiForMcp(dir, countFile, pidFile);

    const client = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: stateDir,
    });

    const initRes = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(initRes.result.serverInfo.name, "pi-worker");
    assert.ok(initRes.result.capabilities.tools);

    const listRes = await client.request("tools/list");
    assert.deepEqual(
      listRes.result.tools.map((t) => t.name),
      [
        "pi_worker_start",
        "pi_worker_reply",
        "pi_worker_status",
        "pi_worker_cancel",
        "pi_worker_list",
      ],
    );

    // 1. start -> needs_input
    const startRes = await client.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "开发新接口", waitSeconds: 5 },
    });
    assert.equal(startRes.result.isError, undefined);
    const task1 = startRes.result.structuredContent;
    assert.equal(task1.status, "needs_input");
    assert.equal(task1.question, "字段用 camelCase 还是 snake_case？");

    // 2. reply -> done
    const replyRes = await client.request("tools/call", {
      name: "pi_worker_reply",
      arguments: { taskId: task1.taskId, reply: "使用 camelCase", waitSeconds: 5 },
    });
    assert.equal(replyRes.result.isError, undefined);
    const task2 = replyRes.result.structuredContent;
    assert.equal(task2.status, "done");
    assert.deepEqual(task2.verifiedCommands, ["node --test"]);

    // 3. list
    const tasksRes = await client.request("tools/call", {
      name: "pi_worker_list",
      arguments: { cwd: workDir },
    });
    assert.equal(tasksRes.result.structuredContent.tasks.length, 1);
    assert.equal(tasksRes.result.structuredContent.tasks[0].taskId, task1.taskId);

    // 4. 参数校验失败返回 isError: true 且进程不崩
    for (const badCall of [
      { name: "pi_worker_start", arguments: { prompt: "no cwd" } },
      { name: "pi_worker_start", arguments: { cwd: "relative/path", prompt: "bad cwd" } },
      { name: "pi_worker_start", arguments: { cwd: workDir, prompt: "p", provider: "openai" } },
      { name: "pi_worker_status", arguments: { taskId: task1.taskId, waitSeconds: 99 } },
      { name: "pi_worker_status", arguments: { taskId: "nonexistent-task" } },
    ]) {
      const res = await client.request("tools/call", badCall);
      assert.equal(res.result.isError, true, `expected isError for ${JSON.stringify(badCall)}`);
    }

    const exitCode = await client.close();
    assert.equal(exitCode, 0);

    // 5. stdin 关闭时清理仍在运行的子进程
    const sleepClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-sleep"),
      FAKE_MCP_MODE: "sleep",
    });
    const sleepStart = await sleepClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "sleep forever", waitSeconds: 0 },
    });
    assert.equal(sleepStart.result.structuredContent.status, "running");

    // 等待 fake-pi 写下 pidFile
    for (let i = 0; i < 40; i += 1) {
      try {
        if (readFileSync(pidFile, "utf8").trim()) break;
      } catch { /* 等待 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(childPid > 0);

    await sleepClient.close();

    // 验证子进程已被清理
    let alive = true;
    for (let i = 0; i < 30; i += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
        break;
      }
    }
    assert.equal(alive, false, "MCP server shutdown must terminate active worker child");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_hides_and_blocks_all_tools_in_nested_worker_env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-nest-"));
  try {
    const client = startMcpClient({
      PI_WORKER_DEPTH: "1",
      PI_WORKER_STATE_DIR: join(dir, "state"),
    });

    const listRes = await client.request("tools/list");
    assert.deepEqual(listRes.result.tools, []);

    for (const name of [
      "pi_worker_start",
      "pi_worker_reply",
      "pi_worker_status",
      "pi_worker_cancel",
      "pi_worker_list",
    ]) {
      const res = await client.request("tools/call", { name, arguments: {} });
      assert.equal(res.result.isError, true, `nested env must reject ${name}`);
    }

    const exitCode = await client.close();
    assert.equal(exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_handles_null_array_and_malformed_json_without_crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-invalid-"));
  try {
    const client = startMcpClient({
      PI_WORKER_STATE_DIR: join(dir, "state"),
    });

    const received = [];
    const origLines = new Promise((resolveDone) => {
      let buf = "";
      client.child.stdout.on("data", (chunk) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id === null) {
            received.push(msg);
            if (received.length >= 3) resolveDone();
          }
        }
      });
    });

    client.child.stdin.write("null\n");
    client.child.stdin.write("[1, 2]\n");
    client.child.stdin.write("{not-valid-json\n");

    await Promise.race([
      origLines,
      new Promise((_, rej) => setTimeout(() => rej(new Error("expected 3 JSON-RPC error responses")), 2000)),
    ]);

    assert.equal(received[0].error.code, -32600);
    assert.equal(received[1].error.code, -32600);
    assert.equal(received[2].error.code, -32700);

    // 关键：服务进程必须仍存活并正常响应后续 ping
    const pingRes = await client.request("ping");
    assert.deepEqual(pingRes.result, {});

    const exitCode = await client.close();
    assert.equal(exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
