#!/usr/bin/env node
/**
 * pi-worker 跨 Harness 统一格式化进度流：
 * 1. createEventFormatter(): 将 Pi --mode json 原始行转为精简结构化事件（节流 thinking、计算工具耗时与参数摘要）。
 * 2. readFormattedEventsDelta(): 按字节偏移安全增量读取 logs/<taskId>.events.jsonl（防多字节 UTF-8 截断、防超大单行 livelock、按 maxEvents 分页对齐）。
 * 3. formatTerminalLine(): 人类可读单行格式化（供 MCP notifications/progress 与 CLI 共享）。
 * 4. CLI 出口：node plugins/pi-worker/src/stream.ts <taskId> [--follow] [--json]
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTextFromContent } from "./protocol.ts";
import { TaskStore, resolveStateDir } from "./store.ts";

export type FormattedEventKind =
  | "session"
  | "thinking"
  | "tool_start"
  | "tool_end"
  | "assistant"
  | "turn_end"
  | "compact"
  | "retry_failed"
  | "aborted"
  | "status";

export interface FormattedStreamEvent {
  seq: number;
  kind: FormattedEventKind;
  title: string;
  detail?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
  thinkingChars?: number;
  timestamp: string;
}

export interface EventsDeltaResult {
  offset: number;
  nextOffset: number;
  truncated: boolean;
  hasMore: boolean;
  events: FormattedStreamEvent[];
}

export interface EventFormatterOptions {
  thinkingThrottleMs?: number;
  now?: () => number;
  startSeq?: number;
}

const DEFAULT_THINKING_THROTTLE_MS = 1500;
const MAX_ARG_SUMMARY_CHARS = 200;
const MAX_ASSISTANT_DETAIL_CHARS = 1200;
const MAX_THINKING_PREVIEW_CHARS = 400;
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 100;
const SKIP_SCAN_CHUNK_BYTES = 64 * 1024;

function truncateHead(text: string, maxChars: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function truncateTailPreview(text: string, maxChars: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `…${cleaned.slice(cleaned.length - maxChars)}`;
}

function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const obj = args as Record<string, unknown>;
  for (const key of ["command", "CommandLine", "path", "Path", "filePath", "file_path", "pattern", "query", "question", "reason"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      return truncateHead(val.replace(/\s+/g, " "), MAX_ARG_SUMMARY_CHARS);
    }
  }
  try {
    const raw = JSON.stringify(obj);
    if (raw && raw !== "{}") return truncateHead(raw, MAX_ARG_SUMMARY_CHARS);
  } catch {
    // 忽略序列化失败
  }
  return undefined;
}

function parseJsonLine(rawLine: string): Record<string, unknown> | null {
  const trimmed = rawLine.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createEventFormatter(options: EventFormatterOptions = {}): {
  feedRawLine(rawLine: string): FormattedStreamEvent[];
  emitStatus(status: string, detail?: string): FormattedStreamEvent;
  flush(): FormattedStreamEvent[];
} {
  const throttleMs = options.thinkingThrottleMs ?? DEFAULT_THINKING_THROTTLE_MS;
  const nowFn = options.now ?? (() => Date.now());
  let seq = options.startSeq ?? 0;

  let thinkingBuf = "";
  let thinkingChars = 0;
  let thinkingStartedAt: number | null = null;
  let lastThinkingEmittedAt: number | null = null;
  let thinkingDirty = false;
  const toolStartTimes = new Map<string, number>();

  const nextTimestamp = (): string => new Date(nowFn()).toISOString();

  const emit = (partial: Omit<FormattedStreamEvent, "seq" | "timestamp">): FormattedStreamEvent => {
    seq += 1;
    return { seq, ...partial, timestamp: nextTimestamp() };
  };

  const flushThinking = (force: boolean): FormattedStreamEvent | null => {
    if (!thinkingDirty || thinkingChars === 0) return null;
    const now = nowFn();
    const anchor = lastThinkingEmittedAt ?? thinkingStartedAt ?? now;
    if (!force && now - anchor < throttleMs) return null;
    lastThinkingEmittedAt = now;
    thinkingDirty = false;
    return emit({
      kind: "thinking",
      title: `思考中 (${thinkingChars} chars)`,
      detail: truncateTailPreview(thinkingBuf, MAX_THINKING_PREVIEW_CHARS),
      thinkingChars,
    });
  };

  const resetThinking = (): void => {
    thinkingBuf = "";
    thinkingChars = 0;
    thinkingStartedAt = null;
    lastThinkingEmittedAt = null;
    thinkingDirty = false;
  };

  return {
    feedRawLine(rawLine: string): FormattedStreamEvent[] {
      const obj = parseJsonLine(rawLine);
      if (!obj) return [];

      const type = typeof obj.type === "string" ? obj.type : "";
      if (type === "message_update") {
        const inner = obj.assistantMessageEvent as Record<string, unknown> | undefined;
        if (inner && inner.type === "thinking_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
          if (thinkingStartedAt === null) thinkingStartedAt = nowFn();
          thinkingChars += inner.delta.length;
          thinkingBuf += inner.delta;
          if (thinkingBuf.length > MAX_THINKING_PREVIEW_CHARS * 2) {
            thinkingBuf = thinkingBuf.slice(thinkingBuf.length - MAX_THINKING_PREVIEW_CHARS * 2);
          }
          thinkingDirty = true;
          const ev = flushThinking(false);
          return ev ? [ev] : [];
        }
        return [];
      }

      const out: FormattedStreamEvent[] = [];
      const flushBeforeOther = (): void => {
        const pending = flushThinking(true);
        if (pending) out.push(pending);
        resetThinking();
      };

      if (type === "session") {
        const sid = typeof obj.id === "string" ? obj.id : "";
        out.push(emit({ kind: "session", title: "会话启动", ...(sid ? { detail: sid } : {}) }));
        return out;
      }

      if (type === "tool_execution_start") {
        flushBeforeOther();
        const toolName = typeof obj.toolName === "string" ? obj.toolName : "tool";
        const toolCallId = typeof obj.toolCallId === "string" ? obj.toolCallId : undefined;
        toolStartTimes.set(toolCallId ?? toolName, nowFn());
        const detail = summarizeToolArgs(obj.args);
        out.push(emit({
          kind: "tool_start",
          title: toolName,
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(detail ? { detail } : {}),
        }));
        return out;
      }

      if (type === "tool_execution_end") {
        const toolName = typeof obj.toolName === "string" ? obj.toolName : "tool";
        const toolCallId = typeof obj.toolCallId === "string" ? obj.toolCallId : undefined;
        const startKey = toolCallId ?? toolName;
        const started = toolStartTimes.get(startKey);
        if (started !== undefined) toolStartTimes.delete(startKey);
        const durationMs = started !== undefined ? Math.max(0, nowFn() - started) : undefined;
        const isError = obj.isError === true;
        out.push(emit({
          kind: "tool_end",
          title: toolName,
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          isError,
          ...(durationMs !== undefined ? { durationMs } : {}),
        }));
        return out;
      }

      if (type === "message_end" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as Record<string, unknown>;
        if (msg.role === "assistant") {
          flushBeforeOther();
          const text = extractTextFromContent(msg.content);
          const errText = typeof msg.errorMessage === "string" && msg.errorMessage ? msg.errorMessage : "";
          const detail = text
            ? truncateHead(text, MAX_ASSISTANT_DETAIL_CHARS)
            : errText
              ? truncateHead(errText, MAX_ASSISTANT_DETAIL_CHARS)
              : undefined;
          if (detail) {
            out.push(emit({
              kind: "assistant",
              title: msg.stopReason === "error" ? "模型报错" : "助手输出",
              detail,
              ...(msg.stopReason === "error" ? { isError: true } : {}),
            }));
          }
        }
        return out;
      }

      if (type === "turn_end") {
        flushBeforeOther();
        out.push(emit({ kind: "turn_end", title: "回合结束" }));
        return out;
      }

      if (type === "session_compact" || type === "compaction_end") {
        flushBeforeOther();
        out.push(emit({ kind: "compact", title: "上下文压缩完成" }));
        return out;
      }

      if (type === "auto_retry_end" && obj.success === false) {
        flushBeforeOther();
        const err = typeof obj.finalError === "string"
          ? obj.finalError
          : typeof obj.error === "string"
            ? obj.error
            : "auto retry failed";
        out.push(emit({
          kind: "retry_failed",
          title: "自动重试失败",
          detail: truncateHead(err, MAX_ASSISTANT_DETAIL_CHARS),
          isError: true,
        }));
        return out;
      }

      if (type === "agent_settled" && obj.aborted === true) {
        flushBeforeOther();
        out.push(emit({ kind: "aborted", title: "执行中止" }));
        return out;
      }

      return out;
    },

    emitStatus(status: string, detail?: string): FormattedStreamEvent {
      return emit({
        kind: "status",
        title: `状态变更: ${status}`,
        ...(detail ? { detail: truncateHead(detail, MAX_ASSISTANT_DETAIL_CHARS) } : {}),
        ...(status === "failed" ? { isError: true } : {}),
      });
    },

    flush(): FormattedStreamEvent[] {
      const pending = flushThinking(true);
      resetThinking();
      return pending ? [pending] : [];
    },
  };
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return ` (${Math.round(ms)}ms)`;
  return ` (${(ms / 1000).toFixed(1)}s)`;
}

export function formatTerminalLine(ev: FormattedStreamEvent): string {
  const timePart = ev.timestamp.length >= 19 ? ev.timestamp.slice(11, 19) : ev.timestamp;
  const prefix = `[${timePart}]`;
  if (ev.kind === "thinking") {
    const preview = ev.detail ? ` ${truncateHead(ev.detail.replace(/\s+/g, " "), 80)}` : "";
    return `${prefix} 💭 ${ev.title}${preview}`;
  }
  if (ev.kind === "tool_start") {
    return `${prefix} ▶ ${ev.toolName ?? ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
  }
  if (ev.kind === "tool_end") {
    const mark = ev.isError ? "✖" : "✓";
    return `${prefix} ${mark} ${ev.toolName ?? ev.title}${formatDuration(ev.durationMs)}`;
  }
  if (ev.kind === "assistant") {
    return `${prefix} 💬 ${ev.detail ? truncateHead(ev.detail.replace(/\s+/g, " "), 120) : ev.title}`;
  }
  if (ev.kind === "compact") return `${prefix} 🗜 ${ev.title}`;
  if (ev.kind === "retry_failed") return `${prefix} ⚠ ${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
  if (ev.kind === "status") return `${prefix} ● ${ev.title}${ev.detail ? ` — ${ev.detail}` : ""}`;
  if (ev.kind === "turn_end") return `${prefix} ─ ${ev.title}`;
  return `${prefix} · ${ev.title}${ev.detail ? `: ${ev.detail}` : ""}`;
}

function findNextNewlineOffset(fd: number, startOffset: number, fileSize: number): number | null {
  const probe = Buffer.allocUnsafe(SKIP_SCAN_CHUNK_BYTES);
  let pos = startOffset;
  while (pos < fileSize) {
    const toRead = Math.min(probe.length, fileSize - pos);
    const n = readSync(fd, probe, 0, toRead, pos);
    if (n <= 0) return null;
    const nl = probe.subarray(0, n).indexOf(0x0a);
    if (nl >= 0) return pos + nl + 1;
    pos += n;
  }
  return null;
}

export function readFormattedEventsDelta(
  eventsPath: string,
  offset = 0,
  options: { maxBytes?: number; maxEvents?: number } = {},
): EventsDeltaResult {
  const maxBytes = Math.max(64, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxEvents = Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS));
  const requestedOffset = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;

  let fd: number;
  try {
    fd = openSync(eventsPath, "r");
  } catch {
    return { offset: requestedOffset, nextOffset: requestedOffset, truncated: false, hasMore: false, events: [] };
  }

  try {
    const fileSize = fstatSync(fd).size;
    let truncated = false;
    let startOffset = requestedOffset;
    if (startOffset > fileSize) {
      startOffset = 0;
      truncated = true;
    }
    if (startOffset >= fileSize) {
      return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
    }

    const toRead = Math.min(maxBytes, fileSize - startOffset);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, startOffset);
    if (bytesRead <= 0) {
      return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
    }
    const slice = buf.subarray(0, bytesRead);

    const firstNewline = slice.indexOf(0x0a);
    if (firstNewline < 0) {
      // 若窗口触及 EOF 说明末尾仍是未写完的半行：暂停等待下次补全；
      // 若尚未到 EOF 说明单行超过 maxBytes：前向扫描到下一个换行并跳过，避免 livelock。
      if (startOffset + bytesRead >= fileSize) {
        return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
      }
      const nextAfterOversized = findNextNewlineOffset(fd, startOffset + bytesRead, fileSize);
      if (nextAfterOversized === null) {
        return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
      }
      return {
        offset: startOffset,
        nextOffset: nextAfterOversized,
        truncated,
        hasMore: nextAfterOversized < fileSize,
        events: [],
      };
    }

    const events: FormattedStreamEvent[] = [];
    let cursor = 0;
    let consumedBytes = 0;
    while (cursor < bytesRead && events.length < maxEvents) {
      const nl = slice.indexOf(0x0a, cursor);
      if (nl < 0) break;
      const lineBuf = slice.subarray(cursor, nl);
      cursor = nl + 1;
      consumedBytes = cursor;
      const lineStr = lineBuf.toString("utf8").trim();
      if (!lineStr) continue;
      try {
        const parsed = JSON.parse(lineStr) as FormattedStreamEvent;
        if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
          events.push(parsed);
        }
      } catch {
        // 跳过损坏行
      }
    }

    const nextOffset = startOffset + consumedBytes;
    const hasMore = nextOffset < fileSize && (
      events.length >= maxEvents || startOffset + bytesRead < fileSize
    );
    return { offset: startOffset, nextOffset, truncated, hasMore, events };
  } finally {
    closeSync(fd);
  }
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  let taskId = "";
  let follow = false;
  let jsonOut = false;

  for (const arg of argv) {
    if (arg === "--follow" || arg === "-f") follow = true;
    else if (arg === "--json") jsonOut = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("用法: node plugins/pi-worker/src/stream.ts <taskId> [--follow] [--json]\n");
      process.exit(0);
    } else if (!taskId) {
      taskId = arg;
    }
  }

  if (!taskId) {
    process.stderr.write("错误: 缺少 taskId\n");
    process.exit(2);
  }

  const store = new TaskStore(resolveStateDir(process.env));
  const initial = store.load(taskId);
  if (!initial) {
    process.stderr.write(`错误: 未找到任务 ${taskId}\n`);
    process.exit(1);
  }

  let offset = 0;
  const drain = (): void => {
    for (;;) {
      const delta = readFormattedEventsDelta(initial.eventsPath, offset);
      offset = delta.nextOffset;
      for (const ev of delta.events) {
        process.stdout.write(`${jsonOut ? JSON.stringify(ev) : formatTerminalLine(ev)}\n`);
      }
      if (!delta.hasMore) break;
    }
  };

  drain();
  if (!follow) return;

  for (;;) {
    const rec = store.load(taskId);
    drain();
    if (!rec || rec.status !== "running") break;
    await new Promise((r) => setTimeout(r, 400));
  }
  drain();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runCli();
}
