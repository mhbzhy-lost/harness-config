export interface TimelineEventLike {
  kind: string;
  isError?: boolean;
  detail?: string;
}

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
      return "💬";
    case "compact":
      return "🗜";
    case "retry_failed":
      return "⚠";
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
