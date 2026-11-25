import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  PROTOCOL_APPEND_PROMPT,
  appendSteerEntry,
  createLineSplitter,
  extractAssistantMessage,
  parsePiJsonLine,
  readOutcomeFile,
  readSteerEntries,
  truncateTail,
  writeOutcomeFile,
} from "../plugins/pi-worker/src/protocol.ts";

test("test_protocol_prompt_is_static_and_mentions_worker_tools", () => {
  assert.equal(typeof PROTOCOL_APPEND_PROMPT, "string");
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("worker_ask_parent"));
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("worker_report_blocked"));
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("worker_finish"));
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("compress"));
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("bash"));
  assert.ok(PROTOCOL_APPEND_PROMPT.includes("bash_async"));
});

test("test_outcome_file_roundtrip_permissions_and_corrupt_handling", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-proto-"));
  try {
    const file = join(dir, "outcome.json");
    const sample = {
      status: "needs_input",
      summary: "已完成前半段探索",
      question: "选择方案 A 还是方案 B？",
      options: ["方案 A", "方案 B"],
      verifiedCommands: [],
      stopReason: null,
      error: null,
    };
    writeOutcomeFile(file, sample);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readOutcomeFile(file), sample);

    const corruptFile = join(dir, "corrupt.json");
    writeFileSync(corruptFile, "{bad json", { mode: 0o600 });
    assert.equal(readOutcomeFile(corruptFile), null);

    const invalidStatusFile = join(dir, "invalid-status.json");
    writeFileSync(invalidStatusFile, JSON.stringify({ status: "unknown", summary: "x" }), { mode: 0o600 });
    assert.equal(readOutcomeFile(invalidStatusFile), null);

    assert.equal(readOutcomeFile(join(dir, "missing.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_line_splitter_preserves_unicode_line_separators", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  const payload = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "a\u2028b\u2029c" }] },
  });
  const buf = Buffer.from(`${payload}\r\n{"type":"turn_end"}\n`, "utf8");
  // 拆分成包含多字节 UTF-8 跨块边界的片段
  splitter.push(buf.subarray(0, 17));
  splitter.push(buf.subarray(17, 55));
  splitter.push(buf.subarray(55));
  splitter.flush();

  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message.content[0].text, "a\u2028b\u2029c");
  assert.deepEqual(JSON.parse(lines[1]), { type: "turn_end" });
});

test("test_parse_pi_json_line_and_extract_assistant_message", () => {
  assert.equal(parsePiJsonLine(""), null);
  assert.equal(parsePiJsonLine("[antigravity] 缺 OAuth client：本扩展不注册"), null);

  const sessionEvt = parsePiJsonLine(JSON.stringify({ type: "session", id: "abc-123", cwd: "/repo" }));
  assert.equal(sessionEvt?.kind, "session");
  assert.equal(sessionEvt?.sessionId, "abc-123");

  const toolStart = parsePiJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }));
  assert.equal(toolStart?.kind, "tool_start");
  assert.equal(toolStart?.toolName, "bash");

  const toolEnd = parsePiJsonLine(JSON.stringify({ type: "tool_execution_end", toolName: "bash" }));
  assert.equal(toolEnd?.kind, "tool_end");
  assert.equal(toolEnd?.toolName, "bash");

  const compactEvt = parsePiJsonLine(JSON.stringify({ type: "session_compact" }));
  assert.equal(compactEvt?.kind, "compact");

  const turnEnd = parsePiJsonLine(JSON.stringify({ type: "turn_end" }));
  assert.equal(turnEnd?.kind, "turn_end");

  const retryFailed = parsePiJsonLine(JSON.stringify({ type: "auto_retry_end", success: false, finalError: "429" }));
  assert.equal(retryFailed?.kind, "retry_failed");
  assert.equal(retryFailed?.errorMessage, "429");

  const aborted = parsePiJsonLine(JSON.stringify({ type: "agent_settled", aborted: true }));
  assert.equal(aborted?.kind, "agent_aborted");

  // user / toolResult 角色消息不得被当成 assistant_message
  const userLine = JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "ignore me" }] },
  });
  assert.equal(extractAssistantMessage(userLine), null);
  assert.equal(parsePiJsonLine(userLine)?.kind, "other");

  const longText = "x".repeat(900);
  const assistantLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: longText }],
    },
  });
  const extracted = extractAssistantMessage(assistantLine);
  assert.equal(extracted?.text, longText);
  assert.equal(extracted?.stopReason, "stop");

  const summaryEvt = parsePiJsonLine(assistantLine);
  assert.equal(summaryEvt?.kind, "assistant_message");
  assert.ok((summaryEvt?.text?.length ?? 0) <= 520);

  const errLine = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit", content: [] },
  });
  const errExtracted = extractAssistantMessage(errLine);
  assert.equal(errExtracted?.stopReason, "error");
  assert.equal(errExtracted?.errorMessage, "429 rate limit");

  const truncated = truncateTail("a".repeat(50), 20);
  assert.ok(truncated.startsWith("...(truncated)\n"));
  assert.ok(truncated.endsWith("a".repeat(20)));
});

test("test_steer_queue_append_and_read_with_private_perms_and_corrupt_line_tolerance", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-proto-steer-"));
  try {
    const steerPath = join(dir, "steers", "task-1.jsonl");
    // 文件不存在时安全返回空队列
    assert.deepEqual(readSteerEntries(steerPath), []);

    appendSteerEntry(steerPath, { id: "s1", message: "改用方案 B", createdAt: "2026-11-25T10:00:00.000Z", source: "agent" });
    appendSteerEntry(steerPath, { id: "s2", message: "面板纠偏", createdAt: "2026-11-25T10:00:01.000Z", source: "app" });
    assert.equal(statSync(dirname(steerPath)).mode & 0o777, 0o700);
    assert.equal(statSync(steerPath).mode & 0o777, 0o600);

    // 损坏行 / 非法条目容错跳过，合法条目保留
    appendFileSync(steerPath, "{not-json\n", "utf8");
    appendFileSync(steerPath, JSON.stringify({ id: "", message: "缺 id" }) + "\n", "utf8");
    appendFileSync(steerPath, JSON.stringify({ id: "s3", message: "  " }) + "\n", "utf8");
    appendFileSync(steerPath, JSON.stringify({ id: "s4", message: "无 createdAt 与 source" }) + "\n", "utf8");
    const entries = readSteerEntries(steerPath);
    assert.deepEqual(entries.map((e) => e.id), ["s1", "s2", "s4"]);
    assert.equal(entries[0].source, "agent");
    assert.equal(entries[1].source, "app");
    assert.equal(entries[2].createdAt, "");
    assert.equal(entries[2].source, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
