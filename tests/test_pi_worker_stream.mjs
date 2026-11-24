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

test("test_formatter_throttles_thinking_and_tracks_tool_duration", () => {
  let clock = 1_700_000_000_000;
  const formatter = createEventFormatter({ thinkingThrottleMs: 1500, now: () => clock });

  // 连续思考 delta 在节流窗口内不会逐 token 发事件
  assert.deepEqual(
    formatter.feedRawLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "正在分析架构" },
    })),
    [],
  );
  clock += 500;
  assert.deepEqual(
    formatter.feedRawLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "与依赖关系" },
    })),
    [],
  );

  // 超过节流间隔后发出一条聚合 thinking 事件
  clock += 1200;
  const throttled = formatter.feedRawLine(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "，准备执行命令" },
  }));
  assert.equal(throttled.length, 1);
  assert.equal(throttled[0].kind, "thinking");
  assert.equal(throttled[0].thinkingChars, "正在分析架构与依赖关系，准备执行命令".length);
  assert.match(throttled[0].detail ?? "", /正在分析架构/);

  // 工具开始：带参数摘要并记录起始时间
  clock += 200;
  const startEvs = formatter.feedRawLine(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "tc-1",
    toolName: "bash",
    args: { command: "node --test" },
  }));
  assert.equal(startEvs.length, 1);
  assert.equal(startEvs[0].kind, "tool_start");
  assert.equal(startEvs[0].toolName, "bash");
  assert.match(startEvs[0].detail ?? "", /node --test/);
  assert.match(formatTerminalLine(startEvs[0]), /bash.*node --test/);

  // 工具结束：计算耗时并记录 isError
  clock += 350;
  const endEvs = formatter.feedRawLine(JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: "bash",
    isError: false,
  }));
  assert.equal(endEvs.length, 1);
  assert.equal(endEvs[0].kind, "tool_end");
  assert.equal(endEvs[0].durationMs, 350);
  assert.equal(endEvs[0].isError, false);
  assert.match(formatTerminalLine(endEvs[0]), /bash.*0\.4s|0\.35s|350ms/);

  // 助手消息与 turn_end
  const msgEvs = formatter.feedRawLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已完成测试" }] },
  }));
  assert.equal(msgEvs.length, 1);
  assert.equal(msgEvs[0].kind, "assistant");
  assert.match(msgEvs[0].detail ?? "", /已完成测试/);
});

test("test_read_events_delta_handles_partial_utf8_oversized_line_and_max_events", () => {
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

    // 2. 单行 > maxBytes 时必须推进越过超长行，绝不 livelock
    const bigPath = join(dir, "big.events.jsonl");
    const hugeLine = JSON.stringify({ seq: 1, kind: "assistant", title: "huge", detail: "X".repeat(600), timestamp: "2026-11-25T00:00:00.000Z" });
    const normalLine = JSON.stringify({ seq: 2, kind: "status", title: "done", timestamp: "2026-11-25T00:00:01.000Z" });
    writeFileSync(bigPath, `${hugeLine}\n${normalLine}\n`, "utf8");

    const b1 = readFormattedEventsDelta(bigPath, 0, { maxBytes: 128, maxEvents: 10 });
    assert.ok(b1.nextOffset > 0, "must advance past oversized line without livelock");
    assert.equal(b1.hasMore, true);
    const b2 = readFormattedEventsDelta(bigPath, b1.nextOffset, { maxBytes: 128, maxEvents: 10 });
    assert.equal(b2.events.length, 1);
    assert.equal(b2.events[0].seq, 2);

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
    const ev = { seq: 1, kind: "tool_start", toolName: "bash", title: "bash", detail: "echo ok", timestamp: now };
    writeFileSync(paths.eventsPath, `${JSON.stringify(ev)}\n`, "utf8");

    const textOut = execFileSync(process.execPath, [STREAM_CLI, taskId], {
      env: { ...process.env, PI_WORKER_STATE_DIR: dir },
      encoding: "utf8",
    });
    assert.match(textOut, /bash.*echo ok/);

    const jsonOut = execFileSync(process.execPath, [STREAM_CLI, taskId, "--json"], {
      env: { ...process.env, PI_WORKER_STATE_DIR: dir },
      encoding: "utf8",
    });
    assert.equal(JSON.parse(jsonOut.trim()).seq, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
