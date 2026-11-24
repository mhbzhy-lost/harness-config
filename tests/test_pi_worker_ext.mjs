import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOutcomeFile } from "../plugins/pi-worker/src/protocol.ts";
import piWorkerExtension, { registerPiWorkerExtension } from "../plugins/pi-worker/src/worker-ext.ts";

function createMockPi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
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
