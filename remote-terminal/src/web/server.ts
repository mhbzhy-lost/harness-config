import pty from "node-pty";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);

export type WebServerOptions = {
  /** HTTP 监听端口 */
  port: number;
  /** HTTP 监听地址，默认 0.0.0.0 以便局域网访问 */
  host: string;
  /** 可选访问令牌；未设置时同一局域网内任何设备都可控制终端 */
  token?: string;
  /** 默认 attach 的 tmux 会话名（仅当 URL 未传 ?session= 时回退） */
  defaultSession?: string;
  /** attach 初始尺寸；客户端连入后会随 syncSize 调整 */
  cols: number;
  rows: number;
  /** attach 进程的默认工作目录 */
  cwd: string;
};

export type SessionInfo = {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  command?: string;
  cwd?: string;
};

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type ServerMessage = { type: "hello"; cols: number; rows: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function here(rel: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), rel);
}

async function resolvePackageFile(pkg: string, rel: string): Promise<string> {
  const pkgJson = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
  return path.join(path.dirname(pkgJson), rel);
}

/**
 * 修复 node-pty 预编译 spawn-helper 的执行权限（npm --ignore-scripts 或 prebuild 解压常缺执行位）。
 */
export async function ensureNodePtyReady(): Promise<void> {
  const pkgDir = path.dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  const prebuildsDir = path.join(pkgDir, "prebuilds");
  let platforms: string[] = [];
  try {
    platforms = await readdir(prebuildsDir);
  } catch {
    // prebuilds 目录不存在，尝试下载
  }
  if (platforms.length === 0) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, ["scripts/prebuild.js"], { cwd: pkgDir });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("node-pty prebuild 下载失败"))));
      child.on("error", reject);
    });
    platforms = await readdir(prebuildsDir);
  }
  for (const platform of platforms) {
    const helper = path.join(prebuildsDir, platform, "spawn-helper");
    try {
      const st = await stat(helper);
      if ((st.mode & 0o111) === 0) await chmod(helper, 0o755);
    } catch {
      // 非 unix 平台无 spawn-helper，忽略
    }
  }
}

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

async function tmux(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { cwd, encoding: "utf8" });
  return stdout;
}

export async function checkTmux(): Promise<string> {
  try {
    const version = (await tmux(["-V"])).trim();
    return version.replace(/^tmux\s+/, "");
  } catch {
    throw new Error("未找到 tmux。请先安装：brew install tmux");
  }
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [ma, mb] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(ma)) return false;
  if (ma !== major) return ma > major;
  return (Number.isFinite(mb) ? mb : 0) >= minor;
}

/** 列出当前全部 tmux 会话（承载任意 CLI / Agent / Shell 会话）。 */
export async function listTmuxSessions(): Promise<SessionInfo[]> {
  try {
    const out = await tmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{t:session_created}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [name = "", windows = "1", created = "", attached = "0", command = "", cwd = ""] = line.split("\t");
        return {
          name,
          windows: Number(windows) || 1,
          created,
          attached: attached !== "0",
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
        };
      });
  } catch {
    return [];
  }
}

async function applyTmuxTuning(tmuxVersion: string): Promise<void> {
  const settings: string[][] = [
    ["set-option", "-s", "escape-time", "10"],
    ["set-option", "-as", "terminal-overrides", ",*:RGB"],
    ["set-option", "-g", "extended-keys", "on"],
    ["set-option", "-g", "mouse", "on"],
    ["unbind-key", "-T", "root", "WheelUpPane"],
    ["bind-key", "-T", "copy-mode", "WheelUpPane", "select-pane ; send-keys -X -N 1 scroll-up"],
    ["bind-key", "-T", "copy-mode", "WheelDownPane", "select-pane ; send-keys -X -N 1 scroll-down"],
    ["bind-key", "-T", "copy-mode-vi", "WheelUpPane", "select-pane ; send-keys -X -N 1 scroll-up"],
    ["bind-key", "-T", "copy-mode-vi", "WheelDownPane", "select-pane ; send-keys -X -N 1 scroll-down"],
  ];
  if (versionAtLeast(tmuxVersion, 3, 5)) settings.push(["set-option", "-g", "extended-keys-format", "csi-u"]);
  for (const args of settings) {
    try {
      await tmux(args);
    } catch {
      // 无 tmux server 时跳过；创建会话后由 shell 包装补设
    }
  }
}

/** tmux 会话名白名单：禁止冒号/点号，避免 tmux target 语法注入 */
export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function startWebServer(opts: WebServerOptions): Promise<{ server: Server; close: () => Promise<void>; urls: string[] }> {
  await ensureNodePtyReady();
  const tmuxVersion = await checkTmux();
  await applyTmuxTuning(tmuxVersion);

  const [xtermJs, xtermCss, fitJs] = await Promise.all([
    readFile(await resolvePackageFile("@xterm/xterm", "lib/xterm.js")),
    readFile(await resolvePackageFile("@xterm/xterm", "css/xterm.css")),
    readFile(await resolvePackageFile("@xterm/addon-fit", "lib/addon-fit.js")),
  ]);

  const assets: Record<string, { body: string | Buffer; type: string }> = {
    "/": {
      body: (await readFile(here("public/index.html"))).toString("utf8").replaceAll("__BUILD__", new Date().toISOString().slice(11, 19)),
      type: MIME[".html"]!,
    },
    "/xterm.js": { body: xtermJs, type: MIME[".js"]! },
    "/xterm.css": { body: xtermCss, type: MIME[".css"]! },
    "/xterm-fit.js": { body: fitJs, type: MIME[".js"]! },
  };

  const wss = new WebSocketServer({ noServer: true });
  // 仅 public 模式由 ensure 设置 HARNESS_REMOTE_TRUST_LOOPBACK=1（兼容旧 PI_WEB_TRUST_LOOPBACK=1）
  const trustLoopback = process.env.HARNESS_REMOTE_TRUST_LOOPBACK === "1" || process.env.PI_WEB_TRUST_LOOPBACK === "1";
  const isLoopback = (req: IncomingMessage): boolean => {
    const addr = req.socket.remoteAddress ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  };
  const checkToken = (url: URL, req: IncomingMessage): boolean =>
    (trustLoopback && isLoopback(req)) || !opts.token || url.searchParams.get("token") === opts.token;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!checkToken(url, req)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("令牌无效：请在 URL 上携带 ?token=...");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ sessions: await listTmuxSessions() }));
      return;
    }
    const asset = assets[url.pathname];
    if (!asset || req.method !== "GET") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
    res.end(asset.body);
  });

  const livePties = new Set<pty.IPty>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !checkToken(url, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionName = url.searchParams.get("session") ?? opts.defaultSession ?? "";
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const pending: string[] = [];
      let attach: pty.IPty | null = null;
      let wsClosed = false;

      const killAttach = () => {
        if (!attach) return;
        const target = attach;
        attach = null;
        try {
          target.kill();
        } catch {
          // 已退出则忽略
        }
        livePties.delete(target);
      };

      // 先于异步 tmux 校验注册 close 监听，防止握手期间客户端断开后泄漏孤儿 pty。
      ws.on("close", () => {
        wsClosed = true;
        killAttach();
      });

      const dispatch = (raw: string) => {
        if (!attach) {
          pending.push(raw);
          return;
        }
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "input") attach.write(msg.data);
        else if (msg.type === "resize") {
          const cols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
          const rows = Math.max(2, Math.min(300, Math.floor(msg.rows)));
          try {
            attach.resize(cols, rows);
          } catch {
            // attach 退出瞬间 resize 可能失败，忽略
          }
        }
      };
      ws.on("message", (raw) => dispatch(String(raw)));

      const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
      delete env.PI_SESSION_OWNER_ID;
      delete env.PI_SESSION_OWNER_REGISTRY;
      try {
        if (!SESSION_NAME_RE.test(sessionName)) throw new Error(`会话名不合法：${sessionName || "(空)"}`);
        await tmux(["has-session", "-t", sessionName]);
        if (wsClosed || ws.readyState !== ws.OPEN) return;
        const att = pty.spawn("tmux", ["attach-session", "-t", sessionName], {
          name: "xterm-256color",
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env,
        });
        attach = att;
        livePties.add(att);
        ws.send(JSON.stringify({ type: "hello", cols: att.cols, rows: att.rows } satisfies ServerMessage));
        att.onData((data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
        });
        att.onExit(() => {
          livePties.delete(att);
          if (attach === att) attach = null;
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
        });
        for (const raw of pending.splice(0)) dispatch(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m[remote-terminal 会话不可用：${reason}]\x1b[0m\r\n` }));
        }
        ws.close();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const close = async () => {
    for (const ws of wss.clients) ws.close();
    for (const p of livePties) {
      try {
        p.kill();
      } catch {
        // 忽略
      }
    }
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, close, urls: lanUrls(opts.port) };
}
