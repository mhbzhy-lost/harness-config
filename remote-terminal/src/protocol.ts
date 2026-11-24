/**
 * 远程终端中继共享协议（与 pi-relay-server v0.1.2 / PROTOCOL_VERSION=2 线级兼容）。
 * 内联零外部依赖实现，避免在配置仓引入 git 依赖与 tsc 编译步骤；
 * 若上游中继升级主协议版本，同步更新 PROTOCOL_VERSION 与消息类型即可。
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type LanInfo = {
  host: string;
  port: number;
  token: string;
};

export type SessionBrief = {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
};

export type DownMessage =
  | { type: "open"; channel: string }
  | { type: "auth"; req: string; id: string; secretHash: string }
  | { type: "pair-request"; id: string; code: string; ua: string; ip: string; secretHash: string }
  | { type: "pair-check"; req: string; id: string }
  | { type: "list-sessions"; req: string };

export type UpMessage =
  | { type: "hello"; lan: LanInfo | null; hostname?: string; version?: number }
  | { type: "auth-result"; req: string; allow: boolean; name?: string }
  | { type: "pair-check-result"; req: string; status: "approved" | "denied" | "pending" }
  | { type: "sessions-result"; req: string; sessions: SessionBrief[] }
  | { type: "device-revoked"; id: string };

export type ControlMessage = DownMessage | UpMessage;

export const CLOSE_AGENT_TOKEN_INVALID = 4001;
export const CLOSE_CHANNEL_INVALID = 4002;
export const CLOSE_PROTOCOL_VERSION_INVALID = 4003;
export const PROTOCOL_VERSION = 2;

export const HEARTBEAT_PING_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

export const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
export const PAIR_TTL_MS = 10 * 60_000;
export const BACKPRESSURE_HIGH_BYTES = 1024 * 1024;
export const BACKPRESSURE_CHECK_MS = 20;

/** SHA256 hex 摘要（secret/token 比对统一先摘要，规避不等长 throw） */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 常量时间比对两个 hex 摘要 */
export function safeEqualHex(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * CA 指纹归一化：接受 `SHA256:AA:BB:…` / `AA:BB:…` / 连续 hex，
 * 统一为大写冒号分隔；非法输入返回 null（fail closed）。
 */
export function normalizeFingerprint(raw: string): string | null {
  let hex = raw.trim().toUpperCase();
  if (hex.startsWith("SHA256:")) hex = hex.slice(7);
  hex = hex.replaceAll(":", "").replace(/\s+/g, "");
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return (hex.match(/../g) ?? []).join(":");
}

/** 是否 192.168.0.0/16 IPv4（同局域网直连的收窄语义） */
export function is192168(addr: string): boolean {
  return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(addr);
}
