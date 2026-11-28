// cliproxyapi 懒加载控制器：与 Qwen 共用 ~/.qwen/cliproxyapi 状态目录和 qwen/extensions/cliproxyapi/scripts/manager.py。
// 两级短路（无凭据 → 端口已监听）避免每次 agent 启动都付出 Python 启动开销；任何异常都吞掉，绝不阻塞 Pi。
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CliproxyapiOptions {
  stateDir: string;
  port: number;
  managerPy: string;
  python: string;
  /** manager.py 子进程的环境（manager.py 用 expanduser 定位状态目录，故需带上 HOME） */
  env: NodeJS.ProcessEnv;
  connectTimeoutMs: number;
  startTimeoutMs: number;
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
    ...overrides,
  };
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
  // 扩展加载即后台触发一次（不 await，避免拖慢启动）；before_agent_start 时若仍在拉起则等待其完成，
  // 若代理曾被手动停止则按需重拉（in-flight 已清空后会重新探测端口）
  void controller.ensure();
  pi.on("before_agent_start", async () => {
    await controller.ensure();
  });
  // 有意不注册 session_shutdown 等退出回收：Qwen 与 Pi 共用同一代理，任一端退出都不得杀掉它
  return controller;
}
