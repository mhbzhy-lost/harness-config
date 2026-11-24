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
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_APPEND_PROMPT,
  createLineSplitter,
  extractAssistantMessage,
  parsePiJsonLine,
  readOutcomeFile,
  truncateTail,
} from "./protocol.ts";
import { TaskStore, defaultIsPidAlive } from "./store.ts";
import type { TaskRecord, TaskStatus, TaskSummary } from "./store.ts";

export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 7200;
export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_EXCLUDE_TOOLS = [
  "ask_question",
  "ask_user_question",
  "bash_async",
  "bash_async_status",
] as const;

export const WORKER_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker-ext.ts");

const MAX_RECENT_EVENTS = 10;
const MAX_STDERR_CHARS = 16 * 1024;
const CANCEL_GRACE_MS = 3000;
const GIT_STATUS_TIMEOUT_MS = 2000;
const MAX_GIT_STATUS_LINES = 50;

export interface StartTaskInput {
  cwd: string;
  prompt: string;
  model?: string;
  provider?: string;
  thinking?: string;
  timeoutSeconds?: number;
  excludeTools?: string[];
  waitSeconds?: number;
}

export interface ReplyTaskInput {
  taskId: string;
  reply: string;
  timeoutSeconds?: number;
  waitSeconds?: number;
}

export interface StatusTaskInput {
  taskId: string;
  waitSeconds?: number;
}

export interface CancelTaskInput {
  taskId: string;
}

export interface ListTasksInput {
  status?: TaskStatus;
  cwd?: string;
  limit?: number;
}

export interface PiWorkerRunnerOptions {
  store?: TaskStore;
  env?: NodeJS.ProcessEnv;
  piBinary?: string;
  collectGitChanges?: (cwd: string) => Promise<string[]>;
}

interface ActiveExecution {
  record: TaskRecord;
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  finalizing: boolean;
  timer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  settled: Promise<TaskRecord>;
  waiters: Set<(record: TaskRecord) => void>;
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

function validateTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds 必须是 ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS} 的整数`);
  }
  return value;
}

function validateWaitSeconds(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_WAIT_SECONDS) {
    throw new Error(`waitSeconds 必须是 0–${MAX_WAIT_SECONDS} 之间的数字`);
  }
  return value;
}

function mergeExcludeTools(extra?: string[]): string[] {
  const merged = new Set<string>(DEFAULT_EXCLUDE_TOOLS);
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

export class PiWorkerRunner {
  readonly store: TaskStore;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly explicitPiBinary?: string;
  private readonly collectGitChangesFn: (cwd: string) => Promise<string[]>;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly inFlight = new Set<string>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: PiWorkerRunnerOptions = {}) {
    this.baseEnv = options.env ?? process.env;
    this.store = options.store ?? new TaskStore(undefined);
    this.explicitPiBinary = options.piBinary;
    this.collectGitChangesFn = options.collectGitChanges ?? collectGitChanges;
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
    const args: string[] = [
      "--mode", "json",
      "--print",
      "--session-dir", record.sessionDir,
      "--session-id", record.taskId,
      "-e", WORKER_EXTENSION_PATH,
      "--exclude-tools", record.excludeTools.join(","),
      "--append-system-prompt", PROTOCOL_APPEND_PROMPT,
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
    };
    delete childEnv.PI_SESSION_OWNER_ID;
    return childEnv;
  }

  private launchRound(record: TaskRecord, promptText: string, timeoutSeconds: number): ActiveExecution {
    const piBinary = this.resolveBinary();
    const args = this.buildArgs(record);
    const childEnv = this.buildChildEnv(record);

    // 清理上一轮残留 outcome 文件，确保本轮读到的结果必属当前轮次
    try { unlinkSync(record.outcomePath); } catch { /* 文件不存在忽略 */ }

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

    let child: ChildProcess;
    try {
      child = spawn(piBinary, args, {
        cwd: record.cwd,
        env: childEnv,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.store.releaseCwdLock(record.cwd, record.taskId);
      throw err;
    }

    const now = new Date().toISOString();
    record.status = "running";
    record.pid = child.pid ?? null;
    record.updatedAt = now;
    record.lastActivityAt = now;

    this.inFlight.add(record.taskId);
    this.store.save(record);

    let resolveSettled!: (finalRecord: TaskRecord) => void;
    const settled = new Promise<TaskRecord>((r) => { resolveSettled = r; });

    const execState: ActiveExecution = {
      record,
      child,
      cancelled: false,
      timedOut: false,
      finalizing: false,
      timer: null,
      killTimer: null,
      settled,
      waiters: new Set(),
    };
    this.active.set(record.taskId, execState);

    const logStream = createWriteStream(record.logPath, { flags: "a", mode: 0o600 });
    logStream.on("error", () => { /* 日志写入失败不阻塞主流程 */ });

    let lastAssistantText = "";
    let lastStopReason: string | null = null;
    let lastErrorMessage: string | null = null;
    let sawRetryFailed = false;
    let sawAgentAborted = false;
    let stderrBuf = "";
    let spawnError: Error | null = null;

    const lineSplitter = createLineSplitter((line) => {
      if (!line.trim()) return;
      logStream.write(`${line}\n`);

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
      // 子进程提前退出触发 EPIPE 时忽略，由 close 统一处理
    });
    try {
      child.stdin?.end(promptText, "utf8");
    } catch {
      // 忽略同步写入错误，由 close 统一处理
    }

    child.on("error", (err) => {
      spawnError = err;
    });

    execState.timer = setTimeout(() => {
      execState.timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      execState.killTimer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
      }, CANCEL_GRACE_MS);
      execState.killTimer.unref?.();
    }, timeoutSeconds * 1000);
    execState.timer.unref?.();

    const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (execState.timer) {
        clearTimeout(execState.timer);
        execState.timer = null;
      }
      if (execState.killTimer) {
        clearTimeout(execState.killTimer);
        execState.killTimer = null;
      }

      lineSplitter.flush();
      await new Promise<void>((done) => {
        logStream.end(() => done());
      });

      const endedAt = new Date().toISOString();
      record.pid = null;
      record.exitCode = exitCode;
      record.updatedAt = endedAt;
      record.lastActivityAt = endedAt;

      const outcome = readOutcomeFile(record.outcomePath);

      if (execState.cancelled) {
        record.status = "cancelled";
        record.error = "cancelled by user";
      } else if (execState.timedOut) {
        record.status = "failed";
        record.error = `timeout after ${timeoutSeconds}s`;
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

      record.gitChanges = await this.collectGitChangesFn(record.cwd);
      tightenSessionPermissions(record.sessionDir, record.taskId);

      // 终态一次性原子落盘后再释放锁与 inFlight 保护，消除 orphan_process 竞态
      this.store.save(record);
      this.store.releaseCwdLock(record.cwd, record.taskId);
      this.active.delete(record.taskId);
      this.inFlight.delete(record.taskId);

      for (const notify of execState.waiters) {
        notify(record);
      }
      execState.waiters.clear();
      resolveSettled(record);
    };

    let finalized = false;
    child.on("close", (code, signal) => {
      if (finalized) return;
      finalized = true;
      execState.finalizing = true;
      void finalize(code, signal);
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
    const timeoutSeconds = validateTimeoutSeconds(input.timeoutSeconds);
    const waitSeconds = validateWaitSeconds(input.waitSeconds);
    const excludeTools = mergeExcludeTools(input.excludeTools);

    const taskId = randomUUID();
    const paths = this.store.allocateTaskPaths(taskId);
    const now = new Date().toISOString();

    const record: TaskRecord = {
      taskId,
      cwd: canonicalCwd,
      sessionDir: paths.sessionDir,
      logPath: paths.logPath,
      outcomePath: paths.outcomePath,
      status: "running",
      pid: null,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
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
      stopReason: null,
      exitCode: null,
      error: null,
      gitChanges: [],
    };

    this.launchRound(record, input.prompt, timeoutSeconds);
    return this.waitForState(taskId, waitSeconds);
  }

  async reply(input: ReplyTaskInput): Promise<TaskRecord> {
    this.assertNotNested();
    if (typeof input.reply !== "string" || !input.reply.trim()) {
      throw new Error("reply 不能为空");
    }
    const timeoutSeconds = validateTimeoutSeconds(input.timeoutSeconds);
    const waitSeconds = validateWaitSeconds(input.waitSeconds);

    const existing = this.getSnapshot(input.taskId);
    if (existing.status === "running") {
      throw new Error(`任务 ${existing.taskId} 正在运行中，无法立即回复`);
    }
    if (existing.status !== "needs_input" && existing.status !== "done" && existing.status !== "blocked") {
      throw new Error(`任务 ${existing.taskId} 当前状态为 ${existing.status}，不支持续跑回复`);
    }

    // 重置上一轮终态字段，避免新轮运行期间 status 读到旧问题/旧摘要
    const nextRecord: TaskRecord = {
      ...existing,
      roundCount: existing.roundCount + 1,
      status: "running",
      summary: null,
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason: null,
      exitCode: null,
      error: null,
    };

    this.launchRound(nextRecord, input.reply, timeoutSeconds);
    return this.waitForState(nextRecord.taskId, waitSeconds);
  }

  async status(input: StatusTaskInput): Promise<TaskRecord> {
    const waitSeconds = validateWaitSeconds(input.waitSeconds);
    return this.waitForState(input.taskId, waitSeconds);
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
      // 跨进程运行的 detached 任务：发 SIGTERM 并等待真正退出，超时再发 SIGKILL，确认已死才释放 cwd 锁
      const targetPid = existing.pid;
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
    const limit = input.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(input.limit)));
    return this.store.list(
      {
        ...(input.status ? { status: input.status } : {}),
        ...(canonicalCwd ? { cwd: canonicalCwd } : {}),
        limit,
      },
      { inFlightTaskIds: this.inFlight },
    );
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
