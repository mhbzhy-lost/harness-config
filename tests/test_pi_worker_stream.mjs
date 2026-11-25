import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createEventFormatter,
  formatTerminalLine,
  readFormattedEventsDelta,
} from "../plugins/pi-worker/src/stream.ts";
import { TaskStore } from "../plugins/pi-worker/src/store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STREAM_CLI = join(ROOT, "plugins", "pi-worker", "src", "stream.ts");

test("test_formatter_streams_untruncated_thinking_text_and_tool_events_with_round", () => {
  let clock = 1_700_000_000_000;
  const formatter = createEventFormatter({
    thinkingThrottleMs: 1500,
    textThrottleMs: 300,
    round: 2,
    now: () => clock,
  });

  // 1. 连续思考 delta 在节流窗口内不会逐 token 发事件，超窗口后发出纯增量块且不截断
  const thinkPart1 = "正在分析架构" + "A".repeat(600);
  const thinkPart2 = "与依赖关系" + "B".repeat(600);
  const thinkPart3 = "，准备执行命令";
  assert.deepEqual(
    formatter.feedRawLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: thinkPart1 },
    })),
    [],
  );
  clock += 500;
  assert.deepEqual(
    formatter.feedRawLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: thinkPart2 },
    })),
    [],
  );

  clock += 1200;
  const throttled = formatter.feedRawLine(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: thinkPart3 },
  }));
  assert.equal(throttled.length, 1);
  assert.equal(throttled[0].kind, "thinking");
  assert.equal(throttled[0].round, 2);
  assert.equal(typeof throttled[0].blockId, "number");
  assert.equal(throttled[0].detail, thinkPart1 + thinkPart2 + thinkPart3);
  assert.equal(throttled[0].thinkingChars, (thinkPart1 + thinkPart2 + thinkPart3).length);

  // 同一思考段后续 delta 只发新增增量，不再重复之前内容
  clock += 1600;
  const thinkPart4 = "，补充边界检查";
  const throttled2 = formatter.feedRawLine(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: thinkPart4 },
  }));
  assert.equal(throttled2.length, 1);
  assert.equal(throttled2[0].blockId, throttled[0].blockId);
  assert.equal(throttled2[0].detail, thinkPart4);
  assert.equal(throttled2[0].thinkingChars, (thinkPart1 + thinkPart2 + thinkPart3 + thinkPart4).length);

  // 2. 工具开始：保留完整参数（无截断）；多参数保留完整 JSON 且提供单行 preview；终端单行保持紧凑
  clock += 200;
  const multilineCmd = "cd ~/repo\nnode --test\necho " + "x".repeat(2000);
  const startEvs = formatter.feedRawLine(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "tc-1",
    toolName: "bash",
    args: { command: multilineCmd },
  }));
  assert.equal(startEvs.length, 1);
  assert.equal(startEvs[0].kind, "tool_start");
  assert.equal(startEvs[0].round, 2);
  assert.equal(startEvs[0].toolName, "bash");
  assert.equal(startEvs[0].detail, multilineCmd);
  const termLine = formatTerminalLine(startEvs[0]);
  assert.match(termLine, /bash.*node --test/);
  assert.ok(!termLine.includes("\n"), "terminal line must stay single-line");
  assert.ok(termLine.length < 220, "terminal line must stay compact");

  // 多字段工具参数（如 edit）保留完整 JSON，同时 preview 提取 path 供折叠预览
  const editStart = formatter.feedRawLine(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "tc-edit",
    toolName: "edit",
    args: { path: "src/app.ts", oldText: "old", newText: "new" },
  }));
  assert.equal(editStart.length, 1);
  assert.equal(editStart[0].preview, "src/app.ts");
  assert.match(editStart[0].detail ?? "", /"oldText": "old"/);
  assert.match(formatTerminalLine(editStart[0]), /edit: src\/app\.ts/);

  // 3. 工具结束：计算耗时、记录 isError 并保留完整输出（不做首尾截断）
  clock += 350;
  const longOutput = `HEADER\n${"middle line\n".repeat(300)}FOOTER_OK`;
  const endEvs = formatter.feedRawLine(JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: longOutput }] },
  }));
  assert.equal(endEvs.length, 1);
  assert.equal(endEvs[0].kind, "tool_end");
  assert.equal(endEvs[0].durationMs, 350);
  assert.equal(endEvs[0].isError, false);
  assert.equal(endEvs[0].detail, longOutput);
  const endTermLine = formatTerminalLine(endEvs[0]);
  assert.match(endTermLine, /bash.*0\.4s|0\.35s|350ms/);
  assert.ok(!endTermLine.includes("HEADER"), "non-error tool_end terminal line should stay compact");

  // 4. 助手正文流式 text_delta 节流输出 + message_end 定稿共用 blockId 且无 1200 字截断
  const textChunk1 = "## 结论\n\n" + "正文段落".repeat(400);
  assert.deepEqual(
    formatter.feedRawLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: textChunk1 },
    })),
    [],
  );
  clock += 350;
  const textChunk2 = "\n\n补充说明";
  const textStreamEvs = formatter.feedRawLine(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: textChunk2 },
  }));
  assert.equal(textStreamEvs.length, 1);
  assert.equal(textStreamEvs[0].kind, "text_delta");
  assert.equal(textStreamEvs[0].detail, textChunk1 + textChunk2);
  assert.equal(typeof textStreamEvs[0].blockId, "number");

  const fullFinalText = textChunk1 + textChunk2 + "\n\n已完成测试";
  const msgEvs = formatter.feedRawLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: fullFinalText }] },
  }));
  assert.equal(msgEvs.length, 1);
  assert.equal(msgEvs[0].kind, "assistant");
  assert.equal(msgEvs[0].blockId, textStreamEvs[0].blockId);
  assert.equal(msgEvs[0].detail, fullFinalText);
  assert.ok(formatTerminalLine(msgEvs[0]).length < 180);
});

test("test_read_events_delta_reads_long_lines_intact_and_guards_extreme_lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-stream-"));
  try {
    const missing = readFormattedEventsDelta(join(dir, "nope.events.jsonl"), 0);
    assert.deepEqual(missing.events, []);
    assert.equal(missing.nextOffset, 0);

    // 1. 末尾半行中文 UTF-8：首次仅消费完整行，补全后完整读出
    const partialPath = join(dir, "partial.events.jsonl");
    const ev1 = JSON.stringify({ seq: 1, kind: "tool_start", title: "读取中文文件", timestamp: "2026-11-25T00:00:00.000Z" });
    const ev2Full = JSON.stringify({ seq: 2, kind: "assistant", title: "中文回复完成", timestamp: "2026-11-25T00:00:01.000Z" });
    const ev2Buf = Buffer.from(`${ev2Full}\n`, "utf8");
    const cutPoint = ev2Buf.indexOf(Buffer.from("中文")) + 2; // 故意切在多字节 UTF-8 字符中间
    writeFileSync(partialPath, Buffer.concat([Buffer.from(`${ev1}\n`, "utf8"), ev2Buf.subarray(0, cutPoint)]));

    const d1 = readFormattedEventsDelta(partialPath, 0);
    assert.equal(d1.events.length, 1);
    assert.equal(d1.events[0].seq, 1);
    assert.equal(d1.nextOffset, Buffer.byteLength(`${ev1}\n`, "utf8"));

    writeFileSync(partialPath, Buffer.concat([Buffer.from(`${ev1}\n`, "utf8"), ev2Buf]));
    const d2 = readFormattedEventsDelta(partialPath, d1.nextOffset);
    assert.equal(d2.events.length, 1);
    assert.equal(d2.events[0].seq, 2);
    assert.equal(d2.events[0].title, "中文回复完成");

    // 2. 单行 > 批量预算 maxBytes 但 <= maxSingleLineBytes：必须完整读出而不静默丢弃
    const bigPath = join(dir, "big.events.jsonl");
    const longDetail = "X".repeat(600);
    const hugeLine = JSON.stringify({ seq: 1, kind: "assistant", title: "huge", detail: longDetail, timestamp: "2026-11-25T00:00:00.000Z" });
    const normalLine = JSON.stringify({ seq: 2, kind: "status", title: "done", timestamp: "2026-11-25T00:00:01.000Z" });
    writeFileSync(bigPath, `${hugeLine}\n${normalLine}\n`, "utf8");

    const b1 = readFormattedEventsDelta(bigPath, 0, { maxBytes: 128, maxEvents: 10 });
    assert.ok(b1.nextOffset > 0, "must advance past long line without livelock");
    assert.equal(b1.hasMore, true);
    assert.equal(b1.events.length, 1);
    assert.equal(b1.events[0].detail, longDetail);
    const b2 = readFormattedEventsDelta(bigPath, b1.nextOffset, { maxBytes: 128, maxEvents: 10 });
    assert.equal(b2.events.length, 1);
    assert.equal(b2.events[0].seq, 2);

    // 2b. 单行超过极端硬上限 maxSingleLineBytes 时安全跳过防 OOM/livelock
    const skipped = readFormattedEventsDelta(bigPath, 0, { maxBytes: 128, maxSingleLineBytes: 256, maxEvents: 10 });
    assert.equal(skipped.events.length, 0);
    assert.equal(skipped.nextOffset, b1.nextOffset);
    assert.equal(skipped.hasMore, true);

    // 3. maxEvents 分页对齐换行字节边界，不丢事件
    const pagedPath = join(dir, "paged.events.jsonl");
    const lines = [1, 2, 3, 4, 5].map((seq) =>
      JSON.stringify({ seq, kind: "turn_end", title: `turn ${seq}`, timestamp: "2026-11-25T00:00:00.000Z" }),
    );
    writeFileSync(pagedPath, `${lines.join("\n")}\n`, "utf8");

    const p1 = readFormattedEventsDelta(pagedPath, 0, { maxEvents: 2 });
    assert.deepEqual(p1.events.map((e) => e.seq), [1, 2]);
    assert.equal(p1.hasMore, true);
    const p2 = readFormattedEventsDelta(pagedPath, p1.nextOffset, { maxEvents: 2 });
    assert.deepEqual(p2.events.map((e) => e.seq), [3, 4]);
    assert.equal(p2.hasMore, true);
    const p3 = readFormattedEventsDelta(pagedPath, p2.nextOffset, { maxEvents: 2 });
    assert.deepEqual(p3.events.map((e) => e.seq), [5]);
    assert.equal(p3.hasMore, false);

    // 4. 文件被截断短于 offset 时重置为 0 重读
    const trunc = readFormattedEventsDelta(pagedPath, p3.nextOffset + 999);
    assert.equal(trunc.truncated, true);
    assert.equal(trunc.events.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_stream_cli_outputs_formatted_lines_and_json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-cli-"));
  try {
    const store = new TaskStore(dir);
    const taskId = "12121212-1212-4121-8121-121212121212";
    const paths = store.allocateTaskPaths(taskId);
    const now = "2026-11-25T00:00:00.000Z";
    store.save({
      taskId,
      cwd: dir,
      sessionDir: paths.sessionDir,
      logPath: paths.logPath,
      eventsPath: paths.eventsPath,
      outcomePath: paths.outcomePath,
      status: "done",
      pid: null,
      excludeTools: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      turnCount: 1,
      roundCount: 1,
      lastTool: "bash",
      recentEvents: [],
      summary: "ok",
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: "stop",
      exitCode: 0,
      error: null,
      gitChanges: [],
    });
    const ev1 = { seq: 1, round: 1, kind: "tool_start", toolName: "bash", title: "bash", detail: "echo ok", timestamp: now };
    const ev2 = { seq: 2, round: 1, blockId: 1, kind: "text_delta", title: "助手输出", detail: "局部流式", timestamp: now };
    const ev3 = { seq: 3, round: 1, blockId: 1, kind: "assistant", title: "助手输出", detail: "局部流式完整文本", timestamp: now };
    writeFileSync(paths.eventsPath, `${[ev1, ev2, ev3].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

    const textOut = execFileSync(process.execPath, [STREAM_CLI, taskId], {
      env: { ...process.env, PI_WORKER_STATE_DIR: dir },
      encoding: "utf8",
    });
    assert.match(textOut, /bash.*echo ok/);
    assert.match(textOut, /局部流式完整文本/);
    assert.equal(textOut.trim().split("\n").length, 2, "CLI text mode should skip intermediate text_delta");

    const jsonOut = execFileSync(process.execPath, [STREAM_CLI, taskId, "--json"], {
      env: { ...process.env, PI_WORKER_STATE_DIR: dir },
      encoding: "utf8",
    });
    const jsonLines = jsonOut.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(jsonLines.length, 3);
    assert.equal(jsonLines[1].kind, "text_delta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
