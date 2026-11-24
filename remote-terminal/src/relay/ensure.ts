/**
 * 三态（off/lan/public）ensure 状态机与进程管理。
 * 通用化版本：托管 remote-terminal web-server 与出站 relay agent，承载任意 tmux 会话。
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "../protocol.ts";
import { loadRemoteSettings, resolveWebPort, type RemoteSettings } from "./config.ts";
import { audit, readActivePending, readDevices } from "./devices.ts";

const execFileAsync = promisify(execFile);

async function callerDesc(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(process.ppid), "-o", "command="], { encoding: "utf8" });
    return `ppid=${process.ppid} cmd=${stdout.trim().slice(0, 120)}`;
  } catch {
    return `ppid=${process.ppid}`;
  }
}

type WebState = { pid: number; port: number; host: string; tokenFingerprint: string; trustLoopback: boolean };

function webStatePath(stateDir: string): string { return path.join(stateDir, "web.json"); }
function webPidPath(stateDir: string): string { return path.join(stateDir, "web.pid"); }
function agentPidPath(stateDir: string): string { return path.join(stateDir, "agent.pid"); }

async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

async function readJson<T>(file: string): Promise<T | null> {
  const raw = await readText(file);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function cmdline(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function pgidOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

const isWebCmdline = (line: string): boolean =>
  line.includes("remote-terminal/scripts/web-server.ts") || line.includes("scripts/pi-web.ts");
const isAgentCmdline = (line: string): boolean =>
  (line.includes("remote-terminal/scripts/remote-ctl.ts") || line.includes("scripts/pi-relay.ts")) && line.includes("_agent");

function probeWeb(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/sessions", timeout: 1_000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** 扫描监听指定端口的全部进程，区分自有 web server 与陌生进程 */
async function findWebListener(port: number): Promise<{ pid: number; ours: boolean } | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    let firstForeign: number | null = null;
    for (const line of stdout.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (isWebCmdline(await cmdline(pid))) return { pid, ours: true };
      firstForeign ??= pid;
    }
    return firstForeign !== null ? { pid: firstForeign, ours: false } : null;
  } catch {
    return null;
  }
}

async function stopPid(stateDir: string, pid: number, label: string): Promise<void> {
  if (!pidAlive(pid)) return;
  const pgid = await pgidOf(pid);
  const target = pgid === pid ? -pid : pid;
  await audit(stateDir, `stop ${label} pid=${pid} signal=SIGTERM group=${pgid === pid} caller=${await callerDesc()}`);
  try { process.kill(target, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(pid)) {
    await audit(stateDir, `stop ${label} pid=${pid} escalate=SIGKILL`);
    try { process.kill(target, "SIGKILL"); } catch { /* 已退出 */ }
  }
}

async function stopWeb(stateDir: string, port: number): Promise<void> {
  const state = await readJson<WebState>(webStatePath(stateDir));
  if (state && pidAlive(state.pid) && isWebCmdline(await cmdline(state.pid))) {
    await stopPid(stateDir, state.pid, "web");
  } else {
    const listener = await findWebListener(port);
    if (listener?.ours) await stopPid(stateDir, listener.pid, "web-legacy");
    else if (listener) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
  }
  await unlink(webPidPath(stateDir)).catch(() => {});
  await unlink(webStatePath(stateDir)).catch(() => {});
}

async function stopAgent(stateDir: string): Promise<void> {
  const raw = await readText(agentPidPath(stateDir));
  const pid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  if (Number.isInteger(pid) && pidAlive(pid) && isAgentCmdline(await cmdline(pid))) {
    await stopPid(stateDir, pid, "agent");
  }
  await unlink(agentPidPath(stateDir)).catch(() => {});
}

async function withEnsureLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, "ensure.lock");
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt((await readFile(lockFile, "utf8")).trim(), 10);
        stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
      } catch {
        stale = true;
      }
      if (stale) {
        await unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("ensure 锁等待超时：可能有其他会话正在初始化，请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch(() => {});
  }
}

async function spawnDetached(pkgRoot: string, stateDir: string, args: string[], logName: string, env: Record<string, string>, pidFile: string): Promise<number> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logHandle = await open(path.join(stateDir, logName), "a", 0o600);
  try {
    const nodeBin = process.env.HARNESS_REMOTE_NODE?.trim() || process.execPath;
    const child = spawn(nodeBin, args, {
      cwd: pkgRoot,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env, ...env },
    });
    child.unref();
    if (!child.pid) throw new Error(`后台进程启动失败：${args.join(" ")}`);
    await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
    return child.pid;
  } finally {
    await logHandle.close();
  }
}

async function ensureWebToken(stateDir: string): Promise<string> {
  const file = path.join(stateDir, "web-token");
  const existing = (await readText(file))?.trim();
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const token = randomBytes(32).toString("base64url");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function lanIpv4s(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) result.push(net.address);
    }
  }
  return result;
}

async function webMatches(stateDir: string, desired: WebState): Promise<boolean> {
  const state = await readJson<WebState>(webStatePath(stateDir));
  if (!state || state.pid !== desired.pid) return false;
  return (
    state.port === desired.port &&
    state.host === desired.host &&
    state.tokenFingerprint === desired.tokenFingerprint &&
    state.trustLoopback === desired.trustLoopback &&
    pidAlive(state.pid) &&
    isWebCmdline(await cmdline(state.pid))
  );
}

async function startWeb(pkgRoot: string, stateDir: string, port: number, host: string, token: string | undefined, trustLoopback: boolean): Promise<number> {
  const args = [path.join(pkgRoot, "scripts", "web-server.ts"), "--port", String(port), "--host", host];
  if (token) args.push("--token", token);
  const pid = await spawnDetached(
    pkgRoot,
    stateDir,
    args,
    "web.log",
    trustLoopback ? { HARNESS_REMOTE_TRUST_LOOPBACK: "1" } : {},
    webPidPath(stateDir),
  );
  const state: WebState = { pid, port, host, tokenFingerprint: sha256Hex(token ?? ""), trustLoopback };
  await writeFile(webStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await probeWeb(port)) return pid;
    if (!pidAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!pidAlive(pid)) throw new Error(`remote-terminal web 启动失败，详见 ${path.join(stateDir, "web.log")}`);
  return pid;
}

async function agentRunning(stateDir: string): Promise<boolean> {
  const raw = await readText(agentPidPath(stateDir));
  const pid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isInteger(pid) && pidAlive(pid) && isAgentCmdline(await cmdline(pid));
}

async function hintPending(stateDir: string): Promise<void> {
  const pending = await readActivePending(stateDir);
  const hintFile = path.join(stateDir, "pending-hint.json");
  const ids = pending.map((p) => p.id).sort().join(",");
  const last = await readText(hintFile);
  if (pending.length === 0) {
    if (last !== "") await writeFile(hintFile, "", { mode: 0o600 }).catch(() => {});
    return;
  }
  if (last === ids) return;
  console.log(`有 ${pending.length} 台设备等待批准，运行 rtctl devices 查看`);
  await writeFile(hintFile, ids, { mode: 0o600 }).catch(() => {});
}

export type EnsureResult = { exposure: string; changed: boolean; messages: string[] };

export async function ensureRemote(pkgRoot: string, stateDir: string, configPath: string): Promise<EnsureResult> {
  const settings: RemoteSettings = await loadRemoteSettings(configPath);
  const port = resolveWebPort();
  const messages: string[] = [];
  await audit(stateDir, `ensure exposure=${settings.exposure} config=${configPath} caller=${await callerDesc()}`);

  return withEnsureLock(stateDir, async () => {
    const prevState = await readJson<{ exposure: string; webPid: number | null; agentPid: number | null }>(path.join(stateDir, "ensure-state.json"));

    if (settings.exposure === "off") {
      await stopWeb(stateDir, port);
      await stopAgent(stateDir);
      await writeFile(path.join(stateDir, "ensure-state.json"), JSON.stringify({ exposure: "off", webPid: null, agentPid: null }), { mode: 0o600 });
      return { exposure: "off", changed: prevState?.exposure !== "off", messages };
    }

    if (settings.exposure === "public" && !settings.relay) {
      throw new Error(`webExposure=public 需要 webRelay 凭据（url/agentToken/caFingerprint）：请写入 ${configPath} 或运行 rtctl join`);
    }
    if (settings.exposure === "public") {
      const caFile = path.join(stateDir, "root-ca.crt");
      if (!(await readText(caFile))) {
        throw new Error(`缺少中继 CA（${caFile}）：请先运行 rtctl fetch-ca`);
      }
    }

    const trustLoopback = settings.exposure === "public";
    const token = settings.exposure === "public"
      ? await ensureWebToken(stateDir)
      : (process.env.HARNESS_REMOTE_TOKEN || process.env.PI_WEB_TOKEN || undefined);
    const host = "0.0.0.0";
    const desired: WebState = { pid: 0, port, host, tokenFingerprint: sha256Hex(token ?? ""), trustLoopback };

    let currentPid: number | null = null;
    const managed = await readJson<WebState>(webStatePath(stateDir));
    if (managed && pidAlive(managed.pid) && isWebCmdline(await cmdline(managed.pid))) {
      currentPid = managed.pid;
    } else if (await probeWeb(port)) {
      const listener = await findWebListener(port);
      if (listener?.ours) currentPid = listener.pid;
      else if (listener) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
    } else {
      const listener = await findWebListener(port);
      if (listener && !listener.ours) throw new Error(`端口 ${port} 被陌生进程占用（pid=${listener.pid}），请手动处理后重试`);
    }

    let webPid = currentPid;
    if (currentPid !== null) {
      desired.pid = currentPid;
      if (!(await webMatches(stateDir, desired))) {
        await stopPid(stateDir, currentPid, "web-restart");
        await unlink(webStatePath(stateDir)).catch(() => {});
        webPid = await startWeb(pkgRoot, stateDir, port, host, token, trustLoopback);
      }
    } else {
      webPid = await startWeb(pkgRoot, stateDir, port, host, token, trustLoopback);
    }

    let agentPid: number | null = null;
    if (settings.exposure === "public") {
      if (!(await agentRunning(stateDir))) {
        agentPid = await spawnDetached(
          pkgRoot,
          stateDir,
          [path.join(pkgRoot, "scripts", "remote-ctl.ts"), "_agent"],
          "agent.log",
          {
            HARNESS_REMOTE_PORT: String(port),
            HARNESS_REMOTE_DIR: stateDir,
            HARNESS_REMOTE_CONFIG: configPath,
          },
          agentPidPath(stateDir),
        );
      } else {
        agentPid = Number.parseInt((await readText(agentPidPath(stateDir)))!.trim(), 10);
      }
    } else {
      await stopAgent(stateDir);
    }

    const changed = prevState?.exposure !== settings.exposure || prevState?.webPid !== webPid || prevState?.agentPid !== agentPid;
    if (changed) {
      if (settings.exposure === "lan") {
        for (const ip of lanIpv4s()) messages.push(`远程终端局域网访问：http://${ip}:${port}${token ? `/?token=${token}` : ""}`);
      } else {
        const relayHost = new URL(settings.relay!.url).hostname;
        const relayPort = new URL(settings.relay!.url).port;
        messages.push(`远程终端公网入口：https://${relayHost}${relayPort && relayPort !== "443" ? `:${relayPort}` : ""}/（首次访问需本机 rtctl approve 批准）`);
        for (const ip of lanIpv4s()) messages.push(`远程终端局域网直连：http://${ip}:${port}/?token=${token}`);
      }
    }
    await hintPending(stateDir);
    await writeFile(path.join(stateDir, "ensure-state.json"), JSON.stringify({ exposure: settings.exposure, webPid, agentPid }), { mode: 0o600 });
    return { exposure: settings.exposure, changed, messages };
  });
}

export async function stopAll(stateDir: string): Promise<void> {
  const port = resolveWebPort();
  await audit(stateDir, `stop-all caller=${await callerDesc()}`);
  await withEnsureLock(stateDir, async () => {
    await stopWeb(stateDir, port);
    await stopAgent(stateDir);
    await writeFile(path.join(stateDir, "ensure-state.json"), JSON.stringify({ exposure: "off", webPid: null, agentPid: null }), { mode: 0o600 });
  });
}

export async function statusReport(stateDir: string, configPath: string): Promise<string> {
  const settings = await loadRemoteSettings(configPath);
  const port = resolveWebPort();
  const lines: string[] = [`webExposure：${settings.exposure}`, `配置路径：${configPath}`, `状态目录：${stateDir}`];
  const web = await readJson<WebState>(webStatePath(stateDir));
  if (web && pidAlive(web.pid) && isWebCmdline(await cmdline(web.pid))) {
    lines.push(`web-server：pid=${web.pid} ${web.host}:${web.port} trustLoopback=${web.trustLoopback}`);
  } else {
    lines.push("web-server：未运行");
  }
  const agentStatus = await readJson<{ state: string; lastHeartbeat: string | null }>(path.join(stateDir, "agent-status.json"));
  if (await agentRunning(stateDir)) {
    lines.push(`relay-agent：${agentStatus?.state ?? "unknown"}${agentStatus?.lastHeartbeat ? ` 最近心跳=${agentStatus.lastHeartbeat}` : ""}`);
  } else {
    lines.push("relay-agent：未运行");
  }
  const devices = await readDevices(stateDir);
  const pending = await readActivePending(stateDir);
  lines.push(`可信设备：${devices.length} 台；待批准：${pending.length} 台`);
  if (settings.exposure !== "off") {
    const token = settings.exposure === "public"
      ? (await readText(path.join(stateDir, "web-token")))?.trim()
      : (process.env.HARNESS_REMOTE_TOKEN || process.env.PI_WEB_TOKEN);
    for (const ip of lanIpv4s()) lines.push(`局域网直连：http://${ip}:${port}${token ? `/?token=${token}` : ""}`);
    if (settings.exposure === "public" && settings.relay) {
      const url = new URL(settings.relay.url);
      lines.push(`公网入口：https://${url.hostname}${url.port && url.port !== "443" ? `:${url.port}` : ""}/`);
    }
  }
  return lines.join("\n");
}
