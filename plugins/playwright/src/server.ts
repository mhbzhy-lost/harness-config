/**
 * browser MCP server（stdio）。
 * 工具面：browser_start / browser_command / browser_status / browser_stop / browser_instances。
 * 实现复用 runtime/（per-instance daemon + unix socket + 安全命令集）；
 * 多实例并行、profile 凭据共享、手动认证模式均由 runtime 提供。
 */

import { getRuntimeStatus, listRuntimeInstances, resolveScope, sendRuntimeCommand, startRuntime, stopRuntime } from "./runtime/lifecycle.ts";
import { fileURLToPath } from "node:url";
import type { Command, RuntimeOptions } from "./runtime/contracts.ts";

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const instanceProperty = { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "实例名，只允许小写字母、数字和连字符" };

const TOOLS: ToolDefinition[] = [
  {
    name: "browser_start",
    description: "启动一个浏览器实例（headless 系统 Chrome），返回就绪状态。使用任何 browser_command 前必须先 start；每个任务使用自己拥有的实例名。",
    inputSchema: {
      type: "object",
      properties: {
        instance: { ...instanceProperty, description: "实例名，必填" },
        profile: { type: "string", description: "可选凭据 profile 名称：复用 ~/.playwright-sdk/profiles 下的持久登录态，实现跨实例凭据共享" },
        headed: { type: "boolean", description: "显示前台 Chrome；默认 headless，只有用户明确要求时使用" },
        auth: { type: "boolean", description: "手动认证模式：限制页面操作，供用户人工登录后沉淀登录态" },
      },
      required: ["instance"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_command",
    description: "对已启动实例执行受限 Playwright 安全命令：navigate/snapshot/click/fill/wait/screenshot/tabs/inspect 等（command 对象形如 {op:'navigate',url:...}）。禁止任意 evaluate、凭据读取和密码输入。",
    inputSchema: {
      type: "object",
      properties: {
        instance: { ...instanceProperty, description: "实例名，必填" },
        command: { type: "object", description: "安全命令对象，例如 {op:'navigate',url:'https://example.com'} 或 {op:'snapshot'}", additionalProperties: true },
      },
      required: ["instance", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_status",
    description: "查询实例运行状态（daemon、浏览器就绪、页面就绪、headless/authMode 等）。",
    inputSchema: {
      type: "object",
      properties: { instance: { ...instanceProperty, description: "实例名，必填" } },
      required: ["instance"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_stop",
    description: "停止实例并释放浏览器与 daemon 进程。任务结束或实例异常时调用。",
    inputSchema: {
      type: "object",
      properties: { instance: { ...instanceProperty, description: "实例名，必填" } },
      required: ["instance"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_instances",
    description: "列出当前所有实例及其状态，用于排查遗留实例或选择空闲实例。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function instanceRequired(value: unknown): string {
  if (typeof value !== "string" || !INSTANCE_PATTERN.test(value)) throw new Error("instance 必须是非空字符串，只允许小写字母、数字和连字符");
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
  const scope = await resolveScope();
  if (name === "browser_instances") return textResult(await listRuntimeInstances(scope));
  const instance = instanceRequired(args.instance);
  const ref = { scope, instance };
  if (name === "browser_start") {
    const idleSeconds = process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT === undefined ? 1800 : Number(process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT);
    const options: RuntimeOptions = {
      instance,
      profile: typeof args.profile === "string" && args.profile ? args.profile : undefined,
      headless: args.headed !== true,
      channel: "chrome",
      authMode: args.auth === true,
      startupTimeoutMs: 30_000,
      idleTimeoutMs: idleSeconds * 1000,
    };
    return textResult(await startRuntime(scope, options));
  }
  if (name === "browser_status") return textResult(await getRuntimeStatus(ref));
  if (name === "browser_stop") return textResult(await stopRuntime(ref));
  if (name === "browser_command") {
    if (!args.command || typeof args.command !== "object" || Array.isArray(args.command)) throw new Error("browser_command 需要 command 对象");
    return textResult(await sendRuntimeCommand(ref, args.command as unknown as Command));
  }
  throw new Error(`未知工具: ${name}`);
}

// 依赖按需安装（懒加载）：提示里用运行时解析的绝对路径，qwen / pi 两种链接方式都可用。
const SETUP_SCRIPT = fileURLToPath(new URL("../scripts/setup.sh", import.meta.url));

const INSTRUCTIONS = [
  "使用顺序：browser_start → browser_command（navigate/snapshot/click/fill/wait/screenshot/tabs/inspect）→ browser_stop。",
  "每个任务使用自己拥有的实例名；需要共享登录态时在 start 传 profile，跨实例复用持久凭据。",
  "普通任务保持 headless；只有用户明确要求前台或手动登录时才用 headed/auth。",
  "只接受安全命令对象：不支持任意 evaluate、run-file，也不输出 cookie、token、密码或授权材料。",
  "等待页面状态使用 op=wait，不使用同步阻塞等待。",
  "实例闲置 30 分钟自动回收（PI_PLAYWRIGHT_IDLE_TIMEOUT 可调）；遗留实例用 browser_instances 排查后 stop。",
  `browser_start 返回 sdk-missing 表示安装依赖缺失：执行 bash "${SETUP_SCRIPT}"（幂等，不下载浏览器）后重试，无需重启会话。`,
].join("\n");

async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
  const method = message.method ?? "";
  if (message.id === undefined) return null;
  if (method === "initialize") {
    const params = message.params as { protocolVersion?: string } | undefined;
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "playwright", version: "1.0.0" },
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
