import {
  extractTextFromContent,
  readSteerEntriesFromOffset,
  truncateTail,
  writeOutcomeFile,
} from "./protocol.ts";
import type { WorkerOutcome } from "./protocol.ts";

export interface PiExtensionContextLike {
  abort?: () => void;
  hasPendingMessages?: () => boolean;
}

export interface PiToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  terminate?: boolean;
}

export interface PiToolDefLike {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: PiExtensionContextLike,
  ) => Promise<PiToolResultLike> | PiToolResultLike;
}

export interface PiExtensionApiLike {
  registerTool(def: PiToolDefLike): void;
  on(
    event: string,
    handler: (event: Record<string, unknown>, ctx?: PiExtensionContextLike) => Promise<void> | void,
  ): void;
  sendUserMessage?: (
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => Promise<void> | void;
}

export interface RegisterWorkerExtOptions {
  outcomeFile: string;
  /** 运行态实时插话磁盘队列文件（PI_WORKER_STEER_FILE） */
  steerFile?: string;
  /** 队列轮询间隔（默认 250ms，测试可注入小值） */
  steerPollMs?: number;
  setExitCode?: (code: number) => void;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function findLastAssistantMessage(messages: unknown): Record<string, unknown> | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item && typeof item === "object" && (item as Record<string, unknown>).role === "assistant") {
      return item as Record<string, unknown>;
    }
  }
  return null;
}

export function registerPiWorkerExtension(
  pi: PiExtensionApiLike,
  options: RegisterWorkerExtOptions,
): void {
  const { outcomeFile } = options;
  const setExitCode = options.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const steerFile = options.steerFile?.trim() || undefined;
  let terminalWritten = false;
  let abortOnTurnEnd = false;
  let forcedErrorExitCode = false;
  let steerTimer: NodeJS.Timeout | null = null;
  let steerOffset = 0;
  const consumedSteerIds = new Set<string>();

  const clearSteerTimer = (): void => {
    if (steerTimer) {
      clearInterval(steerTimer);
      steerTimer = null;
    }
  };

  /**
   * 消费未读 steer 队列条目：按字节偏移增量读取并按 id 去重保证每条至多注入一次；
   * 已写终态（worker_finish / worker_ask_parent / worker_report_blocked）后不再注入。
   * 返回本次是否注入了新消息。
   */
  const consumeSteers = (): boolean => {
    if (!steerFile || terminalWritten || !pi.sendUserMessage) return false;
    const { entries, nextOffset } = readSteerEntriesFromOffset(steerFile, steerOffset);
    steerOffset = nextOffset;
    let injected = false;
    for (const entry of entries) {
      if (consumedSteerIds.has(entry.id)) continue;
      // 先标记后注入：即使注入异常也保证至多消费一次
      consumedSteerIds.add(entry.id);
      try {
        Promise.resolve(pi.sendUserMessage(entry.message, { deliverAs: "steer" })).catch(() => { /* 注入失败忽略 */ });
        injected = true;
      } catch {
        // 同步注入异常忽略
      }
    }
    return injected;
  };

  const hasUnconsumedSteers = (): boolean => {
    if (!steerFile || terminalWritten) return false;
    return readSteerEntriesFromOffset(steerFile, steerOffset).entries.some((entry) => !consumedSteerIds.has(entry.id));
  };

  const clearForcedErrorExitCode = (): void => {
    if (forcedErrorExitCode) {
      forcedErrorExitCode = false;
      setExitCode(0);
    }
  };

  const commitTerminal = (outcome: WorkerOutcome): void => {
    writeOutcomeFile(outcomeFile, outcome);
    terminalWritten = true;
    abortOnTurnEnd = true;
    clearSteerTimer();
    clearForcedErrorExitCode();
  };

  pi.registerTool({
    name: "worker_ask_parent",
    label: "worker_ask_parent",
    description:
      "遇到无法自行拍板的需求、架构或权限歧义时调用本工具挂起任务，向父代理提问并等待父代理续跑回复。调用前优先对已闭合探索段执行尾部 compress。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "需要父代理或用户回答的明确问题" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选候选方案列表，便于快速决策",
        },
        summary: { type: "string", description: "截至目前的已完成进展与上下文简述" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) {
        return { content: [{ type: "text", text: "question 不能为空" }] };
      }
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      const optionsList = asStringArray(params.options);
      commitTerminal({
        status: "needs_input",
        summary,
        question,
        options: optionsList,
        verifiedCommands: [],
        stopReason: null,
        error: null,
      });
      return {
        content: [
          {
            type: "text",
            text: "已记录挂起问题并准备通知父代理，本轮将在当前 turn 结束时自动挂起退出；请勿再调用其他工具。",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "worker_report_blocked",
    label: "worker_report_blocked",
    description: "遇到缺少凭据、环境故障或无法绕过的外部阻塞时调用本工具上报并结束当前轮次。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "阻塞的具体原因与缺失前提" },
        summary: { type: "string", description: "已完成的部分进展与现状摘要" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) {
        return { content: [{ type: "text", text: "reason 不能为空" }] };
      }
      const summary = typeof params.summary === "string" && params.summary.trim()
        ? params.summary.trim()
        : reason;
      commitTerminal({
        status: "blocked",
        summary,
        question: null,
        options: [],
        verifiedCommands: [],
        stopReason: null,
        error: reason,
      });
      return {
        content: [
          {
            type: "text",
            text: "已记录阻塞状态，本轮将在当前 turn 结束时自动退出；请勿再调用其他工具。",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "worker_finish",
    label: "worker_finish",
    description: "完成委派任务并跑通验收命令后调用本工具提交结构化最终摘要与已验证命令列表。",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "本次改动与结果的简洁摘要" },
        verifiedCommands: {
          type: "array",
          items: { type: "string" },
          description: "已执行并核验过的命令与结论列表",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      if (!summary) {
        return { content: [{ type: "text", text: "summary 不能为空" }] };
      }
      commitTerminal({
        status: "done",
        summary,
        question: null,
        options: [],
        verifiedCommands: asStringArray(params.verifiedCommands),
        stopReason: null,
        error: null,
      });
      return {
        content: [
          {
            type: "text",
            text: "已记录完成结果，本轮将在当前 turn 结束时自动退出；请勿再调用其他工具。",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });

  // 运行态 steer 消费：轻量 unref 定时器轮询 + 安全时机事件触发，
  // 通过 Pi 原生 deliverAs: "steer" 在当前 turn 工具执行完、下一次 LLM 请求前送达模型。
  if (steerFile) {
    steerTimer = setInterval(consumeSteers, options.steerPollMs ?? 250);
    steerTimer.unref?.();
    pi.on("tool_execution_end", () => {
      consumeSteers();
    });
    pi.on("agent_before_settle", () => {
      consumeSteers();
    });
    pi.on("agent_settled", () => {
      clearSteerTimer();
    });
  }

  pi.on("turn_end", (_event, ctx) => {
    consumeSteers();
    if (abortOnTurnEnd) {
      abortOnTurnEnd = false;
      ctx?.abort?.();
    }
  });

  pi.on("agent_end", (event, ctx) => {
    if (terminalWritten) return;

    // 存在未消费/待处理 steer 时禁止提前写死终态：
    // Pi 会在 agent_end 后继续 drain steering 队列并再次触发 agent_end。
    const injected = consumeSteers();
    if (injected || hasUnconsumedSteers() || ctx?.hasPendingMessages?.() === true) return;

    const lastAssistant = findLastAssistantMessage(event.messages);
    const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : null;
    const errorMessage = typeof lastAssistant?.errorMessage === "string" && lastAssistant.errorMessage
      ? lastAssistant.errorMessage
      : null;

    if (stopReason === "error" || stopReason === "aborted") {
      writeOutcomeFile(outcomeFile, {
        status: "failed",
        summary: "",
        question: null,
        options: [],
        verifiedCommands: [],
        stopReason,
        error: errorMessage ?? stopReason,
      });
      forcedErrorExitCode = true;
      setExitCode(1);
      return;
    }

    const text = lastAssistant ? truncateTail(extractTextFromContent(lastAssistant.content).trim(), 4000) : "";
    writeOutcomeFile(outcomeFile, {
      status: "done",
      summary: text,
      question: null,
      options: [],
      verifiedCommands: [],
      stopReason,
      error: null,
    });
    clearForcedErrorExitCode();
  });
}

export default function piWorkerExtension(pi: PiExtensionApiLike): void {
  const outcomeFile = process.env.PI_WORKER_OUTCOME_FILE?.trim();
  if (!outcomeFile) return;
  registerPiWorkerExtension(pi, {
    outcomeFile,
    steerFile: process.env.PI_WORKER_STEER_FILE?.trim() || undefined,
  });
}
