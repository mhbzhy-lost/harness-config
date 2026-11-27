/**
 * pi-worker MCP server（stdio）。
 * 将本机自定义 Pi 封装为支持异步执行、抽象档位映射、只读并发、独立 Session 隔离、
 * 挂起提问续跑（Suspend-Resume）、跨 Harness 标准进度流与 Antigravity MCP App 侧面板的跨 Harness 通用子代理。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_WAIT_SECONDS,
  PiWorkerRunner,
  isNestedWorkerEnv,
} from "./runner.ts";
import {
  TaskStore,
  groupTasksByParentSession,
  resolveStateDir,
  validateWorkerTier,
} from "./store.ts";
import type { TaskRecord, TaskSessionGroup, TaskStatus, WorkerTier } from "./store.ts";
import { formatTerminalLine, readFormattedEventsDelta } from "./stream.ts";
import type { FormattedStreamEvent } from "./stream.ts";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const APP_RESOURCE_URI = "ui://pi-worker/monitor.html";
const APP_MIME_TYPE = "text/html;profile=mcp-app";
const DEFAULT_APP_HTML_PATH = join(import.meta.dirname, "..", "ui", "monitor.html");

const VALID_TASK_STATUSES = new Set<string>([
  "running",
  "needs_input",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);

const agyMode = process.env.PI_WORKER_AGY === "1";

const BASE_TOOLS: ToolDefinition[] = [
  {
    name: "pi_worker_start",
    description:
      "在独立隔离的 Pi Session 中启动子代理/工作器任务：支持代码库探索与调研、测试/构建/lint 验证与日志压缩（tier=fast, readOnly=true，支持同 cwd 多路并发）、独立代码审查（tier=heavy, readOnly=true）及多步编码任务（tier=default）。返回机器提取的 executedCommands、eventsPath（未截断工具输入输出）与 gitChanges 供主代理核验；严禁在 Pi 会话内部自我嵌套调用。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "目标工作区绝对路径（必填）" },
        prompt: {
          type: "string",
          description: "完整自包含任务说明（目标、文件锚点、约束红线与验收/返回证据要求，必填）",
        },
        parentSessionId: {
          type: "string",
          description: "可选：父会话标识（如宿主会话/对话 ID），用于跨 Harness 按父会话归组与隔离查询（缺省时回退 PI_WORKER_PARENT_SESSION_ID 环境变量）",
        },
        title: {
          type: "string",
          description: "可选：任务简短可读标题（建议传入；未传时自动从 prompt 首条有意义文本行提取，清洗并截断到 48 字）",
        },
        parentSessionTitle: {
          type: "string",
          description: "可选：父会话可读标题（用于监控面板会话归属展示；清洗并截断到 48 字）",
        },
        tier: {
          type: "string",
          enum: ["fast", "default", "heavy"],
          description: "可选：抽象模型档位（fast/default/heavy），按本机 <stateDir>/config.json 的 tiers 映射解析，未配置档位自动回退 default",
        },
        readOnly: {
          type: "boolean",
          description: "可选：只读模式（默认 false）。设为 true 时自动禁用 write/edit 工具，且不占 cwd 写锁，允许同工作区多路只读任务并发",
        },
        model: { type: "string", description: "可选：显式指定传给 Pi 的 --model 参数（优先级高于 tier 与默认配置）" },
        provider: { type: "string", description: "可选：传给 Pi 的 --provider 参数（须配合 model；缺省且未显式指定 model 时按 tier/默认配置解析）" },
        thinking: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          description: "可选：传给 Pi 的 --thinking 思考档位（缺省时按 tier/默认配置解析）",
        },
        excludeTools: {
          type: "array",
          items: { type: "string" },
          description: "可选：额外禁用的工具名列表（始终自动合并默认禁用列表；readOnly=true 时额外合并 write/edit）",
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
      "向非运行中的任务（needs_input / done / blocked / failed / cancelled）发送回复，沿原隔离 Session 续跑，并支持按需覆盖 tier/model/provider/thinking。收到 needs_input 时优先由主代理依据已有上下文秒答续跑以保持前缀缓存命中；无法拍板时再转问人类。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "由 pi_worker_start 返回的任务 UUID" },
        reply: { type: "string", description: "给 Pi 的明确回复或补充指示" },
        tier: {
          type: "string",
          enum: ["fast", "default", "heavy"],
          description: "可选：覆盖本轮及后续的抽象模型档位（按本机 config.json 解析）",
        },
        model: { type: "string", description: "可选：覆盖本轮及后续 --model 参数" },
        provider: { type: "string", description: "可选：覆盖 --provider 参数（须已有或同时指定 model）" },
        thinking: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          description: "可选：覆盖本轮及后续 --thinking 思考档位",
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
    name: "pi_worker_steer",
    description:
      "向运行中（status=running）的任务实时插话纠偏：同步入队立即返回（非阻塞），消息在当前 turn 工具执行完、下一次 LLM 请求前注入运行中的 worker，不打断当前工具执行；支持跨进程 steer 其他 MCP server 启动的 detached 任务。仅限运行中任务；非运行态（needs_input/done/blocked/failed/cancelled）请改用 pi_worker_reply 续跑。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "目标任务 UUID（必须处于 running 状态）" },
        message: { type: "string", description: "插话内容：纠偏、补充约束或调整方向的明确指示" },
      },
      required: ["taskId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_worker_status",
    description:
      "查询任务实时进度（turnCount/lastTool/recentEvents）、挂起提问（question/options）或终态结果（summary、机器提取的 executedCommands、eventsPath 磁盘轨迹与 gitChanges）；可传 waitSeconds（0–30）短等状态变化。",
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
    description: "列出当前状态目录中的任务精简摘要及按父会话归组结果，可按 status、cwd 或 parentSessionId 过滤。",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "needs_input", "done", "blocked", "failed", "cancelled"],
          description: "可选：按状态过滤",
        },
        cwd: { type: "string", description: "可选：按工作区绝对路径过滤" },
        parentSessionId: { type: "string", description: "可选：按父会话标识过滤" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "返回条数上限（默认 20，最大 100）" },
      },
      additionalProperties: false,
    },
  },
];

const AGY_APP_TOOLS: ToolDefinition[] = [
  {
    name: "pi_worker_monitor",
    description:
      "在 Antigravity 侧面板打开 Pi Worker 实时进度监控面板，查看运行中与历史任务的流式思考、工具时间线、变更文件与一键取消；可传 parentSessionId/cwd 锁定默认作用域。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "可选：默认聚焦的任务 UUID；省略时自动选中当前作用域内最新运行中或最近任务" },
        parentSessionId: { type: "string", description: "可选：按父会话标识过滤默认作用域（传入时仅按会话过滤，不叠加 cwd，避免漏掉同会话跨 worktree 任务）" },
        parentSessionTitle: { type: "string", description: "可选：父会话可读标题，用于侧面板锁定标识与会话归属展示" },
        cwd: { type: "string", description: "可选：按工作区绝对路径过滤默认作用域（仅在未传 parentSessionId 时生效）" },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: APP_RESOURCE_URI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Pi Worker" },
          { type: "global", title: "Pi Worker" },
        ],
      },
    },
  },
  {
    name: "pi_worker_app_snapshot",
    description: "供 Pi Worker MCP App 侧面板增量拉取按父会话分组的任务列表、目标任务详情与格式化事件流。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "可选：目标任务 UUID" },
        parentSessionId: { type: "string", description: "可选：按父会话标识过滤（传入时仅按会话过滤，不叠加 cwd）" },
        parentSessionTitle: { type: "string", description: "可选：父会话可读标题，随 scope 原样回传供面板展示" },
        cwd: { type: "string", description: "可选：按工作区绝对路径过滤（仅在未传 parentSessionId 时生效）" },
        offset: { type: "integer", minimum: 0, description: "可选：events.jsonl 增量字节偏移" },
        tasksLimit: { type: "integer", minimum: 1, maximum: 100, description: "可选：任务列表条数上限（默认 50）" },
        maxEvents: { type: "integer", minimum: 1, maximum: 200, description: "可选：单次增量事件条数上限（默认 100）" },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  {
    name: "pi_worker_app_cancel",
    description: "供 Pi Worker MCP App 侧面板取消指定任务。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 UUID" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  {
    name: "pi_worker_app_steer",
    description: "供 Pi Worker MCP App 侧面板向运行中任务实时插话（同步入队立即返回，当前 turn 结束后注入）。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "目标任务 UUID（必须处于 running 状态）" },
        message: { type: "string", description: "插话内容" },
      },
      required: ["taskId", "message"],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
];

const ACTIVE_TOOLS: ToolDefinition[] = agyMode ? [...BASE_TOOLS, ...AGY_APP_TOOLS] : BASE_TOOLS;
const TOOL_NAME_SET = new Set(ACTIVE_TOOLS.map((t) => t.name));

const BASE_INSTRUCTIONS = [
  "磁盘证据核验（跨 Harness 通用，严禁只信自述）：任务返回中的 summary 与 verifiedCommands 仅为 Pi 自述，不得直接当已验证事实转述。整合回复前必须对照机器提取的 executedCommands（真实命令、isError、startSeq/endSeq）、eventsPath（未截断 tool_start/tool_end 磁盘日志）、gitChanges/git diff 及引用 file:line 源码做交叉核验。",
  "当任务返回 status=needs_input 时，优先依据主会话已有上下文通过 pi_worker_reply 秒答续跑（命中前缀缓存），拍不了板再转问用户。",
  "运行中任务需要主动纠偏或补充约束时，用 pi_worker_steer(taskId, message) 实时插话（同步入队立即返回，当前 turn 工具执行完、下一次 LLM 请求前注入）；仅限 running 任务，非运行态改用 pi_worker_reply 续跑。",
  "探索、验证与独立审查优先使用 readOnly=true（可同工作区并发）；读写任务运行期间主会话不得同时修改同一工作区文件；严禁在 Pi 会话内部自嵌套调用。",
];

const INSTRUCTIONS = (
  agyMode
    ? [
        ...BASE_INSTRUCTIONS,
        "当前运行于 Antigravity 原生后台模式：pi_worker_start 与 pi_worker_reply 由宿主作为后台任务异步执行并在本轮结束时自动唤醒主会话，无需循环轮询 pi_worker_status；凡落在主 Agent 职责边界之外的工作应在首轮直接派发 pi_worker_start，需要实时可视化观测进度时可调用 pi_worker_monitor 打开侧面板。",
        "会话首次派发 pi_worker_start 时，同步顺带调用一次 pi_worker_monitor（同步快速返回）将当前会话侧面板绑定到本会话 parentSessionId；建议为 pi_worker_start 传入简短 title（未传时自动从 prompt 首行提取）。",
      ]
    : BASE_INSTRUCTIONS
).join("\n");

const nested = isNestedWorkerEnv(process.env);
const store = new TaskStore(resolveStateDir(process.env));
const runner = new PiWorkerRunner({ store, env: process.env });
const inFlightRequests = new Map<string, string>();

function requestKey(id: unknown): string | null {
  if (typeof id === "string" || typeof id === "number") return String(id);
  return null;
}

function textResult(
  data: unknown,
  isError = false,
  summaryText?: string,
  extraNotes?: string[],
): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  const content: Array<{ type: string; text: string }> = [
    { type: "text", text: summaryText ?? JSON.stringify(data, null, 2) },
  ];
  for (const note of extraNotes ?? []) {
    if (note.trim()) content.push({ type: "text", text: note });
  }
  return {
    content,
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function buildEvidenceNotice(record: TaskRecord): string | null {
  if (record.status === "running") return null;
  const cmds = record.executedCommands ?? [];
  const failedCmds = cmds.filter((c) => c.isError);
  const lines = [
    "[磁盘证据核验提醒] summary 与 verifiedCommands 仅为 worker 自述，向用户定论前须交叉核验磁盘证据：",
    `- 真实命令索引（executedCommands）：本轮共执行 ${cmds.length} 条 bash 命令，失败 ${failedCmds.length} 条${
      failedCmds.length > 0
        ? `（失败项：${failedCmds.slice(0, 5).map((c) => `seq=${c.endSeq} \`${c.command || "(empty)"}\``).join("；")}）`
        : ""
    }。`,
    `- 未截断原始轨迹（eventsPath）：${record.eventsPath}（含完整 tool_start/tool_end 参数与输出，可直接读取或按 seq 抽查）。`,
  ];
  if (record.gitChanges.length > 0) {
    lines.push(`- 工作区改动（gitChanges）：共 ${record.gitChanges.length} 项，请用 git diff 或直接读取改动文件核验。`);
  }
  lines.push("- 探索/审查结论涉及的关键 file:line 须直接读取对应源码核实后再向用户定论。");
  return lines.join("\n");
}

function taskResult(record: TaskRecord) {
  const notice = buildEvidenceNotice(record);
  return textResult(record, false, undefined, notice ? [notice] : undefined);
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

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值`);
  return value;
}

function optionalTier(value: unknown): WorkerTier | undefined {
  if (value === undefined) return undefined;
  return validateWorkerTier(optionalString(value, "tier"));
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return value;
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function makeProgressEmitter(progressToken: unknown): ((ev: FormattedStreamEvent) => void) | undefined {
  if (typeof progressToken !== "string" && typeof progressToken !== "number") return undefined;
  return (ev: FormattedStreamEvent): void => {
    if (ev.kind === "text_delta") return;
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress: ev.seq,
        message: formatTerminalLine(ev),
      },
    });
  };
}

// 会话标题懒补齐（仅 AGY 模式）：进程内 LRU 缓存，任意失败静默 fail-open，绝不阻塞工具调用。
// 注意：多会话共享同一 MCP server 进程，这里只缓存“会话 ID → 标题”映射，严禁引入进程级 lastScope 状态。
const TITLE_CACHE_MAX_ENTRIES = 256;
const TITLE_CACHE_HIT_TTL_MS = 30 * 60 * 1000;
const TITLE_CACHE_MISS_TTL_MS = (() => {
  const raw = Number(process.env.PI_WORKER_TITLE_MISS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
})();

interface TitleCacheEntry {
  value: string | null;
  expiresAt: number;
}

const conversationTitleCache = new Map<string, TitleCacheEntry>();

function getCachedConversationTitle(key: string): string | null | undefined {
  const entry = conversationTitleCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    conversationTitleCache.delete(key);
    return undefined;
  }
  conversationTitleCache.delete(key);
  conversationTitleCache.set(key, entry);
  return entry.value;
}

function setCachedConversationTitle(key: string, value: string | null): void {
  if (conversationTitleCache.has(key)) {
    conversationTitleCache.delete(key);
  }
  while (conversationTitleCache.size >= TITLE_CACHE_MAX_ENTRIES) {
    const oldestKey = conversationTitleCache.keys().next().value;
    if (oldestKey === undefined) break;
    conversationTitleCache.delete(oldestKey);
  }
  const ttl = value !== null ? TITLE_CACHE_HIT_TTL_MS : TITLE_CACHE_MISS_TTL_MS;
  conversationTitleCache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function fetchConversationTitle(parentSessionId: string): Promise<string | null> {
  if (!agyMode || !parentSessionId) return null;
  const address = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!address || !csrfToken) return null;
  const cached = getCachedConversationTitle(parentSessionId);
  if (cached !== undefined) return cached;
  let title: string | null = null;
  try {
    const res = await fetch(`http://${address}/product.v1.ConversationService/GetConversation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": csrfToken,
      },
      body: JSON.stringify({ conversationId: parentSessionId }),
      signal: AbortSignal.timeout(350),
    });
    if (res.ok) {
      const data = await res.json() as {
        annotations?: { title?: unknown };
        state?: { summary?: unknown };
      };
      const raw = typeof data?.annotations?.title === "string" && data.annotations.title.trim()
        ? data.annotations.title
        : typeof data?.state?.summary === "string"
          ? data.state.summary
          : "";
      const cleaned = raw.replace(/\s+/g, " ").trim();
      if (cleaned) title = cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
    }
  } catch {
    // 超时/网络/解析异常一律静默降级
  }
  setCachedConversationTitle(parentSessionId, title);
  return title;
}

async function backfillSessionTitles(groups: TaskSessionGroup[]): Promise<void> {
  if (!agyMode) return;
  await Promise.all(groups.map(async (group) => {
    if (!group.parentSessionId || group.parentSessionTitle) return;
    const title = await fetchConversationTitle(group.parentSessionId);
    if (!title) return;
    group.parentSessionTitle = title;
    for (const task of group.tasks) {
      if (!task.parentSessionTitle) task.parentSessionTitle = title;
    }
  }));
}

async function buildMonitorPayload(opts: {
  taskId?: string;
  parentSessionId?: string;
  parentSessionTitle?: string;
  cwd?: string;
  offset?: number;
  tasksLimit?: number;
  maxEvents?: number;
}): Promise<{
  scope: { parentSessionId: string | null; parentSessionTitle: string | null; cwd: string | null };
  tasks: ReturnType<PiWorkerRunner["list"]>;
  groups: TaskSessionGroup[];
  task: TaskRecord | null;
  stream: ReturnType<typeof readFormattedEventsDelta> | null;
}> {
  // 会话作用域优先：同时传入 parentSessionId 与 cwd 时仅按会话过滤，
  // 避免漏掉同会话在 git worktree 等其他目录派发的任务。
  const tasks = runner.list({
    ...(opts.parentSessionId
      ? { parentSessionId: opts.parentSessionId }
      : opts.cwd
        ? { cwd: opts.cwd }
        : {}),
    limit: opts.tasksLimit ?? 50,
  });
  const groups = groupTasksByParentSession(tasks);
  await backfillSessionTitles(groups);
  const targetId = opts.taskId
    ?? groups[0]?.tasks[0]?.taskId
    ?? tasks.find((t) => t.status === "running")?.taskId
    ?? tasks[0]?.taskId;
  let task: TaskRecord | null = null;
  if (targetId) {
    try {
      task = await runner.status({ taskId: targetId, waitSeconds: 0 });
    } catch {
      task = null;
    }
  }
  const stream = task
    ? readFormattedEventsDelta(task.eventsPath, opts.offset ?? 0, { maxEvents: opts.maxEvents ?? 100 })
    : null;
  const scopeTitle = opts.parentSessionTitle
    ?? groups[0]?.parentSessionTitle
    ?? (opts.parentSessionId ? await fetchConversationTitle(opts.parentSessionId) : null)
    ?? null;
  return {
    scope: {
      parentSessionId: opts.parentSessionId ?? null,
      parentSessionTitle: scopeTitle,
      cwd: opts.cwd ?? null,
    },
    tasks,
    groups,
    task,
    stream,
  };
}

function readMonitorHtml(): string {
  const customPath = process.env.PI_WORKER_APP_HTML?.trim();
  const targetPath = customPath || DEFAULT_APP_HTML_PATH;
  return readFileSync(targetPath, "utf8");
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  reqId?: unknown,
  progressToken?: unknown,
) {
  if (nested) {
    return textResult(
      { error: "检测到处于 pi-worker / Pi 子代理嵌套环境中，禁止调用任何 pi-worker 工具" },
      true,
    );
  }
  if (!TOOL_NAME_SET.has(name)) {
    return textResult({ error: `未知工具: ${name}` }, true);
  }

  const reqKey = requestKey(reqId);
  let rpcDone = false;
  const rawProgress = makeProgressEmitter(progressToken);
  const onProgress = rawProgress
    ? (ev: FormattedStreamEvent): void => {
        if (!rpcDone) rawProgress(ev);
      }
    : undefined;

  try {
    if (name === "pi_worker_start") {
      const cwd = optionalString(args.cwd, "cwd");
      const prompt = optionalString(args.prompt, "prompt");
      if (!cwd) throw new Error("缺少必填参数 cwd");
      if (!prompt) throw new Error("缺少必填参数 prompt");
      try {
        const record = await runner.start({
          cwd,
          prompt,
          parentSessionId: optionalString(args.parentSessionId, "parentSessionId"),
          title: optionalString(args.title, "title"),
          parentSessionTitle: optionalString(args.parentSessionTitle, "parentSessionTitle"),
          tier: optionalTier(args.tier),
          readOnly: optionalBoolean(args.readOnly, "readOnly"),
          model: optionalString(args.model, "model"),
          provider: optionalString(args.provider, "provider"),
          thinking: optionalString(args.thinking, "thinking"),
          excludeTools: optionalStringArray(args.excludeTools, "excludeTools"),
          waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
          ...(agyMode ? { waitUntilSettled: true } : {}),
          ...(reqKey ? { onTaskCreated: (taskId) => { inFlightRequests.set(reqKey, taskId); } } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
        return taskResult(record);
      } finally {
        rpcDone = true;
        if (reqKey) inFlightRequests.delete(reqKey);
      }
    }

    if (name === "pi_worker_reply") {
      const taskId = optionalString(args.taskId, "taskId");
      const reply = optionalString(args.reply, "reply");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      if (!reply) throw new Error("缺少必填参数 reply");
      try {
        const record = await runner.reply({
          taskId,
          reply,
          tier: optionalTier(args.tier),
          model: optionalString(args.model, "model"),
          provider: optionalString(args.provider, "provider"),
          thinking: optionalString(args.thinking, "thinking"),
          waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
          ...(agyMode ? { waitUntilSettled: true } : {}),
          ...(reqKey ? { onTaskCreated: (id) => { inFlightRequests.set(reqKey, id); } } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
        return taskResult(record);
      } finally {
        rpcDone = true;
        if (reqKey) inFlightRequests.delete(reqKey);
      }
    }

    if (name === "pi_worker_steer" || name === "pi_worker_app_steer") {
      const taskId = optionalString(args.taskId, "taskId");
      const message = optionalString(args.message, "message");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      if (!message) throw new Error("缺少必填参数 message");
      const result = await runner.steer({
        taskId,
        message,
        source: name === "pi_worker_app_steer" ? "app" : "agent",
      });
      return textResult(
        result,
        false,
        `Steer 已入队（steerId=${result.steerId}），将在当前 turn 工具执行完、下一次 LLM 请求前注入运行中的任务`,
      );
    }

    if (name === "pi_worker_status") {
      const taskId = optionalString(args.taskId, "taskId");
      if (!taskId) throw new Error("缺少必填参数 taskId");
      const record = await runner.status({
        taskId,
        waitSeconds: optionalNumber(args.waitSeconds, "waitSeconds"),
      });
      return taskResult(record);
    }

    if (name === "pi_worker_cancel" || name === "pi_worker_app_cancel") {
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
        parentSessionId: optionalString(args.parentSessionId, "parentSessionId"),
        limit: optionalNumber(args.limit, "limit"),
      });
      const groups = groupTasksByParentSession(tasks);
      await backfillSessionTitles(groups);
      return textResult({ tasks, groups });
    }

    if (name === "pi_worker_monitor") {
      const taskId = optionalString(args.taskId, "taskId");
      const parentSessionId = optionalString(args.parentSessionId, "parentSessionId");
      const parentSessionTitle = optionalString(args.parentSessionTitle, "parentSessionTitle");
      const cwd = optionalString(args.cwd, "cwd");
      const payload = await buildMonitorPayload({ taskId, parentSessionId, parentSessionTitle, cwd });
      const summary = payload.task
        ? `Pi Worker 监控面板已就绪（共 ${payload.tasks.length} 个任务 / ${payload.groups.length} 组；当前聚焦 ${payload.task.taskId} [${payload.task.status}]）`
        : `Pi Worker 监控面板已就绪（当前作用域暂无任务）`;
      return textResult(payload, false, summary);
    }

    if (name === "pi_worker_app_snapshot") {
      const taskId = optionalString(args.taskId, "taskId");
      const parentSessionId = optionalString(args.parentSessionId, "parentSessionId");
      const parentSessionTitle = optionalString(args.parentSessionTitle, "parentSessionTitle");
      const cwd = optionalString(args.cwd, "cwd");
      const offset = optionalNumber(args.offset, "offset");
      const tasksLimit = optionalNumber(args.tasksLimit, "tasksLimit");
      const maxEvents = optionalNumber(args.maxEvents, "maxEvents");
      const payload = await buildMonitorPayload({ taskId, parentSessionId, parentSessionTitle, cwd, offset, tasksLimit, maxEvents });
      return textResult(payload, false, "ok");
    }

    return textResult({ error: `未知工具: ${name}` }, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message }, true);
  }
}

async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
  const method = message.method ?? "";
  if (message.id === undefined) {
    if (method === "notifications/cancelled") {
      const params = message.params as { requestId?: unknown } | undefined;
      const key = requestKey(params?.requestId);
      const taskId = key ? inFlightRequests.get(key) : undefined;
      if (taskId) {
        void runner.cancel({ taskId }).catch(() => undefined);
      }
    }
    return null;
  }
  if (method === "initialize") {
    const params = message.params as { protocolVersion?: string } | undefined;
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: agyMode && !nested ? { tools: {}, resources: {} } : { tools: {} },
      serverInfo: { name: "pi-worker", version: "0.2.0" },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: nested ? [] : ACTIVE_TOOLS };
  if (method === "tools/call") {
    const params = message.params as {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: { progressToken?: unknown };
    } | undefined;
    if (!params?.name) return textResult({ error: "缺少工具名" }, true);
    const callArgs = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    return callTool(params.name, callArgs, message.id, params._meta?.progressToken);
  }
  if (method === "resources/list") {
    if (!agyMode || nested) return { resources: [] };
    return {
      resources: [
        {
          uri: APP_RESOURCE_URI,
          name: "Pi Worker Monitor",
          description: "实时流式观测 Pi Worker 思考、工具调用、变更文件与取消操作",
          mimeType: APP_MIME_TYPE,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    };
  }
  if (method === "resources/read") {
    if (!agyMode || nested) {
      throw Object.assign(new Error("当前模式未启用 MCP App 资源"), { code: -32602 });
    }
    const params = message.params as { uri?: string } | undefined;
    if (params?.uri !== APP_RESOURCE_URI) {
      throw Object.assign(new Error(`未知资源: ${String(params?.uri ?? "")}`), { code: -32602 });
    }
    let html: string;
    try {
      html = readMonitorHtml();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`读取 MCP App HTML 失败: ${msg}`), { code: -32603 });
    }
    return {
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: APP_MIME_TYPE,
          text: html,
        },
      ],
    };
  }
  if (method === "prompts/list") return { prompts: [] };
  throw Object.assign(new Error(`未知方法: ${method}`), { code: -32601 });
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    const message = parsed as { id?: unknown; method?: string; params?: unknown };
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
