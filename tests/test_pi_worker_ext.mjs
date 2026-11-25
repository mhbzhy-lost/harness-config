import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOutcomeFile, appendSteerEntry } from "../plugins/pi-worker/src/protocol.ts";
import piWorkerExtension, { registerPiWorkerExtension } from "../plugins/pi-worker/src/worker-ext.ts";

function createMockPi({ withSendUserMessage = false } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const sentMessages = [];
  const pi = {
    tools,
    handlers,
    sentMessages,
    registerTool(def) {
      tools.set(def.name, def);
    },
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    async emit(event, payload, ctx) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
  if (withSendUserMessage) {
    pi.sendUserMessage = (text, options) => {
      sentMessages.push({ text, options });
    };
  }
  return pi;
}

test("test_extension_is_noop_when_outcome_env_absent", () => {
  const prev = process.env.PI_WORKER_OUTCOME_FILE;
  delete process.env.PI_WORKER_OUTCOME_FILE;
  try {
    const mockPi = createMockPi();
    piWorkerExtension(mockPi);
    assert.equal(mockPi.tools.size, 0);
    assert.equal(mockPi.handlers.size, 0);
  } finally {
    if (prev !== undefined) process.env.PI_WORKER_OUTCOME_FILE = prev;
  }
});

test("test_worker_ask_parent_writes_outcome_returns_tool_result_then_aborts_on_turn_end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-"));
  try {
    const outcomeFile = join(dir, "outcome.json");
    const mockPi = createMockPi();
    let exitCodeSet = null;
    registerPiWorkerExtension(mockPi, {
      outcomeFile,
      setExitCode: (code) => { exitCodeSet = code; },
    });

    assert.ok(mockPi.tools.has("worker_ask_parent"));
    assert.ok(mockPi.tools.has("worker_report_blocked"));
    assert.ok(mockPi.tools.has("worker_finish"));

    let abortCalls = 0;
    const ctx = { abort: () => { abortCalls += 1; } };

    const askTool = mockPi.tools.get("worker_ask_parent");
    const toolResult = await askTool.execute("tc_1", {
      question: "选方案 A 还是 B？",
      options: ["A", "B"],
      summary: "已完成前置调研",
    }, undefined, undefined, ctx);

    // 关键：tool execute 阶段不直接 abort，确保 tool_result 先落盘，且返回 terminate: true + details: {} 阻止进入多余第 2 轮
    assert.equal(abortCalls, 0);
    assert.equal(toolResult.terminate, true);
    assert.deepEqual(toolResult.details, {});
    assert.ok(Array.isArray(toolResult.content) && toolResult.content.length > 0);
    assert.deepEqual(readOutcomeFile(outcomeFile), {
      status: "needs_input",
      summary: "已完成前置调研",
      question: "选方案 A 还是 B？",
      options: ["A", "B"],
      verifiedCommands: [],
      stopReason: null,
      error: null,
    });

    // turn_end 时才触发 abort
    await mockPi.emit("turn_end", { type: "turn_end" }, ctx);
    assert.equal(abortCalls, 1);

    // 随后的 agent_end（即使带 aborted stopReason）不得覆写 needs_input 或改 exitCode
    await mockPi.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
    }, ctx);
    assert.equal(exitCodeSet, null);
    assert.equal(readOutcomeFile(outcomeFile)?.status, "needs_input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_worker_report_blocked_and_worker_finish_write_structured_outcomes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-"));
  try {
    // 1. blocked
    const blockedFile = join(dir, "blocked.json");
    const mockBlocked = createMockPi();
    registerPiWorkerExtension(mockBlocked, { outcomeFile: blockedFile, setExitCode: () => {} });
    let abortCalls = 0;
    const ctx = { abort: () => { abortCalls += 1; } };

    const blockedResult = await mockBlocked.tools.get("worker_report_blocked").execute("tc_2", {
      reason: "缺少数据库凭据",
      summary: "迁移脚本已就绪，待提供测试库密码",
    }, undefined, undefined, ctx);
    assert.equal(blockedResult.terminate, true);
    assert.deepEqual(blockedResult.details, {});
    assert.equal(abortCalls, 0);
    await mockBlocked.emit("turn_end", { type: "turn_end" }, ctx);
    assert.equal(abortCalls, 1);
    assert.deepEqual(readOutcomeFile(blockedFile), {
      status: "blocked",
      summary: "迁移脚本已就绪，待提供测试库密码",
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: null,
      error: "缺少数据库凭据",
    });

    // 2. finish
    const doneFile = join(dir, "done.json");
    const mockDone = createMockPi();
    registerPiWorkerExtension(mockDone, { outcomeFile: doneFile, setExitCode: () => {} });
    let finishAborts = 0;
    const finishCtx = { abort: () => { finishAborts += 1; } };
    const finishResult = await mockDone.tools.get("worker_finish").execute("tc_3", {
      summary: "完成重构并全部通过测试",
      verifiedCommands: ["npm test", "npm run lint"],
    }, undefined, undefined, finishCtx);
    assert.equal(finishResult.terminate, true);
    assert.deepEqual(finishResult.details, {});
    await mockDone.emit("turn_end", { type: "turn_end" }, finishCtx);
    assert.equal(finishAborts, 1);
    assert.deepEqual(readOutcomeFile(doneFile), {
      status: "done",
      summary: "完成重构并全部通过测试",
      question: null,
      options: [],
      verifiedCommands: ["npm test", "npm run lint"],
      stopReason: null,
      error: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_steer_queue_consumed_once_dedup_by_id_and_ignored_after_terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-steer-"));
  try {
    const outcomeFile = join(dir, "outcome.json");
    const steerFile = join(dir, "steer.jsonl");
    const mockPi = createMockPi({ withSendUserMessage: true });
    registerPiWorkerExtension(mockPi, {
      outcomeFile,
      steerFile,
      steerPollMs: 60_000, // 单测中关闭定时器噪声，仅验证事件驱动消费
      setExitCode: () => {},
    });
    const ctx = { abort: () => {} };

    appendSteerEntry(steerFile, { id: "s1", message: "改用方案 B", createdAt: "t1", source: "agent" });
    appendSteerEntry(steerFile, { id: "s2", message: "注意兼容旧接口", createdAt: "t2", source: "app" });

    // tool_execution_end 边界消费全部未读 steer，且 deliverAs 为 steer
    await mockPi.emit("tool_execution_end", { type: "tool_execution_end" }, ctx);
    assert.deepEqual(mockPi.sentMessages, [
      { text: "改用方案 B", options: { deliverAs: "steer" } },
      { text: "注意兼容旧接口", options: { deliverAs: "steer" } },
    ]);

    // turn_end / agent_before_settle 重复触发不得重复注入（按 id 去重）
    await mockPi.emit("turn_end", { type: "turn_end" }, ctx);
    await mockPi.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
    assert.equal(mockPi.sentMessages.length, 2);

    // 追加新条目 + 重复旧 id：只注入新条目
    appendSteerEntry(steerFile, { id: "s1", message: "改用方案 B", createdAt: "t1", source: "agent" });
    appendSteerEntry(steerFile, { id: "s3", message: "补充验收命令", createdAt: "t3" });
    await mockPi.emit("turn_end", { type: "turn_end" }, ctx);
    assert.equal(mockPi.sentMessages.length, 3);
    assert.equal(mockPi.sentMessages[2].text, "补充验收命令");

    // terminalWritten（worker_finish）后不再注入任何 steer
    await mockPi.tools.get("worker_finish").execute("tc_s", { summary: "已完成" }, undefined, undefined, ctx);
    appendSteerEntry(steerFile, { id: "s4", message: "迟到的插话", createdAt: "t4" });
    await mockPi.emit("tool_execution_end", { type: "tool_execution_end" }, ctx);
    await mockPi.emit("turn_end", { type: "turn_end" }, ctx);
    await mockPi.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
    assert.equal(mockPi.sentMessages.length, 3);
    assert.equal(readOutcomeFile(outcomeFile)?.status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_agent_end_does_not_write_terminal_outcome_when_steer_unconsumed_or_pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-steer-guard-"));
  try {
    // 1. 存在未消费 steer：agent_end 消费注入后不得写终态，让续跑完成
    const f1 = join(dir, "o1.json");
    const s1 = join(dir, "s1.jsonl");
    const pi1 = createMockPi({ withSendUserMessage: true });
    let exit1 = null;
    registerPiWorkerExtension(pi1, { outcomeFile: f1, steerFile: s1, steerPollMs: 60_000, setExitCode: (c) => { exit1 = c; } });
    appendSteerEntry(s1, { id: "a1", message: "追加要求", createdAt: "t" });
    await pi1.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第一阶段完成" }] }],
    }, {});
    assert.equal(pi1.sentMessages.length, 1);
    assert.equal(readOutcomeFile(f1), null);
    assert.equal(exit1, null);
    // 队列排空后的下一次 agent_end 正常写 done（无 steer 兜底行为完全兼容）
    await pi1.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "含插话全部完成" }] }],
    }, {});
    assert.equal(readOutcomeFile(f1)?.status, "done");
    assert.equal(readOutcomeFile(f1)?.summary, "含插话全部完成");
    await pi1.emit("agent_settled", { type: "agent_settled" }, {});

    // 2. ctx.hasPendingMessages() 为 true：即使无磁盘队列也不得提前写终态
    const f2 = join(dir, "o2.json");
    const pi2 = createMockPi({ withSendUserMessage: true });
    registerPiWorkerExtension(pi2, { outcomeFile: f2, steerFile: join(dir, "s2.jsonl"), steerPollMs: 60_000, setExitCode: () => {} });
    await pi2.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "部分完成" }] }],
    }, { hasPendingMessages: () => true });
    assert.equal(readOutcomeFile(f2), null);
    await pi2.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终完成" }] }],
    }, { hasPendingMessages: () => false });
    assert.equal(readOutcomeFile(f2)?.status, "done");
    await pi2.emit("agent_settled", { type: "agent_settled" }, {});

    // 3. 有未消费 steer 但宿主不支持 sendUserMessage：同样禁止误写终态
    const f3 = join(dir, "o3.json");
    const s3 = join(dir, "s3.jsonl");
    const pi3 = createMockPi();
    registerPiWorkerExtension(pi3, { outcomeFile: f3, steerFile: s3, steerPollMs: 60_000, setExitCode: () => {} });
    appendSteerEntry(s3, { id: "a3", message: "无法注入的插话", createdAt: "t" });
    await pi3.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完成" }] }],
    }, {});
    assert.equal(readOutcomeFile(f3), null);
    await pi3.emit("agent_settled", { type: "agent_settled" }, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_steer_timer_polls_queue_without_events_and_settled_clears_timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-steer-timer-"));
  try {
    const outcomeFile = join(dir, "outcome.json");
    const steerFile = join(dir, "steer.jsonl");
    const mockPi = createMockPi({ withSendUserMessage: true });
    registerPiWorkerExtension(mockPi, { outcomeFile, steerFile, steerPollMs: 20, setExitCode: () => {} });

    // 不触发任何事件，仅靠轻量定时器在工具执行期间消费入队 steer
    appendSteerEntry(steerFile, { id: "t1", message: "定时器注入", createdAt: "t" });
    let injected = false;
    for (let i = 0; i < 100; i += 1) {
      if (mockPi.sentMessages.length >= 1) { injected = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(injected, true, "steer timer must consume queue without explicit events");
    assert.deepEqual(mockPi.sentMessages[0], { text: "定时器注入", options: { deliverAs: "steer" } });

    // agent_settled 后清理定时器：后续追加不再被消费
    await mockPi.emit("agent_settled", { type: "agent_settled" }, {});
    appendSteerEntry(steerFile, { id: "t2", message: "结束后迟到", createdAt: "t" });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(mockPi.sentMessages.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_agent_end_handles_natural_done_and_sets_exit_code_on_error_stop_reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ext-"));
  try {
    // 1. 自然结束 -> done
    const okFile = join(dir, "ok.json");
    const mockOk = createMockPi();
    let okExit = null;
    registerPiWorkerExtension(mockOk, { outcomeFile: okFile, setExitCode: (c) => { okExit = c; } });
    await mockOk.emit("agent_end", {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "do work" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "全部完成" }] },
      ],
    }, {});
    assert.equal(okExit, null);
    assert.deepEqual(readOutcomeFile(okFile), {
      status: "done",
      summary: "全部完成",
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: "stop",
      error: null,
    });

    // 2. stopReason: error -> failed + exitCode 1
    const errFile = join(dir, "err.json");
    const mockErr = createMockPi();
    let errExit = null;
    registerPiWorkerExtension(mockErr, { outcomeFile: errFile, setExitCode: (c) => { errExit = c; } });
    await mockErr.emit("agent_end", {
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests", content: [] },
      ],
    }, {});
    assert.equal(errExit, 1);
    assert.deepEqual(readOutcomeFile(errFile), {
      status: "failed",
      summary: "",
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: "error",
      error: "429 Too Many Requests",
    });

    // 3. stopReason: aborted (非工具触发) -> failed + exitCode 1
    const abortedFile = join(dir, "aborted.json");
    const mockAborted = createMockPi();
    let abortedExit = null;
    registerPiWorkerExtension(mockAborted, { outcomeFile: abortedFile, setExitCode: (c) => { abortedExit = c; } });
    await mockAborted.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
    }, {});
    assert.equal(abortedExit, 1);
    assert.equal(readOutcomeFile(abortedFile)?.status, "failed");

    // 4. 自动重试恢复成功：首次 error 置 exitCode=1，后续重试成功必须清零 exitCode=0
    const retryFile = join(dir, "retry-recover.json");
    const mockRetry = createMockPi();
    const exitHistory = [];
    registerPiWorkerExtension(mockRetry, {
      outcomeFile: retryFile,
      setExitCode: (c) => { exitHistory.push(c); },
    });
    await mockRetry.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 retryable", content: [] }],
    }, {});
    assert.deepEqual(exitHistory, [1]);
    await mockRetry.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "重试后完成" }] }],
    }, {});
    assert.deepEqual(exitHistory, [1, 0]);
    assert.equal(readOutcomeFile(retryFile)?.status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
