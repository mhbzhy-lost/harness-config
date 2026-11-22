/**
 * search MCP server（stdio）。
 * 工具面：web_search（关键词搜索）/ web_fetch（抓取单页正文）。
 * 默认 DeepSeek 优先，失败自动 Exa fallback；结果为供应商原始 JSON，不改写、不制造引用。
 */

import { requestSearch } from "./providers.ts";

const MAX_QUERY_CHARS = 128;
const MAX_FETCH_URL_CHARS = 8192;
const DEFAULT_COUNT = 10;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "联网搜索最新网页信息，返回候选结果列表（title/url/snippet/summary 等）。查新闻、事实、技术文档或核实资料时使用；引用一律使用 results[].url，不要引用模型记忆。默认 10 条，支持 site:/lang:/after: 等检索算子（DeepSeek 通道）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，必填，最多 128 个 Unicode 字符" },
        count: { type: "integer", minimum: 1, maximum: 50, description: "结果数量，默认 10" },
        needContent: { type: "boolean", description: "是否同时返回结果正文（DeepSeek 通道支持）" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description: "抓取单个网页正文（Markdown 文本，Exa fallback 时上限约 3000 字符、可能截断）。先 web_search 拿到候选 URL，正文不足时再 fetch；与已有知识冲突时以原文为准。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标网页 URL，仅 http/https，必填" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("query 不能为空");
  if ([...value].length > MAX_QUERY_CHARS) throw new Error(`query 最多 ${MAX_QUERY_CHARS} 个 Unicode 字符`);
  return value;
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_FETCH_URL_CHARS) throw new Error("url 格式无效或过长");
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /\s/.test(value)) throw new Error();
  } catch { throw new Error("url 必须是没有 userinfo 的 http/https URL"); }
  return value;
}

function textResult(data: unknown, isError = false): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "web_search") {
    const query = validateQuery(args.query);
    const count = args.count === undefined ? DEFAULT_COUNT : args.count;
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("count 必须是 1–50 的整数");
    const result = await requestSearch("search", { query, count, ...(args.needContent === true ? { need_content: true } : {}) });
    return textResult({ ...result.data, _provider: result.provider, _fallback: result.fallback });
  }
  if (name === "web_fetch") {
    const url = validateUrl(args.url);
    const result = await requestSearch("fetch", { url });
    return textResult({ ...result.data, _provider: result.provider, _fallback: result.fallback });
  }
  throw new Error(`未知工具: ${name}`);
}

const INSTRUCTIONS = [
  "需要联网获取最新信息、新闻、事实或技术文档时先用 web_search，再用 web_fetch 抓重点 URL 正文。",
  "不要用模型记忆替代联网搜索，也不要用 curl/wget 抓网页查资料。",
  "引用一律使用返回结果中的 URL；results 为空数组表示无匹配，不要编造结果。",
  "默认 DeepSeek 优先，失败自动 Exa fallback（_provider/_fallback 字段标记实际通道）；两者都失败时报脱敏错误类别，不打印密钥。",
].join("\n");

async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
  const method = message.method ?? "";
  if (message.id === undefined) return null;
  if (method === "initialize") {
    const params = message.params as { protocolVersion?: string } | undefined;
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "deepseek-search", version: "1.0.0" },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!params?.name) return { content: [{ type: "text", text: "缺少工具名" }], isError: true };
    return callTool(params.name, params.arguments ?? {});
  }
  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };
  throw Object.assign(new Error(`未知方法: ${method}`), { code: -32601 });
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message: { id?: unknown; method?: string; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handleRequest(message)
      .then((result) => {
        if (result !== null) send({ jsonrpc: "2.0", id: message.id, result });
      })
      .catch((error: Error & { code?: number }) => {
        if (message.id === undefined) return;
        send({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } });
      });
  }
});
process.stdin.on("end", () => process.exit(0));
