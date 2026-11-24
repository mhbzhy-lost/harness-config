import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { StreamEventSummary } from "./protocol.ts";

export type TaskStatus = "running" | "needs_input" | "done" | "blocked" | "failed" | "cancelled";

export interface TaskRecord {
  taskId: string;
  cwd: string;
  sessionDir: string;
  logPath: string;
  outcomePath: string;
  status: TaskStatus;
  pid: number | null;
  model?: string;
  provider?: string;
  thinking?: string;
  excludeTools: string[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  turnCount: number;
  roundCount: number;
  lastTool: string | null;
  recentEvents: StreamEventSummary[];
  summary: string | null;
  question: string | null;
  options: string[];
  verifiedCommands: string[];
  stopReason: string | null;
  exitCode: number | null;
  error: string | null;
  gitChanges: string[];
}

export type TaskSummary = Pick<
  TaskRecord,
  | "taskId"
  | "cwd"
  | "status"
  | "roundCount"
  | "turnCount"
  | "lastTool"
  | "createdAt"
  | "updatedAt"
  | "lastActivityAt"
  | "question"
  | "error"
>;

export interface TaskPaths {
  taskFile: string;
  sessionDir: string;
  logPath: string;
  outcomePath: string;
}

export interface CwdLockOwner {
  taskId: string;
  ownerPid: number;
}

export type CwdLockResult =
  | { lockPath: string }
  | { conflictTaskId: string; ownerPid: number };

export interface TaskStoreOptions {
  isPidAlive?: (pid: number) => boolean;
}

export interface StoreReadOptions {
  inFlightTaskIds?: ReadonlySet<string>;
}

export interface TaskListFilter {
  status?: TaskStatus;
  cwd?: string;
  limit?: number;
}

interface LockPayload {
  taskId: string;
  ownerPid: number;
  cwd: string;
  acquiredAt: string;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_WORKER_STATE_DIR?.trim();
  if (override) {
    return override.startsWith("~/") ? resolve(homedir(), override.slice(2)) : resolve(override);
  }
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const baseAgentDir = agentDir
    ? (agentDir.startsWith("~/") ? resolve(homedir(), agentDir.slice(2)) : resolve(agentDir))
    : join(homedir(), ".pi", "agent");
  return join(baseAgentDir, "pi-worker");
}

function validateTaskId(taskId: string): string {
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 taskId: ${String(taskId)}`);
  }
  return taskId;
}

function writeAtomicPrivateJson(targetPath: string, payload: unknown): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* 清理失败忽略 */ }
    throw err;
  }
}

function toSummary(record: TaskRecord): TaskSummary {
  return {
    taskId: record.taskId,
    cwd: record.cwd,
    status: record.status,
    roundCount: record.roundCount,
    turnCount: record.turnCount,
    lastTool: record.lastTool,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt,
    question: record.question,
    error: record.error,
  };
}

export class TaskStore {
  readonly stateDir: string;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(stateDir: string = resolveStateDir(), options: TaskStoreOptions = {}) {
    this.stateDir = resolve(stateDir);
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  ensureDirs(): void {
    for (const dir of [
      this.stateDir,
      join(this.stateDir, "tasks"),
      join(this.stateDir, "sessions"),
      join(this.stateDir, "logs"),
      join(this.stateDir, "locks"),
      join(this.stateDir, "outcomes"),
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }

  allocateTaskPaths(taskId: string): TaskPaths {
    const validId = validateTaskId(taskId);
    this.ensureDirs();
    return {
      taskFile: join(this.stateDir, "tasks", `${validId}.json`),
      sessionDir: join(this.stateDir, "sessions"),
      logPath: join(this.stateDir, "logs", `${validId}.jsonl`),
      outcomePath: join(this.stateDir, "outcomes", `${validId}.json`),
    };
  }

  private lockPathForCwd(canonicalCwd: string): string {
    const hash = createHash("sha256").update(canonicalCwd).digest("hex");
    return join(this.stateDir, "locks", `${hash}.lock`);
  }

  private readLockPayload(lockPath: string): LockPayload | null {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
      if (
        typeof parsed?.taskId === "string"
        && typeof parsed?.ownerPid === "number"
        && typeof parsed?.cwd === "string"
      ) {
        return {
          taskId: parsed.taskId,
          ownerPid: parsed.ownerPid,
          cwd: parsed.cwd,
          acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private createLockExclusive(lockPath: string, payload: LockPayload): boolean {
    let fd: number;
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    chmodSync(lockPath, 0o600);
    return true;
  }

  acquireCwdLock(
    canonicalCwd: string,
    owner: CwdLockOwner,
    options: StoreReadOptions = {},
  ): CwdLockResult {
    const validId = validateTaskId(owner.taskId);
    this.ensureDirs();
    const lockPath = this.lockPathForCwd(canonicalCwd);
    const payload: LockPayload = {
      taskId: validId,
      ownerPid: owner.ownerPid,
      cwd: canonicalCwd,
      acquiredAt: new Date().toISOString(),
    };

    if (this.createLockExclusive(lockPath, payload)) {
      return { lockPath };
    }

    const existing = this.readLockPayload(lockPath);
    if (existing) {
      const inFlight = options.inFlightTaskIds?.has(existing.taskId) ?? false;
      const alive = inFlight || this.isPidAlive(existing.ownerPid);
      if (alive) {
        return { conflictTaskId: existing.taskId, ownerPid: existing.ownerPid };
      }
      // 持有者进程已死：回收陈旧锁并校正旧任务记录
      try { unlinkSync(lockPath); } catch { /* 已被并发清理 */ }
      if (TASK_ID_RE.test(existing.taskId)) {
        const stale = this.readRawTask(existing.taskId);
        if (stale && stale.status === "running") {
          this.markOrphanFailed(stale);
        }
      }
    } else {
      // 锁文件损坏：删除后重试
      try { unlinkSync(lockPath); } catch { /* 忽略 */ }
    }

    if (this.createLockExclusive(lockPath, payload)) {
      return { lockPath };
    }

    const contender = this.readLockPayload(lockPath);
    return {
      conflictTaskId: contender?.taskId ?? "unknown",
      ownerPid: contender?.ownerPid ?? 0,
    };
  }

  releaseCwdLock(canonicalCwd: string, taskId: string): void {
    const validId = validateTaskId(taskId);
    const lockPath = this.lockPathForCwd(canonicalCwd);
    const existing = this.readLockPayload(lockPath);
    if (existing && existing.taskId === validId) {
      try { unlinkSync(lockPath); } catch { /* 已被删除 */ }
    }
  }

  save(record: TaskRecord): void {
    const { taskFile } = this.allocateTaskPaths(record.taskId);
    writeAtomicPrivateJson(taskFile, record);
  }

  private readRawTask(taskId: string): TaskRecord | null {
    const validId = validateTaskId(taskId);
    const taskFile = join(this.stateDir, "tasks", `${validId}.json`);
    try {
      const parsed = JSON.parse(readFileSync(taskFile, "utf8")) as TaskRecord;
      if (!parsed || typeof parsed !== "object" || parsed.taskId !== validId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private markOrphanFailed(record: TaskRecord): TaskRecord {
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...record,
      status: "failed",
      pid: null,
      error: "orphan_process",
      updatedAt: now,
    };
    this.save(updated);
    this.releaseCwdLock(record.cwd, record.taskId);
    return updated;
  }

  private reconcileIfNeeded(record: TaskRecord, options: StoreReadOptions): TaskRecord {
    if (record.status !== "running") return record;
    if (options.inFlightTaskIds?.has(record.taskId)) return record;
    if (record.pid !== null && this.isPidAlive(record.pid)) return record;
    return this.markOrphanFailed(record);
  }

  load(taskId: string, options: StoreReadOptions = {}): TaskRecord | null {
    const raw = this.readRawTask(taskId);
    if (!raw) return null;
    return this.reconcileIfNeeded(raw, options);
  }

  list(filter: TaskListFilter = {}, options: StoreReadOptions = {}): TaskSummary[] {
    const tasksDir = join(this.stateDir, "tasks");
    let entries: string[];
    try {
      entries = readdirSync(tasksDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }

    const records: TaskRecord[] = [];
    for (const file of entries) {
      const taskId = file.slice(0, -5);
      if (!TASK_ID_RE.test(taskId)) continue;
      const loaded = this.load(taskId, options);
      if (!loaded) continue;
      if (filter.status && loaded.status !== filter.status) continue;
      if (filter.cwd && loaded.cwd !== filter.cwd) continue;
      records.push(loaded);
    }

    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = filter.limit ?? 20;
    return records.slice(0, Math.max(0, limit)).map(toSummary);
  }
}
