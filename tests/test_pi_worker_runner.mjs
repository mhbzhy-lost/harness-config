import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PROTOCOL_APPEND_PROMPT, appendSteerEntry, readSteerEntries } from "../plugins/pi-worker/src/protocol.ts";
import { readFormattedEventsDelta } from "../plugins/pi-worker/src/stream.ts";
import {
  DEFAULT_EXCLUDE_TOOLS,
  MAX_TITLE_CHARS,
  PiWorkerRunner,
  READONLY_EXCLUDE_TOOLS,
  WORKER_BUILTIN_EXTENSIONS,
  WORKER_EXTENSION_PATH,
  WORKER_MANAGED_EXTENSIONS,
  discoverProjectContextFiles,
  extractTitleFromPrompt,
  resolvePiBinary,
  resolveWorkerExtensionArgs,
  sanitizeTaskTitle,
} from "../plugins/pi-worker/src/runner.ts";
import { TaskStore } from "../plugins/pi-worker/src/store.ts";

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_WORKER_DEPTH;
  delete env.PI_WORKER_AGY;
  delete env.PI_WORKER_DEFAULT_PROVIDER;
  delete env.PI_WORKER_DEFAULT_MODEL;
  delete env.PI_WORKER_DEFAULT_THINKING;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WORKER_TIER_")) delete env[key];
  }
  return { ...env, ...overrides };
}

function createFakePi(dir, recordFile) {
  const scriptPath = join(dir, "fake-pi.mjs");
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdinText = Buffer.concat(chunks).toString("utf8");

const record = {
  argv,
  stdin: stdinText,
  cwd: process.cwd(),
  env: {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD ?? null,
    PI_WORKER_DEPTH: process.env.PI_WORKER_DEPTH ?? null,
    PI_WORKER_OUTCOME_FILE: process.env.PI_WORKER_OUTCOME_FILE ?? null,
    PI_WORKER_STEER_FILE: process.env.PI_WORKER_STEER_FILE ?? null,
    PI_SESSION_OWNER_ID: process.env.PI_SESSION_OWNER_ID ?? null,
    PI_WORKER_AGY: process.env.PI_WORKER_AGY ?? null,
  },
};
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(record) + "\\n", "utf8");

const mode = process.env.FAKE_PI_SCENARIO || "two-round";

if (mode === "steer-e2e") {
  // 模拟长工具执行中消费 steer 队列：轮到 steer 后 echo 其正文并写 done 终态
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "s-1", toolName: "bash", args: { command: "long build" } }) + "\\n");
  const steerFile = process.env.PI_WORKER_STEER_FILE;
  const deadline = Date.now() + 15000;
  const timer = setInterval(() => {
    let entries = [];
    try {
      entries = readFileSync(steerFile, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* 队列尚未创建 */ }
    if (entries.length > 0) {
      clearInterval(timer);
      const msg = entries[0].message;
      process.stdout.write(JSON.stringify({ type: "queue_update", steering: [msg], followUp: [] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: msg }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "s-1", toolName: "bash", isError: false }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn_end" }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已按插话执行: " + msg }] },
      }) + "\\n");
      writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
        status: "done",
        summary: "已按插话执行: " + msg,
        question: null,
        options: [],
        verifiedCommands: [],
        stopReason: null,
        error: null,
      }), { mode: 0o600 });
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      process.stderr.write("steer-e2e timeout: no steer entry consumed\\n");
      process.exit(2);
    }
  }, 50);
} else if (mode === "sleep") {
  process.stdout.write("[startup] noisy line\\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\\n");
  setInterval(() => {}, 1000);
} else if (mode === "fail-then-succeed") {
  const lines = readFileSync(${JSON.stringify(recordFile)}, "utf8").trim().split("\\n");
  if (lines.length === 1) {
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "503 transient", content: [] },
    }) + "\\n");
    process.exit(0);
  }
  writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
    status: "done",
    summary: "重试后成功",
    question: null,
    options: [],
    verifiedCommands: ["node --test"],
    stopReason: null,
    error: null,
  }), { mode: 0o600 });
  process.exit(0);
} else if (mode === "sleep-then-resume") {
  if (stdinText.includes("sleep first")) {
    setInterval(() => {}, 1000);
  } else {
    writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
      status: "done",
      summary: "取消后续跑完成",
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: null,
      error: null,
    }), { mode: 0o600 });
    process.exit(0);
  }
} else if (mode === "error-exit-zero") {
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests", content: [] },
  }) + "\\n");
  process.exit(0);
} else if (mode === "two-round") {
  const lines = readFileSync(${JSON.stringify(recordFile)}, "utf8").trim().split("\\n");
  const round = lines.length;
  process.stdout.write("[antigravity] non-json startup noise\\n");
  process.stdout.write(JSON.stringify({ type: "session", id: argv[argv.indexOf("--session-id") + 1], cwd: process.cwd() }) + "\\n");
  if (round === 1) {
    process.stdout.write(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "b-r1-1",
      toolName: "bash",
      args: { command: "git status --short" },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "b-r1-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "M src/index.ts" }] },
    }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "b-r2-1",
      toolName: "bash",
      args: { command: "node --test" },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "b-r2-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "ok 1" }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "b-r2-2",
      toolName: "bash",
      args: { command: "npm run lint" },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "b-r2-2",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "lint failed" }] },
    }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "turn_end" }) + "\\n");
  if (round === 1) {
    writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
      status: "needs_input",
      summary: "已完成前期检查",
      question: "选方案 A 还是 B？",
      options: ["A", "B"],
      verifiedCommands: [],
      stopReason: null,
      error: null,
    }), { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted", content: [] },
    }) + "\\n");
  } else {
    writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
      status: "done",
      summary: "已按方案 A 实施并验收通过",
      question: null,
      options: [],
      verifiedCommands: ["node --test"],
      stopReason: null,
      error: null,
    }), { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    }) + "\\n");
  }
  process.exit(0);
}
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("test_start_needs_input_then_reply_resumes_same_session_via_stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-run-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    const store = new TaskStore(stateDir);
    const runner = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({
        PI_SESSION_OWNER_ID: "should-be-stripped",
        PI_WORKER_AGY: "1",
        FAKE_PI_SCENARIO: "two-round",
      }),
    });

    const first = await runner.start({
      cwd: workDir,
      prompt: "- 检查 @src/index.ts 中的边界问题",
      excludeTools: ["write"],
      waitSeconds: 5,
    });
    assert.equal(first.status, "needs_input");
    assert.equal(first.question, "选方案 A 还是 B？");
    assert.deepEqual(first.options, ["A", "B"]);
    assert.equal(first.roundCount, 1);
    assert.equal(first.turnCount, 1);
    assert.equal(first.executedCommands.length, 1);
    assert.equal(first.executedCommands[0].round, 1);
    assert.equal(first.executedCommands[0].command, "git status --short");
    assert.equal(first.executedCommands[0].isError, false);
    assert.ok(first.executedCommands[0].startSeq < first.executedCommands[0].endSeq);

    const second = await runner.reply({
      taskId: first.taskId,
      reply: "@confirm 选方案 A",
      waitSeconds: 5,
    });
    assert.equal(second.status, "done");
    assert.equal(second.roundCount, 2);
    assert.equal(second.question, null);
    assert.deepEqual(second.verifiedCommands, ["node --test"]);
    // executedCommands 独立于 worker_finish 自述，客观记录本轮全部真实 bash 命令（含失败项）且重置上一轮记录
    assert.equal(second.executedCommands.length, 2);
    assert.deepEqual(
      second.executedCommands.map((c) => ({ round: c.round, command: c.command, isError: c.isError })),
      [
        { round: 2, command: "node --test", isError: false },
        { round: 2, command: "npm run lint", isError: true },
      ],
    );
    assert.ok(second.executedCommands.every((c) => c.startSeq < c.endSeq));

    const records = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(records.length, 2);

    const [r1, r2] = records;
    for (const r of [r1, r2]) {
      assert.ok(r.argv.includes("--mode"));
      assert.equal(r.argv[r.argv.indexOf("--mode") + 1], "json");
      assert.ok(r.argv.includes("--print"));
      assert.ok(!r.argv.includes("-c") && !r.argv.includes("--continue") && !r.argv.includes("--session"));
      assert.equal(r.argv[r.argv.indexOf("--session-dir") + 1], join(stateDir, "sessions"));
      assert.equal(r.argv[r.argv.indexOf("--session-id") + 1], first.taskId);
      // 扩展白名单：最后一项 -e 固定为 worker-ext.ts；协议 prompt 为最后一个 --append-system-prompt
      assert.equal(r.argv[r.argv.lastIndexOf("-e") + 1], WORKER_EXTENSION_PATH);
      assert.equal(r.argv[r.argv.lastIndexOf("--append-system-prompt") + 1], PROTOCOL_APPEND_PROMPT);
      const excluded = r.argv[r.argv.indexOf("--exclude-tools") + 1].split(",");
      for (const tool of [...DEFAULT_EXCLUDE_TOOLS, "write"]) {
        assert.ok(excluded.includes(tool), `missing excluded tool: ${tool}`);
      }
      assert.equal(r.env.PI_SUBAGENT_CHILD, "1");
      assert.equal(r.env.PI_WORKER_DEPTH, "1");
      assert.equal(r.env.PI_SESSION_OWNER_ID, null);
      assert.equal(r.env.PI_WORKER_AGY, null);
    }
    assert.equal(r1.stdin, "- 检查 @src/index.ts 中的边界问题");
    assert.equal(r2.stdin, "@confirm 选方案 A");
    assert.equal(
      r1.argv[r1.argv.lastIndexOf("--append-system-prompt") + 1],
      r2.argv[r2.argv.lastIndexOf("--append-system-prompt") + 1],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_fallback_when_outcome_file_missing_catches_error_stop_reason_on_exit_zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-err-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "error-exit-zero" }),
    });

    const rec = await runner.start({ cwd: workDir, prompt: "do work", waitSeconds: 5 });
    assert.equal(rec.status, "failed");
    assert.equal(rec.stopReason, "error");
    assert.match(rec.error ?? "", /429 Too Many Requests/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_rejects_provider_without_model_and_recursive_env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-guard-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));

    const normalRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv(),
    });
    await assert.rejects(
      () => normalRunner.start({ cwd: workDir, prompt: "hi", provider: "openai" }),
      /provider.*model/i,
    );

    const depthRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-depth")),
      piBinary: fakePi,
      env: cleanEnv({ PI_WORKER_DEPTH: "1" }),
    });
    await assert.rejects(
      () => depthRunner.start({ cwd: workDir, prompt: "hi" }),
      /嵌套|递归/,
    );

    const childRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-child")),
      piBinary: fakePi,
      env: cleanEnv({ PI_SUBAGENT_CHILD: "1" }),
    });
    await assert.rejects(
      () => childRunner.start({ cwd: workDir, prompt: "hi" }),
      /嵌套|递归/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_concurrent_cwd_lock_cancel_semantics_and_no_finalizing_orphan_race", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-lock-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const aliasDir = join(dir, "repo-link");
    symlinkSync(workDir, aliasDir);

    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });

    const running = await runner.start({ cwd: workDir, prompt: "long job", waitSeconds: 0 });
    assert.equal(running.status, "running");

    // 同一 cwd 的软链别名也必须被并发写锁拒绝
    await assert.rejects(
      () => runner.start({ cwd: aliasDir, prompt: "second job", waitSeconds: 0 }),
      /并发|运行中/,
    );

    const cancelled = await runner.cancel({ taskId: running.taskId });
    assert.equal(cancelled.wasRunning, true);
    assert.equal(cancelled.task.status, "cancelled");

    // 已终态再次 cancel 保持原状态且 wasRunning 为 false
    const cancelAgain = await runner.cancel({ taskId: running.taskId });
    assert.equal(cancelAgain.wasRunning, false);
    assert.equal(cancelAgain.task.status, "cancelled");

    // 取消后可重新启动（快速退出场景检验不误报 orphan_process）
    const fastRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });
    const quick = await fastRunner.start({ cwd: workDir, prompt: "quick", waitSeconds: 0 });
    const finalStatus = await fastRunner.status({ taskId: quick.taskId, waitSeconds: 5 });
    assert.equal(finalStatus.status, "needs_input");
    assert.notEqual(finalStatus.error, "orphan_process");

    // 对 needs_input 取消应转为 cancelled 且 wasRunning 为 false
    const cancelPending = await fastRunner.cancel({ taskId: quick.taskId });
    assert.equal(cancelPending.wasRunning, false);
    assert.equal(cancelPending.task.status, "cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cancel_terminates_detached_process_group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-cancel-pg-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });

    const started = await runner.start({ cwd: workDir, prompt: "hang", waitSeconds: 0 });
    assert.equal(started.status, "running");
    assert.ok(started.pid && started.pid > 0);

    const cancelled = await runner.cancel({ taskId: started.taskId });
    assert.equal(cancelled.wasRunning, true);
    assert.equal(cancelled.task.status, "cancelled");
    assert.throws(() => process.kill(started.pid, 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_resolve_pi_binary_skips_symlink_to_launcher_zsh", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-bin-"));
  try {
    const piDir = join(dir, "repo", "pi");
    const firstBinDir = join(dir, "bin1");
    const secondBinDir = join(dir, "bin2");
    mkdirSync(piDir, { recursive: true });
    mkdirSync(firstBinDir, { recursive: true });
    mkdirSync(secondBinDir, { recursive: true });

    const launcher = join(piDir, "launcher.zsh");
    writeFileSync(launcher, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
    chmodSync(launcher, 0o755);
    symlinkSync(launcher, join(firstBinDir, "pi"));

    const realPi = join(secondBinDir, "pi");
    writeFileSync(realPi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(realPi, 0o755);

    const resolved = resolvePiBinary({
      PATH: `${firstBinDir}:${secondBinDir}`,
      HOME: join(dir, "empty-home"),
    });
    assert.equal(resolved, realPi);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cross_process_cancel_waits_for_detached_pid_exit_before_releasing_lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-xproc-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const stateDir = join(dir, "state");
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));

    // Runner 1 启动一个长睡 detached 子进程
    const runner1 = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    const started = await runner1.start({ cwd: workDir, prompt: "sleep", waitSeconds: 0 });
    assert.equal(started.status, "running");
    assert.ok(started.pid && started.pid > 0);

    // 模拟另一个独立的 MCP Server 进程（不持有 runner1 内存 active 表）执行 cancel
    const runner2 = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    const res = await runner2.cancel({ taskId: started.taskId });
    assert.equal(res.wasRunning, true);
    assert.equal(res.task.status, "cancelled");

    // 关键：cancel 返回时目标进程必须已经真正退出（process.kill(pid, 0) 抛 ESRCH）
    assert.throws(() => process.kill(started.pid, 0));

    // 等待 runner1 内部收尾后清理
    await runner1.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cancel_during_finalizing_does_not_overwrite_completed_task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-fin-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));

    let enteredGitStatus;
    const gitStatusStarted = new Promise((r) => { enteredGitStatus = r; });
    let releaseGitStatus;
    const gitStatusGate = new Promise((r) => { releaseGitStatus = r; });

    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
      collectGitChanges: async () => {
        enteredGitStatus();
        await gitStatusGate;
        return [" M file.ts"];
      },
    });

    const started = await runner.start({ cwd: workDir, prompt: "fast exit", waitSeconds: 0 });
    await gitStatusStarted;

    // 此时子进程已退出并进入 finalizing（正在等 collectGitChanges）
    const cancelPromise = runner.cancel({ taskId: started.taskId });
    releaseGitStatus();
    const cancelResult = await cancelPromise;

    assert.equal(cancelResult.wasRunning, false);
    assert.equal(cancelResult.task.status, "needs_input");
    assert.deepEqual(cancelResult.task.gitChanges, [" M file.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_reply_overrides_model_thinking_and_resumes_failed_and_cancelled_tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-resume-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    // 1. failed 状态续跑并覆盖 provider/model/thinking
    const failRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-fail")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "fail-then-succeed" }),
    });
    const failed = await failRunner.start({ cwd: workDir, prompt: "first try", waitSeconds: 5 });
    assert.equal(failed.status, "failed");

    // 仅传 provider 且无既有/新传 model 必须报错
    await assert.rejects(
      () => failRunner.reply({ taskId: failed.taskId, reply: "bad", provider: "zai-coding-cn" }),
      /provider.*model/i,
    );

    const retried = await failRunner.reply({
      taskId: failed.taskId,
      reply: "retry with lower thinking",
      provider: "zai-coding-cn",
      model: "glm-5.4",
      thinking: "low",
      waitSeconds: 5,
    });
    assert.equal(retried.status, "done");
    assert.equal(retried.roundCount, 2);
    assert.equal(retried.error, null);
    assert.equal(retried.provider, "zai-coding-cn");
    assert.equal(retried.model, "glm-5.4");
    assert.equal(retried.thinking, "low");

    const records = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const r2 = records[1];
    assert.equal(r2.argv[r2.argv.indexOf("--provider") + 1], "zai-coding-cn");
    assert.equal(r2.argv[r2.argv.indexOf("--model") + 1], "glm-5.4");
    assert.equal(r2.argv[r2.argv.indexOf("--thinking") + 1], "low");

    // 2. cancelled 状态续跑并覆盖 thinking
    const cancelRecordFile = join(dir, "cancel-invocations.jsonl");
    const cancelFakePi = createFakePi(dir, cancelRecordFile);
    const cancelRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-cancel")),
      piBinary: cancelFakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep-then-resume" }),
    });
    const started = await cancelRunner.start({ cwd: workDir, prompt: "sleep first", waitSeconds: 0 });
    const cancelled = await cancelRunner.cancel({ taskId: started.taskId });
    assert.equal(cancelled.task.status, "cancelled");

    const resumed = await cancelRunner.reply({
      taskId: started.taskId,
      reply: "continue now",
      thinking: "minimal",
      waitSeconds: 5,
    });
    assert.equal(resumed.status, "done");
    assert.equal(resumed.roundCount, 2);
    assert.equal(resumed.thinking, "minimal");
    const cancelRecords = readFileSync(cancelRecordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const lastCancelRecord = cancelRecords[cancelRecords.length - 1];
    assert.equal(lastCancelRecord.argv[lastCancelRecord.argv.indexOf("--thinking") + 1], "minimal");
    await cancelRunner.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_wait_until_settled_blocks_until_round_finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-settled-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });

    const first = await runner.start({ cwd: workDir, prompt: "go", waitUntilSettled: true });
    assert.equal(first.status, "needs_input");

    const second = await runner.reply({ taskId: first.taskId, reply: "A", waitUntilSettled: true });
    assert.equal(second.status, "done");
    assert.equal(second.roundCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_start_applies_default_model_config_with_env_and_explicit_precedence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-default-model-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    const store = new TaskStore(stateDir);
    writeFileSync(
      store.configPath,
      JSON.stringify({ provider: "zai-coding-cn", model: "glm-5.4", thinking: "high" }),
      "utf8",
    );

    // 1. start 省略模型参数时读取 config.json 默认值
    const runner1 = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });
    const t1 = await runner1.start({ cwd: workDir, prompt: "use file defaults", waitUntilSettled: true });
    assert.equal(t1.provider, "zai-coding-cn");
    assert.equal(t1.model, "glm-5.4");
    assert.equal(t1.thinking, "high");

    // 2. 显式仅传 model 时不混用 config.json 默认 provider，仍继承默认 thinking
    const t2 = await runner1.start({ cwd: workDir, prompt: "explicit model", model: "openai/gpt-4o", waitUntilSettled: true });
    assert.equal(t2.provider, undefined);
    assert.equal(t2.model, "openai/gpt-4o");
    assert.equal(t2.thinking, "high");

    // 3. 环境变量覆盖 config.json 默认值
    const runner2 = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({
        FAKE_PI_SCENARIO: "two-round",
        PI_WORKER_DEFAULT_PROVIDER: "qoder-pool",
        PI_WORKER_DEFAULT_MODEL: "GLM-5.3",
        PI_WORKER_DEFAULT_THINKING: "low",
      }),
    });
    const t3 = await runner2.start({ cwd: workDir, prompt: "use env defaults", waitUntilSettled: true });
    assert.equal(t3.provider, "qoder-pool");
    assert.equal(t3.model, "GLM-5.3");
    assert.equal(t3.thinking, "low");

    const records = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(records.length, 3);
    assert.equal(records[0].argv[records[0].argv.indexOf("--provider") + 1], "zai-coding-cn");
    assert.equal(records[0].argv[records[0].argv.indexOf("--model") + 1], "glm-5.4");
    assert.equal(records[0].argv[records[0].argv.indexOf("--thinking") + 1], "high");
    assert.equal(records[1].argv.includes("--provider"), false);
    assert.equal(records[1].argv[records[1].argv.indexOf("--model") + 1], "openai/gpt-4o");
    assert.equal(records[2].argv[records[2].argv.indexOf("--provider") + 1], "qoder-pool");
    assert.equal(records[2].argv[records[2].argv.indexOf("--model") + 1], "GLM-5.3");
    assert.equal(records[2].argv[records[2].argv.indexOf("--thinking") + 1], "low");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_tier_resolution_reply_switch_and_readonly_concurrency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-tier-ro-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    const store = new TaskStore(stateDir);
    writeFileSync(
      store.configPath,
      JSON.stringify({
        default: { provider: "zai-coding-cn", model: "glm-5.4", thinking: "medium" },
        tiers: {
          fast: { provider: "zai-coding-cn", model: "glm-5.3-flash", thinking: "low" },
        },
      }),
      "utf8",
    );

    const runner = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });

    // 1. fast 档位 + readOnly 禁用 write/edit 并追加只读提示
    const fastRo = await runner.start({
      cwd: workDir,
      prompt: "inspect codebase",
      tier: "fast",
      readOnly: true,
      waitUntilSettled: true,
    });
    assert.equal(fastRo.tier, "fast");
    assert.equal(fastRo.readOnly, true);
    assert.equal(fastRo.provider, "zai-coding-cn");
    assert.equal(fastRo.model, "glm-5.3-flash");
    assert.equal(fastRo.thinking, "low");
    for (const tool of READONLY_EXCLUDE_TOOLS) {
      assert.ok(fastRo.excludeTools.includes(tool), `readOnly must exclude ${tool}`);
    }

    // 2. reply 可切换 tier（heavy 未配置时自动回退 default）
    const upgraded = await runner.reply({
      taskId: fastRo.taskId,
      reply: "deep review",
      tier: "heavy",
      waitUntilSettled: true,
    });
    assert.equal(upgraded.tier, "heavy");
    assert.equal(upgraded.provider, "zai-coding-cn");
    assert.equal(upgraded.model, "glm-5.4");
    assert.equal(upgraded.thinking, "medium");

    const records = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.match(records[0].argv[records[0].argv.lastIndexOf("--append-system-prompt") + 1], /只读模式/);
    assert.equal(records[0].argv[records[0].argv.indexOf("--model") + 1], "glm-5.3-flash");
    assert.equal(records[1].argv[records[1].argv.indexOf("--model") + 1], "glm-5.4");

    // 3. 同一 cwd 支持多路 readOnly=true 任务并发运行（不互相抢写锁）
    const sleepRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-concurrent")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    const ro1 = await sleepRunner.start({ cwd: workDir, prompt: "ro-1", readOnly: true, waitSeconds: 0 });
    const ro2 = await sleepRunner.start({ cwd: workDir, prompt: "ro-2", readOnly: true, waitSeconds: 0 });
    assert.equal(ro1.status, "running");
    assert.equal(ro2.status, "running");
    await sleepRunner.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_title_sanitization_and_prompt_first_line_extraction", () => {
  assert.equal(MAX_TITLE_CHARS, 48);
  // 清洗：去首尾空白、合并换行/连续空白
  assert.equal(sanitizeTaskTitle("  修复\n  登录   崩溃  "), "修复 登录 崩溃");
  assert.equal(sanitizeTaskTitle("   "), undefined);
  assert.equal(sanitizeTaskTitle(42), undefined);
  assert.equal(sanitizeTaskTitle(undefined), undefined);
  // 截断到 48 字 + 省略号
  assert.equal(sanitizeTaskTitle("字".repeat(60)), `${"字".repeat(48)}…`);
  assert.equal(sanitizeTaskTitle("字".repeat(48)), "字".repeat(48));

  // prompt 首条有意义行：剥离 Markdown/列表/编号/引用/常见任务前缀，跳过分隔线
  assert.equal(extractTitleFromPrompt("\n---\n# 任务目标：修复监控面板\n\n细节"), "修复监控面板");
  assert.equal(extractTitleFromPrompt("- 只读调研：分析崩溃根因"), "分析崩溃根因");
  assert.equal(extractTitleFromPrompt("1. 第一条有意义行\nsecond"), "第一条有意义行");
  assert.equal(extractTitleFromPrompt("> 引用行内容"), "引用行内容");
  assert.equal(extractTitleFromPrompt("```\n---\n"), undefined);
  assert.equal(extractTitleFromPrompt(""), undefined);
  assert.equal(extractTitleFromPrompt("任务目标："), undefined);
  assert.equal(extractTitleFromPrompt(`# ${"长".repeat(60)}`), `${"长".repeat(48)}…`);
});

test("test_start_persists_explicit_title_and_auto_extracted_title_and_parent_session_title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-run-title-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);
    const store = new TaskStore(stateDir);
    const runner = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });

    // 显式 title 优先，且与 parentSessionTitle 一并清洗落盘
    const explicit = await runner.start({
      cwd: workDir,
      prompt: "# 任务目标：不应被用作标题\n其余说明",
      title: "  显式\n 标题 ",
      parentSessionId: "conv-title",
      parentSessionTitle: " 父会话\n标题 ",
      waitSeconds: 5,
    });
    assert.equal(explicit.title, "显式 标题");
    assert.equal(explicit.parentSessionTitle, "父会话 标题");
    const loaded = store.load(explicit.taskId);
    assert.equal(loaded.title, "显式 标题");
    assert.equal(loaded.parentSessionTitle, "父会话 标题");

    // reply 续跑保留标题字段
    const resumed = await runner.reply({ taskId: explicit.taskId, reply: "@confirm 继续", waitSeconds: 5 });
    assert.equal(resumed.status, "done");
    assert.equal(resumed.title, "显式 标题");
    assert.equal(resumed.parentSessionTitle, "父会话 标题");

    // 未显式传 title：自动从 prompt 首条有意义行提取；未传 parentSessionTitle 则不落盘
    const auto = await runner.start({
      cwd: workDir,
      prompt: "\n---\n任务目标：自动提取标题\n后续细节",
      parentSessionId: "conv-title",
      waitSeconds: 5,
    });
    assert.equal(auto.title, "自动提取标题");
    assert.equal(auto.parentSessionTitle, undefined);
    assert.equal("parentSessionTitle" in store.load(auto.taskId), false);

    // list 摘要携带 title
    const summary = store.list({ parentSessionId: "conv-title" }).find((t) => t.taskId === auto.taskId);
    assert.equal(summary.title, "自动提取标题");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_steer_queues_entry_writes_event_and_fake_pi_consumes_end_to_end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-steer-e2e-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);
    const store = new TaskStore(stateDir);
    const progressEvents = [];
    const runner = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "steer-e2e" }),
    });

    const started = await runner.start({
      cwd: workDir,
      prompt: "long job",
      waitSeconds: 0,
      onProgress: (ev) => progressEvents.push(ev),
    });
    assert.equal(started.status, "running");
    assert.equal(started.steerPath, join(stateDir, "steers", `${started.taskId}.jsonl`));

    const res = await runner.steer({ taskId: started.taskId, message: "改用方案 B 并补测试", source: "agent" });
    assert.equal(res.queued, true);
    assert.equal(res.status, "running");
    assert.equal(res.taskId, started.taskId);
    assert.equal(res.message, "改用方案 B 并补测试");
    assert.equal(res.source, "agent");
    assert.ok(res.steerId);
    assert.ok(res.queuedAt);

    // 磁盘队列条目与入队回执一致
    const entries = readSteerEntries(started.steerPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, res.steerId);
    assert.equal(entries[0].message, "改用方案 B 并补测试");
    assert.equal(entries[0].source, "agent");

    // eventsPath 立即出现统一格式的 steer 事件，且进程内 onProgress 同步收到
    const delta = readFormattedEventsDelta(started.eventsPath, 0);
    const steerEvents = delta.events.filter((ev) => ev.kind === "steer");
    assert.equal(steerEvents.length, 1);
    assert.match(steerEvents[0].title, /主代理/);
    assert.equal(steerEvents[0].detail, "改用方案 B 并补测试");
    assert.ok(progressEvents.some((ev) => ev.kind === "steer" && ev.detail === "改用方案 B 并补测试"));

    // 假 Pi 消费 steer 后继续执行并正常结束（端到端注入闭环）
    const final = await runner.status({ taskId: started.taskId, waitSeconds: 15 });
    assert.equal(final.status, "done");
    assert.match(final.summary ?? "", /已按插话执行: 改用方案 B 并补测试/);

    // 子进程 env 收到 PI_WORKER_STEER_FILE；queue_update 等未知事件不产生乱码条目
    const records = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(records[0].env.PI_WORKER_STEER_FILE, started.steerPath);
    const allEvents = readFormattedEventsDelta(started.eventsPath, 0, { maxEvents: 500 }).events;
    assert.equal(allEvents.some((ev) => ev.kind === "other"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_steer_rejects_non_running_and_invalid_input_and_supports_cross_process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-steer-guard-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));

    // 参数校验
    const runner = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    await assert.rejects(() => runner.steer({ taskId: "  ", message: "x" }), /taskId 不能为空/);
    await assert.rejects(() => runner.steer({ taskId: "some-task", message: "   " }), /message 不能为空/);

    // 跨进程：runner1 启动 detached 长睡任务，runner2（无内存 active 表）steer 成功入队
    const runner1 = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    const started = await runner1.start({ cwd: workDir, prompt: "sleep", waitSeconds: 0 });
    assert.equal(started.status, "running");

    const runner2 = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });
    const res = await runner2.steer({ taskId: started.taskId, message: "面板纠偏", source: "app" });
    assert.equal(res.queued, true);
    assert.equal(res.source, "app");
    const entries = readSteerEntries(started.steerPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, "app");
    const delta = readFormattedEventsDelta(started.eventsPath, 0, { maxEvents: 500 });
    const steerEv = delta.events.find((ev) => ev.kind === "steer");
    assert.ok(steerEv);
    assert.match(steerEv.title, /面板/);

    await runner1.shutdown();

    // 非运行态（cancelled）拒绝 steer 并引导 pi_worker_reply
    await assert.rejects(
      () => runner2.steer({ taskId: started.taskId, message: "迟到插话" }),
      /非运行中无法实时插话.*pi_worker_reply/s,
    );

    // needs_input 同样拒绝
    const twoRunner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state-two")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });
    const pending = await twoRunner.start({ cwd: workDir, prompt: "go", waitSeconds: 5 });
    assert.equal(pending.status, "needs_input");
    await assert.rejects(
      () => twoRunner.steer({ taskId: pending.taskId, message: "插话" }),
      /needs_input.*pi_worker_reply/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_launch_round_clears_stale_steer_queue_before_reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-steer-clean-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });

    const first = await runner.start({ cwd: workDir, prompt: "go", waitSeconds: 5 });
    assert.equal(first.status, "needs_input");

    // 上一轮残留的失效 steer：reply 启动前必须被清理，不得误触发新一轮
    appendSteerEntry(first.steerPath, { id: "stale", message: "过期插话", createdAt: "old" });
    assert.equal(readSteerEntries(first.steerPath).length, 1);

    const second = await runner.reply({ taskId: first.taskId, reply: "A", waitSeconds: 5 });
    assert.equal(second.status, "done");
    assert.deepEqual(readSteerEntries(first.steerPath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_launch_round_save_failure_rolls_back_child_process_and_releases_lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-save-fail-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const fakePi = createFakePi(dir, join(dir, "invocations.jsonl"));
    const store = new TaskStore(stateDir);
    store.save = () => {
      throw new Error("simulated disk full");
    };
    const runner = new PiWorkerRunner({
      store,
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "sleep" }),
    });

    await assert.rejects(
      () => runner.start({ cwd: workDir, prompt: "should rollback", waitSeconds: 0 }),
      /simulated disk full/,
    );

    // 写锁必须已被释放（locks 目录无残留 .lock）
    const lockFiles = readdirSync(join(stateDir, "locks")).filter((n) => n.endsWith(".lock"));
    assert.deepEqual(lockFiles, []);
    // 同一 cwd 可立即由正常 runner 启动，无残留冲突
    const okRunner = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });
    const started = await okRunner.start({ cwd: workDir, prompt: "after rollback", waitSeconds: 5 });
    assert.equal(started.status, "needs_input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_exit_with_grandchild_holding_stdio_kills_pgid_and_releases_lock_after_grace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-grandchild-"));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const grandchildPidFile = join(dir, "grandchild.pid");
    const scriptPath = join(dir, "fake-pi-grandchild.mjs");
    writeFileSync(scriptPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
const gc = spawn("sleep", ["20"], { stdio: "inherit" });
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid), "utf8");
writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
  status: "done",
  summary: "main exited while grandchild held stdio",
  question: null,
  options: [],
  verifiedCommands: [],
  stopReason: null,
  error: null,
}), { mode: 0o600 });
process.exit(0);
`, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);

    const store = new TaskStore(stateDir);
    const runner = new PiWorkerRunner({
      store,
      piBinary: scriptPath,
      pipeDrainGraceMs: 150,
      env: cleanEnv(),
    });

    const t0 = Date.now();
    const settled = await runner.start({
      cwd: workDir,
      prompt: "spawn grandchild",
      waitUntilSettled: true,
    });
    const elapsedMs = Date.now() - t0;
    assert.equal(settled.status, "done");
    assert.ok(elapsedMs < 3000, `expected grace timeout to settle quickly, took ${elapsedMs}ms`);

    // 孙进程组必须已被 SIGKILL 清理，且 cwd 写锁已释放
    const gcPid = Number(readFileSync(grandchildPidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(gcPid) && gcPid > 0);
    assert.throws(() => process.kill(gcPid, 0));
    const lockFiles = readdirSync(join(stateDir, "locks")).filter((n) => n.endsWith(".lock"));
    assert.deepEqual(lockFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cross_process_cancel_skips_signal_when_pid_signature_mismatches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-xproc-sig-"));
  let dummy;
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    assert.ok(dummy.pid && dummy.pid > 0);

    const store = new TaskStore(stateDir);
    const taskId = "55555555-5555-4555-8555-555555555555";
    const paths = store.allocateTaskPaths(taskId);
    const now = new Date().toISOString();
    store.acquireCwdLock(workDir, { taskId, ownerPid: 99999999 });
    store.save({
      taskId,
      cwd: workDir,
      sessionDir: paths.sessionDir,
      logPath: paths.logPath,
      eventsPath: paths.eventsPath,
      outcomePath: paths.outcomePath,
      steerPath: paths.steerPath,
      status: "running",
      pid: dummy.pid,
      pidSignature: "Mon Jan 01 00:00:00 1990",
      excludeTools: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      turnCount: 0,
      roundCount: 1,
      lastTool: null,
      recentEvents: [],
      summary: null,
      question: null,
      options: [],
      verifiedCommands: [],
      executedCommands: [],
      stopReason: null,
      exitCode: null,
      error: null,
      gitChanges: [],
    });

    const runner = new PiWorkerRunner({ store, env: cleanEnv() });
    const res = await runner.cancel({ taskId });
    assert.equal(res.task.status, "cancelled");
    assert.equal(res.task.pid, null);
    // 无关进程组不得被误杀
    assert.doesNotThrow(() => process.kill(dummy.pid, 0));
    const lockFiles = readdirSync(join(stateDir, "locks")).filter((n) => n.endsWith(".lock"));
    assert.deepEqual(lockFiles, []);
  } finally {
    if (dummy?.pid) {
      try { dummy.kill("SIGKILL"); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_build_child_env_strips_diagnostic_node_options", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-node-opts-"));
  try {
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const outFile = join(dir, "child-node-opts.txt");
    const scriptPath = join(dir, "fake-pi-opts.mjs");
    writeFileSync(scriptPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(outFile)}, process.env.NODE_OPTIONS ?? "__UNSET__", "utf8");
writeFileSync(process.env.PI_WORKER_OUTCOME_FILE, JSON.stringify({
  status: "done",
  summary: "ok",
  question: null,
  options: [],
  verifiedCommands: [],
  stopReason: null,
  error: null,
}), { mode: 0o600 });
process.exit(0);
`, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);

    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: scriptPath,
      env: cleanEnv({
        NODE_OPTIONS: '--max-old-space-size=4096 --heapsnapshot-near-heap-limit=2 --diagnostic-dir="/tmp/my diag dir" --enable-source-maps',
      }),
    });
    const rec = await runner.start({ cwd: workDir, prompt: "check opts", waitUntilSettled: true });
    assert.equal(rec.status, "done");
    const childOpts = readFileSync(outFile, "utf8");
    assert.doesNotMatch(childOpts, /--heapsnapshot-near-heap-limit/);
    assert.doesNotMatch(childOpts, /--diagnostic-dir/);
    assert.match(childOpts, /--max-old-space-size=4096/);
    assert.match(childOpts, /--enable-source-maps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 收集 argv 中某个可重复选项的全部取值（如 `-e`、`--append-system-prompt`） */
function collectOptionValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) values.push(argv[i + 1]);
  }
  return values;
}

test("test_build_args_uses_strict_extension_whitelist_and_no_context_files", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ext-allow-")));
  try {
    const stateDir = join(dir, "state");
    const workDir = join(dir, "repo");
    mkdirSync(workDir, { recursive: true });
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    const runner = new PiWorkerRunner({
      store: new TaskStore(stateDir),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round" }),
    });
    await runner.start({ cwd: workDir, prompt: "检查边界", waitSeconds: 5 });

    const [record] = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const argv = record.argv;

    // 1. 严格白名单与上下文隔离开关
    assert.ok(argv.includes("--no-extensions"));
    assert.ok(argv.includes("--no-context-files"));
    assert.ok(argv.includes("--exclude-tools"));
    for (const tool of DEFAULT_EXCLUDE_TOOLS) {
      assert.ok(argv[argv.indexOf("--exclude-tools") + 1].split(",").includes(tool));
    }

    // 2. -e 白名单：内置 → pi-dcp（与 pi/settings.json 锁版一致）→ 仓内受管扩展 → worker-ext.ts
    const exts = collectOptionValues(argv, "-e");
    assert.deepEqual(exts.slice(0, WORKER_BUILTIN_EXTENSIONS.length), [...WORKER_BUILTIN_EXTENSIONS]);
    const settings = JSON.parse(readFileSync(resolve(import.meta.dirname, "../pi/settings.json"), "utf8"));
    const dcpSpec = settings.packages.find((p) => typeof p === "string" && p.includes("pi-dcp"));
    assert.ok(dcpSpec, "pi/settings.json 应锁定 pi-dcp 包");
    assert.equal(exts[WORKER_BUILTIN_EXTENSIONS.length], dcpSpec);
    const managed = exts.slice(WORKER_BUILTIN_EXTENSIONS.length + 1, -1);
    assert.deepEqual(managed, [...WORKER_MANAGED_EXTENSIONS].map((name) =>
      resolve(import.meta.dirname, "../pi/extensions", name, `${name}.ts`)));
    assert.equal(exts.at(-1), WORKER_EXTENSION_PATH);
    assert.equal(new Set(exts).size, exts.length);

    // 3. 明确排除交互式/TUI/子代理扩展
    for (const forbidden of [
      "builtin:llama.cpp",
      "ask-user-question",
      "bash-async",
      "compact-tools",
      "pi/extensions/dcp/dcp.ts",
      "session-owner",
      "tui-lite",
      "pi-core-ask",
      "pi-subagents",
    ]) {
      assert.ok(!exts.some((e) => e.includes(forbidden)), `must not load ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_resolve_worker_extension_args_with_injected_repo_root_skips_missing", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ext-root-")));
  try {
    // 临时仓根：无 pi/settings.json、仅存在一个受管扩展 → 安全跳过其余项
    mkdirSync(join(dir, "pi", "extensions", "bash-cwd"), { recursive: true });
    writeFileSync(join(dir, "pi", "extensions", "bash-cwd", "bash-cwd.ts"), "", "utf8");
    const args = resolveWorkerExtensionArgs(dir);
    assert.deepEqual(args, [
      "--no-extensions",
      "-e", "builtin:mcp",
      "-e", "builtin:codemode",
      "-e", "builtin:tool-search",
      "-e", join(dir, "pi", "extensions", "bash-cwd", "bash-cwd.ts"),
      "-e", WORKER_EXTENSION_PATH,
    ]);

    // 写入不含 pi-dcp 的 settings.json 后依旧不注入 pi-dcp
    mkdirSync(join(dir, "pi"), { recursive: true });
    writeFileSync(join(dir, "pi", "settings.json"), JSON.stringify({ packages: ["npm:other@1.0.0"] }), "utf8");
    assert.ok(!resolveWorkerExtensionArgs(dir).some((a) => a.includes("pi-dcp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_discover_project_context_files_git_root_to_cwd_prefers_agents_md", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ctx-git-")));
  try {
    const repo = join(dir, "outer", "repo");
    const pkg = join(repo, "packages", "core");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    // git 根之上还有一层 outer/AGENTS.md，不得越界收集
    writeFileSync(join(dir, "outer", "AGENTS.md"), "outer", "utf8");
    writeFileSync(join(repo, "AGENTS.md"), "root-agents", "utf8");
    writeFileSync(join(repo, "CLAUDE.md"), "root-claude", "utf8");
    mkdirSync(join(repo, "packages", "only-claude"), { recursive: true });
    writeFileSync(join(repo, "packages", "only-claude", "CLAUDE.md"), "claude-only", "utf8");
    writeFileSync(join(pkg, "AGENTS.md"), "pkg-agents", "utf8");
    writeFileSync(join(pkg, "CLAUDE.md"), "pkg-claude", "utf8");

    assert.deepEqual(discoverProjectContextFiles(pkg, { agentDir: join(dir, "agent") }), [
      join(repo, "AGENTS.md"),
      join(pkg, "AGENTS.md"),
    ]);
    assert.deepEqual(discoverProjectContextFiles(join(repo, "packages", "only-claude"), { agentDir: join(dir, "agent") }), [
      join(repo, "AGENTS.md"),
      join(repo, "packages", "only-claude", "CLAUDE.md"),
    ]);
    // 无上下文文件的子目录：仍只从 git 根收集
    const deep = join(pkg, "src", "deep");
    mkdirSync(deep, { recursive: true });
    assert.deepEqual(discoverProjectContextFiles(deep, { agentDir: join(dir, "agent") }), [
      join(repo, "AGENTS.md"),
      join(pkg, "AGENTS.md"),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_discover_project_context_files_worktree_and_non_git", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ctx-wt-")));
  try {
    // git worktree：.git 为文件
    const wt = join(dir, "wt");
    const sub = join(wt, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/main/.git/worktrees/wt\n", "utf8");
    writeFileSync(join(wt, "AGENTS.md"), "wt", "utf8");
    writeFileSync(join(sub, "AGENTS.md"), "sub", "utf8");
    assert.deepEqual(discoverProjectContextFiles(sub, { agentDir: join(dir, "agent") }), [
      join(wt, "AGENTS.md"),
      join(sub, "AGENTS.md"),
    ]);

    // 非 git 目录：仅收集 cwd 自身，不向上爬
    const plain = join(dir, "plain", "child");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(dir, "plain", "AGENTS.md"), "parent", "utf8");
    assert.deepEqual(discoverProjectContextFiles(plain, { agentDir: join(dir, "agent") }), []);
    writeFileSync(join(plain, "CLAUDE.md"), "child", "utf8");
    assert.deepEqual(discoverProjectContextFiles(plain, { agentDir: join(dir, "agent") }), [join(plain, "CLAUDE.md")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_discover_project_context_files_never_loads_agent_dir_global", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ctx-global-")));
  try {
    // 模拟 ~/.pi/agent 下含 AGENTS.md（即 pi/GLOBAL.md）：cwd 设为 agentDir 本身
    const agentDir = join(dir, "home", ".pi", "agent");
    const project = join(agentDir, "projects", "repo");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "project", "utf8");
    assert.deepEqual(discoverProjectContextFiles(project, { agentDir }), [join(project, "AGENTS.md")]);
    assert.deepEqual(discoverProjectContextFiles(agentDir, { agentDir }), []);

    // 非 git 且 cwd 为 agentDir 子目录：仅 cwd 自身，agentDir/AGENTS.md 永不入选
    rmSync(join(project, ".git"), { recursive: true, force: true });
    assert.deepEqual(discoverProjectContextFiles(project, { agentDir }), [join(project, "AGENTS.md")]);
    assert.deepEqual(discoverProjectContextFiles(agentDir, { agentDir }), []);

    // 指向 agentDir/AGENTS.md 的软链（realpath 去重 + 目录排除）同样被排除
    const linkDir = join(dir, "link");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(agentDir, "AGENTS.md"), join(linkDir, "AGENTS.md"));
    assert.deepEqual(discoverProjectContextFiles(linkDir, { agentDir }), []);

    // 环境变量 PI_CODING_AGENT_DIR 作为默认 agentDir
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      assert.deepEqual(discoverProjectContextFiles(agentDir), []);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_build_args_appends_project_context_files_before_protocol_prompt", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-ctx-e2e-")));
  try {
    const repo = join(dir, "repo");
    const workDir = join(repo, "sub");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "repo rules", "utf8");
    writeFileSync(join(workDir, "AGENTS.md"), "sub rules", "utf8");
    const recordFile = join(dir, "invocations.jsonl");
    const fakePi = createFakePi(dir, recordFile);

    const runner = new PiWorkerRunner({
      store: new TaskStore(join(dir, "state")),
      piBinary: fakePi,
      env: cleanEnv({ FAKE_PI_SCENARIO: "two-round", PI_CODING_AGENT_DIR: join(dir, "agent") }),
    });
    const result = await runner.start({ cwd: workDir, prompt: "检查边界", waitSeconds: 5 });
    assert.equal(result.status, "needs_input");

    const [record] = readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const argv = record.argv;
    const noCtxIndex = argv.indexOf("--no-context-files");
    assert.ok(noCtxIndex > 0);
    const appends = collectOptionValues(argv, "--append-system-prompt");
    assert.deepEqual(appends, [
      join(repo, "AGENTS.md"),
      join(workDir, "AGENTS.md"),
      PROTOCOL_APPEND_PROMPT,
    ]);
    // --append-system-prompt 必须全部位于 --no-context-files 之后
    assert.ok(argv.indexOf("--append-system-prompt") > noCtxIndex);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
