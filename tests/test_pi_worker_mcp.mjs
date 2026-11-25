import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  delete env.PI_WORKER_AGY;
  delete env.PI_WORKER_DEFAULT_PROVIDER;
  delete env.PI_WORKER_DEFAULT_MODEL;
  delete env.PI_WORKER_DEFAULT_THINKING;
  delete env.ANTIGRAVITY_LS_ADDRESS;
  delete env.ANTIGRAVITY_CSRF_TOKEN;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WORKER_TIER_")) delete env[key];
  }
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
    assert.match(initRes.result.instructions, /executedCommands/);
    assert.match(initRes.result.instructions, /eventsPath/);
    assert.doesNotMatch(initRes.result.instructions, /Antigravity/);

    const listRes = await client.request("tools/list");
    assert.deepEqual(
      listRes.result.tools.map((t) => t.name),
      [
        "pi_worker_start",
        "pi_worker_reply",
        "pi_worker_steer",
        "pi_worker_status",
        "pi_worker_cancel",
        "pi_worker_list",
      ],
    );
    const startSchema = listRes.result.tools.find((t) => t.name === "pi_worker_start").inputSchema;
    const replySchema = listRes.result.tools.find((t) => t.name === "pi_worker_reply").inputSchema;
    const listSchema = listRes.result.tools.find((t) => t.name === "pi_worker_list").inputSchema;
    assert.equal("timeoutSeconds" in startSchema.properties, false);
    assert.equal("timeoutSeconds" in replySchema.properties, false);
    assert.equal(startSchema.properties.parentSessionId.type, "string");
    assert.equal(listSchema.properties.parentSessionId.type, "string");
    assert.deepEqual(startSchema.properties.tier.enum, ["fast", "default", "heavy"]);
    assert.equal(startSchema.properties.readOnly.type, "boolean");
    assert.deepEqual(replySchema.properties.tier.enum, ["fast", "default", "heavy"]);

    // 1. start -> needs_input
    const startRes = await client.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "开发新接口", waitSeconds: 5 },
    });
    assert.equal(startRes.result.isError, undefined);
    const task1 = startRes.result.structuredContent;
    assert.equal(task1.status, "needs_input");
    assert.equal(task1.question, "字段用 camelCase 还是 snake_case？");
    assert.equal(task1.executedCommands.length, 1);
    assert.equal(task1.executedCommands[0].command, "echo step");
    assert.equal(task1.executedCommands[0].isError, false);
    assert.equal(startRes.result.content.length, 2);
    assert.equal(JSON.parse(startRes.result.content[0].text).taskId, task1.taskId);
    assert.match(startRes.result.content[1].text, /磁盘证据核验提醒/);
    assert.ok(startRes.result.content[1].text.includes(task1.eventsPath));

    // 2. reply -> done
    const replyRes = await client.request("tools/call", {
      name: "pi_worker_reply",
      arguments: { taskId: task1.taskId, reply: "使用 camelCase", waitSeconds: 5 },
    });
    assert.equal(replyRes.result.isError, undefined);
    const task2 = replyRes.result.structuredContent;
    assert.equal(task2.status, "done");
    assert.deepEqual(task2.verifiedCommands, ["node --test"]);
    assert.equal(task2.executedCommands.length, 1);
    assert.equal(task2.executedCommands[0].round, 2);
    assert.equal(task2.executedCommands[0].command, "echo step");
    assert.equal(replyRes.result.content.length, 2);
    assert.match(replyRes.result.content[1].text, /磁盘证据核验提醒/);

    // 3. list（返回 tasks 与按父会话聚合的 groups，且支持 parentSessionId 过滤）
    const tasksRes = await client.request("tools/call", {
      name: "pi_worker_list",
      arguments: { cwd: workDir },
    });
    assert.equal(tasksRes.result.structuredContent.tasks.length, 1);
    assert.equal(tasksRes.result.structuredContent.tasks[0].taskId, task1.taskId);
    assert.equal(tasksRes.result.structuredContent.groups.length, 1);
    assert.equal(tasksRes.result.structuredContent.groups[0].groupKey, `cwd:${task1.cwd}`);

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
    assert.equal(sleepStart.result.content.length, 1, "running snapshot should not attach settled evidence notice");

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
      "pi_worker_steer",
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
    assert.equal(stdTools.includes("pi_worker_app_steer"), false);
    assert.equal(stdTools.includes("pi_worker_steer"), true);

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

    // 启动任务后，pi_worker_monitor 的 LLM content 紧凑（不含 events 数组），structuredContent 含 stream 与 groups，且支持按 parentSessionId 隔离作用域
    const started = await agyClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "agy app task", parentSessionId: "conv-harness" },
    });
    const tid = started.result.structuredContent.taskId;
    assert.equal(started.result.structuredContent.parentSessionId, "conv-harness");

    const monRes = await agyClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { taskId: tid, parentSessionId: "conv-harness" },
    });
    assert.equal(monRes.result.isError, undefined);
    assert.equal(monRes.result.structuredContent.scope.parentSessionId, "conv-harness");
    assert.equal(monRes.result.structuredContent.task.taskId, tid);
    assert.equal(monRes.result.structuredContent.groups.length, 1);
    assert.equal(monRes.result.structuredContent.groups[0].parentSessionId, "conv-harness");
    assert.ok(monRes.result.structuredContent.stream.events.length >= 1);
    assert.equal(monRes.result.content[0].text.includes('"events"'), false);

    // 另一父会话作用域内不应串出 conv-harness 的任务
    const otherSessionMon = await agyClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { parentSessionId: "conv-new-api" },
    });
    assert.equal(otherSessionMon.result.isError, undefined);
    assert.deepEqual(otherSessionMon.result.structuredContent.tasks, []);
    assert.deepEqual(otherSessionMon.result.structuredContent.groups, []);
    assert.equal(otherSessionMon.result.structuredContent.task, null);

    // app-only snapshot 增量读取
    const snap = await agyClient.request("tools/call", {
      name: "pi_worker_app_snapshot",
      arguments: { taskId: tid, parentSessionId: "conv-harness", offset: 0 },
    });
    assert.equal(snap.result.isError, undefined);
    assert.ok(snap.result.structuredContent.stream.events.length >= 1);
    assert.equal(snap.result.structuredContent.groups.length, 1);
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

test("test_mcp_title_passthrough_session_scope_ignores_cwd_and_ls_title_backfill", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-title-"));
  let agyClient;
  let lsClient;
  let lsServer;
  try {
    const mainDir = join(dir, "repo", "main");
    const worktreeDir = join(dir, "repo", "worktree");
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const fakePi = createFakePiForMcp(dir, join(dir, "rounds.txt"), join(dir, "sleep.pid"));

    agyClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-title"),
      PI_WORKER_AGY: "1",
    });

    // schema：start 增加 title/parentSessionTitle，monitor/app_snapshot 增加 parentSessionTitle，additionalProperties 保持 false
    const tools = (await agyClient.request("tools/list")).result.tools;
    const startSchema = tools.find((t) => t.name === "pi_worker_start").inputSchema;
    assert.equal(startSchema.properties.title.type, "string");
    assert.equal(startSchema.properties.parentSessionTitle.type, "string");
    assert.equal(startSchema.additionalProperties, false);
    const monitorSchema = tools.find((t) => t.name === "pi_worker_monitor").inputSchema;
    assert.equal(monitorSchema.properties.parentSessionTitle.type, "string");
    assert.equal(monitorSchema.additionalProperties, false);
    const snapshotSchema = tools.find((t) => t.name === "pi_worker_app_snapshot").inputSchema;
    assert.equal(snapshotSchema.properties.parentSessionTitle.type, "string");
    // tasksLimit 描述与实现对齐（默认 50）
    assert.match(snapshotSchema.properties.tasksLimit.description, /50/);

    // start 透传 title / parentSessionTitle
    const t1 = (await agyClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: {
        cwd: mainDir,
        prompt: "# 任务目标：不应作为标题\n细节",
        title: "任务A",
        parentSessionId: "conv-scope",
        parentSessionTitle: "会话标题甲",
        waitSeconds: 5,
      },
    })).result.structuredContent;
    assert.equal(t1.title, "任务A");
    assert.equal(t1.parentSessionTitle, "会话标题甲");

    // 同会话在另一目录（git worktree 场景）派发的任务
    const t2 = (await agyClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: worktreeDir, prompt: "worktree 任务", parentSessionId: "conv-scope", waitSeconds: 5 },
    })).result.structuredContent;
    assert.equal(t2.title, "worktree 任务");

    // 同时传 parentSessionId + cwd：仅按会话过滤，worktree 任务不得被 cwd 过滤漏掉
    const mon = (await agyClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { parentSessionId: "conv-scope", cwd: mainDir },
    })).result.structuredContent;
    assert.deepEqual(mon.tasks.map((t) => t.taskId).sort(), [t1.taskId, t2.taskId].sort());
    assert.equal(mon.groups.length, 1);
    assert.equal(mon.scope.parentSessionId, "conv-scope");
    assert.equal(mon.scope.parentSessionTitle, "会话标题甲");
    assert.equal(mon.scope.cwd, mainDir);

    // 显式 parentSessionTitle 优先于组内解析结果
    const monExplicit = (await agyClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { parentSessionId: "conv-scope", parentSessionTitle: "显式标题" },
    })).result.structuredContent;
    assert.equal(monExplicit.scope.parentSessionTitle, "显式标题");

    // 无 parentSessionId 时才按 cwd 过滤
    const monCwd = (await agyClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { cwd: worktreeDir },
    })).result.structuredContent;
    assert.deepEqual(monCwd.tasks.map((t) => t.taskId), [t2.taskId]);
    assert.equal(monCwd.scope.parentSessionId, null);
    await agyClient.close();
    agyClient = undefined;

    // AGY 模式历史标题懒补齐：经 ConversationService GetConversation 读取 annotations.title（内存缓存，不重复请求）
    const hits = [];
    lsServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        hits.push({ url: req.url, csrf: req.headers["x-antigravity-csrf-token"], body: JSON.parse(body || "{}") });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ annotations: { title: "来自 LS 的标题" } }));
      });
    });
    await new Promise((r) => lsServer.listen(0, "127.0.0.1", r));
    lsClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-ls"),
      PI_WORKER_AGY: "1",
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsServer.address().port}`,
      ANTIGRAVITY_CSRF_TOKEN: "test-csrf-token",
    });
    const t3 = (await lsClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: mainDir, prompt: "LS 标题任务", parentSessionId: "conv-ls", waitSeconds: 5 },
    })).result.structuredContent;
    assert.equal(t3.parentSessionTitle, undefined);

    const lsMon = (await lsClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { parentSessionId: "conv-ls" },
    })).result.structuredContent;
    assert.equal(lsMon.scope.parentSessionTitle, "来自 LS 的标题");
    assert.equal(lsMon.groups[0].parentSessionTitle, "来自 LS 的标题");
    assert.equal(lsMon.tasks[0].parentSessionTitle, "来自 LS 的标题");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "/product.v1.ConversationService/GetConversation");
    assert.equal(hits[0].csrf, "test-csrf-token");
    assert.equal(hits[0].body.conversationId, "conv-ls");

    // 再次 monitor：命中内存缓存，不重复请求 LS
    const lsMon2 = (await lsClient.request("tools/call", {
      name: "pi_worker_monitor",
      arguments: { parentSessionId: "conv-ls" },
    })).result.structuredContent;
    assert.equal(lsMon2.scope.parentSessionTitle, "来自 LS 的标题");
    assert.equal(hits.length, 1);
  } finally {
    if (agyClient) await agyClient.close().catch(() => {});
    if (lsClient) await lsClient.close().catch(() => {});
    if (lsServer) await new Promise((r) => lsServer.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_mcp_steer_tool_standard_and_agy_app_only_with_eager_config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-mcp-steer-"));
  let stdClient;
  let agyClient;
  try {
    // mcp_config.json 静态断言：pi_worker_steer 必须 eager 且非 background
    const mcpConfig = JSON.parse(readFileSync(join(ROOT, "plugins", "pi-worker", "mcp_config.json"), "utf8"));
    const steerCfg = mcpConfig.mcpServers["pi-worker"].tools.pi_worker_steer;
    assert.deepEqual(steerCfg, { eager: true });
    assert.equal("background" in steerCfg, false);

    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const pidFile = join(dir, "sleep.pid");
    const fakePi = createFakePiForMcp(dir, join(dir, "rounds.txt"), pidFile);

    // 1. 标准模式：pi_worker_steer 可见、app_steer 不可见；运行中任务入队立即返回不阻塞
    stdClient = startMcpClient({
      PI_WORKER_BIN: fakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-std"),
      FAKE_MCP_MODE: "sleep",
    });
    const stdTools = (await stdClient.request("tools/list")).result.tools;
    const steerTool = stdTools.find((t) => t.name === "pi_worker_steer");
    assert.ok(steerTool);
    assert.deepEqual(steerTool.inputSchema.required, ["taskId", "message"]);
    assert.equal(steerTool._meta, undefined);
    assert.equal(stdTools.some((t) => t.name === "pi_worker_app_steer"), false);

    const started = await stdClient.request("tools/call", {
      name: "pi_worker_start",
      arguments: { cwd: workDir, prompt: "long job", waitSeconds: 0 },
    });
    const tid = started.result.structuredContent.taskId;
    assert.equal(started.result.structuredContent.status, "running");

    const steerRes = await stdClient.request("tools/call", {
      name: "pi_worker_steer",
      arguments: { taskId: tid, message: "改用方案 B" },
    });
    assert.equal(steerRes.result.isError, undefined);
    const sc = steerRes.result.structuredContent;
    assert.equal(sc.queued, true);
    assert.equal(sc.status, "running");
    assert.equal(sc.source, "agent");
    assert.equal(sc.message, "改用方案 B");
    assert.ok(sc.steerId);
    assert.match(steerRes.result.content[0].text, /Steer 已入队/);

    // 磁盘证据：steer 队列与 eventsPath 中的 steer 事件
    const steerFile = join(dir, "state-std", "steers", `${tid}.jsonl`);
    const entries = readFileSync(steerFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, sc.steerId);
    const eventsFile = join(dir, "state-std", "logs", `${tid}.events.jsonl`);
    const evLines = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const steerEv = evLines.find((ev) => ev.kind === "steer");
    assert.ok(steerEv);
    assert.equal(steerEv.detail, "改用方案 B");
    assert.match(steerEv.title, /主代理/);

    // 参数校验与非运行态拒绝
    const badRes = await stdClient.request("tools/call", {
      name: "pi_worker_steer",
      arguments: { taskId: tid, message: "   " },
    });
    assert.equal(badRes.result.isError, true);
    await stdClient.request("tools/call", { name: "pi_worker_cancel", arguments: { taskId: tid } });
    const nonRunning = await stdClient.request("tools/call", {
      name: "pi_worker_steer",
      arguments: { taskId: tid, message: "迟到插话" },
    });
    assert.equal(nonRunning.result.isError, true);
    assert.match(nonRunning.result.content[0].text, /pi_worker_reply/);
    await stdClient.close();
    stdClient = undefined;

    // 2. AGY 模式：pi_worker_app_steer 仅 app 可见，source 标记为 app
    const agyPidFile = join(dir, "sleep-agy.pid");
    const agyFakePi = createFakePiForMcp(dir, join(dir, "rounds-agy.txt"), agyPidFile);
    agyClient = startMcpClient({
      PI_WORKER_BIN: agyFakePi,
      PI_WORKER_STATE_DIR: join(dir, "state-agy"),
      PI_WORKER_AGY: "1",
      FAKE_MCP_MODE: "sleep",
    });
    const agyTools = (await agyClient.request("tools/list")).result.tools;
    const appSteerTool = agyTools.find((t) => t.name === "pi_worker_app_steer");
    assert.ok(appSteerTool);
    assert.deepEqual(appSteerTool._meta.ui.visibility, ["app"]);
    assert.ok(agyTools.some((t) => t.name === "pi_worker_steer"));

    // AGY 模式下 start 会阻塞至本轮结束，故直接向 state-agy 写入一个运行中的任务快照
    // （模拟另一进程 detached 运行），验证跨进程 app-only steer 入队。
    const { TaskStore } = await import("../plugins/pi-worker/src/store.ts");
    const store = new TaskStore(join(dir, "state-agy"));
    const paths = store.allocateTaskPaths("agy-detached-task");
    store.save({
      taskId: "agy-detached-task",
      cwd: workDir,
      sessionDir: paths.sessionDir,
      logPath: paths.logPath,
      eventsPath: paths.eventsPath,
      outcomePath: paths.outcomePath,
      steerPath: paths.steerPath,
      status: "running",
      pid: process.pid, // 借用当前存活 pid 模拟运行中的 detached 任务
      excludeTools: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      turnCount: 0,
      roundCount: 1,
      lastTool: null,
      recentEvents: [],
      summary: "",
      question: null,
      options: [],
      verifiedCommands: [],
      executedCommands: [],
      stopReason: null,
      exitCode: null,
      error: null,
      gitChanges: [],
    });
    const appRes = await agyClient.request("tools/call", {
      name: "pi_worker_app_steer",
      arguments: { taskId: "agy-detached-task", message: "面板实时纠偏" },
    });
    assert.equal(appRes.result.isError, undefined);
    assert.equal(appRes.result.structuredContent.source, "app");
    assert.equal(appRes.result.structuredContent.queued, true);
    const agyEntries = readFileSync(paths.steerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(agyEntries[0].message, "面板实时纠偏");
    assert.equal(agyEntries[0].source, "app");
    await agyClient.close();
    agyClient = undefined;
  } finally {
    if (stdClient) await stdClient.close().catch(() => {});
    if (agyClient) await agyClient.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
