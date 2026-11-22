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
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";

export type SearchAction = "search" | "fetch";
export type SearchProvider = "deepseek" | "exa";
export type ProviderResult = { provider: SearchProvider; data: Record<string, unknown>; fallback: boolean };

const MAX_RESPONSE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 30_000;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

class ProviderFailure extends Error {
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

  constructor(proxyPort: number) {
    super();
    this.proxyPort = proxyPort;
  }

  override createConnection(options: RequestOptions, callback: (error: Error | null, socket?: unknown) => void): void {
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port ?? 443);
    if (!host || !Number.isInteger(port)) {
      callback(new ProviderFailure("exa", "代理隧道目标无效"));
      return;
    }
    const connect = httpRequest({
      host: "127.0.0.1",
      port: this.proxyPort,
      method: "CONNECT",
      path: `${host}:${port}`,
      timeout: REQUEST_TIMEOUT_MS,
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new ProviderFailure("exa", `代理 CONNECT 失败：HTTP ${response.statusCode ?? 0}`));
        return;
      }
      const tls = tlsConnect({ socket, servername: host });
      tls.once("secureConnect", () => callback(null, tls));
      tls.once("error", (error: Error) => callback(new ProviderFailure("exa", `代理隧道 TLS 握手失败：${error.name}`)));
    });
    connect.once("timeout", () => {
      connect.destroy();
      callback(new ProviderFailure("exa", "代理 CONNECT 超时"));
    });
    connect.once("error", (error: Error) => callback(new ProviderFailure("exa", `代理 CONNECT 失败：${error.name}`)));
    connect.end();
  }
}

interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  bytes(): Promise<Uint8Array>;
}

/** 统一 POST JSON：直连用全局 fetch；配代理端口时对 https 目标走隧道。 */
async function postJson(provider: SearchProvider, url: string, payload: Record<string, unknown>, headers: Record<string, string>): Promise<HttpResponse> {
  const proxyPort = provider === "exa" ? exaProxyPort() : undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ProviderFailure(provider, "仅支持 https 端点");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (proxyPort === undefined) {
      const response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers,
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        headers: response.headers,
        async bytes() {
          const buffer = new Uint8Array(await response.arrayBuffer());
          if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new ProviderFailure(provider, `${provider} 响应超过 ${MAX_RESPONSE_BYTES} 字节限制`);
          return buffer;
        },
      };
    }
    return await new Promise<HttpResponse>((resolve, reject) => {
      const request = httpsRequest(parsed, {
        method: "POST",
        agent: new ProxyTunnelAgent(proxyPort),
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(JSON.stringify(payload))) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.once("error", () => reject(new ProviderFailure(provider, `${provider} 响应流中断`)));
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy();
            reject(new ProviderFailure(provider, `${provider} 响应超过 ${MAX_RESPONSE_BYTES} 字节限制`));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          async bytes() { return new Uint8Array(Buffer.concat(chunks)); },
        }));
      });
      request.once("timeout", () => {
        request.destroy();
        reject(new ProviderFailure(provider, `${provider} 请求超时`));
      });
      request.setTimeout(REQUEST_TIMEOUT_MS);
      request.once("error", (error: Error) => {
        if (error.name === "AbortError") reject(new ProviderFailure(provider, `${provider} 请求超时`));
        else reject(new ProviderFailure(provider, `${provider} 请求失败`));
      });
      request.end(JSON.stringify(payload));
    });
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ProviderFailure(provider, `${provider} 请求超时`);
    throw new ProviderFailure(provider, `${provider} 请求失败`);
  } finally {
    clearTimeout(timer);
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
  const bytes = await response.bytes();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ProviderFailure(provider, `${provider} 响应不是合法 JSON`); }
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
