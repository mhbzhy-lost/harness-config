// cliproxyapi 懒加载控制器：与 Qwen 共用 ~/.qwen/cliproxyapi 状态目录和 qwen/extensions/cliproxyapi/scripts/manager.py。
// 两级短路（无凭据 → 端口已监听）避免每次 agent 启动都付出 Python 启动开销；任何异常都吞掉，绝不阻塞 Pi。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

export interface CliproxyapiOptions {
  stateDir: string;
  port: number;
  managerPy: string;
  python: string;
  /** manager.py 子进程的环境（manager.py 用 expanduser 定位状态目录，故需带上 HOME） */
  env: NodeJS.ProcessEnv;
  connectTimeoutMs: number;
  startTimeoutMs: number;
  /** Pi models.json 路径；仅读取用于运行时兜底注册，绝不写回 */
  modelsPath?: string;
}

export const DEFAULT_CLIPROXYAPI_PORT = 8317;

export function resolveCliproxyapiOptions(
  env: NodeJS.ProcessEnv,
  selfUrl: string,
  overrides: Partial<CliproxyapiOptions> = {},
): CliproxyapiOptions {
  const port = Number(env.CLIPROXYAPI_API_PORT || env.CODEX_PROXY_API_PORT || DEFAULT_CLIPROXYAPI_PORT);
  // 仓内布局：<repo>/pi/extensions/cliproxyapi/controller.ts → <repo>/qwen/extensions/cliproxyapi/scripts/manager.py
  const defaultManagerPy = resolve(dirname(fileURLToPath(selfUrl)), "../../../qwen/extensions/cliproxyapi/scripts/manager.py");
  return {
    stateDir: env.CLIPROXYAPI_STATE_DIR || join(homedir(), ".qwen", "cliproxyapi"),
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_CLIPROXYAPI_PORT,
    managerPy: env.CLIPROXYAPI_MANAGER_PY || defaultManagerPy,
    python: "python3",
    env,
    connectTimeoutMs: 200,
    startTimeoutMs: 12_000,
    modelsPath: join(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "models.json"),
    ...overrides,
  };
}

/** 仅保留 scheme + host + port，忽略 /v1beta 等路径后缀。 */
function loopbackOrigin(baseUrl: string, port: number): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
  if (url.port !== String(port)) return undefined;
  return `http://${url.hostname}:${url.port}`;
}

/**
 * 纯函数：扫描 models.json 的 providers，找出走本地回环 CLIProxyAPI 且 api 为 google-generative-ai、
 * 但未显式配置 compat.supportsStrictMode 的模型，返回需重新注册的 provider 定义。
 *
 * 根因：Pi 默认对 gemini-3+ 模型开启 VALIDATED 严格工具模式（anyOf schema 改写），
 * 会触发 Antigravity 429 RESOURCE_EXHAUSTED；回环代理场景下由本扩展运行时兜底关闭。
 * 用户显式配置的 true / false 完全尊重；其余 provider 与所有字段原样保留；返回的对象与入参不共享引用。
 */
export function collectCliproxyapiStrictModeOverrides(
  doc: unknown,
  port: number,
): Array<{ name: string; config: ProviderConfig }> {
  const out: Array<{ name: string; config: ProviderConfig }> = [];
  if (!doc || typeof doc !== "object") return out;
  const providers = (doc as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object") return out;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as Record<string, unknown>;
    const models = Array.isArray(p.models) ? p.models : [];
    let changed = false;
    const nextModels = models.map((model) => {
      if (!model || typeof model !== "object") return model;
      const m = model as Record<string, unknown>;
      const api = m.api ?? p.api;
      const baseUrl = m.baseUrl ?? p.baseUrl;
      const compat = (m.compat && typeof m.compat === "object" ? m.compat : {}) as Record<string, unknown>;
      if (compat.supportsStrictMode !== undefined) return model;
      if (api !== "google-generative-ai") return model;
      if (typeof baseUrl !== "string" || loopbackOrigin(baseUrl, port) === undefined) return model;
      changed = true;
      return { ...m, compat: { ...compat, supportsStrictMode: false } };
    });
    if (!changed) continue;
    out.push({ name, config: { ...p, models: nextModels } as unknown as ProviderConfig });
  }
  return out;
}

/** 短路 1：<stateDir>/auth 下存在任意 *.json 即视为有凭据。只读文件名，绝不读取凭据内容。 */
export function hasCredentials(stateDir: string): boolean {
  try {
    return readdirSync(join(stateDir, "auth")).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** 短路 2：向 127.0.0.1:<port> 做短超时 TCP connect，连通即认为代理已在监听。 */
export function portListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function runManagerStart(opts: CliproxyapiOptions): Promise<void> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(opts.python, [opts.managerPy, "start"], {
        stdio: "ignore",
        env: opts.env,
        windowsHide: true,
      });
    } catch {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.startTimeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once("error", done);
    child.once("exit", done);
  });
}

export interface LazyProxyController {
  /** 确保代理在运行；并发调用合并为同一次 in-flight。永不 reject。 */
  ensure(): Promise<void>;
  /** 当前进行中的拉起（若有），供测试与 before_agent_start 等待。 */
  inflight(): Promise<void> | undefined;
}

export function createLazyProxyController(opts: CliproxyapiOptions): LazyProxyController {
  let inflight: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    // 并发调用合并到同一次 in-flight，避免重复拉起；in-flight 结束后下一次调用会重新探测端口（按需重拉）
    if (inflight) return inflight;
    if (!hasCredentials(opts.stateDir)) return Promise.resolve();
    // 所有异常吞掉：懒加载失败不得阻塞 Pi
    const guarded = (async () => {
      if (await portListening(opts.port, opts.connectTimeoutMs)) return;
      await runManagerStart(opts);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (inflight === guarded) inflight = undefined;
      });
    inflight = guarded;
    return guarded;
  };

  return { ensure, inflight: () => inflight };
}

export function createCliproxyapiExtension(pi: ExtensionAPI, opts: CliproxyapiOptions): LazyProxyController {
  const controller = createLazyProxyController(opts);

  // 运行时兜底：本地回环 CLIProxyAPI 的 google-generative-ai 模型关闭严格工具模式（见 collectCliproxyapiStrictModeOverrides）。
  // 只读 models.json、只经 pi.registerProvider 覆盖，绝不写回磁盘；文件缺失或解析失败静默忽略。
  const registered = new Map<string, string>();
  let shutdownCleanupInstalled = false;
  const applyStrictModeOverrides = (): void => {
    if (!opts.modelsPath || typeof pi.registerProvider !== "function") return;
    let overrides: ReturnType<typeof collectCliproxyapiStrictModeOverrides>;
    try {
      if (!existsSync(opts.modelsPath)) {
        overrides = [];
      } else {
        overrides = collectCliproxyapiStrictModeOverrides(JSON.parse(readFileSync(opts.modelsPath, "utf8")), opts.port);
      }
    } catch {
      return;
    }
    const desired = new Map<string, { config: ProviderConfig; fingerprint: string }>();
    for (const { name, config } of overrides) {
      desired.set(name, { config, fingerprint: JSON.stringify(config) });
    }
    // 若用户已在 models.json 显式补齐或移除了该 provider，注销旧覆盖避免快照陈旧
    if (typeof pi.unregisterProvider === "function") {
      for (const name of [...registered.keys()]) {
        if (desired.has(name)) continue;
        try {
          pi.unregisterProvider(name);
        } catch {
          // ignore
        }
        registered.delete(name);
      }
    }
    for (const [name, { config, fingerprint }] of desired) {
      if (registered.get(name) === fingerprint) continue;
      try {
        pi.registerProvider(name, config);
        registered.set(name, fingerprint);
      } catch {
        // 注册失败不影响代理懒加载
      }
    }
    if (registered.size > 0 && !shutdownCleanupInstalled && typeof pi.unregisterProvider === "function") {
      shutdownCleanupInstalled = true;
      pi.on("session_shutdown", () => {
        // 仅注销本扩展注册过的 provider；有意不在此回收代理进程（Qwen 与 Pi 共用）
        for (const name of registered.keys()) {
          try {
            pi.unregisterProvider(name);
          } catch {
            // ignore
          }
        }
        registered.clear();
      });
    }
  };
  applyStrictModeOverrides();

  // 扩展加载即后台触发一次（不 await，避免拖慢启动）；before_agent_start 时若仍在拉起则等待其完成，
  // 若代理曾被手动停止则按需重拉（in-flight 已清空后会重新探测端口）
  void controller.ensure();
  pi.on("before_agent_start", async () => {
    await controller.ensure();
  });
  // session_start 时重读 models.json（用户可能在会话间手改），兜底新出现的回环 gemini 模型
  pi.on("session_start", () => {
    applyStrictModeOverrides();
  });
  // 有意不注册代理进程的退出回收：Qwen 与 Pi 共用同一代理，任一端退出都不得杀掉它
  return controller;
}
