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

export const WORKER_TIERS = ["fast", "default", "heavy"] as const;
export type WorkerTier = (typeof WORKER_TIERS)[number];

export interface ExecutedCommandEvidence {
  round: number;
  startSeq: number;
  endSeq: number;
  command: string;
  isError: boolean;
  durationMs?: number;
}

export interface TaskRecord {
  taskId: string;
  cwd: string;
  parentSessionId?: string;
  sessionDir: string;
  logPath: string;
  eventsPath: string;
  outcomePath: string;
  status: TaskStatus;
  pid: number | null;
  tier?: WorkerTier;
  readOnly?: boolean;
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
  executedCommands: ExecutedCommandEvidence[];
  stopReason: string | null;
  exitCode: number | null;
  error: string | null;
  gitChanges: string[];
}

export type TaskSummary = Pick<
  TaskRecord,
  | "taskId"
  | "cwd"
  | "parentSessionId"
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

export interface TaskSessionGroup {
  groupKey: string;
  parentSessionId: string | null;
  cwd: string;
  runningCount: number;
  latestActivityAt: string;
  tasks: TaskSummary[];
}

export interface TaskPaths {
  taskFile: string;
  sessionDir: string;
  logPath: string;
  eventsPath: string;
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
  parentSessionId?: string;
  limit?: number;
}

export interface WorkerDefaultConfig {
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface WorkerConfig {
  default: WorkerDefaultConfig;
  tiers: Partial<Record<WorkerTier, WorkerDefaultConfig>>;
}

const VALID_TIER_SET = new Set<string>(WORKER_TIERS);
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function validateWorkerTier(value: unknown): WorkerTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !VALID_TIER_SET.has(value)) {
    throw new Error(`非法 tier: ${String(value)}（仅支持 ${WORKER_TIERS.join(" / ")}）`);
  }
  return value as WorkerTier;
}

function normalizeOptionalField(value: unknown, field: string, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${source} 中的 ${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateThinkingLevel(value: string | undefined, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (!VALID_THINKING_LEVELS.has(value)) {
    throw new Error(`${source} 中的 thinking 非法: ${value}`);
  }
  return value;
}

function parseProfileObject(value: unknown, source: string): WorkerDefaultConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON 对象`);
  }
  const obj = value as Record<string, unknown>;
  const provider = normalizeOptionalField(obj.provider, "provider", source);
  const model = normalizeOptionalField(obj.model, "model", source);
  const thinking = validateThinkingLevel(
    normalizeOptionalField(obj.thinking, "thinking", source),
    source,
  );
  if (provider && !model) {
    throw new Error(`${source} 指定了 provider 但缺少 model`);
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function overlayEnvProfile(
  base: WorkerDefaultConfig,
  env: NodeJS.ProcessEnv,
  prefix: string,
): WorkerDefaultConfig {
  const providerVar = `${prefix}_PROVIDER`;
  const modelVar = `${prefix}_MODEL`;
  const thinkingVar = `${prefix}_THINKING`;
  const envProvider = normalizeOptionalField(env[providerVar], providerVar, "环境变量");
  const envModel = normalizeOptionalField(env[modelVar], modelVar, "环境变量");
  const envThinking = validateThinkingLevel(
    normalizeOptionalField(env[thinkingVar], thinkingVar, "环境变量"),
    "环境变量",
  );
  if (envProvider && !envModel) {
    throw new Error(`环境变量指定了 ${providerVar} 但缺少 ${modelVar}`);
  }
  // 环境变量若显式覆盖了 model，则不混用文件中的旧 provider
  const model = envModel ?? base.model;
  const provider = envModel !== undefined ? envProvider : base.provider;
  const thinking = envThinking ?? base.thinking;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function loadWorkerConfig(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const configPath = join(resolve(stateDir), "config.json");
  let fileDefault: WorkerDefaultConfig = {};
  const fileTiers: Partial<Record<WorkerTier, WorkerDefaultConfig>> = {};

  let raw: string | null = null;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`读取默认配置文件失败 (${configPath}): ${(err as Error).message}`);
    }
  }

  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`解析默认配置文件失败 (${configPath}): ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`默认配置文件必须是 JSON 对象 (${configPath})`);
    }
    const obj = parsed as Record<string, unknown>;

    // 兼容顶层直接写 provider/model/thinking 与嵌套 default 对象两种写法
    const rootProfile = parseProfileObject(obj, `默认配置文件 (${configPath})`);
    const nestedDefault = obj.default !== undefined
      ? parseProfileObject(obj.default, `默认配置文件 (${configPath}) default`)
      : {};
    const mergedDefaultModel = nestedDefault.model ?? rootProfile.model;
    const mergedDefaultProvider = nestedDefault.model !== undefined
      ? nestedDefault.provider
      : rootProfile.provider;
    const mergedDefaultThinking = nestedDefault.thinking ?? rootProfile.thinking;
    fileDefault = {
      ...(mergedDefaultProvider ? { provider: mergedDefaultProvider } : {}),
      ...(mergedDefaultModel ? { model: mergedDefaultModel } : {}),
      ...(mergedDefaultThinking ? { thinking: mergedDefaultThinking } : {}),
    };

    if (obj.tiers !== undefined) {
      if (!obj.tiers || typeof obj.tiers !== "object" || Array.isArray(obj.tiers)) {
        throw new Error(`默认配置文件 (${configPath}) 中的 tiers 必须是 JSON 对象`);
      }
      const tiersObj = obj.tiers as Record<string, unknown>;
      for (const tierName of WORKER_TIERS) {
        if (tiersObj[tierName] !== undefined) {
          fileTiers[tierName] = parseProfileObject(
            tiersObj[tierName],
            `默认配置文件 (${configPath}) tiers.${tierName}`,
          );
        }
      }
      if (fileTiers.default) {
        const td = fileTiers.default;
        const m = td.model ?? fileDefault.model;
        const p = td.model !== undefined ? td.provider : fileDefault.provider;
        const th = td.thinking ?? fileDefault.thinking;
        fileDefault = {
          ...(p ? { provider: p } : {}),
          ...(m ? { model: m } : {}),
          ...(th ? { thinking: th } : {}),
        };
      }
    }
  }

  const resolvedDefault = overlayEnvProfile(fileDefault, env, "PI_WORKER_DEFAULT");
  const resolvedTiers: Partial<Record<WorkerTier, WorkerDefaultConfig>> = {};
  for (const tierName of ["fast", "heavy"] as const) {
    const envPrefix = `PI_WORKER_TIER_${tierName.toUpperCase()}`;
    const merged = overlayEnvProfile(fileTiers[tierName] ?? {}, env, envPrefix);
    if (merged.provider || merged.model || merged.thinking) {
      resolvedTiers[tierName] = merged;
    }
  }

  return {
    default: resolvedDefault,
    tiers: resolvedTiers,
  };
}

export function resolveWorkerTierProfile(
  stateDir: string,
  tier?: WorkerTier,
  env: NodeJS.ProcessEnv = process.env,
): WorkerDefaultConfig {
  const validTier = validateWorkerTier(tier);
  const config = loadWorkerConfig(stateDir, env);
  if (!validTier || validTier === "default") {
    return config.default;
  }
  const tierProfile = config.tiers[validTier];
  if (!tierProfile) {
    return config.default;
  }
  // 档位若未单独指定 model（例如仅配置了 thinking 档位），自动回退 default 的 provider/model
  const model = tierProfile.model ?? config.default.model;
  const provider = tierProfile.model !== undefined ? tierProfile.provider : config.default.provider;
  const thinking = tierProfile.thinking ?? config.default.thinking;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function loadWorkerDefaultConfig(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerDefaultConfig {
  return resolveWorkerTierProfile(stateDir, "default", env);
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
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
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

/**
 * 跨 Harness 公有分组逻辑：
 * - 有 parentSessionId 的任务按父会话聚合（groupKey = "session:<id>"）；
 * - 未标记 parentSessionId 的旧/独立任务按工作区回退聚合（groupKey = "cwd:<cwd>"），避免跨项目混杂。
 * 分组与组内任务均按“存在 running 优先，其次按最新活跃时间倒序”排列。
 */
export function groupTasksByParentSession(tasks: readonly TaskSummary[]): TaskSessionGroup[] {
  const byKey = new Map<string, TaskSessionGroup>();

  for (const task of tasks) {
    const parentSessionId = task.parentSessionId?.trim() || null;
    const groupKey = parentSessionId ? `session:${parentSessionId}` : `cwd:${task.cwd}`;
    const activity = task.lastActivityAt || task.updatedAt;
    let group = byKey.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        parentSessionId,
        cwd: task.cwd,
        runningCount: 0,
        latestActivityAt: activity,
        tasks: [],
      };
      byKey.set(groupKey, group);
    }
    group.tasks.push(task);
    if (task.status === "running") group.runningCount += 1;
    if (activity.localeCompare(group.latestActivityAt) > 0) {
      group.latestActivityAt = activity;
      group.cwd = task.cwd;
    }
  }

  const groups = [...byKey.values()];
  for (const group of groups) {
    group.tasks.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }
  groups.sort((a, b) => {
    if (a.runningCount > 0 && b.runningCount === 0) return -1;
    if (b.runningCount > 0 && a.runningCount === 0) return 1;
    return b.latestActivityAt.localeCompare(a.latestActivityAt);
  });
  return groups;
}

export class TaskStore {
  readonly stateDir: string;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(stateDir: string = resolveStateDir(), options: TaskStoreOptions = {}) {
    this.stateDir = resolve(stateDir);
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  get configPath(): string {
    return join(this.stateDir, "config.json");
  }

  loadDefaultConfig(env: NodeJS.ProcessEnv = process.env): WorkerDefaultConfig {
    return loadWorkerDefaultConfig(this.stateDir, env);
  }

  resolveModelProfile(tier?: WorkerTier, env: NodeJS.ProcessEnv = process.env): WorkerDefaultConfig {
    return resolveWorkerTierProfile(this.stateDir, tier, env);
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
      eventsPath: join(this.stateDir, "logs", `${validId}.events.jsonl`),
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
      const ownerAlive = inFlight || this.isPidAlive(existing.ownerPid);
      if (ownerAlive) {
        return { conflictTaskId: existing.taskId, ownerPid: existing.ownerPid };
      }
      // 即使原 MCP ownerPid 已死，仍须核查 detached worker 子进程是否仍在运行
      const stale = TASK_ID_RE.test(existing.taskId) ? this.readRawTask(existing.taskId) : null;
      if (stale && stale.status === "running" && stale.pid !== null && this.isPidAlive(stale.pid)) {
        return { conflictTaskId: stale.taskId, ownerPid: stale.pid };
      }
      // 宿主与 worker 进程均已死：回收陈旧锁并校正旧任务记录
      try { unlinkSync(lockPath); } catch { /* 已被并发清理 */ }
      if (stale && stale.status === "running") {
        this.markOrphanFailed(stale);
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
      if (typeof parsed.eventsPath !== "string" || !parsed.eventsPath) {
        parsed.eventsPath = join(this.stateDir, "logs", `${validId}.events.jsonl`);
      }
      if (!Array.isArray(parsed.executedCommands)) {
        parsed.executedCommands = [];
      }
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
    // 跨进程 finalize 窗口（例如正跑 git status）期间：worker child 已死，但 cwd 锁仍被活 ownerPid 持有
    const lock = this.readLockPayload(this.lockPathForCwd(record.cwd));
    if (lock && lock.taskId === record.taskId && this.isPidAlive(lock.ownerPid)) {
      return record;
    }
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
      if (filter.parentSessionId && loaded.parentSessionId !== filter.parentSessionId) continue;
      records.push(loaded);
    }

    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = filter.limit ?? 20;
    return records.slice(0, Math.max(0, limit)).map(toSummary);
  }
}
