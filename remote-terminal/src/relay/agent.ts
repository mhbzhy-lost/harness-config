/**
 * 本机出站 relay agent：控制 WSS 常连接 + 按需数据通道，把 ECS 中继流量直通 127.0.0.1 的 web-server。
 * 与 pi-relay-server v0.1.2（PROTOCOL_VERSION=2）线级兼容，可承载任意 tmux 会话。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { get as httpGet } from "node:http";
import { connect, type Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  BACKPRESSURE_CHECK_MS,
  BACKPRESSURE_HIGH_BYTES,
  CLOSE_AGENT_TOKEN_INVALID,
  CLOSE_PROTOCOL_VERSION_INVALID,
  HEARTBEAT_TIMEOUT_MS,
  MAX_WS_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  is192168,
  safeEqualHex,
  type DownMessage,
  type LanInfo,
  type SessionBrief,
  type UpMessage,
} from "../protocol.ts";
import { loadRemoteSettings, resolveWebPort } from "./config.ts";
import { addPending, clearStalePending, readDevices, readPending, writeLastSeen } from "./devices.ts";

const execFileAsync = promisify(execFile);
const HEARTBEAT_PING_CHECK_MS = 5_000;
const MAX_DRAIN_WAIT_MS = 5_000;

function log(event: string): void {
  console.error(`[remote-relay-agent] ${event}`);
}

async function defaultRouteInterface(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("route", ["-n", "get", "default"], { encoding: "utf8" });
      return /interface:\s*(\S+)/.exec(stdout)?.[1] ?? null;
    }
    const { stdout } = await execFileAsync("ip", ["route", "show", "default"], { encoding: "utf8" });
    return /\bdev\s+(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

const VIRTUAL_IFACE_RE = /^(utun|bridge|vmnet|vnic|parallels|vbox|awdl|llw|anpi|ap\d|gif|stf|lo)/i;

async function pickLanInfo(webPort: number, webToken: string): Promise<LanInfo | null> {
  const preferred = await defaultRouteInterface();
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal && is192168(net.address)) candidates.push({ name, address: net.address });
    }
  }
  const picked = candidates.find((c) => c.name === preferred) ?? candidates[0];
  return picked ? { host: picked.address, port: webPort, token: webToken } : null;
}

async function writeStatus(stateDir: string, state: string, lastHeartbeat: string | null): Promise<void> {
  await writeFile(path.join(stateDir, "agent-status.json"), `${JSON.stringify({ state, since: new Date().toISOString(), lastHeartbeat }, null, 2)}\n`, { mode: 0o600 });
}

function toSessionBrief(s: unknown): SessionBrief | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.windows !== "number" || typeof o.created !== "string" || typeof o.attached !== "boolean") return null;
  // 按 pi-relay-server 协议仅上报标准 SessionBrief 四字段，保证线级兼容
  return { name: o.name, windows: o.windows, created: o.created, attached: o.attached };
}

function fetchSessions(webPort: number): Promise<SessionBrief[]> {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port: webPort, path: "/api/sessions", timeout: 4_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sessions?: unknown };
          const list = Array.isArray(data.sessions) ? data.sessions.map(toSessionBrief).filter((x): x is SessionBrief => x !== null) : [];
          resolve(list);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve([]));
  });
}

function forceConnectionClose(chunk: Buffer): Buffer {
  const idx = chunk.indexOf("\r\n\r\n");
  if (idx < 0) return chunk;
  let header = chunk.subarray(0, idx).toString("latin1");
  if (/^upgrade:/im.test(header)) return chunk;
  header = header.replace(/^connection:[^\r\n]*\r\n/gim, "");
  header += "\r\nConnection: close";
  return Buffer.concat([Buffer.from(header, "latin1"), chunk.subarray(idx)]);
}

function pipePair(socket: Socket, ws: WebSocket, transformFirst: boolean): void {
  let checkTimer: NodeJS.Timeout | null = null;
  let socketClosed = false;

  socket.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) {
      socket.destroy();
      return;
    }
    ws.send(chunk);
    if (ws.bufferedAmount > BACKPRESSURE_HIGH_BYTES && !checkTimer) {
      socket.pause();
      checkTimer = setInterval(() => {
        if (ws.bufferedAmount <= BACKPRESSURE_HIGH_BYTES || ws.readyState !== ws.OPEN) {
          if (checkTimer) clearInterval(checkTimer);
          checkTimer = null;
          socket.resume();
        }
      }, BACKPRESSURE_CHECK_MS);
    }
  });
  ws.on("message", (data: Buffer) => {
    if (socketClosed || socket.destroyed) return;
    if (transformFirst) {
      data = forceConnectionClose(data);
      transformFirst = false;
    }
    if (!socket.write(data)) ws.pause();
  });
  socket.on("drain", () => ws.resume());

  const drainThenCloseWs = (deadline: number): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 0 && Date.now() < deadline) {
      setTimeout(() => drainThenCloseWs(deadline), BACKPRESSURE_CHECK_MS);
      return;
    }
    try {
      if (ws.bufferedAmount > 0) ws.terminate();
      else ws.close(1000);
    } catch {
      // 忽略
    }
  };
  socket.on("close", () => {
    socketClosed = true;
    if (checkTimer) clearInterval(checkTimer);
    drainThenCloseWs(Date.now() + MAX_DRAIN_WAIT_MS);
  });
  socket.on("error", () => {
    socketClosed = true;
    if (checkTimer) clearInterval(checkTimer);
    try { ws.terminate(); } catch { /* 忽略 */ }
  });
  ws.on("close", () => {
    if (checkTimer) clearInterval(checkTimer);
    socket.destroy();
  });
  ws.on("error", () => socket.destroy());
}

export async function runAgent(stateDir: string, configPath: string): Promise<void> {
  const settings = await loadRemoteSettings(configPath);
  if (settings.exposure !== "public" || !settings.relay) {
    throw new Error("agent 仅在 webExposure=public 且 webRelay 配置完整时运行");
  }
  const relay = settings.relay;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let caPem: string;
  try {
    caPem = await readFile(path.join(stateDir, "root-ca.crt"), "utf8");
  } catch {
    throw new Error(`缺少 ${path.join(stateDir, "root-ca.crt")}：请先运行 rtctl fetch-ca`);
  }
  let webToken: string;
  try {
    webToken = (await readFile(path.join(stateDir, "web-token"), "utf8")).trim();
  } catch {
    throw new Error(`缺少 ${path.join(stateDir, "web-token")}：请先运行 rtctl ensure`);
  }
  const webPort = resolveWebPort();
  const baseUrl = relay.url.replace(/\/+$/, "");
  const tlsOptions = { ca: caPem, rejectUnauthorized: true };

  let control: WebSocket | null = null;
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastPingAt = 0;
  let lastHeartbeat: string | null = null;
  let lastStatusWriteAt = 0;
  let deviceSnapshot = new Set<string>();
  const lastSeen = new Map<string, string>();
  let lastSeenDirty = false;

  const sendUp = (msg: UpMessage): void => {
    if (control?.readyState === WebSocket.OPEN) {
      try { control.send(JSON.stringify(msg)); } catch { /* 忽略 */ }
    }
  };

  const openDataChannel = (channel: string): void => {
    const ws = new WebSocket(`${baseUrl}/agent/data?agentToken=${encodeURIComponent(relay.agentToken)}&channel=${encodeURIComponent(channel)}`, {
      ...tlsOptions,
      maxPayload: MAX_WS_MESSAGE_BYTES,
    });
    let socket: Socket | null = null;
    const early: Buffer[] = [];
    const onEarly = (data: Buffer): void => { early.push(data); };
    ws.on("message", onEarly);
    ws.on("open", () => {
      socket = connect({ host: "127.0.0.1", port: webPort });
      socket.on("connect", () => {
        ws.removeListener("message", onEarly);
        const hadEarly = early.length > 0;
        if (hadEarly) early[0] = forceConnectionClose(early[0]!);
        for (const chunk of early.splice(0)) socket!.write(chunk);
        pipePair(socket!, ws, !hadEarly);
      });
      socket.on("error", () => {
        try { ws.terminate(); } catch { /* 忽略 */ }
      });
    });
    ws.on("close", () => socket?.destroy());
    ws.on("error", () => socket?.destroy());
  };

  const handleMessage = async (msg: DownMessage): Promise<void> => {
    if (msg.type === "auth") {
      const devices = await readDevices(stateDir);
      const device = devices.find((d) => d.id === msg.id);
      const allow = !!device && safeEqualHex(device.secretHash, msg.secretHash);
      if (allow && device) {
        lastSeen.set(device.id, new Date().toISOString());
        lastSeenDirty = true;
      }
      sendUp({ type: "auth-result", req: msg.req, allow, ...(allow && device ? { name: device.name } : {}) });
    } else if (msg.type === "pair-request") {
      await addPending(stateDir, { id: msg.id, code: msg.code, ua: msg.ua, ip: msg.ip, secretHash: msg.secretHash, ts: Date.now(), status: "pending" });
      log("pair-request-persisted");
    } else if (msg.type === "pair-check") {
      const devices = await readDevices(stateDir);
      const pending = await readPending(stateDir);
      const status = devices.some((d) => d.id === msg.id) ? "approved" : pending.find((p) => p.id === msg.id)?.status === "denied" ? "denied" : "pending";
      sendUp({ type: "pair-check-result", req: msg.req, status });
    } else if (msg.type === "open") {
      openDataChannel(msg.channel);
    } else if (msg.type === "list-sessions") {
      const sessions = await fetchSessions(webPort);
      sendUp({ type: "sessions-result", req: msg.req, sessions });
    }
  };

  const diffDevices = async (push: boolean): Promise<void> => {
    try {
      const devices = await readDevices(stateDir);
      const current = new Set(devices.map((d) => d.id));
      if (push) {
        for (const id of deviceSnapshot) {
          if (!current.has(id)) sendUp({ type: "device-revoked", id });
        }
      }
      deviceSnapshot = current;
    } catch {
      // 存储损坏时不推送
    }
  };

  const connectControl = (): void => {
    if (stopped) return;
    void writeStatus(stateDir, "connecting", lastHeartbeat);
    const ws = new WebSocket(`${baseUrl}/agent/control?agentToken=${encodeURIComponent(relay.agentToken)}`, {
      ...tlsOptions,
      maxPayload: MAX_WS_MESSAGE_BYTES,
    });
    control = ws;
    let opened = false;
    ws.on("open", () => {
      opened = true;
      backoff = RECONNECT_MIN_MS;
      lastPingAt = Date.now();
      void (async () => {
        const lan = await pickLanInfo(webPort, webToken);
        sendUp({ type: "hello", lan, hostname: hostname().slice(0, 64), version: PROTOCOL_VERSION });
        await clearStalePending(stateDir).catch(() => {});
        await diffDevices(false);
        await writeStatus(stateDir, "connected", lastHeartbeat);
        log("control-connected");
      })();
    });
    ws.on("ping", () => {
      lastPingAt = Date.now();
      lastHeartbeat = new Date().toISOString();
      if (Date.now() - lastStatusWriteAt >= 15_000) {
        lastStatusWriteAt = Date.now();
        void writeStatus(stateDir, "connected", lastHeartbeat);
      }
    });
    ws.on("message", (raw) => {
      let msg: DownMessage;
      try { msg = JSON.parse(String(raw)) as DownMessage; } catch { return; }
      void handleMessage(msg).catch(() => log("message-handle-failed"));
    });
    ws.on("close", (code) => {
      if (control === ws) control = null;
      if (code === CLOSE_AGENT_TOKEN_INVALID || code === CLOSE_PROTOCOL_VERSION_INVALID) {
        stopped = true;
        log(code === CLOSE_AGENT_TOKEN_INVALID
          ? "agentToken 与中继不一致，请核对 config.json 与 ECS init 输出"
          : "协议版本与中继不匹配：请检查中继服务端协议版本");
        void writeStatus(stateDir, "stopped", lastHeartbeat).then(() => process.exit(1));
        return;
      }
      log(opened ? "control-disconnected" : "control-connect-failed");
      void writeStatus(stateDir, "connecting", lastHeartbeat);
      scheduleReconnect();
    });
    ws.on("error", () => {});
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = backoff + randomBytes(2).readUInt16BE(0) % 500;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl();
    }, delay);
  };

  const heartbeatTimer = setInterval(() => {
    if (control?.readyState === WebSocket.OPEN && Date.now() - lastPingAt > HEARTBEAT_TIMEOUT_MS) {
      log("heartbeat-timeout");
      control.terminate();
    }
  }, HEARTBEAT_PING_CHECK_MS);

  const lastSeenTimer = setInterval(() => {
    if (!lastSeenDirty) return;
    lastSeenDirty = false;
    void writeLastSeen(stateDir, Object.fromEntries(lastSeen)).catch(() => {});
  }, 60_000);

  let watchDebounce: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  try {
    const watcher = fsWatch(stateDir);
    watcher.on("change", (_event, filename) => {
      if (String(filename) !== "devices.json") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => void diffDevices(true), 200);
    });
    watcher.on("error", () => {
      watcher.close();
      if (!pollTimer) pollTimer = setInterval(() => void diffDevices(true), 5_000);
    });
    process.on("exit", () => watcher.close());
  } catch {
    pollTimer = setInterval(() => void diffDevices(true), 5_000);
  }

  const shutdown = (): void => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearInterval(lastSeenTimer);
    if (pollTimer) clearInterval(pollTimer);
    control?.terminate();
    void writeStatus(stateDir, "stopped", lastHeartbeat).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await diffDevices(false);
  connectControl();
  await new Promise<void>(() => {});
}
