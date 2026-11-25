/**
 * 监控面板作用域与标题展示的纯逻辑模块（无 React/DOM 依赖，便于 node --test 单测）。
 *
 * 核心约定：
 * - parentSessionId 存在时严格锁定为 session 模式，仅按会话过滤（不叠加 cwd），
 *   避免漏掉同会话在 git worktree 等其他目录派发的任务；
 * - 首屏 ontoolinput 即可解析作用域，杜绝无作用域抢跑快照导致跨会话混入。
 */

export interface ScopeTaskLike {
  taskId: string;
  cwd: string;
  parentSessionId?: string;
  title?: string;
  parentSessionTitle?: string;
  status: string;
  roundCount: number;
  turnCount: number;
  updatedAt: string;
  lastActivityAt: string;
}

export interface ScopeGroupLike {
  groupKey: string;
  parentSessionId: string | null;
  parentSessionTitle?: string | null;
  cwd: string;
  runningCount: number;
  latestActivityAt: string;
  tasks: ScopeTaskLike[];
}

export interface MonitorScope {
  parentSessionId: string | null;
  parentSessionTitle: string | null;
  cwd: string | null;
}

export type ScopeMode = "session" | "cwd" | "all";

export interface ParsedToolInput {
  scope: MonitorScope;
  taskId: string | null;
}

export const EMPTY_SCOPE: MonitorScope = {
  parentSessionId: null,
  parentSessionTitle: null,
  cwd: null,
};

/** 会话锁定态低频轮询间隔：保证同会话后续新派发任务自动出现 */
export const LOCKED_IDLE_POLL_MS = 2500;
/** 首屏兜底快照延迟：仅在既无 ontoolinput 也无 ontoolresult 时触发一次 */
export const INITIAL_FALLBACK_MS = 600;

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 解析 ontoolinput 的 params（{ arguments?: Record<string, unknown> }），提前锁定作用域 */
export function parseToolInputScope(params: unknown): ParsedToolInput {
  const rawArgs = params && typeof params === "object"
    ? (params as { arguments?: unknown }).arguments
    : undefined;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
  return {
    scope: {
      parentSessionId: trimmedString(args.parentSessionId),
      parentSessionTitle: trimmedString(args.parentSessionTitle),
      cwd: trimmedString(args.cwd),
    },
    taskId: trimmedString(args.taskId),
  };
}

export function resolveScopeMode(scope: MonitorScope): ScopeMode {
  if (scope.parentSessionId) return "session";
  if (scope.cwd) return "cwd";
  return "all";
}

/** parentSessionId 存在即严格锁定单会话，禁止切到 cwd/all（全局查看走左侧栏 global 入口） */
export function isSessionLocked(scope: MonitorScope): boolean {
  return Boolean(scope.parentSessionId);
}

export function shortDir(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function truncateLabel(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 会话徽章：优先会话标题，无标题回退 “会话 <id8>” */
export function formatSessionBadge(
  parentSessionId: string,
  parentSessionTitle?: string | null,
): string {
  const title = parentSessionTitle?.trim();
  return title || `会话 ${parentSessionId.slice(0, 8)}`;
}

/** 下拉任务项：[status] 标题（或目录名）· R轮 T轮 (id8)，标题过长截断保持紧凑 */
export function formatTaskOptionLabel(task: ScopeTaskLike): string {
  const label = truncateLabel(task.title?.trim() || shortDir(task.cwd), 40);
  return `[${task.status}] ${label} · R${task.roundCount} T${task.turnCount} (${task.taskId.slice(0, 8)})`;
}

/** 分组标签：优先会话标题（${title} · ${dir}），无标题回退 ${dir} · 会话 ${id8} */
export function formatGroupLabel(group: ScopeGroupLike): string {
  const dir = shortDir(group.cwd);
  const title = group.parentSessionTitle?.trim();
  const head = group.parentSessionId
    ? title
      ? `${truncateLabel(title, 32)} · ${dir}`
      : `${dir} · 会话 ${group.parentSessionId.slice(0, 8)}`
    : `${dir} · 未标记会话`;
  const running = group.runningCount > 0 ? ` · ${group.runningCount} 运行中` : "";
  return `${head} (${group.tasks.length}${running})`;
}

/** 服务端未返回 groups 时的前端兜底分组（与 store.groupTasksByParentSession 同规则） */
export function fallbackGroupTasks(list: ScopeTaskLike[]): ScopeGroupLike[] {
  const map = new Map<string, ScopeGroupLike>();
  const titleActivityByKey = new Map<string, string>();
  for (const t of list) {
    const pid = t.parentSessionId?.trim() || null;
    const key = pid ? `session:${pid}` : `cwd:${t.cwd}`;
    const activity = t.lastActivityAt || t.updatedAt;
    let grp = map.get(key);
    if (!grp) {
      grp = {
        groupKey: key,
        parentSessionId: pid,
        parentSessionTitle: null,
        cwd: t.cwd,
        runningCount: 0,
        latestActivityAt: activity,
        tasks: [],
      };
      map.set(key, grp);
    }
    const sessionTitle = t.parentSessionTitle?.trim();
    if (sessionTitle && activity.localeCompare(titleActivityByKey.get(key) ?? "") >= 0) {
      grp.parentSessionTitle = sessionTitle;
      titleActivityByKey.set(key, activity);
    }
    grp.tasks.push(t);
    if (t.status === "running") grp.runningCount += 1;
    if (activity.localeCompare(grp.latestActivityAt) > 0) {
      grp.latestActivityAt = activity;
      grp.cwd = t.cwd;
    }
  }
  return [...map.values()];
}

/** 快照过滤参数：session 模式仅传 parentSessionId（不叠加 cwd）；cwd 模式仅传 cwd */
export function buildSnapshotScopeArgs(
  mode: ScopeMode,
  scope: MonitorScope,
): Record<string, unknown> {
  if (mode === "session" && scope.parentSessionId) {
    return {
      parentSessionId: scope.parentSessionId,
      ...(scope.parentSessionTitle ? { parentSessionTitle: scope.parentSessionTitle } : {}),
    };
  }
  if (mode === "cwd" && scope.cwd) {
    return { cwd: scope.cwd };
  }
  return {};
}

/** 自动聚焦：优先最新运行中任务，否则列表首个（列表已按活跃倒序） */
export function pickAutoFocusTaskId(tasks: readonly ScopeTaskLike[]): string | null {
  return tasks.find((t) => t.status === "running")?.taskId ?? tasks[0]?.taskId ?? null;
}

/** 轮询节奏：hasMore 80ms / running 500ms / needs_input 3s / 会话锁定空闲 2.5s，否则停 */
export function resolvePollDelayMs(input: {
  hasMore: boolean;
  taskStatus?: string | null;
  tasks: readonly ScopeTaskLike[];
  sessionLocked: boolean;
}): number | null {
  if (input.hasMore) return 80;
  if (input.taskStatus === "running") return 500;
  if (input.taskStatus === "needs_input") return 3000;
  if (!input.taskStatus && input.tasks.some((t) => t.status === "running")) return 1500;
  if (input.sessionLocked) return LOCKED_IDLE_POLL_MS;
  return null;
}
