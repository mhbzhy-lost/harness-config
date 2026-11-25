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
  | "text_delta"
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
  round?: number;
  blockId?: number;
  kind: FormattedEventKind;
  title: string;
  detail?: string;
  preview?: string;
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
  textThrottleMs?: number;
  now?: () => number;
  startSeq?: number;
  round?: number;
}

const DEFAULT_THINKING_THROTTLE_MS = 500;
const DEFAULT_TEXT_THROTTLE_MS = 250;
const MAX_TERMINAL_ARG_CHARS = 160;
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_SINGLE_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100;
const SKIP_SCAN_CHUNK_BYTES = 64 * 1024;
const PRIMARY_ARG_KEYS = [
  "command",
  "CommandLine",
  "path",
  "Path",
  "filePath",
  "file_path",
  "pattern",
  "query",
  "question",
  "reason",
] as const;

function truncateHead(text: string, maxChars: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function summarizeToolOutput(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed || undefined;
  }
  if (!result || typeof result !== "object") return undefined;
  const obj = result as Record<string, unknown>;
  const contentText = extractTextFromContent(obj.content);
  if (contentText.trim()) {
    return contentText.trim();
  }
  for (const key of ["output", "error", "message", "text"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  const fallback = obj.structuredContent ?? obj.details;
  if (fallback !== undefined) {
    try {
      const raw = JSON.stringify(fallback, null, 2);
      if (raw && raw !== "{}" && raw !== "[]") {
        return raw;
      }
    } catch {
      // 忽略序列化失败
    }
  }
  return undefined;
}

function summarizeToolArgs(args: unknown): { detail?: string; preview?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};

  let primaryVal: string | undefined;
  let primaryKey: string | undefined;
  for (const key of PRIMARY_ARG_KEYS) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      primaryVal = val.trim();
      primaryKey = key;
      break;
    }
  }

  // 单主键（如 bash { command }）直接保留原文；多参数（如 edit { path, oldText, newText }）保留完整 JSON 供展开查看
  if (primaryVal && keys.length === 1 && keys[0] === primaryKey) {
    return { detail: primaryVal, preview: truncateHead(primaryVal.replace(/\s+/g, " "), MAX_TERMINAL_ARG_CHARS) };
  }

  try {
    const raw = JSON.stringify(obj, null, 2);
    if (raw && raw !== "{}") {
      const preview = primaryVal
        ? truncateHead(primaryVal.replace(/\s+/g, " "), MAX_TERMINAL_ARG_CHARS)
        : truncateHead(raw.replace(/\s+/g, " "), MAX_TERMINAL_ARG_CHARS);
      return { detail: raw, preview };
    }
  } catch {
    // 忽略序列化失败
  }
  return primaryVal ? { detail: primaryVal, preview: truncateHead(primaryVal.replace(/\s+/g, " "), MAX_TERMINAL_ARG_CHARS) } : {};
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
  const thinkingThrottleMs = options.thinkingThrottleMs ?? DEFAULT_THINKING_THROTTLE_MS;
  const textThrottleMs = options.textThrottleMs ?? DEFAULT_TEXT_THROTTLE_MS;
  const nowFn = options.now ?? (() => Date.now());
  const round = options.round;
  let seq = options.startSeq ?? 0;
  let nextBlockId = 0;

  let thinkingBlockId: number | null = null;
  let pendingThinkingDelta = "";
  let thinkingChars = 0;
  let thinkingStartedAt: number | null = null;
  let lastThinkingEmittedAt: number | null = null;

  let textBlockId: number | null = null;
  let pendingTextDelta = "";
  let textStartedAt: number | null = null;
  let lastTextEmittedAt: number | null = null;

  const toolStartTimes = new Map<string, number>();

  const nextTimestamp = (): string => new Date(nowFn()).toISOString();

  const emit = (partial: Omit<FormattedStreamEvent, "seq" | "timestamp" | "round">): FormattedStreamEvent => {
    seq += 1;
    return {
      seq,
      ...(round !== undefined ? { round } : {}),
      ...partial,
      timestamp: nextTimestamp(),
    };
  };

  const flushThinking = (force: boolean): FormattedStreamEvent | null => {
    if (!pendingThinkingDelta || thinkingChars === 0) return null;
    const now = nowFn();
    const anchor = lastThinkingEmittedAt ?? thinkingStartedAt ?? now;
    if (!force && now - anchor < thinkingThrottleMs) return null;
    lastThinkingEmittedAt = now;
    const chunk = pendingThinkingDelta;
    pendingThinkingDelta = "";
    return emit({
      kind: "thinking",
      ...(thinkingBlockId !== null ? { blockId: thinkingBlockId } : {}),
      title: `思考中 (${thinkingChars} chars)`,
      detail: chunk,
      thinkingChars,
    });
  };

  const resetThinking = (): void => {
    thinkingBlockId = null;
    pendingThinkingDelta = "";
    thinkingChars = 0;
    thinkingStartedAt = null;
    lastThinkingEmittedAt = null;
  };

  const flushText = (force: boolean): FormattedStreamEvent | null => {
    if (!pendingTextDelta) return null;
    const now = nowFn();
    const anchor = lastTextEmittedAt ?? textStartedAt ?? now;
    if (!force && now - anchor < textThrottleMs) return null;
    lastTextEmittedAt = now;
    const chunk = pendingTextDelta;
    pendingTextDelta = "";
    return emit({
      kind: "text_delta",
      ...(textBlockId !== null ? { blockId: textBlockId } : {}),
      title: "助手输出",
      detail: chunk,
    });
  };

  const resetText = (): void => {
    textBlockId = null;
    pendingTextDelta = "";
    textStartedAt = null;
    lastTextEmittedAt = null;
  };

  return {
    feedRawLine(rawLine: string): FormattedStreamEvent[] {
      const obj = parseJsonLine(rawLine);
      if (!obj) return [];

      const type = typeof obj.type === "string" ? obj.type : "";
      if (type === "message_update") {
        const inner = obj.assistantMessageEvent as Record<string, unknown> | undefined;
        if (!inner) return [];

        if (inner.type === "thinking_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
          const out: FormattedStreamEvent[] = [];
          const pendingText = flushText(true);
          if (pendingText) out.push(pendingText);
          resetText();

          if (thinkingBlockId === null) {
            nextBlockId += 1;
            thinkingBlockId = nextBlockId;
            thinkingStartedAt = nowFn();
          }
          thinkingChars += inner.delta.length;
          pendingThinkingDelta += inner.delta;
          const ev = flushThinking(false);
          if (ev) out.push(ev);
          return out;
        }

        if (inner.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
          const out: FormattedStreamEvent[] = [];
          const pendingThinking = flushThinking(true);
          if (pendingThinking) out.push(pendingThinking);
          resetThinking();

          if (textBlockId === null) {
            nextBlockId += 1;
            textBlockId = nextBlockId;
            textStartedAt = nowFn();
          }
          pendingTextDelta += inner.delta;
          const ev = flushText(false);
          if (ev) out.push(ev);
          return out;
        }

        return [];
      }

      const out: FormattedStreamEvent[] = [];
      const flushAllStreams = (): void => {
        const pendingThinking = flushThinking(true);
        if (pendingThinking) out.push(pendingThinking);
        resetThinking();
        const pendingText = flushText(true);
        if (pendingText) out.push(pendingText);
        resetText();
      };

      if (type === "session") {
        const sid = typeof obj.id === "string" ? obj.id : "";
        out.push(emit({ kind: "session", title: "会话启动", ...(sid ? { detail: sid } : {}) }));
        return out;
      }

      if (type === "tool_execution_start") {
        flushAllStreams();
        const toolName = typeof obj.toolName === "string" ? obj.toolName : "tool";
        const toolCallId = typeof obj.toolCallId === "string" ? obj.toolCallId : undefined;
        toolStartTimes.set(toolCallId ?? toolName, nowFn());
        const { detail, preview } = summarizeToolArgs(obj.args);
        out.push(emit({
          kind: "tool_start",
          title: toolName,
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(detail ? { detail } : {}),
          ...(preview ? { preview } : {}),
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
        const detail = summarizeToolOutput(obj.result);
        out.push(emit({
          kind: "tool_end",
          title: toolName,
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(detail ? { detail } : {}),
          isError,
          ...(durationMs !== undefined ? { durationMs } : {}),
        }));
        return out;
      }

      if (type === "message_end" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as Record<string, unknown>;
        if (msg.role === "assistant") {
          const pendingThinking = flushThinking(true);
          if (pendingThinking) out.push(pendingThinking);
          resetThinking();

          const activeBlockId = textBlockId;
          resetText();

          const text = extractTextFromContent(msg.content).trim();
          const errText = typeof msg.errorMessage === "string" && msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : "";
          const detail = text || errText || undefined;
          if (detail) {
            out.push(emit({
              kind: "assistant",
              ...(activeBlockId !== null ? { blockId: activeBlockId } : {}),
              title: msg.stopReason === "error" ? "模型报错" : "助手输出",
              detail,
              ...(msg.stopReason === "error" ? { isError: true } : {}),
            }));
          }
        }
        return out;
      }

      if (type === "turn_end") {
        flushAllStreams();
        out.push(emit({ kind: "turn_end", title: "回合结束" }));
        return out;
      }

      if (type === "session_compact" || type === "compaction_end") {
        flushAllStreams();
        out.push(emit({ kind: "compact", title: "上下文压缩完成" }));
        return out;
      }

      if (type === "auto_retry_end" && obj.success === false) {
        flushAllStreams();
        const err = typeof obj.finalError === "string"
          ? obj.finalError
          : typeof obj.error === "string"
            ? obj.error
            : "auto retry failed";
        out.push(emit({
          kind: "retry_failed",
          title: "自动重试失败",
          detail: err.trim(),
          isError: true,
        }));
        return out;
      }

      if (type === "agent_settled" && obj.aborted === true) {
        flushAllStreams();
        out.push(emit({ kind: "aborted", title: "执行中止" }));
        return out;
      }

      return out;
    },

    emitStatus(status: string, detail?: string): FormattedStreamEvent {
      const cleaned = detail?.trim();
      return emit({
        kind: "status",
        title: `状态变更: ${status}`,
        ...(cleaned ? { detail: cleaned } : {}),
        ...(status === "failed" ? { isError: true } : {}),
      });
    },

    flush(): FormattedStreamEvent[] {
      const out: FormattedStreamEvent[] = [];
      const pendingThinking = flushThinking(true);
      if (pendingThinking) out.push(pendingThinking);
      resetThinking();
      const pendingText = flushText(true);
      if (pendingText) out.push(pendingText);
      resetText();
      return out;
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
    const rawPreview = ev.preview ?? ev.detail;
    const summary = rawPreview ? `: ${truncateHead(rawPreview.replace(/\s+/g, " "), MAX_TERMINAL_ARG_CHARS)}` : "";
    return `${prefix} ▶ ${ev.toolName ?? ev.title}${summary}`;
  }
  if (ev.kind === "tool_end") {
    const mark = ev.isError ? "✖" : "✓";
    const errPreview = ev.isError && ev.detail
      ? `: ${truncateHead(ev.detail.replace(/\s+/g, " "), 120)}`
      : "";
    return `${prefix} ${mark} ${ev.toolName ?? ev.title}${formatDuration(ev.durationMs)}${errPreview}`;
  }
  if (ev.kind === "assistant" || ev.kind === "text_delta") {
    return `${prefix} 💬 ${ev.detail ? truncateHead(ev.detail.replace(/\s+/g, " "), 120) : ev.title}`;
  }
  if (ev.kind === "compact") return `${prefix} 🗜 ${ev.title}`;
  if (ev.kind === "retry_failed") return `${prefix} ⚠ ${ev.title}${ev.detail ? `: ${truncateHead(ev.detail.replace(/\s+/g, " "), 160)}` : ""}`;
  if (ev.kind === "status") return `${prefix} ● ${ev.title}${ev.detail ? ` — ${truncateHead(ev.detail.replace(/\s+/g, " "), 160)}` : ""}`;
  if (ev.kind === "turn_end") return `${prefix} ─ ${ev.title}`;
  return `${prefix} · ${ev.title}${ev.detail ? `: ${truncateHead(ev.detail.replace(/\s+/g, " "), 160)}` : ""}`;
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

function parseFormattedEventLine(lineStr: string): FormattedStreamEvent | null {
  const trimmed = lineStr.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as FormattedStreamEvent;
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
      return parsed;
    }
  } catch {
    // 跳过损坏行
  }
  return null;
}

export function readFormattedEventsDelta(
  eventsPath: string,
  offset = 0,
  options: { maxBytes?: number; maxEvents?: number; maxSingleLineBytes?: number } = {},
): EventsDeltaResult {
  const maxBytes = Math.max(64, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxEvents = Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS));
  const maxSingleLineBytes = Math.max(maxBytes, Math.trunc(options.maxSingleLineBytes ?? DEFAULT_MAX_SINGLE_LINE_BYTES));
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
      // 若尚未到 EOF 说明单行超过批量窗口 maxBytes：前向找到换行并完整读出（仅超硬上限 maxSingleLineBytes 才跳过防 OOM/livelock）。
      if (startOffset + bytesRead >= fileSize) {
        return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
      }
      const nextAfterOversized = findNextNewlineOffset(fd, startOffset + bytesRead, fileSize);
      if (nextAfterOversized === null) {
        return { offset: startOffset, nextOffset: startOffset, truncated, hasMore: false, events: [] };
      }
      const fullLineBytes = nextAfterOversized - startOffset;
      const events: FormattedStreamEvent[] = [];
      if (fullLineBytes <= maxSingleLineBytes) {
        const lineBuf = Buffer.allocUnsafe(fullLineBytes);
        let filled = 0;
        while (filled < fullLineBytes) {
          const n = readSync(fd, lineBuf, filled, fullLineBytes - filled, startOffset + filled);
          if (n <= 0) break;
          filled += n;
        }
        const ev = parseFormattedEventLine(lineBuf.subarray(0, filled).toString("utf8"));
        if (ev) events.push(ev);
      }
      return {
        offset: startOffset,
        nextOffset: nextAfterOversized,
        truncated,
        hasMore: nextAfterOversized < fileSize,
        events,
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
      const ev = parseFormattedEventLine(lineBuf.toString("utf8"));
      if (ev) events.push(ev);
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
        if (!jsonOut && ev.kind === "text_delta") continue;
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
