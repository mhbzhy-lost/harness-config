/**
 * pi-worker MCP server（stdio）。
 * 将本机自定义 Pi 封装为支持异步长跑、独立 Session 隔离与挂起提问续跑（Suspend-Resume）的独立长任务工作器。
 */

import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  PiWorkerRunner,
  isNestedWorkerEnv,
} from "./runner.ts";
import { TaskStore, resolveStateDir } from "./store.ts";
import type { TaskStatus } from "./store.ts";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const VALID_TASK_STATUSES = new Set<string>([
  "running",
  "needs_input",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);

const TOOLS: ToolDefinition[] = [
  {
    name: "pi_worker_start",
    description:
      "在独立隔离的 Pi Session 中启动一个长程编码/执行任务。仅用于规格已清晰、有可执行验收命令、预计多轮工具调用的长任务；同一 cwd 同时只允许 1 个运行中任务，严禁在 Pi 会话内部自我嵌套调用。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "目标工作区绝对路径（必填）" },
        prompt: {
          type: "string",
          description: "完整自包含任务说明（目标、文件锚点、约束红线与验收命令，必填）",
        },
        model: { type: "string", description: "可选：传给 Pi 的 --model 参数" },
        provider: { type: "string", description: "可选：传给 Pi 的 --provider 参数（须配合 model）" },
        thinking: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          description: "可选：传给 Pi 的 --thinking 思考档位",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `单轮超时秒数（默认 ${DEFAULT_TIMEOUT_SECONDS}，范围 ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS}）`,
        },
        excludeTools: {
          type: "array",
          items: { type: "string" },
          description: "可选：额外禁用的工具名列表（始终自动合并默认禁用列表）",
        },
        waitSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: `可选：短等状态变化秒数（0–${MAX_WAIT_SECONDS}，默认 0 立即返回）`,
        },
      },
      required: ["cwd", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_worker_reply",
    description:
      "向处于 needs_input（或 done/blocked 需继续迭代）的任务发送回复，并沿原隔离 Session 续跑。收到 needs_input 时优先由主代理依据已有上下文秒答续跑以保持前缀缓存命中；无法拍板时再转问人类。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "由 pi_worker_start 返回的任务 UUID" },
        reply: { type: "string", description: "给 Pi 的明确回复或补充指示" },
        timeoutSeconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `本轮超时秒数（默认 ${DEFAULT_TIMEOUT_SECONDS}）`,
        },
        waitSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: `可选：短等状态变化秒数（0–${MAX_WAIT_SECONDS}，默认 0）`,
        },
      },
      required: ["taskId", "reply"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_worker_status",
    description:
      "查询任务实时进度（turnCount/lastTool/recentEvents）、挂起提问（question/options）或最终摘要与 git 变更；可传 waitSeconds（0–30）短等状态变化。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 UUID" },
        waitSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: `可选：短等状态变化秒数（0–${MAX_WAIT_SECONDS}，默认 0）`,
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_worker_cancel",
    description:
      "取消正在运行或等待输入的任务（运行中按进程组优雅终止）；若任务已处于 done/failed/cancelled 终态则保持原状态不变并返回 wasRunning: false。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 UUID" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_worker_list",
    description: "列出当前状态目录中的任务精简摘要，可按 status 或 cwd 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "needs_input", "done", "blocked", "failed", "cancelled"],
          description: "可选：按状态过滤",
        },
        cwd: { type: "string", description: "可选：按工作区绝对路径过滤" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "返回条数上限（默认 20，最大 100）" },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_NAME_SET = new Set(TOOLS.map((t) => t.name));

const INSTRUCTIONS = [
  "仅将规格明确、具备硬验收命令、需要多轮工具执行的独立长任务委派给 pi-worker。",
  "小改动直接主会话完成；宽探索/测试日志/Diff 文档交给更轻量的只读或验证子代理；严禁在 Pi 会话内部自嵌套调用。",
  "当任务返回 status=needs_input 时，优先依据主会话已有上下文通过 pi_worker_reply 秒答续跑（命中前缀缓存），拍不了板再转问用户。",
  "委派运行期间主会话不得同时修改同一工作区文件；任务 done 后由主会话核验 gitChanges 与 diff。",
].join("\n");

const nested = isNestedWorkerEnv(process.env);
const store = new TaskStore(resolveStateDir(process.env));
const runner = new PiWorkerRunner({ store, env: process.env });

function textResult(
  data: unknown,
  isError = false,
): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return value;
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (nested) {
    return textResult(
      { error: "检测到处于 pi-worker / Pi 子代理嵌套环境中，禁止调用任何 pi-worker 工具" },
      true,
    );
  }
  if (!TOOL_NAME_SET.has(name)) {
    return textResult({ error: `未知工具: ${name}` }, true);
  }

  try {
    if (name === "pi_worker_start") {
      const cwd = optionalString(args.cwd, "cwd");
      const prompt = optionalString(args.prompt, "prompt");
      if (!cwd) throw new Error("缺少必填参数 cwd");
      if (!prompt) throw new Error("缺少必填参数 prompt");
      const record = await runner.start({
        cwd,
        prompt,
        model: optionalString(args.model, "model"),
        provider: optionalString(args.provider, "provider"),
        thinking: optionalString(args.thinking, "thinking"),
        timeoutSeconds: optionalNumber(args.timeoutSeconds, "timeoutSeconds"),
        excludeTools: optionalStringArray(args.excludeTools, "excludeTools"),
        waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
      });
      return textResult(record);
    }

    if (name === "pi_worker_reply") {
      const taskId = optionalString(args.taskId, "taskId");
      const reply = optionalString(args.reply, "reply");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      if (!reply) throw new Error("缺少必填参数 reply");
      const record = await runner.reply({
        taskId,
        reply,
        timeoutSeconds: optionalNumber(args.timeoutSeconds, "timeoutSeconds"),
        waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
      });
      return textResult(record);
    }

    if (name === "pi_worker_status") {
      const taskId = optionalString(args.taskId, "taskId");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      const record = await runner.status({
        taskId,
        waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
      });
      return textResult(record);
    }

    if (name === "pi_worker_cancel") {
      const taskId = optionalString(args.taskId, "taskId");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      const result = await runner.cancel({ taskId });
      return textResult(result);
    }

    if (name === "pi_worker_list") {
      const rawStatus = optionalString(args.status, "status");
      if (rawStatus !== undefined && !VALID_TASK_STATUSES.has(rawStatus)) {
        throw new Error(`非法 status: ${rawStatus}`);
      }
      const tasks = runner.list({
        ...(rawStatus ? { status: rawStatus as TaskStatus } : {}),
        cwd: optionalString(args.cwd, "cwd"),
        limit: optionalNumber(args.limit, "limit"),
      });
      return textResult({ tasks });
    }

    return textResult({ error: `未知工具: ${name}` }, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message }, true);
  }
}

async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
  const method = message.method ?? "";
  if (message.id === undefined) return null;
  if (method === "initialize") {
    const params = message.params as { protocolVersion?: string } | undefined;
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-worker", version: "0.1.0" },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: nested ? [] : TOOLS };
  if (method === "tools/call") {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!params?.name) return textResult({ error: "缺少工具名" }, true);
    const callArgs = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    return callTool(params.name, callArgs);
  }
  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };
  throw Object.assign(new Error(`未知方法: ${method}`), { code: -32601 });
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let exiting: Promise<void> | null = null;
function gracefulExit(code = 0): void {
  if (exiting) return;
  exiting = runner
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      process.exit(code);
    });
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
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error.code ?? -32603, message: error.message },
        });
      });
  }
});

process.stdin.on("end", () => gracefulExit(0));
process.on("SIGINT", () => gracefulExit(0));
process.on("SIGTERM", () => gracefulExit(0));
