/**
 * 搜索 provider 层：DeepSeek 优先、Exa fallback。
 * 零 npm 依赖：直连走 Node 全局 fetch；Exa 配置 EXA_PROXY_PORT 时经本地 HTTP 代理
 * 建 CONNECT 隧道（node:https + 自定义 Agent），未配置时直连。
 * 密钥来源：进程环境变量优先，其次插件根 .env；key 只进认证请求头，严禁打印。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest, Agent as HttpsAgent, type RequestOptions } from "node:https";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export type SearchAction = "search" | "fetch";
export type SearchProvider = "deepseek" | "exa";
export type ProviderResult = { provider: SearchProvider; data: Record<string, unknown>; fallback: boolean };

const MAX_RESPONSE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_SOCKET_TIMEOUT_MS = 30_000;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export class ProviderFailure extends Error {
  readonly provider: SearchProvider;

  constructor(provider: SearchProvider, message: string) {
    super(message);
    this.provider = provider;
  }
}

function dotenvPath(): string {
  return join(pluginRoot, ".env");
}

async function readDotenvKey(name: "DEEPSEEK_API_KEY" | "EXA_API_KEY"): Promise<string> {
  try {
    const text = await readFile(dotenvPath(), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const entry = line.trim();
      const match = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(entry);
      if (!match) continue;
      const value = match[1]!.trim();
      if (!value) return "";
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim();
      return value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProviderFailure(name === "DEEPSEEK_API_KEY" ? "deepseek" : "exa", "无法读取本地搜索配置");
  }
  return "";
}

async function apiKey(provider: SearchProvider): Promise<string> {
  const name = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "EXA_API_KEY";
  const value = process.env[name]?.trim() || await readDotenvKey(name);
  if (!value) throw new ProviderFailure(provider, `缺少 ${name}`);
  if (value.length > 256 || [...value].some(char => char < " " || char === "\u007f")) throw new ProviderFailure(provider, `${name} 格式无效`);
  return value;
}

function safeRequestId(headers: { get(name: string): string | null }, provider: SearchProvider): string {
  const names = provider === "exa" ? ["x-exa-request-id", "x-request-id"] : ["x-request-id"];
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return ` (request_id=${value})`;
  }
  return "";
}

function statusCategory(status: number, action: SearchAction, provider: SearchProvider): string {
  if (status === 401 || (provider === "exa" && status === 403)) return "authentication_error";
  if (status === 402) return "payment_required";
  if (status === 403) return action === "fetch" ? "fetch_blocked_by_policy" : "access_forbidden";
  if (status === 404) return action === "fetch" ? "content_unavailable" : "not_found";
  if (status === 408) return "request_timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server_error" : status >= 400 ? "client_error" : "http_error";
}

/** 代理端口：仅当 EXA_PROXY_PORT 显式设置且合法时启用隧道；未设置则直连。 */
function exaProxyPort(): number | undefined {
  const raw = process.env.EXA_PROXY_PORT;
  if (raw === undefined || raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) throw new ProviderFailure("exa", "EXA_PROXY_PORT 必须是 1–65535 的十进制端口");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ProviderFailure("exa", "EXA_PROXY_PORT 必须是 1–65535 的十进制端口");
  return port;
}

/** 经本地 HTTP 代理的 CONNECT 隧道完成 TLS 握手，把得到的 TLSSocket 交给 node:https 复用完整 HTTP/1.1 实现。 */
class ProxyTunnelAgent extends HttpsAgent {
  private readonly proxyPort: number;
  private readonly ca?: string | Buffer;
  private readonly timeoutMs: number;
  private readonly onDestroy?: () => void;

  constructor(proxyPort: number, options?: { ca?: string | Buffer; timeoutMs?: number; onDestroy?: () => void }) {
    super({ keepAlive: true, maxSockets: 8, timeout: IDLE_SOCKET_TIMEOUT_MS });
    this.proxyPort = proxyPort;
    this.ca = options?.ca;
    this.timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onDestroy = options?.onDestroy;
  }

  override destroy(): void {
    this.onDestroy?.();
    super.destroy();
  }

  override createConnection(options: RequestOptions, callback: (error: Error | null, socket?: unknown) => void): void {
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port ?? 443);
    if (!host || !Number.isInteger(port)) {
      callback(new ProviderFailure("exa", "代理隧道目标无效"));
      return;
    }

    let settled = false;
    let connectReq: ClientRequest | undefined;
    let rawSocket: Socket | undefined;
    let tlsSocket: TLSSocket | undefined;
    let onTlsError: ((error: Error) => void) | undefined;
    let onTlsClose: (() => void) | undefined;
    let onTlsTimeout: (() => void) | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      tlsSocket?.destroy();
      rawSocket?.destroy();
      connectReq?.destroy();
      callback(error);
    };

    const succeed = (tls: TLSSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (onTlsError) tls.removeListener("error", onTlsError);
      if (onTlsClose) tls.removeListener("close", onTlsClose);
      if (onTlsTimeout) tls.removeListener("timeout", onTlsTimeout);
      tls.setTimeout(0);
      callback(null, tls);
    };

    const deadlineTimer = setTimeout(() => {
      fail(new ProviderFailure("exa", "代理隧道超时"));
    }, this.timeoutMs);

    connectReq = httpRequest({
      host: "127.0.0.1",
      port: this.proxyPort,
      method: "CONNECT",
      path: `${host}:${port}`,
      timeout: this.timeoutMs,
    });
    connectReq.once("connect", (response, socket) => {
      rawSocket = socket;
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 200) {
        fail(new ProviderFailure("exa", `代理 CONNECT 失败：HTTP ${response.statusCode ?? 0}`));
        return;
      }
      try {
        tlsSocket = tlsConnect({
          socket,
          ...(isIP(host) === 0 ? { servername: host } : {}),
          ...(this.ca !== undefined ? { ca: this.ca } : {}),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        fail(new ProviderFailure("exa", `代理隧道 TLS 握手失败：${name}`));
        return;
      }
      onTlsError = (error: Error) => fail(new ProviderFailure("exa", `代理隧道 TLS 握手失败：${error.name}`));
      onTlsClose = () => fail(new ProviderFailure("exa", "代理隧道 TLS 连接提前关闭"));
      onTlsTimeout = () => fail(new ProviderFailure("exa", "代理隧道 TLS 握手超时"));
      tlsSocket.once("secureConnect", () => succeed(tlsSocket!));
      tlsSocket.once("error", onTlsError);
      tlsSocket.once("close", onTlsClose);
      tlsSocket.setTimeout(this.timeoutMs, onTlsTimeout);
    });
    connectReq.once("timeout", () => fail(new ProviderFailure("exa", "代理 CONNECT 超时")));
    connectReq.once("error", (error: Error) => fail(new ProviderFailure("exa", `代理 CONNECT 失败：${error.name}`)));
    connectReq.end();
  }
}

const proxyAgentPool = new Map<string, ProxyTunnelAgent>();

/** 按端口复用代理隧道 Agent；传入测试自定义 ca/timeoutMs 时不污染默认缓存池。 */
export function getProxyTunnelAgent(proxyPort: number, options?: { ca?: string | Buffer; timeoutMs?: number }): ProxyTunnelAgent {
  if (options?.ca !== undefined || options?.timeoutMs !== undefined) {
    return new ProxyTunnelAgent(proxyPort, options);
  }
  const key = String(proxyPort);
  let agent = proxyAgentPool.get(key);
  if (!agent) {
    agent = new ProxyTunnelAgent(proxyPort, {
      onDestroy: () => {
        if (proxyAgentPool.get(key) === agent) proxyAgentPool.delete(key);
      },
    });
    proxyAgentPool.set(key, agent);
  }
  return agent;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

export interface PostJsonOptions {
  timeoutMs?: number;
  ca?: string | Buffer;
  proxyPort?: number;
}

function toHeaderReader(headers: IncomingHttpHeaders): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      const value = headers[name.toLowerCase()];
      if (Array.isArray(value)) return value.join(", ");
      return typeof value === "string" ? value : null;
    },
  };
}

async function readFetchBody(response: Response, provider: SearchProvider): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ProviderFailure(provider, `${provider} 响应超过 ${MAX_RESPONSE_BYTES} 字节限制`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 统一 POST JSON：直连用全局 fetch；配代理端口时对 https 目标走隧道。 */
export async function postJson(
  provider: SearchProvider,
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  options?: PostJsonOptions,
): Promise<HttpResponse> {
  const proxyPort = options?.proxyPort ?? (provider === "exa" ? exaProxyPort() : undefined);
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ProviderFailure(provider, "仅支持 https 端点");
  const bodyText = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ephemeralAgent: ProxyTunnelAgent | undefined;
  try {
    if (proxyPort === undefined) {
      const response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers,
        body: bodyText,
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, headers: response.headers, body: new Uint8Array(0) };
      }
      const body = await readFetchBody(response, provider);
      return { status: response.status, headers: response.headers, body };
    }
    const hasCustomAgentOptions = options?.ca !== undefined
      || (options?.timeoutMs !== undefined && options.timeoutMs !== REQUEST_TIMEOUT_MS);
    const agent = hasCustomAgentOptions
      ? getProxyTunnelAgent(proxyPort, { ca: options?.ca, timeoutMs })
      : getProxyTunnelAgent(proxyPort);
    if (hasCustomAgentOptions) ephemeralAgent = agent;
    return await new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const finishOk = (res: HttpResponse) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        resolve(res);
      };
      const onAbort = () => {
        request?.destroy();
        finishError(new ProviderFailure(provider, `${provider} 请求超时`));
      };
      if (controller.signal.aborted) {
        finishError(new ProviderFailure(provider, `${provider} 请求超时`));
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });

      request = httpsRequest(parsed, {
        method: "POST",
        agent,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(bodyText)) },
      }, (response) => {
        const status = response.statusCode ?? 0;
        const headerReader = toHeaderReader(response.headers);
        if (status < 200 || status >= 300) {
          response.destroy();
          finishOk({ status, headers: headerReader, body: new Uint8Array(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let ended = false;
        response.once("error", () => finishError(new ProviderFailure(provider, `${provider} 响应流中断`)));
        response.once("aborted", () => {
          if (!ended) finishError(new ProviderFailure(provider, `${provider} 响应流中断`));
        });
        response.once("close", () => {
          if (!ended && !response.complete) finishError(new ProviderFailure(provider, `${provider} 响应流中断`));
        });
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy();
            finishError(new ProviderFailure(provider, `${provider} 响应超过 ${MAX_RESPONSE_BYTES} 字节限制`));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          ended = true;
          finishOk({ status, headers: headerReader, body: new Uint8Array(Buffer.concat(chunks)) });
        });
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finishError(new ProviderFailure(provider, `${provider} 请求超时`));
      });
      request.once("error", (error: Error) => {
        if (error instanceof ProviderFailure) finishError(error);
        else if (controller.signal.aborted || error.name === "AbortError") finishError(new ProviderFailure(provider, `${provider} 请求超时`));
        else finishError(new ProviderFailure(provider, `${provider} 请求失败`));
      });
      request.end(bodyText);
    });
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new ProviderFailure(provider, `${provider} 请求超时`);
    throw new ProviderFailure(provider, `${provider} 请求失败`);
  } finally {
    clearTimeout(timer);
    ephemeralAgent?.destroy();
  }
}

function requestSpec(provider: SearchProvider, action: SearchAction, input: Record<string, unknown>): { url: string; payload: Record<string, unknown> } {
  if (provider === "deepseek") return { url: `https://api.deepseek.com/v1/tools/${action}`, payload: input };
  if (action === "search") return {
    url: "https://api.exa.ai/search",
    payload: { query: input.query, numResults: input.count, type: "auto", contents: { highlights: true } },
  };
  return { url: "https://api.exa.ai/contents", payload: { urls: [input.url], text: { maxCharacters: 3000 } } };
}

async function requestProvider(provider: SearchProvider, action: SearchAction, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { url, payload } = requestSpec(provider, action, input);
  const authHeaders = provider === "deepseek"
    ? { Authorization: `Bearer ${await apiKey(provider)}` }
    : { "x-api-key": await apiKey(provider), "User-Agent": "agents-plugin-deepseek-search/1.0" };
  const response = await postJson(provider, url, payload, { Accept: "application/json", "Content-Type": "application/json", ...authHeaders });
  if (response.status >= 300 && response.status < 400) throw new ProviderFailure(provider, `${provider} 请求重定向被阻断`);
  if (response.status < 200 || response.status >= 300) throw new ProviderFailure(provider, `${provider} ${action} 失败：HTTP ${response.status} ${statusCategory(response.status, action, provider)}${safeRequestId(response.headers, provider)}`);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(response.body)); } catch { throw new ProviderFailure(provider, `${provider} 响应不是合法 JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderFailure(provider, `${provider} 响应不是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

export async function requestSearch(action: SearchAction, input: Record<string, unknown>): Promise<ProviderResult> {
  try {
    return { provider: "deepseek", data: await requestProvider("deepseek", action, input), fallback: false };
  } catch (deepseekError) {
    try {
      return { provider: "exa", data: await requestProvider("exa", action, input), fallback: true };
    } catch (exaError) {
      const deepseekMessage = deepseekError instanceof ProviderFailure ? deepseekError.message : "DeepSeek 请求失败";
      const exaMessage = exaError instanceof ProviderFailure ? exaError.message : "Exa 请求失败";
      throw new Error(`搜索服务均不可用：DeepSeek（${deepseekMessage}）；Exa（${exaMessage}）`);
    }
  }
}
