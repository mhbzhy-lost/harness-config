#!/usr/bin/env node
/**
 * pi-worker 真实端到端验证脚本（调用本机真实 Pi 与真实 LLM）：
 * 完整验证 start -> 实时进度 -> needs_input 挂起 -> session 成对校验 -> reply 恢复续跑 -> done + 宿主机独立单测验收。
 * 用法：node plugins/pi-worker/scripts/live-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(PLUGIN_ROOT, "src", "server.ts");

function createTempGitProject() {
  const base = mkdtempSync(join(tmpdir(), "pi-worker-live-e2e-"));
  const repoDir = join(base, "demo-repo");
  const stateDir = join(base, "state");
  mkdirSync(join(repoDir, "src"), { recursive: true });

  writeFileSync(
    join(repoDir, "src", "greet.mjs"),
    `// 待扩展模块\nexport function ping() {\n  return "pong";\n}\n`,
    "utf8",
  );
  writeFileSync(
    join(repoDir, "test.mjs"),
    `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ping } from "./src/greet.mjs";\n\ntest("ping works", () => {\n  assert.equal(ping(), "pong");\n});\n`,
    "utf8",
  );

  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "e2e-test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

  return { base, repoDir, stateDir };
}

function startMcpServer(stateDir) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, PI_WORKER_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

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

  const request = (method, params = {}) =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, { resolve: res });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const close = () =>
    new Promise((res) => {
      child.once("close", (code) => res({ code, stderr }));
      child.stdin.end();
    });

  return { request, close };
}

async function pollUntilNotRunning(client, taskId, label, maxPolls = 18) {
  for (let i = 1; i <= maxPolls; i += 1) {
    const res = await client.request("tools/call", {
      name: "pi_worker_status",
      arguments: { taskId, waitSeconds: 15 },
    });
    assert.notEqual(res.result.isError, true, `status error: ${JSON.stringify(res.result)}`);
    const rec = res.result.structuredContent;
    console.log(
      `[${label} poll #${i}] status=${rec.status} round=${rec.roundCount} turns=${rec.turnCount} lastTool=${rec.lastTool ?? "-"} events=${rec.recentEvents.length}`,
    );
    if (rec.status !== "running") return rec;
  }
  throw new Error(`${label} timed out while still running`);
}

function inspectSessionFile(sessionDir, taskId) {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl") && f.includes(taskId));
  assert.equal(files.length, 1, `expected exactly 1 session file for ${taskId}, got ${JSON.stringify(files)}`);
  const fullPath = join(sessionDir, files[0]);
  const mode = statSync(fullPath).mode & 0o777;
  const lines = readFileSync(fullPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const messages = lines.filter((e) => e.type === "message").map((e) => e.message);
  const abortedCount = messages.filter((m) => m?.role === "assistant" && m?.stopReason === "aborted").length;
  return { fullPath, mode, lineCount: lines.length, messageCount: messages.length, abortedCount };
}

const { base, repoDir, stateDir } = createTempGitProject();
const client = startMcpServer(stateDir);
let passed = false;

try {
  console.log("=== 0. MCP Initialize & Tools Check ===");
  const initRes = await client.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initRes.result.serverInfo.name, "pi-worker");
  const toolsRes = await client.request("tools/list");
  console.log("Exposed tools:", toolsRes.result.tools.map((t) => t.name).join(", "));

  console.log("\n=== 1. Round 1: Start task with deliberate ambiguity (expect needs_input) ===");
  const startPrompt = [
    "任务目标：在 src/greet.mjs 中新增导出函数 formatUser(name)，并在 test.mjs 中补充对应单元测试，最后运行 `node --test test.mjs` 确认通过。",
    "锚点文件：src/greet.mjs、test.mjs。",
    "关键未决约束：formatUser(name) 的返回格式目前存在两个候选方案，规格尚未确认：",
    "- 方案 A：`Hello, <NAME>!`（name 转为全大写）",
    "- 方案 B：`hi <name>`（name 转为全小写）",
    "硬性要求：先阅读 src/greet.mjs 和 test.mjs，不要自行猜测或提前修改任何文件，必须立即调用 `worker_ask_parent` 工具询问父代理选择方案 A 还是方案 B，待父代理回复后再继续实施。",
  ].join("\n");

  const startRes = await client.request("tools/call", {
    name: "pi_worker_start",
    arguments: {
      cwd: repoDir,
      prompt: startPrompt,
      timeoutSeconds: 180,
      waitSeconds: 0,
    },
  });
  assert.notEqual(startRes.result.isError, true, `start failed: ${JSON.stringify(startRes.result)}`);
  const started = startRes.result.structuredContent;
  console.log("Started taskId:", started.taskId);

  const round1 = await pollUntilNotRunning(client, started.taskId, "Round1");
  console.log("Round 1 result:", JSON.stringify({
    status: round1.status,
    exitCode: round1.exitCode,
    stopReason: round1.stopReason,
    question: round1.question,
    options: round1.options,
    summary: round1.summary,
    gitChanges: round1.gitChanges,
    error: round1.error,
  }, null, 2));

  assert.equal(round1.status, "needs_input", `expected needs_input, got ${round1.status} (error=${round1.error})`);
  assert.equal(round1.exitCode, 0);
  assert.ok(round1.question && round1.question.length > 0);
  assert.deepEqual(round1.gitChanges, [], "Round 1 must not edit repo files before confirmation");

  const sess1 = inspectSessionFile(round1.sessionDir, round1.taskId);
  console.log("Round 1 session inspection:", sess1);
  assert.equal(sess1.mode, 0o600);
  assert.equal(sess1.abortedCount, 0, "terminate:true should prevent spurious aborted assistant message");

  console.log("\n=== 2. Round 2: Reply to resume same session (expect done + green tests) ===");
  const replyRes = await client.request("tools/call", {
    name: "pi_worker_reply",
    arguments: {
      taskId: round1.taskId,
      reply: "选择方案 A：`Hello, <NAME>!`（name 转为全大写，例如 formatUser('alice') === 'Hello, ALICE!'）。请立即在 src/greet.mjs 实现并导出 formatUser，在 test.mjs 补充单元测试，运行 `node --test test.mjs` 验证全部通过，然后调用 `worker_finish` 汇报结果。",
      timeoutSeconds: 180,
      waitSeconds: 0,
    },
  });
  assert.notEqual(replyRes.result.isError, true, `reply failed: ${JSON.stringify(replyRes.result)}`);

  const round2 = await pollUntilNotRunning(client, round1.taskId, "Round2");
  console.log("Round 2 result:", JSON.stringify({
    status: round2.status,
    roundCount: round2.roundCount,
    exitCode: round2.exitCode,
    stopReason: round2.stopReason,
    summary: round2.summary,
    verifiedCommands: round2.verifiedCommands,
    gitChanges: round2.gitChanges,
    error: round2.error,
  }, null, 2));

  assert.equal(round2.status, "done", `expected done, got ${round2.status} (error=${round2.error})`);
  assert.equal(round2.roundCount, 2);
  assert.equal(round2.exitCode, 0);
  assert.equal(round2.question, null);
  assert.ok(round2.gitChanges.some((l) => l.includes("src/greet.mjs")));
  assert.ok(round2.gitChanges.some((l) => l.includes("test.mjs")));

  const sess2 = inspectSessionFile(round2.sessionDir, round2.taskId);
  console.log("Round 2 session inspection:", sess2);
  assert.equal(sess2.fullPath, sess1.fullPath, "must resume the exact same session file");
  assert.ok(sess2.lineCount > sess1.lineCount, "session file must grow across resume");
  assert.equal(sess2.abortedCount, 0, "terminate:true should prevent spurious aborted assistant message");

  console.log("\n=== 3. Independent host verification of repo output & tests ===");
  const hostTestOut = execFileSync(process.execPath, ["--test", "test.mjs"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  console.log(hostTestOut.trim());
  const mod = await import(`file://${join(repoDir, "src", "greet.mjs")}`);
  assert.equal(mod.formatUser("alice"), "Hello, ALICE!");
  console.log("formatUser('alice') =>", mod.formatUser("alice"));

  passed = true;
  console.log("\n=== LIVE E2E PASSED ===");
} finally {
  const closed = await client.close();
  if (closed.stderr.trim()) {
    console.error("MCP server stderr:", closed.stderr.trim());
  }
  if (passed) {
    rmSync(base, { recursive: true, force: true });
  } else {
    console.error(`Kept failed E2E artifacts for diagnosis at: ${base}`);
  }
}
