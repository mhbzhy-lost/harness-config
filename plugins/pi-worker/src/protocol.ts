import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type WorkerOutcomeStatus = "done" | "needs_input" | "blocked" | "failed";

export interface WorkerOutcome {
  status: WorkerOutcomeStatus;
  summary: string;
  question: string | null;
  options: string[];
  verifiedCommands: string[];
  stopReason: string | null;
  error: string | null;
}

export type StreamEventKind =
  | "session"
  | "tool_start"
  | "tool_end"
  | "assistant_message"
  | "turn_end"
  | "compact"
  | "retry_failed"
  | "agent_aborted"
  | "other";

export interface StreamEventSummary {
  kind: StreamEventKind;
  toolName?: string;
  text?: string;
  stopReason?: string;
  errorMessage?: string;
  sessionId?: string;
  timestamp: string;
}

export interface AssistantMessageExtract {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

export const PROTOCOL_APPEND_PROMPT = [
  "你当前运行在 pi-worker 无头子代理进程中，受父代理编排并支持挂起后沿同一会话续跑：",
  "1. 当前为无头模式：bash_async 与交互提问工具已禁用，所有命令（含测试与构建）直接使用同步 bash 执行。",
  "2. 上下文 hygiene：仅在后续仍有多轮工作（刚完成一个已闭合的探索、调试或阶段实施段落）或准备调用 worker_ask_parent 挂起等待续跑、且上下文存在冗余工具噪声时，执行一次尾部 compress 压缩已闭合段落；若已准备直接调用 worker_finish 结束任务，跳过 compress 直接收尾。",
  "3. 遇到无法自行决断的需求/架构歧义时，调用 worker_ask_parent 工具（填写清晰的 question、可选 options 与当前进展 summary），不要编造假设；收到工具回执后等待本轮自动挂起退出。",
  "4. 遇到缺少凭据、权限、依赖等无法绕过的外部阻塞时，调用 worker_report_blocked 工具（说明 reason 与 summary）。",
  "5. 完成目标并跑通验收命令后，优先调用 worker_finish 工具汇报最终 summary 与 verifiedCommands（精确命令及结果）。",
].join("\n");

const VALID_OUTCOME_STATUSES = new Set<string>(["done", "needs_input", "blocked", "failed"]);
const MAX_EVENT_TEXT_CHARS = 500;

export function truncateTail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `...(truncated)\n${text.slice(text.length - maxChars)}`;
}

function truncateHead(text: string, maxChars = MAX_EVENT_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLines = (): void => {
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      let line = buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf("\n");
    }
  };

  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      emitLines();
    },
    flush(): void {
      buffer += decoder.end();
      emitLines();
      if (buffer.length > 0) {
        const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        onLine(tail);
      }
    },
  };
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractAssistantMessage(line: string): AssistantMessageExtract | null {
  const obj = parseJsonObject(line);
  if (!obj) return null;

  if (obj.type === "message_end" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (msg.role !== "assistant") return null;
    const result: AssistantMessageExtract = {
      text: extractTextFromContent(msg.content),
    };
    if (typeof msg.stopReason === "string") result.stopReason = msg.stopReason;
    if (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0) {
      result.errorMessage = msg.errorMessage;
    }
    return result;
  }

  return null;
}

export function parsePiJsonLine(line: string): StreamEventSummary | null {
  const obj = parseJsonObject(line);
  if (!obj) return null;

  const timestamp = new Date().toISOString();
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "session") {
    return {
      kind: "session",
      ...(typeof obj.id === "string" ? { sessionId: obj.id } : {}),
      timestamp,
    };
  }
  if (type === "tool_execution_start") {
    return {
      kind: "tool_start",
      ...(typeof obj.toolName === "string" ? { toolName: obj.toolName } : {}),
      timestamp,
    };
  }
  if (type === "tool_execution_end") {
    return {
      kind: "tool_end",
      ...(typeof obj.toolName === "string" ? { toolName: obj.toolName } : {}),
      timestamp,
    };
  }
  if (type === "turn_end") {
    return { kind: "turn_end", timestamp };
  }
  if (type === "session_compact" || type === "compaction_end") {
    return { kind: "compact", timestamp };
  }
  if (type === "auto_retry_end" && obj.success === false) {
    const errText = typeof obj.finalError === "string"
      ? obj.finalError
      : typeof obj.error === "string"
        ? obj.error
        : "auto retry failed";
    return {
      kind: "retry_failed",
      errorMessage: truncateHead(errText),
      timestamp,
    };
  }
  if (type === "agent_settled" && obj.aborted === true) {
    return { kind: "agent_aborted", timestamp };
  }
  if (type === "message_end" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      return {
        kind: "assistant_message",
        ...(text ? { text: truncateHead(text) } : {}),
        ...(typeof msg.stopReason === "string" ? { stopReason: msg.stopReason } : {}),
        ...(typeof msg.errorMessage === "string" && msg.errorMessage
          ? { errorMessage: truncateHead(msg.errorMessage) }
          : {}),
        timestamp,
      };
    }
  }

  return { kind: "other", timestamp };
}

/** 运行态实时插话队列条目（磁盘队列 steers/<taskId>.jsonl，每行一条 JSON） */
export interface SteerQueueEntry {
  id: string;
  message: string;
  createdAt: string;
  source?: "agent" | "app";
}

/**
 * 安全追加一条 steer 队列条目：目录 0o700、文件 0o600。
 * 追加为单行 JSON + \n，跨进程 O_APPEND 写入天然原子（单行远小于 PIPE_BUF）。
 */
export function appendSteerEntry(steerPath: string, entry: SteerQueueEntry): void {
  const dir = dirname(steerPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(steerPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  chmodSync(steerPath, 0o600);
}

/** 读取 steer 队列全部合法条目；文件不存在返回空数组，损坏行逐行跳过容错。 */
export function readSteerEntries(steerPath: string): SteerQueueEntry[] {
  let raw: string;
  try {
    raw = readFileSync(steerPath, "utf8");
  } catch {
    return [];
  }
  const entries: SteerQueueEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SteerQueueEntry>;
      if (
        parsed && typeof parsed === "object"
        && typeof parsed.id === "string" && parsed.id
        && typeof parsed.message === "string" && parsed.message.trim()
      ) {
        entries.push({
          id: parsed.id,
          message: parsed.message,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
          ...(parsed.source === "agent" || parsed.source === "app" ? { source: parsed.source } : {}),
        });
      }
    } catch {
      // 跳过损坏行
    }
  }
  return entries;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function writeOutcomeFile(filePath: string, outcome: WorkerOutcome): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.outcome-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(outcome, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* 清理临时文件失败忽略 */ }
    throw err;
  }
}

export function readOutcomeFile(filePath: string): WorkerOutcome | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.status !== "string" || !VALID_OUTCOME_STATUSES.has(obj.status)) return null;
  if (typeof obj.summary !== "string") return null;

  return {
    status: obj.status as WorkerOutcomeStatus,
    summary: obj.summary,
    question: typeof obj.question === "string" ? obj.question : null,
    options: normalizeStringArray(obj.options),
    verifiedCommands: normalizeStringArray(obj.verifiedCommands),
    stopReason: typeof obj.stopReason === "string" ? obj.stopReason : null,
    error: typeof obj.error === "string" ? obj.error : null,
  };
}
