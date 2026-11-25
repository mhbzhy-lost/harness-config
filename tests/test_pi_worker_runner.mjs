import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROTOCOL_APPEND_PROMPT } from "../plugins/pi-worker/src/protocol.ts";
import {
  DEFAULT_EXCLUDE_TOOLS,
  PiWorkerRunner,
  READONLY_EXCLUDE_TOOLS,
  WORKER_EXTENSION_PATH,
  resolvePiBinary,
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
    PI_SESSION_OWNER_ID: process.env.PI_SESSION_OWNER_ID ?? null,
    PI_WORKER_AGY: process.env.PI_WORKER_AGY ?? null,
  },
};
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(record) + "\\n", "utf8");

const mode = process.env.FAKE_PI_SCENARIO || "two-round";

if (mode === "sleep") {
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
      assert.equal(r.argv[r.argv.indexOf("-e") + 1], WORKER_EXTENSION_PATH);
      assert.equal(r.argv[r.argv.indexOf("--append-system-prompt") + 1], PROTOCOL_APPEND_PROMPT);
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
      r1.argv[r1.argv.indexOf("--append-system-prompt") + 1],
      r2.argv[r2.argv.indexOf("--append-system-prompt") + 1],
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
    assert.match(records[0].argv[records[0].argv.indexOf("--append-system-prompt") + 1], /只读模式/);
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
