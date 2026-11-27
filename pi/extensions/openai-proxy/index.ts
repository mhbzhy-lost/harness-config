import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveUpward(startDir: string, packageName: string): string {
  let directory = startDir;
  for (let depth = 0; depth < 16 && directory !== "/" && directory !== dirname(directory); depth += 1) {
    try {
      return createRequire(pathToFileURL(join(directory, "package.json"))).resolve(packageName);
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error(`${packageName} is not resolvable upward from ${startDir}`);
}

function hostPackageEntry(packageName: string, options: { inferredRoot?: string; selfUrl?: string } = {}): string {
  const configuredRoot = process.env.PI_PACKAGE_DIR?.trim();
  const entryPath = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return ""; } })() : "";
  const entryDirectory = entryPath ? dirname(entryPath) : "";
  const inferredRoot = options.inferredRoot
    ?? (entryDirectory ? (basename(entryDirectory) === "bundle" ? dirname(dirname(entryDirectory)) : dirname(entryDirectory)) : "");
  const root = configuredRoot || inferredRoot;
  const selfUrl = options.selfUrl ?? import.meta.url;
  const candidates: Array<() => string> = [
    ...(root ? [
      () => createRequire(pathToFileURL(join(root, "package.json"))).resolve(packageName),
      () => createRequire(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))).resolve(packageName),
      () => resolveUpward(root, packageName),
    ] : []),
    () => {
      // 经宿主模块树解析（jiti alias 或全局安装均可命中 @earendil-works/pi-coding-agent 所在依赖树）
      const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      return resolveUpward(dirname(realpathSync(hostEntry)), packageName);
    },
    () => createRequire(selfUrl).resolve(packageName),
    () => resolveUpward(dirname(realpathSync(fileURLToPath(selfUrl))), packageName),
  ];
  for (const resolve of candidates) {
    try {
      return pathToFileURL(resolve()).href;
    } catch {
      continue;
    }
  }
  throw new Error(`openai proxy cannot resolve ${packageName} from the Pi host package tree`);
}

export const hostPackageEntryForTest = hostPackageEntry;

export async function loadOpenAIApi() {
  const module = await import("@earendil-works/pi-ai/compat");
  return module.openAIResponsesApi();
}

export async function loadOpenAICodexApi() {
  const module = await import("@earendil-works/pi-ai/compat");
  return module.openAICodexResponsesApi();
}

function validProxy(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && Boolean(url.hostname)
      && (!url.port || (Number(url.port) >= 1 && Number(url.port) <= 65535));
  } catch {
    return false;
  }
}

export function loadOpenAIProxyConfig(
  configPath: string,
  { onError }: { onError?: (message: string) => void } = {},
): { proxy: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    // 本机未配置 openai-proxy.json 时静默跳过，不产生启动告警噪音。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    onError?.("openai proxy configuration could not be read");
    return undefined;
  }
  try {
    const config = JSON.parse(raw);
    if (validProxy(config?.proxy)) return { proxy: config.proxy };
    onError?.("openai proxy configuration has an invalid proxy URL");
    return undefined;
  } catch {
    onError?.("openai proxy configuration is not valid JSON");
    return undefined;
  }
}

async function defaultCreateProxyFetch(proxy: string) {
  const { fetch: undiciFetch, ProxyAgent } = await import(hostPackageEntry("undici"));
  const dispatcher = new ProxyAgent(proxy);
  const wrapped: any = (input: any, init: any = {}) => undiciFetch(input, { ...init, dispatcher }) as any;
  wrapped.close = () => dispatcher.close?.();
  return wrapped;
}

export const OAUTH_PROXY_HOSTS = ["auth.openai.com", "chatgpt.com"];
const SCOPED_FETCH_KEY = Symbol.for("pi.openai-proxy.scopedFetch");
const SCOPED_STATE_KEY = Symbol.for("pi.openai-proxy.scopedState");

type ScopedProxyState = {
  proxyFetch: any;
  allowed: Set<string>;
  proxy?: string;
};

const targetProxyClosers = new WeakMap<object, { proxyFetch: any; close?: () => unknown }>();

function closeProxyHandle(close: (() => unknown) | undefined): void {
  if (typeof close !== "function") return;
  try {
    void Promise.resolve(close()).catch(() => {});
  } catch {
    // 忽略关闭旧 ProxyAgent 时的清理异常
  }
}

function requestUrl(input: any): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input.url === "string") return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

function isScopedFetch(value: any): boolean {
  return typeof value === "function" && Boolean((value as any)[SCOPED_FETCH_KEY]);
}

/**
 * 同步安装或热更新主机白名单 fetch 包装层：通过可变委托槽切换新代理并关闭旧 ProxyAgent。
 */
export function installScopedProxyFetch(
  proxyFetch: any,
  { hosts = OAUTH_PROXY_HOSTS, target = globalThis as any, proxy }: any = {},
) {
  const allowed = new Set<string>(hosts);
  const previous = targetProxyClosers.get(target);
  if (previous && previous.proxyFetch !== proxyFetch) {
    closeProxyHandle(previous.close);
  }
  const nextClose = typeof proxyFetch?.close === "function" ? () => proxyFetch.close() : undefined;
  targetProxyClosers.set(target, { proxyFetch, close: nextClose });

  if (isScopedFetch(target.fetch)) {
    const state = (target.fetch as any)[SCOPED_STATE_KEY] as ScopedProxyState | undefined;
    if (state) {
      state.proxyFetch = proxyFetch;
      state.allowed = allowed;
      if (proxy !== undefined) state.proxy = proxy;
      return target.fetch;
    }
  }

  const state: ScopedProxyState = { proxyFetch, allowed, ...(proxy !== undefined ? { proxy } : {}) };
  const original = target.fetch.bind(target);
  const scoped: any = (input: any, init: any) => {
    const url = requestUrl(input);
    if (!url || !state.allowed.has(url.hostname)) return original(input, init);
    return state.proxyFetch(input, init);
  };
  Object.defineProperty(scoped, SCOPED_FETCH_KEY, { value: true });
  Object.defineProperty(scoped, SCOPED_STATE_KEY, { value: state });
  target.fetch = scoped;
  return scoped;
}

/**
 * 安装或按需热更新主机白名单 fetch 包装层；代理 URL 未变化时保持幂等，变更时替换委托并关闭旧 ProxyAgent。
 */
export async function ensureScopedProxyFetch(
  proxy: string,
  { hosts = OAUTH_PROXY_HOSTS, createProxyFetch = defaultCreateProxyFetch, target = globalThis as any }: any = {},
) {
  if (isScopedFetch(target.fetch)) {
    const state = (target.fetch as any)[SCOPED_STATE_KEY] as ScopedProxyState | undefined;
    if (state && state.proxy === proxy) {
      state.allowed = new Set<string>(hosts);
      return target.fetch;
    }
  }
  const proxyFetch = await createProxyFetch(proxy);
  return installScopedProxyFetch(proxyFetch, { hosts, target, proxy });
}

export async function createOpenAIProxyExtension(
  pi: any,
  { openaiApi, codexApi, proxy, createProxyFetch = defaultCreateProxyFetch }: any = {},
) {
  if (!validProxy(proxy)) return;
  const fetch = await createProxyFetch(proxy);
  const keepOAuthProxy = () => {
    installScopedProxyFetch(fetch, { proxy });
  };
  keepOAuthProxy();

  const openai = openaiApi ?? await loadOpenAIApi();
  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: any, context: any, options: any = {}) {
      keepOAuthProxy();
      return openai.streamSimple(model, context, { ...options, fetch });
    },
  });

  const codex = codexApi ?? await loadOpenAICodexApi();
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple(model: any, context: any, options: any = {}) {
      keepOAuthProxy();
      // codex 的 auto 传输会选 WebSocket，而 WebSocket 不吃注入的 fetch；强制 sse 才能走代理。
      return codex.streamSimple(model, context, { ...options, fetch, transport: "sse" });
    },
  });
}
