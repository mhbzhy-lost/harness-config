export type CachedBashOptionsConfig = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

/**
 * 按 `(cwd, projectTrusted)` 短时缓存 bash 配置查询，避免每次工具调用同步重读磁盘 settings。
 */
export function createCachedBashOptions<TCtx extends { cwd?: string; isProjectTrusted?: () => boolean } | undefined>(
  getBashOptions: (ctx?: TCtx) => any,
  { ttlMs = 5000, maxEntries = 32, now = Date.now }: CachedBashOptionsConfig = {},
) {
  const cache = new Map<string, { expiresAt: number; value: any }>();
  return (ctx?: TCtx) => {
    if (!ctx || typeof ctx.cwd !== "string") return getBashOptions(ctx);
    const trusted = ctx.isProjectTrusted?.() === true;
    const key = `${trusted ? "1" : "0"}:${ctx.cwd}`;
    const currentTime = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value;
    }
    if (cached) cache.delete(key);
    const value = getBashOptions(ctx);
    if (ttlMs > 0 && maxEntries > 0) {
      if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(key, { expiresAt: currentTime + ttlMs, value });
    }
    return value;
  };
}

export function createBashCwdToolDefinition({
  workspaceRoot = process.cwd(),
  createBashToolDefinition,
  getBashOptions = () => ({}),
}: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any } = {}) {
  if (typeof createBashToolDefinition !== "function") {
    throw new Error("bash settings extension requires createBashToolDefinition");
  }

  const cachedGetBashOptions = createCachedBashOptions(getBashOptions);
  const baseDefinition = createBashToolDefinition(workspaceRoot, {});
  return {
    ...baseDefinition,
    name: "bash",
    async execute(id: any, input: any, signal: any, onUpdate: any, ctx: any) {
      const { definition } = await prepareBashCwdExecution({
        workspaceRoot, createBashToolDefinition, getBashOptions: cachedGetBashOptions,
      }, ctx);
      return definition.execute(id, input, signal, onUpdate, ctx);
    },
  };
}

/** 只解析一次 shell options，供同步与异步 Bash 执行共用。 */
export async function prepareBashCwdExecution(
  { workspaceRoot = process.cwd(), createBashToolDefinition, getBashOptions = () => ({}) }: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any },
  ctx: any,
  transformOptions: (options: any) => any = (options) => options,
) {
  const effectiveCwd = ctx?.cwd ?? workspaceRoot;
  const options = transformOptions(getBashOptions(ctx));
  return { definition: createBashToolDefinition!(effectiveCwd, options), cwd: effectiveCwd };
}

export function createBashCwdExtension(pi: any, options = {}) {
  pi.registerTool(createBashCwdToolDefinition(options));
}

export default createBashCwdExtension;
