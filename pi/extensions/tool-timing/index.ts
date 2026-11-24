import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "tool-timing.v1";

type ToolTiming = {
  toolCallId: string;
  requestedAt: string;
  resultReadyAt: string;
};

export function createToolTimingExtension(pi: ExtensionAPI): void {
  const pending = new Map<string, { wallMs: number; monotonicMs: number }>();
  const completed = new Map<string, ToolTiming>();

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    pending.clear();
    completed.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as Partial<ToolTiming> | undefined;
      if (typeof data?.toolCallId === "string" && typeof data.requestedAt === "string" && typeof data.resultReadyAt === "string") {
        completed.set(data.toolCallId, data as ToolTiming);
      }
    }
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => { pending.clear(); completed.clear(); });
  pi.on("agent_end", () => { pending.clear(); });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const wallMs = Date.now();
    const monotonicMs = performance.now();
    for (const part of event.message.content) {
      if (part.type === "toolCall") pending.set(part.id, { wallMs, monotonicMs });
    }
  });

  pi.on("tool_execution_end", (event) => {
    const start = pending.get(event.toolCallId);
    if (!start) return;
    pending.delete(event.toolCallId);
    const timing: ToolTiming = {
      toolCallId: event.toolCallId,
      requestedAt: new Date(start.wallMs).toISOString(),
      resultReadyAt: new Date(start.wallMs + performance.now() - start.monotonicMs).toISOString(),
    };
    completed.set(event.toolCallId, timing);
    pi.appendEntry(ENTRY_TYPE, timing);
  });

  pi.on("context", (event) => {
    const assistantIndex = event.messages.findLastIndex((message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "toolCall"));
    if (assistantIndex < 0) return;

    const timingByToolCall = new Map<string, ToolTiming>();
    for (const message of event.messages.slice(assistantIndex + 1)) {
      if (message.role !== "toolResult") break;
      const timing = completed.get(message.toolCallId);
      if (!timing) continue;
      timingByToolCall.set(message.toolCallId, timing);
    }
    if (timingByToolCall.size === 0) return;

    return {
      messages: event.messages.map((message) => {
        if (message.role !== "toolResult") return message;
        const timing = timingByToolCall.get(message.toolCallId);
        if (!timing) return message;
        const timingText = `${timing.requestedAt}\n${timing.resultReadyAt}`;
        if (message.content.some((part) => part.type === "text" && part.text === timingText)) return message;
        return {
          ...message,
          content: [
            ...message.content,
            { type: "text" as const, text: timingText },
          ],
        };
      }),
    };
  });

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.promptGuidelines.push(
      "工具结果末尾可能附带两行 ISO8601 时间戳：第一行是调用接收时间，第二行是结果就绪时间。这是 tool-timing 扩展注入的观测元数据，仅用于感知工具耗时，不是工具自身输出，也不代表错误或操作失误，不要据此重试、修正或道歉。",
    );
  });
}
