import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_APPEND_PROMPT,
  appendSteerEntry,
  createLineSplitter,
  extractAssistantMessage,
  parsePiJsonLine,
  readOutcomeFile,
  truncateTail,
} from "./protocol.ts";
import { TaskStore, defaultIsPidAlive, groupTasksByParentSession, validateWorkerTier } from "./store.ts";
import type {
  ExecutedCommandEvidence,
  TaskRecord,
  TaskSessionGroup,
  TaskStatus,
  TaskSummary,
  WorkerTier,
} from "./store.ts";
import { appendSteerEvent, createEventFormatter } from "./stream.ts";
import type { FormattedStreamEvent } from "./stream.ts";

export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_EXCLUDE_TOOLS = [
  "ask_question",
  "ask_user_question",
  "bash_async",
  "bash_async_status",
] as const;
export const READONLY_EXCLUDE_TOOLS = ["write", "edit"] as const;
const READONLY_APPEND_PROMPT =
  "6. 当前为只读模式（readOnly=true）：write 与 edit 工具已禁用，严禁通过 bash 创建、修改或删除项目源码/配置文件（测试或构建命令产生的正常临时产物除外）。";

export const WORKER_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker-ext.ts");

/** 任务/会话标题统一截断长度 */
export const MAX_TITLE_CHARS = 48;

/** 清洗标题：去首尾空白、合并换行/连续空白、截断到 MAX_TITLE_CHARS */
export function sanitizeTaskTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_TITLE_CHARS ? `${cleaned.slice(0, MAX_TITLE_CHARS)}…` : cleaned;
}

/** 从 prompt 提取首条有意义文本行作为默认标题（去除 Markdown/列表/常见任务前缀后截断） */
export function extractTitleFromPrompt(prompt: string): string | undefined {
  if (typeof prompt !== "string") return undefined;
  for (const rawLine of prompt.split(/\r?\n/)) {
    let line = rawLine.trim();
    // 反复剥离常见前缀：Markdown 标题/列表/引用/编号，以及“任务目标：”等标签
    let prev = "";
    while (line && line !== prev) {
      prev = line;
      line = line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)、]\s*/, "")
        .replace(/^>\s*/, "")
        .replace(/^(任务目标|任务说明|任务|目标|只读调研|调研|背景|需求)[:：]\s*/, "")
        .trim();
    }
    // 跳过纯分隔线/代码围栏等无意义行
    if (!line || /^[-=*_`~]{3,}$/.test(line)) continue;
    return sanitizeTaskTitle(line);
  }
  return undefined;
}

const MAX_RECENT_EVENTS = 10;
const MAX_EXECUTED_COMMANDS = 50;
const MAX_EXECUTED_COMMAND_PREVIEW_CHARS = 300;
const MAX_STDERR_CHARS = 16 * 1024;
const CANCEL_GRACE_MS = 3000;
const PIPE_DRAIN_GRACE_MS = 1500;
const STREAM_END_TIMEOUT_MS = 1000;
const GIT_STATUS_TIMEOUT_MS = 2000;
const MAX_GIT_STATUS_LINES = 50;

export interface StartTaskInput {
  cwd: string;
  prompt: string;
  parentSessionId?: string;
  title?: string;
  parentSessionTitle?: string;
  tier?: WorkerTier;
  readOnly?: boolean;
  model?: string;
  provider?: string;
  thinking?: string;
  excludeTools?: string[];
  waitSeconds?: number;
  waitUntilSettled?: boolean;
  onTaskCreated?: (taskId: string) => void;
  onProgress?: (event: FormattedStreamEvent) => void;
}

export interface ReplyTaskInput {
  taskId: string;
  reply: string;
  tier?: WorkerTier;
  model?: string;
  provider?: string;
  thinking?: string;
  waitSeconds?: number;
  waitUntilSettled?: boolean;
  onTaskCreated?: (taskId: string) => void;
  onProgress?: (event: FormattedStreamEvent) => void;
}

export interface StatusTaskInput {
  taskId: string;
  waitSeconds?: number;
}

export interface CancelTaskInput {
  taskId: string;
}

export interface SteerTaskInput {
  taskId: string;
  message: string;
  source?: "agent" | "app";
}

export interface SteerTaskResult {
  taskId: string;
  steerId: string;
  queued: true;
  status: "running";
  message: string;
  queuedAt: string;
  source: "agent" | "app";
}

export interface ListTasksInput {
  status?: TaskStatus;
  cwd?: string;
  parentSessionId?: string;
  limit?: number;
}

export interface PiWorkerRunnerOptions {
  store?: TaskStore;
  env?: NodeJS.ProcessEnv;
  piBinary?: string;
  collectGitChanges?: (cwd: string) => Promise<string[]>;
  pipeDrainGraceMs?: number;
  streamEndTimeoutMs?: number;
}

interface ActiveExecution {
  record: TaskRecord;
  child: ChildProcess;
  cancelled: boolean;
  finalizing: boolean;
  killTimer: NodeJS.Timeout | null;
  settled: Promise<TaskRecord>;
  waiters: Set<(record: TaskRecord) => void>;
  onProgress?: (event: FormattedStreamEvent) => void;
  emitSteerEvent?: (input: { message: string; source?: "agent" | "app"; timestamp?: string }) => Promise<FormattedStreamEvent>;
}

export function isNestedWorkerEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const depth = Number(env.PI_WORKER_DEPTH ?? "0");
  return (Number.isFinite(depth) && depth >= 1) || env.PI_SUBAGENT_CHILD === "1";
}

function isLauncherZsh(pathStr: string): boolean {
  const normalized = pathStr.replace(/\\/g, "/");
  if (normalized.endsWith("/pi/launcher.zsh")) return true;
  try {
    const resolved = realpathSync(pathStr).replace(/\\/g, "/");
    return resolved.endsWith("/pi/launcher.zsh");
  } catch {
    return false;
  }
}

function isUsableExecutable(candidate: string): boolean {
  try {
    if (isLauncherZsh(candidate)) return false;
    const info = statSync(candidate);
    if (!info.isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  const workerBin = env.PI_WORKER_BIN?.trim();
  if (workerBin) candidates.push(workerBin);
  const realBin = env.PI_REAL_BIN?.trim();
  if (realBin) candidates.push(realBin);

  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(join(trimmed, "pi"));
  }

  const home = env.HOME?.trim() || homedir();
  candidates.push(
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    join(home, ".local", "share", "pitty", "node_modules", ".bin", "pi"),
  );

  for (const candidate of candidates) {
    if (isUsableExecutable(candidate)) return candidate;
  }
  throw new Error(
    "未找到可用的 pi 可执行文件（已跳过 pi/launcher.zsh）；请安装 @earendil-works/pi-coding-agent 或设置 PI_WORKER_BIN",
  );
}

function validateCwd(cwd: string): string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("cwd 不能为空");
  }
  if (!isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("不是目录");
    }
  } catch {
    throw new Error(`cwd 不存在或不是目录: ${cwd}`);
  }
  return canonical;
}

function validateWaitSeconds(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_WAIT_SECONDS) {
    throw new Error(`waitSeconds 必须是 0–${MAX_WAIT_SECONDS} 之间的数字`);
  }
  return value;
}

function mergeExcludeTools(extra?: string[], readOnly = false): string[] {
  const merged = new Set<string>(DEFAULT_EXCLUDE_TOOLS);
  if (readOnly) {
    for (const tool of READONLY_EXCLUDE_TOOLS) merged.add(tool);
  }
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item === "string" && item.trim()) merged.add(item.trim());
    }
  }
  return [...merged];
}

function collectGitChanges(cwd: string): Promise<string[]> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["status", "--short"],
      { cwd, timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err || typeof stdout !== "string") {
          resolvePromise([]);
          return;
        }
        const lines = stdout
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .slice(0, MAX_GIT_STATUS_LINES);
        resolvePromise(lines);
      },
    );
  });
}

function tightenSessionPermissions(sessionDir: string, taskId: string): void {
  try {
    for (const name of readdirSync(sessionDir)) {
      if (name.endsWith(".jsonl") && name.includes(taskId)) {
        try { chmodSync(join(sessionDir, name), 0o600); } catch { /* best-effort */ }
      }
    }
  } catch {
    // best-effort
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 进程组不存在或平台不支持时降级为单进程 kill
    }
  }
  try { child.kill(signal); } catch { /* 已退出 */ }
}

async function waitUntilPidExits(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!defaultIsPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return !defaultIsPidAlive(pid);
}

function endStreamWithTimeout(stream: WriteStream, timeoutMs: number): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise<void>((resolveDone) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone();
    };
    const timer = setTimeout(() => {
      try { stream.destroy(); } catch { /* 忽略 */ }
      finish();
    }, timeoutMs);
    timer.unref?.();
    stream.once("error", finish);
    stream.once("close", finish);
    try {
      stream.end(finish);
    } catch {
      finish();
    }
  });
}

function stripDiagnosticNodeOptions(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      current += ch;
      inToken = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaped) current += "\\";
  if (inToken) tokens.push(current);

  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (
      tok === "--heapsnapshot-near-heap-limit"
      || tok === "--diagnostic-dir"
    ) {
      // 空格分隔参数形式（如 --diagnostic-dir /tmp/dir）一并跳过其值
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (
      tok.startsWith("--heapsnapshot-near-heap-limit=")
      || tok.startsWith("--diagnostic-dir=")
    ) {
      continue;
    }
    kept.push(/[\s"'\\]/.test(tok) ? `"${tok.replace(/([\\"])/g, "\\$1")}"` : tok);
  }
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export class PiWorkerRunner {
  readonly store: TaskStore;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly explicitPiBinary?: string;
  private readonly collectGitChangesFn: (cwd: string) => Promise<string[]>;
  private readonly pipeDrainGraceMs: number;
  private readonly streamEndTimeoutMs: number;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly inFlight = new Set<string>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: PiWorkerRunnerOptions = {}) {
    this.baseEnv = options.env ?? process.env;
    this.store = options.store ?? new TaskStore(undefined);
    this.explicitPiBinary = options.piBinary;
    this.collectGitChangesFn = options.collectGitChanges ?? collectGitChanges;
    this.pipeDrainGraceMs = options.pipeDrainGraceMs ?? PIPE_DRAIN_GRACE_MS;
    this.streamEndTimeoutMs = options.streamEndTimeoutMs ?? STREAM_END_TIMEOUT_MS;
  }

  private assertNotNested(): void {
    if (isNestedWorkerEnv(this.baseEnv)) {
      throw new Error("检测到处于 pi-worker / Pi 子代理嵌套环境中，禁止递归委派任务");
    }
  }

  private resolveBinary(): string {
    if (this.explicitPiBinary) return this.explicitPiBinary;
    return resolvePiBinary(this.baseEnv);
  }

  private buildArgs(record: TaskRecord): string[] {
    const appendPrompt = record.readOnly
      ? `${PROTOCOL_APPEND_PROMPT}\n${READONLY_APPEND_PROMPT}`
      : PROTOCOL_APPEND_PROMPT;
    const args: string[] = [
      "--mode", "json",
      "--print",
      "--session-dir", record.sessionDir,
      "--session-id", record.taskId,
      "-e", WORKER_EXTENSION_PATH,
      "--exclude-tools", record.excludeTools.join(","),
      "--append-system-prompt", appendPrompt,
    ];
    if (record.provider) args.push("--provider", record.provider);
    if (record.model) args.push("--model", record.model);
    if (record.thinking) args.push("--thinking", record.thinking);
    return args;
  }

  private buildChildEnv(record: TaskRecord): NodeJS.ProcessEnv {
    const currentDepth = Number(this.baseEnv.PI_WORKER_DEPTH ?? "0");
    const nextDepth = Number.isFinite(currentDepth) && currentDepth >= 0 ? currentDepth + 1 : 1;
    const childEnv: NodeJS.ProcessEnv = {
      ...this.baseEnv,
      PI_SUBAGENT_CHILD: "1",
      PI_WORKER_DEPTH: String(nextDepth),
      PI_WORKER_OUTCOME_FILE: record.outcomePath,
      PI_WORKER_STEER_FILE: record.steerPath,
    };
    delete childEnv.PI_SESSION_OWNER_ID;
    delete childEnv.PI_WORKER_AGY;
    const sanitizedNodeOpts = stripDiagnosticNodeOptions(childEnv.NODE_OPTIONS);
    if (sanitizedNodeOpts) {
      childEnv.NODE_OPTIONS = sanitizedNodeOpts;
    } else {
      delete childEnv.NODE_OPTIONS;
    }
    return childEnv;
  }

  private launchRound(
    record: TaskRecord,
    promptText: string,
    onProgress?: (event: FormattedStreamEvent) => void,
  ): ActiveExecution {
    const piBinary = this.resolveBinary();
    const args = this.buildArgs(record);
    const childEnv = this.buildChildEnv(record);

    const holdsWriteLock = !record.readOnly;
    if (holdsWriteLock) {
      const lockResult = this.store.acquireCwdLock(
        record.cwd,
        { taskId: record.taskId, ownerPid: process.pid },
        { inFlightTaskIds: this.inFlight },
      );
      if ("conflictTaskId" in lockResult) {
        throw new Error(
          `同一工作区 ${record.cwd} 已有运行中任务（taskId=${lockResult.conflictTaskId}），禁止并发写入`,
        );
      }
    }

    // 获锁后再清理上一轮残留 outcome 文件，避免并发冲突时误删原结果
    try { unlinkSync(record.outcomePath); } catch { /* 文件不存在忽略 */ }
    // 清理上一轮已失效/残留的 steer 队列，防止旧 steer 误触发新一轮
    try { unlinkSync(record.steerPath); } catch { /* 文件不存在忽略 */ }

    let child: ChildProcess;
    try {
      child = spawn(piBinary, args, {
        cwd: record.cwd,
        env: childEnv,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      if (holdsWriteLock) this.store.releaseCwdLock(record.cwd, record.taskId);
      throw err;
    }

    const now = new Date().toISOString();
    record.status = "running";
    record.pid = child.pid ?? null;
    const pidSig = child.pid ? this.store.getProcessSignature(child.pid) : null;
    if (pidSig) {
      record.pidSignature = pidSig;
    } else {
      delete record.pidSignature;
    }
    record.updatedAt = now;
    record.lastActivityAt = now;

    let logStream: WriteStream | null = null;
    let eventsStream: WriteStream | null = null;
    let execState: ActiveExecution;
    let resolveSettled!: (finalRecord: TaskRecord) => void;

    try {
      this.inFlight.add(record.taskId);
      this.store.save(record);

      const settled = new Promise<TaskRecord>((r) => { resolveSettled = r; });

      execState = {
        record,
        child,
        cancelled: false,
        finalizing: false,
        killTimer: null,
        settled,
        waiters: new Set(),
        ...(onProgress ? { onProgress } : {}),
      };
      this.active.set(record.taskId, execState);

      logStream = createWriteStream(record.logPath, { flags: "a", mode: 0o600 });
      logStream.on("error", () => { /* 日志写入失败不阻塞主流程 */ });
      eventsStream = createWriteStream(record.eventsPath, { flags: "a", mode: 0o600 });
      eventsStream.on("error", () => { /* 进度流写入失败不阻塞主流程 */ });
    } catch (err) {
      signalProcessGroup(child, "SIGKILL");
      try { logStream?.destroy(); } catch { /* 忽略 */ }
      try { eventsStream?.destroy(); } catch { /* 忽略 */ }
      this.active.delete(record.taskId);
      this.inFlight.delete(record.taskId);
      if (holdsWriteLock) this.store.releaseCwdLock(record.cwd, record.taskId);
      throw err;
    }

    const activeLogStream = logStream;
    const activeEventsStream = eventsStream;
    const eventFormatter = createEventFormatter({ round: record.roundCount });
    const pendingBashCommands = new Map<string, { command: string; startSeq: number }>();
    const compactCommandPreview = (text: string): string => {
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (cleaned.length <= MAX_EXECUTED_COMMAND_PREVIEW_CHARS) return cleaned;
      return `${cleaned.slice(0, MAX_EXECUTED_COMMAND_PREVIEW_CHARS)}…`;
    };
    const recordFormattedEvents = (formatted: FormattedStreamEvent[]): void => {
      for (const item of formatted) {
        activeEventsStream.write(`${JSON.stringify(item)}\n`);
        if (item.kind === "tool_start" && item.toolName === "bash") {
          const key = item.toolCallId ?? "bash";
          pendingBashCommands.set(key, {
            command: compactCommandPreview(item.detail ?? item.preview ?? ""),
            startSeq: item.seq,
          });
        } else if (item.kind === "tool_end" && item.toolName === "bash") {
          const key = item.toolCallId ?? "bash";
          const started = pendingBashCommands.get(key);
          if (started) pendingBashCommands.delete(key);
          const entry: ExecutedCommandEvidence = {
            round: item.round ?? record.roundCount,
            startSeq: started?.startSeq ?? item.seq,
            endSeq: item.seq,
            command: started?.command ?? "",
            isError: item.isError === true,
            ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          };
          record.executedCommands.push(entry);
          if (record.executedCommands.length > MAX_EXECUTED_COMMANDS) {
            record.executedCommands.splice(0, record.executedCommands.length - MAX_EXECUTED_COMMANDS);
          }
        }
        try { onProgress?.(item); } catch { /* 进度通知异常不阻塞主流程 */ }
      }
    };

    execState.emitSteerEvent = async (input) => {
      if (activeEventsStream.destroyed || activeEventsStream.writableEnded) {
        const fallbackEv = appendSteerEvent(record.eventsPath, {
          round: record.roundCount,
          message: input.message,
          source: input.source,
          timestamp: input.timestamp,
        });
        try { onProgress?.(fallbackEv); } catch { /* 进度通知异常不阻塞主流程 */ }
        return fallbackEv;
      }
      const ev = eventFormatter.emitSteer(input.message, input.source, input.timestamp);
      await new Promise<void>((resolveWrite) => {
        activeEventsStream.write(`${JSON.stringify(ev)}\n`, () => resolveWrite());
      });
      try { onProgress?.(ev); } catch { /* 进度通知异常不阻塞主流程 */ }
      return ev;
    };

    let lastAssistantText = "";
    let lastStopReason: string | null = null;
    let lastErrorMessage: string | null = null;
    let sawRetryFailed = false;
    let sawAgentAborted = false;
    let stderrBuf = "";
    let spawnError: Error | null = null;

    const lineSplitter = createLineSplitter((line) => {
      if (!line.trim()) return;
      activeLogStream.write(`${line}\n`);
      recordFormattedEvents(eventFormatter.feedRawLine(line));

      const assistant = extractAssistantMessage(line);
      if (assistant) {
        if (assistant.text) lastAssistantText = assistant.text;
        if (assistant.stopReason) lastStopReason = assistant.stopReason;
        if (assistant.errorMessage) lastErrorMessage = assistant.errorMessage;
      }

      const evt = parsePiJsonLine(line);
      if (!evt) return;

      const ts = evt.timestamp;
      record.lastActivityAt = ts;
      if (evt.kind === "tool_start" && evt.toolName) record.lastTool = evt.toolName;
      if (evt.kind === "turn_end") record.turnCount += 1;
      if (evt.kind === "retry_failed") {
        sawRetryFailed = true;
        if (evt.errorMessage) lastErrorMessage = evt.errorMessage;
      }
      if (evt.kind === "agent_aborted") sawAgentAborted = true;

      if (evt.kind !== "other") {
        record.recentEvents.push(evt);
        if (record.recentEvents.length > MAX_RECENT_EVENTS) {
          record.recentEvents.splice(0, record.recentEvents.length - MAX_RECENT_EVENTS);
        }
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      lineSplitter.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > MAX_STDERR_CHARS) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_STDERR_CHARS);
      }
    });

    child.stdin?.on("error", () => {
      // 子进程提前退出触发 EPIPE 时忽略，由 close/exit 统一处理
    });
    try {
      child.stdin?.end(promptText, "utf8");
    } catch {
      // 忽略同步写入错误，由 close/exit 统一处理
    }

    child.on("error", (err) => {
      spawnError = err;
    });

    const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (execState.killTimer) {
        clearTimeout(execState.killTimer);
        execState.killTimer = null;
      }

      try {
        lineSplitter.flush();
        recordFormattedEvents(eventFormatter.flush());
        await endStreamWithTimeout(activeLogStream, this.streamEndTimeoutMs);

        const endedAt = new Date().toISOString();
        record.pid = null;
        delete record.pidSignature;
        record.exitCode = exitCode;
        record.updatedAt = endedAt;
        record.lastActivityAt = endedAt;

        const outcome = readOutcomeFile(record.outcomePath);

        if (execState.cancelled) {
          record.status = "cancelled";
          record.error = "cancelled by user";
        } else if (spawnError) {
          record.status = "failed";
          record.error = `spawn error: ${spawnError.message}`;
        } else if (outcome) {
          record.status = outcome.status;
          record.summary = outcome.summary || null;
          record.question = outcome.question;
          record.options = outcome.options;
          record.verifiedCommands = outcome.verifiedCommands;
          record.stopReason = outcome.stopReason ?? lastStopReason;
          record.error = outcome.error;
        } else if (exitCode !== 0) {
          record.status = "failed";
          record.stopReason = lastStopReason;
          const detail = truncateTail(stderrBuf.trim(), 4000);
          record.error = detail || (signal ? `terminated by ${signal}` : `pi exited with code ${exitCode}`);
        } else if (
          lastStopReason === "error"
          || lastStopReason === "aborted"
          || sawRetryFailed
          || sawAgentAborted
        ) {
          record.status = "failed";
          record.stopReason = lastStopReason;
          record.error = lastErrorMessage ?? lastStopReason ?? "agent execution failed";
        } else {
          record.status = "done";
          record.stopReason = lastStopReason;
          record.summary = lastAssistantText ? truncateTail(lastAssistantText.trim(), 4000) : "";
          record.question = null;
          record.options = [];
          record.verifiedCommands = [];
          record.error = null;
        }

        recordFormattedEvents([
          eventFormatter.emitStatus(
            record.status,
            record.question ?? record.error ?? record.summary ?? undefined,
          ),
        ]);
        await endStreamWithTimeout(activeEventsStream, this.streamEndTimeoutMs);

        record.gitChanges = await this.collectGitChangesFn(record.cwd);
        tightenSessionPermissions(record.sessionDir, record.taskId);

        // 终态一次性原子落盘后再释放锁与 inFlight 保护，消除 orphan_process 竞态
        this.store.save(record);
      } finally {
        if (holdsWriteLock) this.store.releaseCwdLock(record.cwd, record.taskId);
        this.active.delete(record.taskId);
        this.inFlight.delete(record.taskId);

        for (const notify of execState.waiters) {
          notify(record);
        }
        execState.waiters.clear();
        resolveSettled(record);
      }
    };

    let finalized = false;
    let drainGraceTimer: NodeJS.Timeout | null = null;
    const triggerFinalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (drainGraceTimer) {
        clearTimeout(drainGraceTimer);
        drainGraceTimer = null;
      }
      if (finalized) return;
      finalized = true;
      execState.finalizing = true;
      void finalize(code, signal);
    };

    child.on("exit", (code, signal) => {
      if (finalized || drainGraceTimer) return;
      drainGraceTimer = setTimeout(() => {
        drainGraceTimer = null;
        if (finalized) return;
        // 先清杀继承管道的残留孙进程组（防止释锁后继续写入工作区），再销毁管道收尾
        signalProcessGroup(child, "SIGKILL");
        try { child.stdin?.destroy(); } catch { /* 忽略 */ }
        try { child.stdout?.destroy(); } catch { /* 忽略 */ }
        try { child.stderr?.destroy(); } catch { /* 忽略 */ }
        triggerFinalize(code, signal);
      }, this.pipeDrainGraceMs);
      drainGraceTimer.unref?.();
    });

    child.on("close", (code, signal) => {
      triggerFinalize(code, signal);
    });

    return execState;
  }

  private async waitForState(taskId: string, waitSeconds: number): Promise<TaskRecord> {
    const active = this.active.get(taskId);
    if (!active || waitSeconds <= 0) {
      return this.getSnapshot(taskId);
    }

    return await new Promise<TaskRecord>((resolveWait) => {
      const timer = setTimeout(() => {
        active.waiters.delete(onDone);
        resolveWait(this.getSnapshot(taskId));
      }, waitSeconds * 1000);
      timer.unref?.();

      const onDone = (finalRecord: TaskRecord): void => {
        clearTimeout(timer);
        resolveWait({ ...finalRecord, recentEvents: [...finalRecord.recentEvents] });
      };
      active.waiters.add(onDone);
    });
  }

  private getSnapshot(taskId: string): TaskRecord {
    const active = this.active.get(taskId);
    if (active) {
      return {
        ...active.record,
        options: [...active.record.options],
        verifiedCommands: [...active.record.verifiedCommands],
        executedCommands: active.record.executedCommands.map((c) => ({ ...c })),
        gitChanges: [...active.record.gitChanges],
        recentEvents: [...active.record.recentEvents],
      };
    }
    const loaded = this.store.load(taskId, { inFlightTaskIds: this.inFlight });
    if (!loaded) throw new Error(`未找到任务: ${taskId}`);
    return loaded;
  }

  async start(input: StartTaskInput): Promise<TaskRecord> {
    this.assertNotNested();
    const canonicalCwd = validateCwd(input.cwd);
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      throw new Error("prompt 不能为空");
    }
    if (input.provider && !input.model) {
      throw new Error("指定 provider 时必须同时指定 model");
    }
    const tier = validateWorkerTier(input.tier);
    const readOnly = input.readOnly === true;
    const rawParentSession = input.parentSessionId ?? this.baseEnv.PI_WORKER_PARENT_SESSION_ID;
    const parentSessionId = typeof rawParentSession === "string" && rawParentSession.trim()
      ? rawParentSession.trim()
      : undefined;
    const title = sanitizeTaskTitle(input.title) ?? extractTitleFromPrompt(input.prompt);
    const parentSessionTitle = sanitizeTaskTitle(input.parentSessionTitle);
    const profile = this.store.resolveModelProfile(tier, this.baseEnv);
    const resolvedModel = input.model ?? profile.model;
    const resolvedProvider = input.model !== undefined ? input.provider : profile.provider;
    const resolvedThinking = input.thinking ?? profile.thinking;
    const waitSeconds = validateWaitSeconds(input.waitSeconds);
    const excludeTools = mergeExcludeTools(input.excludeTools, readOnly);

    const taskId = randomUUID();
    const paths = this.store.allocateTaskPaths(taskId);
    const now = new Date().toISOString();

    const record: TaskRecord = {
      taskId,
      cwd: canonicalCwd,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(title ? { title } : {}),
      ...(parentSessionTitle ? { parentSessionTitle } : {}),
      sessionDir: paths.sessionDir,
      logPath: paths.logPath,
      eventsPath: paths.eventsPath,
      outcomePath: paths.outcomePath,
      steerPath: paths.steerPath,
      status: "running",
      pid: null,
      ...(tier ? { tier } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedProvider ? { provider: resolvedProvider } : {}),
      ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
      excludeTools,
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
    };

    const execState = this.launchRound(record, input.prompt, input.onProgress);
    input.onTaskCreated?.(taskId);
    if (input.waitUntilSettled) {
      const settled = await execState.settled;
      return { ...settled, recentEvents: [...settled.recentEvents] };
    }
    return this.waitForState(taskId, waitSeconds);
  }

  async reply(input: ReplyTaskInput): Promise<TaskRecord> {
    this.assertNotNested();
    if (typeof input.reply !== "string" || !input.reply.trim()) {
      throw new Error("reply 不能为空");
    }
    const waitSeconds = validateWaitSeconds(input.waitSeconds);

    const existing = this.getSnapshot(input.taskId);
    if (existing.status === "running") {
      throw new Error(`任务 ${existing.taskId} 正在运行中，无法立即回复`);
    }

    const nextTier = validateWorkerTier(input.tier);
    const tierProfile = nextTier ? this.store.resolveModelProfile(nextTier, this.baseEnv) : undefined;
    const nextModel = input.model ?? tierProfile?.model ?? existing.model;
    const nextProvider = input.model !== undefined
      ? (input.provider ?? (input.model.includes("/") ? undefined : existing.provider))
      : tierProfile
        ? (input.provider ?? (tierProfile.model !== undefined ? tierProfile.provider : existing.provider))
        : (input.provider ?? existing.provider);
    const nextThinking = input.thinking ?? tierProfile?.thinking ?? existing.thinking;
    if (nextProvider && !nextModel) {
      throw new Error("指定 provider 时必须同时指定 model");
    }

    // 重置上一轮终态字段，避免新轮运行期间 status 读到旧问题/旧摘要
    const {
      model: _prevModel,
      provider: _prevProvider,
      thinking: _prevThinking,
      tier: _prevTier,
      ...baseExisting
    } = existing;
    const finalTier = nextTier ?? existing.tier;
    const nextRecord: TaskRecord = {
      ...baseExisting,
      ...(finalTier ? { tier: finalTier } : {}),
      ...(nextModel ? { model: nextModel } : {}),
      ...(nextProvider ? { provider: nextProvider } : {}),
      ...(nextThinking ? { thinking: nextThinking } : {}),
      roundCount: existing.roundCount + 1,
      status: "running",
      summary: null,
      question: null,
      options: [],
      verifiedCommands: [],
      executedCommands: [],
      stopReason: null,
      exitCode: null,
      error: null,
    };

    const execState = this.launchRound(nextRecord, input.reply, input.onProgress);
    input.onTaskCreated?.(nextRecord.taskId);
    if (input.waitUntilSettled) {
      const settled = await execState.settled;
      return { ...settled, recentEvents: [...settled.recentEvents] };
    }
    return this.waitForState(nextRecord.taskId, waitSeconds);
  }

  async status(input: StatusTaskInput): Promise<TaskRecord> {
    const waitSeconds = validateWaitSeconds(input.waitSeconds);
    return this.waitForState(input.taskId, waitSeconds);
  }

  /**
   * 向运行中任务实时插话（非阻塞）：写入磁盘 steer 队列由 worker 扩展在当前 turn
   * 工具执行完、下一次 LLM 请求前注入；同时追加统一 steer 事件供监控面板展示。
   * 兼容本进程 active 与跨进程运行中的 detached 任务；非运行态拒绝并引导 pi_worker_reply。
   */
  async steer(input: SteerTaskInput): Promise<SteerTaskResult> {
    this.assertNotNested();
    if (typeof input.taskId !== "string" || !input.taskId.trim()) {
      throw new Error("taskId 不能为空");
    }
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) {
      throw new Error("message 不能为空");
    }
    const source = input.source === "app" ? "app" : "agent";
    const snapshot = this.getSnapshot(input.taskId.trim());
    if (snapshot.status !== "running") {
      throw new Error(
        `任务 ${snapshot.taskId} 当前状态为 ${snapshot.status}，非运行中无法实时插话；请改用 pi_worker_reply 沿原 Session 续跑`,
      );
    }

    const steerId = randomUUID();
    const queuedAt = new Date().toISOString();
    appendSteerEntry(snapshot.steerPath, { id: steerId, message, createdAt: queuedAt, source });

    const active = this.active.get(snapshot.taskId);
    if (active && !active.finalizing && active.emitSteerEvent) {
      await active.emitSteerEvent({ message, source, timestamp: queuedAt });
      active.record.lastActivityAt = queuedAt;
      active.record.updatedAt = queuedAt;
      this.store.save(active.record);
    } else {
      appendSteerEvent(snapshot.eventsPath, {
        round: snapshot.roundCount,
        message,
        source,
        timestamp: queuedAt,
      });
    }

    return { taskId: snapshot.taskId, steerId, queued: true, status: "running", message, queuedAt, source };
  }

  async cancel(input: CancelTaskInput): Promise<{ task: TaskRecord; wasRunning: boolean }> {
    const active = this.active.get(input.taskId);
    if (active) {
      if (active.finalizing) {
        const finalRecord = await active.settled;
        return { task: finalRecord, wasRunning: false };
      }
      active.cancelled = true;
      signalProcessGroup(active.child, "SIGTERM");
      if (!active.killTimer) {
        active.killTimer = setTimeout(() => {
          signalProcessGroup(active.child, "SIGKILL");
        }, CANCEL_GRACE_MS);
        active.killTimer.unref?.();
      }
      const finalRecord = await active.settled;
      return { task: finalRecord, wasRunning: true };
    }

    const existing = this.getSnapshot(input.taskId);
    if (existing.status === "needs_input") {
      const updated: TaskRecord = {
        ...existing,
        status: "cancelled",
        error: "cancelled while awaiting input",
        updatedAt: new Date().toISOString(),
      };
      this.store.save(updated);
      this.store.releaseCwdLock(updated.cwd, updated.taskId);
      return { task: updated, wasRunning: false };
    }

    if (existing.status === "running" && existing.pid !== null) {
      // 跨进程运行的 detached 任务：若记录含 pidSignature，先核验进程启动时间防止 PID 复用误杀无关进程组
      const targetPid = existing.pid;
      if (existing.pidSignature) {
        const actualSig = this.store.getProcessSignature(targetPid);
        if (actualSig !== existing.pidSignature) {
          const updated: TaskRecord = {
            ...existing,
            status: "cancelled",
            pid: null,
            error: "cancelled by user",
            updatedAt: new Date().toISOString(),
          };
          delete updated.pidSignature;
          this.store.save(updated);
          this.store.releaseCwdLock(updated.cwd, updated.taskId);
          return { task: updated, wasRunning: false };
        }
      }
      try { process.kill(-targetPid, "SIGTERM"); } catch {
        try { process.kill(targetPid, "SIGTERM"); } catch { /* 忽略 */ }
      }
      let exited = await waitUntilPidExits(targetPid, CANCEL_GRACE_MS);
      if (!exited) {
        try { process.kill(-targetPid, "SIGKILL"); } catch {
          try { process.kill(targetPid, "SIGKILL"); } catch { /* 忽略 */ }
        }
        exited = await waitUntilPidExits(targetPid, 1000);
      }
      if (!exited) {
        throw new Error(`无法终止跨进程任务 ${existing.taskId}（pid=${targetPid}），已保留工作区写锁以防并发写入`);
      }
      const updated: TaskRecord = {
        ...existing,
        status: "cancelled",
        pid: null,
        error: "cancelled by user",
        updatedAt: new Date().toISOString(),
      };
      delete updated.pidSignature;
      this.store.save(updated);
      this.store.releaseCwdLock(updated.cwd, updated.taskId);
      return { task: updated, wasRunning: true };
    }

    // 已处于 done / blocked / failed / cancelled：保持原状态不变
    return { task: existing, wasRunning: false };
  }

  list(input: ListTasksInput = {}): TaskSummary[] {
    let canonicalCwd: string | undefined;
    if (input.cwd) {
      canonicalCwd = validateCwd(input.cwd);
    }
    const parentSessionId = input.parentSessionId?.trim() || undefined;
    const limit = input.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(input.limit)));
    return this.store.list(
      {
        ...(input.status ? { status: input.status } : {}),
        ...(canonicalCwd ? { cwd: canonicalCwd } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        limit,
      },
      { inFlightTaskIds: this.inFlight },
    );
  }

  listGroups(input: ListTasksInput = {}): TaskSessionGroup[] {
    return groupTasksByParentSession(this.list(input));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      const taskIds = [...this.active.keys()];
      await Promise.all(taskIds.map((taskId) => this.cancel({ taskId }).catch(() => undefined)));
    })();
    return this.shutdownPromise;
  }
}
