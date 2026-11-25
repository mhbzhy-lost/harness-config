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
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo step" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false }) + "\\n");
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

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_WORKER_DEPTH;
  return { ...env, ...overrides };
}

function startMcpClient(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: cleanEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  const notifications = [];
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
      } else if (msg.id === undefined && msg.method) {
        notifications.push(msg);
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

  return { child, request, close, notifications };
}

test("test_mcp_full_lifecycle_validation_and_graceful_shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-"));
  let client;
  let sleepClient;
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const stateDir = join(dir, "state");
    const countFile = join(dir, "rounds.txt");
    const pidFile = join(dir, "sleep.pid");
    const fakePi = createFakePiForMcp(dir, countFile, pidFile);

    client = startMcpClient({
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
    const startSchema = listRes.result.tools.find((t) => t.name === "pi_worker_start").inputSchema;
    const replySchema = listRes.result.tools.find((t) => t.name === "pi_worker_reply").inputSchema;
    assert.equal("timeoutSeconds" in startSchema.properties, false);
    assert.equal("timeoutSeconds" in replySchema.properties, false);

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
    client = undefined;
    assert.equal(exitCode, 0);

    // 5. stdin 关闭时清理仍在运行的子进程
    sleepClient = startMcpClient({
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
    sleepClient = undefined;

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
    if (client) await client.close().catch(() => {});
    if (sleepClient) await sleepClient.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_hides_and_blocks_all_tools_in_nested_worker_env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-nest-"));
  let client;
  try {
    client = startMcpClient({
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
    client = undefined;
    assert.equal(exitCode, 0);
  } finally {
    if (client) await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_handles_null_array_and_malformed_json_without_crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-invalid-"));
  let client;
  try {
    client = startMcpClient({
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
    client = undefined;
    assert.equal(exitCode, 0);
  } finally {
    if (client) await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_agy_mode_blocks_start_reply_and_cancels_via_notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-agy-"));
  let client;
  let cancelClient;
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const countFile = join(dir, "rounds.txt");
    const pidFile = join(dir, "sleep.pid");
    const fakePi = createFakePiForMcp(dir, countFile, pidFile);

    // 1. AGY 模式下 start/reply 直接阻塞等到本轮结束，且 reply schema 支持 model/provider/thinking
    client = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-agy"),
      PI_WORKER_AGY: "1",
    });

    const listRes = await client.request("tools/list");
    const replyTool = listRes.result.tools.find((t) => t.name === "pi_worker_reply");
    assert.ok("model" in replyTool.inputSchema.properties);
    assert.ok("provider" in replyTool.inputSchema.properties);
    assert.ok("thinking" in replyTool.inputSchema.properties);
    assert.equal(listRes.result.tools.some((t) => t.name === "pi_worker_wait"), false);

    // 不传 waitSeconds，AGY 模式直接等到 needs_input 返回
    const startRes = await client.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "agy job" },
    });
    assert.equal(startRes.result.isError, undefined);
    assert.equal(startRes.result.structuredContent.status, "needs_input");

    const replyRes = await client.request("tools/call", {
      name: "pi_worker_reply",
      arguments: { taskId: startRes.result.structuredContent.taskId, reply: "camelCase", thinking: "low" },
    });
    assert.equal(replyRes.result.isError, undefined);
    assert.equal(replyRes.result.structuredContent.status, "done");
    assert.equal(replyRes.result.structuredContent.thinking, "low");
    await client.close();
    client = undefined;

    // 2. AGY 模式下通过 JSON-RPC notifications/cancelled 取消后台运行中的 start
    cancelClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-agy-cancel"),
      PI_WORKER_AGY: "1",
      FAKE_MCP_MODE: "sleep",
    });

    const startReqId = 42;
    const cancelStartPromise = new Promise((resolveDone) => {
      let buf = "";
      const onData = (chunk) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id === startReqId) {
            cancelClient.child.stdout.off("data", onData);
            resolveDone(msg);
          }
        }
      };
      cancelClient.child.stdout.on("data", onData);
      cancelClient.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: startReqId,
        method: "tools/call",
        params: { name: "pi_worker_start", arguments: { cwd: workDir, prompt: "sleep" } },
      })}\n`);
    });

    for (let i = 0; i < 40; i += 1) {
      try {
        if (readFileSync(pidFile, "utf8").trim()) break;
      } catch { /* 等待 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(childPid > 0);

    // 发送 MCP 标准取消通知
    cancelClient.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: startReqId, reason: "user cancelled" },
    })}\n`);

    const cancelledMsg = await cancelStartPromise;
    assert.equal(cancelledMsg.result.structuredContent.status, "cancelled");
    assert.throws(() => process.kill(childPid, 0));
    await cancelClient.close();
    cancelClient = undefined;
  } finally {
    if (client) await client.close().catch(() => {});
    if (cancelClient) await cancelClient.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_progress_notifications_and_agy_app_endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-app-"));
  let agyClient;
  let stdClient;
  let nestedAgyClient;
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const countFile = join(dir, "rounds.txt");
    const pidFile = join(dir, "sleep.pid");
    const fakePi = createFakePiForMcp(dir, countFile, pidFile);
    const fakeHtmlPath = join(dir, "monitor.html");
    writeFileSync(fakeHtmlPath, "<!DOCTYPE html><html><body>monitor-ok</body></html>", "utf8");

    // 1. 标准模式（未设 PI_WORKER_AGY）：发 progressToken 时仍支持标准 notifications/progress，但不暴露 MCP App 资源或工具
    stdClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-std"),
    });
    const stdResList = await stdClient.request("resources/list");
    assert.deepEqual(stdResList.result.resources, []);
    const stdTools = (await stdClient.request("tools/list")).result.tools.map((t) => t.name);
    assert.equal(stdTools.includes("pi_worker_monitor"), false);
    assert.equal(stdTools.includes("pi_worker_app_snapshot"), false);

    const stdStart = await stdClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "with progress", waitSeconds: 5 },
      _meta: { progressToken: "pt-std-1" },
    });
    assert.equal(stdStart.result.isError, undefined);
    const progNotes = stdClient.notifications.filter((n) => n.method === "notifications/progress");
    assert.ok(progNotes.length >= 1, "expected standard notifications/progress when progressToken is provided");
    assert.equal(progNotes[0].params.progressToken, "pt-std-1");
    assert.match(progNotes[0].params.message, /bash/);
    await stdClient.close();
    stdClient = undefined;

    // 2. AGY 模式：resources/list + resources/read + pi_worker_monitor + app-only 工具
    agyClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-agy"),
      PI_WORKER_AGY: "1",
      PI_WORKER_APP_HTML: fakeHtmlPath,
    });
    const agyInit = await agyClient.request("initialize", { protocolVersion: "2025-06-18" });
    assert.ok(agyInit.result.capabilities.resources);
    const agyResList = await agyClient.request("resources/list");
    assert.equal(agyResList.result.resources.length, 1);
    assert.equal(agyResList.result.resources[0].uri, "ui://pi-worker/monitor.html");
    assert.equal(agyResList.result.resources[0].mimeType, "text/html;profile=mcp-app");

    const readRes = await agyClient.request("resources/read", { uri: "ui://pi-worker/monitor.html" });
    assert.equal(readRes.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(readRes.result.contents[0].text, /monitor-ok/);

    const agyTools = (await agyClient.request("tools/list")).result.tools;
    const monitorTool = agyTools.find((t) => t.name === "pi_worker_monitor");
    assert.ok(monitorTool);
    assert.equal(monitorTool._meta.ui.resourceUri, "ui://pi-worker/monitor.html");
    assert.equal(monitorTool._meta["com.google.antigravity/ui"].entrypoints.length, 2);

    const snapshotTool = agyTools.find((t) => t.name === "pi_worker_app_snapshot");
    const appCancelTool = agyTools.find((t) => t.name === "pi_worker_app_cancel");
    assert.deepEqual(snapshotTool._meta.ui.visibility, ["app"]);
    assert.deepEqual(appCancelTool._meta.ui.visibility, ["app"]);

    // start/reply 不附加 inline resourceUri，避免聊天流堆叠重复轮询 iframe
    const startTool = agyTools.find((t) => t.name === "pi_worker_start");
    assert.equal(startTool._meta, undefined);

    // 空参启动 pi_worker_monitor({}) 必须安全返回
    const emptyMon = await agyClient.request("tools/call", { name: "pi_worker_monitor", arguments: {} });
    assert.equal(emptyMon.result.isError, undefined);
    assert.deepEqual(emptyMon.result.structuredContent.tasks, []);
    assert.equal(emptyMon.result.structuredContent.task, null);

    // 启动任务后，pi_worker_monitor 的 LLM content 紧凑（不含 events 数组），structuredContent 含 stream
    const started = await agyClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "agy app task" },
    });
    const tid = started.result.structuredContent.taskId;
    const monRes = await agyClient.request("tools/call", { name: "pi_worker_monitor", arguments: { taskId: tid } });
    assert.equal(monRes.result.isError, undefined);
    assert.equal(monRes.result.structuredContent.task.taskId, tid);
    assert.ok(monRes.result.structuredContent.stream.events.length >= 1);
    assert.equal(monRes.result.content[0].text.includes('"events"'), false);

    // app-only snapshot 增量读取
    const snap = await agyClient.request("tools/call", {
      name: "pi_worker_app_snapshot",
      arguments: { taskId: tid, offset: 0 },
    });
    assert.equal(snap.result.isError, undefined);
    assert.ok(snap.result.structuredContent.stream.events.length >= 1);
    await agyClient.close();
    agyClient = undefined;

    // 3. 嵌套环境即使带 PI_WORKER_AGY=1 也必须隐藏并封锁全部资源与工具
    nestedAgyClient = startMcpClient({
      PI_WORKER_AGY: "1",
      PI_WORKER_DEPTH: "1",
      PI_WORKER_STATE_DIR: join(dir, "state-nest-agy"),
    });
    assert.deepEqual((await nestedAgyClient.request("tools/list")).result.tools, []);
    assert.deepEqual((await nestedAgyClient.request("resources/list")).result.resources, []);
    const nestedRead = await nestedAgyClient.request("resources/read", { uri: "ui://pi-worker/monitor.html" });
    assert.ok(nestedRead.error);
    await nestedAgyClient.close();
    nestedAgyClient = undefined;
  } finally {
    if (stdClient) await stdClient.close().catch(() => {});
    if (agyClient) await agyClient.close().catch(() => {});
    if (nestedAgyClient) await nestedAgyClient.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
