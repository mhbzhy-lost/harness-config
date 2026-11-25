export interface TimelineEventLike {
  seq: number;
  round?: number;
  blockId?: number;
  kind: string;
  title: string;
  detail?: string;
  preview?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
  thinkingChars?: number;
  timestamp: string;
}

export type TimelineItem =
  | {
      type: "round";
      key: string;
      round: number;
      timestamp: string;
    }
  | {
      type: "thinking";
      key: string;
      round: number;
      blockId: number | null;
      text: string;
      thinkingChars: number;
      startedAt: string;
      updatedAt: string;
      isStreaming: boolean;
    }
  | {
      type: "assistant";
      key: string;
      round: number;
      blockId: number | null;
      title: string;
      text: string;
      isError: boolean;
      isStreaming: boolean;
      timestamp: string;
    }
  | {
      type: "tool";
      key: string;
      round: number;
      toolCallId?: string;
      toolName: string;
      input?: string;
      inputPreview?: string;
      output?: string;
      status: "running" | "done" | "error" | "interrupted";
      durationMs?: number;
      startedAt: string;
      endedAt?: string;
    }
  | {
      type: "event";
      key: string;
      round: number;
      kind: string;
      title: string;
      detail?: string;
      isError: boolean;
      timestamp: string;
    };

const EXPANDABLE_DETAIL_MIN_CHARS = 100;
const DEFAULT_PREVIEW_MAX_CHARS = 96;

/**
 * 进度流事件图标。
 * 注意：禁止使用 "▶" 等折叠箭头作为静态图标，避免与原生 <details> 展开三角混淆。
 */
export function iconForEvent(ev: Pick<TimelineEventLike, "kind" | "isError">): string {
  switch (ev.kind) {
    case "tool_start":
      return "⚙";
    case "tool_end":
      return ev.isError ? "✖" : "✓";
    case "assistant":
    case "text_delta":
      return "💬";
    case "thinking":
      return "💭";
    case "compact":
      return "🗜";
    case "retry_failed":
      return "⚠";
    case "steer":
      return "🧭";
    case "status":
      return "●";
    case "turn_end":
      return "─";
    default:
      return "·";
  }
}

/**
 * 判断事件详情是否需要渲染为可展开的 <details>：
 * 多行文本或超长文本折叠显示单行预览、点击展开全文；短单行直接静态展示。
 */
export function isExpandableDetail(detail?: string): boolean {
  if (!detail) return false;
  const trimmed = detail.trim();
  if (!trimmed) return false;
  return trimmed.includes("\n") || trimmed.length > EXPANDABLE_DETAIL_MIN_CHARS;
}

export function summarizeDetailPreview(detail: string, maxChars = DEFAULT_PREVIEW_MAX_CHARS): string {
  const singleLine = detail.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars)}…`;
}

/**
 * 将原始增量 FormattedStreamEvent 数组归约为稳定的时间线卡片列表：
 * - 同一 (round, blockId) 的 thinking 增量无损拼接为单个可折叠思考块；
 * - 同一 (round, blockId) 的 text_delta 增量实时拼接，并在收到对应 assistant 定稿时收口；
 * - 同一 round 内按 toolCallId（或回退 toolName）将 tool_start + tool_end 合并为单张工具调用卡；
 * - 跨轮（round 切换）自动插入 Round 分隔并保证所有 key 全局唯一。
 */
export function reduceTimelineItems(
  events: readonly TimelineEventLike[],
  isTaskRunning: boolean,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const thinkingByBlock = new Map<string, Extract<TimelineItem, { type: "thinking" }>>();
  const assistantByBlock = new Map<string, Extract<TimelineItem, { type: "assistant" }>>();
  const openToolsById = new Map<string, Extract<TimelineItem, { type: "tool" }>>();

  let lastRound: number | null = null;
  let activeThinking: Extract<TimelineItem, { type: "thinking" }> | null = null;
  let activeAssistant: Extract<TimelineItem, { type: "assistant" }> | null = null;

  const closeOpenThinking = (): void => {
    if (activeThinking) {
      activeThinking.isStreaming = false;
      activeThinking = null;
    }
  };

  const closeOpenAssistant = (): void => {
    if (activeAssistant) {
      activeAssistant.isStreaming = false;
      activeAssistant = null;
    }
  };

  for (let idx = 0; idx < events.length; idx += 1) {
    const ev = events[idx];
    const round = typeof ev.round === "number" && ev.round >= 1 ? ev.round : 1;

    if (lastRound !== null && round !== lastRound) {
      closeOpenThinking();
      closeOpenAssistant();
      items.push({
        type: "round",
        key: `round-${round}-${idx}`,
        round,
        timestamp: ev.timestamp,
      });
    }
    lastRound = round;

    if (ev.kind === "thinking") {
      closeOpenAssistant();
      const blockId = typeof ev.blockId === "number" ? ev.blockId : null;
      const mapKey = blockId !== null ? `${round}:${blockId}` : null;
      const existing = mapKey ? thinkingByBlock.get(mapKey) : undefined;
      const chunk = ev.detail ?? "";

      if (existing) {
        existing.text += chunk;
        existing.thinkingChars = Math.max(existing.thinkingChars, ev.thinkingChars ?? existing.text.length);
        existing.updatedAt = ev.timestamp;
        existing.isStreaming = isTaskRunning;
        activeThinking = existing;
      } else {
        closeOpenThinking();
        const item: Extract<TimelineItem, { type: "thinking" }> = {
          type: "thinking",
          key: mapKey ? `thinking-${mapKey}` : `thinking-${round}-${ev.seq}-${idx}`,
          round,
          blockId,
          text: chunk,
          thinkingChars: ev.thinkingChars ?? chunk.length,
          startedAt: ev.timestamp,
          updatedAt: ev.timestamp,
          isStreaming: isTaskRunning,
        };
        if (mapKey) thinkingByBlock.set(mapKey, item);
        items.push(item);
        activeThinking = item;
      }
      continue;
    }

    if (ev.kind === "text_delta") {
      closeOpenThinking();
      const blockId = typeof ev.blockId === "number" ? ev.blockId : null;
      const mapKey = blockId !== null ? `${round}:${blockId}` : null;
      const existing = mapKey ? assistantByBlock.get(mapKey) : undefined;
      const chunk = ev.detail ?? "";

      if (existing) {
        existing.text += chunk;
        existing.timestamp = ev.timestamp;
        existing.isStreaming = isTaskRunning;
        activeAssistant = existing;
      } else {
        closeOpenAssistant();
        const item: Extract<TimelineItem, { type: "assistant" }> = {
          type: "assistant",
          key: mapKey ? `assistant-${mapKey}` : `assistant-${round}-${ev.seq}-${idx}`,
          round,
          blockId,
          title: ev.title || "助手输出",
          text: chunk,
          isError: false,
          isStreaming: isTaskRunning,
          timestamp: ev.timestamp,
        };
        if (mapKey) assistantByBlock.set(mapKey, item);
        items.push(item);
        activeAssistant = item;
      }
      continue;
    }

    if (ev.kind === "assistant") {
      closeOpenThinking();
      const blockId = typeof ev.blockId === "number" ? ev.blockId : null;
      const mapKey = blockId !== null ? `${round}:${blockId}` : null;
      const existing = mapKey ? assistantByBlock.get(mapKey) : undefined;

      if (existing) {
        if (ev.detail !== undefined) existing.text = ev.detail;
        existing.title = ev.title || existing.title;
        existing.isError = ev.isError === true;
        existing.isStreaming = false;
        existing.timestamp = ev.timestamp;
        if (activeAssistant === existing) activeAssistant = null;
      } else {
        closeOpenAssistant();
        items.push({
          type: "assistant",
          key: mapKey ? `assistant-${mapKey}` : `assistant-${round}-${ev.seq}-${idx}`,
          round,
          blockId,
          title: ev.title || "助手输出",
          text: ev.detail ?? "",
          isError: ev.isError === true,
          isStreaming: false,
          timestamp: ev.timestamp,
        });
      }
      continue;
    }

    if (ev.kind === "tool_start") {
      closeOpenThinking();
      closeOpenAssistant();
      const toolName = ev.toolName ?? ev.title ?? "tool";
      const toolCallId = ev.toolCallId;
      const key = toolCallId
        ? `tool-${round}-${toolCallId}-${idx}`
        : `tool-${round}-${ev.seq}-${idx}`;
      const item: Extract<TimelineItem, { type: "tool" }> = {
        type: "tool",
        key,
        round,
        ...(toolCallId ? { toolCallId } : {}),
        toolName,
        ...(ev.detail !== undefined ? { input: ev.detail } : {}),
        ...(ev.preview !== undefined ? { inputPreview: ev.preview } : {}),
        status: "running",
        startedAt: ev.timestamp,
      };
      if (toolCallId) {
        openToolsById.set(`${round}:${toolCallId}`, item);
      }
      items.push(item);
      continue;
    }

    if (ev.kind === "tool_end") {
      closeOpenThinking();
      closeOpenAssistant();
      const toolName = ev.toolName ?? ev.title ?? "tool";
      const toolCallId = ev.toolCallId;
      let target: Extract<TimelineItem, { type: "tool" }> | undefined;
      if (toolCallId) {
        const lookupKey = `${round}:${toolCallId}`;
        target = openToolsById.get(lookupKey);
        if (target) openToolsById.delete(lookupKey);
      }
      if (!target) {
        for (let j = items.length - 1; j >= 0; j -= 1) {
          const cand = items[j];
          if (cand.type === "tool" && cand.round === round && cand.status === "running" && cand.toolName === toolName) {
            target = cand;
            break;
          }
        }
      }
      if (target) {
        target.status = ev.isError === true ? "error" : "done";
        if (ev.detail !== undefined) target.output = ev.detail;
        if (ev.durationMs !== undefined) target.durationMs = ev.durationMs;
        target.endedAt = ev.timestamp;
      } else {
        items.push({
          type: "tool",
          key: `tool-end-${round}-${ev.seq}-${idx}`,
          round,
          ...(toolCallId ? { toolCallId } : {}),
          toolName,
          ...(ev.detail !== undefined ? { output: ev.detail } : {}),
          status: ev.isError === true ? "error" : "done",
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
        });
      }
      continue;
    }

    closeOpenThinking();
    closeOpenAssistant();
    items.push({
      type: "event",
      key: `ev-${round}-${ev.seq}-${idx}`,
      round,
      kind: ev.kind,
      title: ev.title,
      ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      isError: ev.isError === true,
      timestamp: ev.timestamp,
    });
  }

  if (!isTaskRunning) {
    for (const item of items) {
      if (item.type === "thinking" || item.type === "assistant") {
        item.isStreaming = false;
      } else if (item.type === "tool" && item.status === "running") {
        item.status = "interrupted";
      }
    }
  }

  return items;
}
