/**
 * 本机远程终端配置（默认 ~/.harness-remote/config.json）的深度校验与读取。
 * 支持 webExposure（off / lan / public）与 webRelay（url / agentToken / caFingerprint）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeFingerprint } from "../protocol.ts";

export type WebExposure = "off" | "lan" | "public";

export type WebRelayConfig = {
  /** 中继控制连接地址，必须 wss:// */
  url: string;
  /** ECS init 生成的 agent 鉴权 token */
  agentToken: string;
  /** CA SHA256 指纹（归一化后大写冒号分隔） */
  caFingerprint: string;
};

export type RemoteSettings = { exposure: WebExposure; relay: WebRelayConfig | null };

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HARNESS_REMOTE_DIR?.trim();
  if (configured) return path.resolve(configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured);
  return path.join(homedir(), ".harness-remote");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HARNESS_REMOTE_CONFIG?.trim();
  if (configured) return path.resolve(configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured);
  return path.join(defaultStateDir(env), "config.json");
}

export function resolveWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HARNESS_REMOTE_PORT ?? env.PI_WEB_PORT ?? "7681";
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 7681;
}

function fail(message: string): never {
  throw new Error(`remote-terminal 配置无效：${message}`);
}

/** 校验 webExposure / webRelay 字段（fail-closed） */
export function validateRemoteSettings(settings: { webExposure?: unknown; webRelay?: unknown }): RemoteSettings {
  const rawExposure = settings.webExposure;
  let exposure: WebExposure = "off";
  if (rawExposure !== undefined) {
    if (rawExposure !== "off" && rawExposure !== "lan" && rawExposure !== "public") {
      fail(`webExposure 必须是 "off"、"lan" 或 "public"，当前：${JSON.stringify(rawExposure)}`);
    }
    exposure = rawExposure;
  }

  const rawRelay = settings.webRelay;
  if (rawRelay === undefined) return { exposure, relay: null };
  if (!rawRelay || typeof rawRelay !== "object" || Array.isArray(rawRelay)) fail("webRelay 必须是 JSON 对象");
  const obj = rawRelay as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "url" && key !== "agentToken" && key !== "caFingerprint") fail(`webRelay 包含不支持的字段 ${key}`);
  }

  const url = obj.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) fail("webRelay.url 必须是 wss:// 地址");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`webRelay.url 无法解析：${url}`);
  }
  const host = parsed.hostname;
  if (!host || host.startsWith("-") || /[\s\0\r\n]/.test(host) || !/^[A-Za-z0-9.[\]:_-]+$/.test(host)) {
    fail(`webRelay.url 主机名不合法：${host}`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") fail("webRelay.url 不应包含路径");
  if (parsed.search || parsed.hash) fail("webRelay.url 不应包含 query 或 fragment");
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`webRelay.url 端口不合法：${parsed.port}`);
  }

  const agentToken = obj.agentToken;
  if (typeof agentToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(agentToken)) {
    fail("webRelay.agentToken 必须是 16-128 位 [A-Za-z0-9_-] 字符串（ECS init 输出）");
  }

  const rawFp = obj.caFingerprint;
  if (typeof rawFp !== "string") fail("webRelay.caFingerprint 必须是字符串（SHA256:AA:BB:… 格式）");
  const caFingerprint = normalizeFingerprint(rawFp);
  if (!caFingerprint) fail("webRelay.caFingerprint 不是合法的 SHA256 指纹（64 位 hex，可冒号分隔）");

  return { exposure, relay: { url, agentToken, caFingerprint } };
}

/** 读取配置文件；不存在时视为 off（默认不启用外部访问） */
export async function loadRemoteSettings(configPath: string): Promise<RemoteSettings> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exposure: "off", relay: null };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("必须是 JSON 对象");
  return validateRemoteSettings(parsed as { webExposure?: unknown; webRelay?: unknown });
}
