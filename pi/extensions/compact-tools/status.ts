export type CompactRenderStatus = "loading" | "success" | "failure";
export const COMPACT_STATUS_KEY = "compactToolsStatus";
export const DEFAULT_MAX_SPINNER_LIFETIME_MS = 30 * 60 * 1000;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const loadingTimers = new WeakMap<object, () => void>();
const activeCleanups = new Set<() => void>();

type ThemeLike = { fg(color: string, text: string): string };
type RenderContextLike = { state?: object; invalidate?: () => void } | undefined;
type ResultLike = { isError?: boolean } | undefined;
type ResultOptionsLike = { isPartial?: boolean } | undefined;
export type SyncStatusAnimationOptions = {
  now?: () => number;
  maxLifetimeMs?: number;
};

export function resultStatus(result: ResultLike, options: ResultOptionsLike, context: { isError?: boolean } | undefined): CompactRenderStatus {
  return context?.isError === true || result?.isError === true
    ? "failure"
    : options?.isPartial === true
      ? "loading"
      : "success";
}

export function setRenderStatus(
  context: RenderContextLike,
  status: CompactRenderStatus,
  key = "status",
  options?: SyncStatusAnimationOptions,
): void {
  if (context?.state) (context.state as Record<string, unknown>)[key] = status;
  syncStatusAnimation(context, status, options);
}

export function clearAllStatusAnimations(): void {
  for (const stop of [...activeCleanups]) {
    stop();
  }
}

/**
 * loading 状态需要主动触发 TUI 重绘；通过 WeakRef 与最长寿命上限防止未达终态时泄漏。
 */
export function syncStatusAnimation(
  context: RenderContextLike,
  status: CompactRenderStatus | undefined,
  options: SyncStatusAnimationOptions = {},
): void {
  const state = context?.state;
  if (!state) return;
  const currentStop = loadingTimers.get(state);
  const loading = status === undefined || status === "loading";
  if (!loading) {
    currentStop?.();
    return;
  }
  if (currentStop || typeof context?.invalidate !== "function") return;
  const now = options.now ?? Date.now;
  const maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_SPINNER_LIFETIME_MS;
  const startedAt = now();
  const contextRef = new WeakRef(context as NonNullable<RenderContextLike>);
  const stateRef = new WeakRef(state);
  let stopped = false;
  let timer: ReturnType<typeof setInterval>;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    activeCleanups.delete(stop);
    const currentState = stateRef.deref();
    if (currentState) loadingTimers.delete(currentState);
  };
  timer = setInterval(() => {
    const currentCtx = contextRef.deref();
    if (!currentCtx || typeof currentCtx.invalidate !== "function" || now() - startedAt >= maxLifetimeMs) {
      stop();
      return;
    }
    try {
      currentCtx.invalidate();
    } catch {
      stop();
    }
  }, 120);
  timer.unref?.();
  activeCleanups.add(stop);
  loadingTimers.set(state, stop);
}

export function statusGlyph(theme: ThemeLike, status: CompactRenderStatus | undefined, now = Date.now()): string {
  if (status === "success") return theme.fg("success", "✓");
  if (status === "loading" || status === undefined) {
    return theme.fg("dim", SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length]!);
  }
  return theme.fg("error", "✗");
}
