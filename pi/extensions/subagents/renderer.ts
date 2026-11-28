import type { Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import {
  createExpandedToolText,
  failedResultLine,
  resultStatus,
  setRenderStatus,
  statusGlyph,
  syncStatusAnimation,
  type CompactRenderStatus,
} from "../compact-tools/index.ts";

/** 本渲染器接管的 pi-subagents 工具名集合 */
export const SUBAGENT_TOOL_NAMES = [
  "subagent",
  "subagent_launch",
  "bg_wait",
  "contact_supervisor",
  "subagent_supervisor",
  "watchdog_diff",
] as const;

const STATUS_KEY = "subagentsStatus";
const SUMMARY_KEY = "subagentsSummary";
const DONE_STATUSES = new Set(["done", "completed", "succeeded", "success"]);
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "aborted"]);

/** 折叠连续空白为单空格并 trim，避免多行参数破坏单行标题 */
export function collapseWhitespace(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function textOutput(result: any): string {
  const content = result?.content;
  return Array.isArray(content)
    ? content.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n")
    : typeof content === "string" ? content : "";
}

function nonEmptyLineCount(text: string): number {
  return text ? text.split("\n").filter((line) => line.trim()).length : 0;
}

function serializedBlock(block: any): string {
  if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
    const keys = Object.keys(block);
    if (keys.every((key) => key === "type" || key === "text")) return block.text;
    return `${block.text}\ncontentBlock:\n${JSON.stringify(block, null, 2)}`;
  }
  const serialized = JSON.stringify(block, null, 2);
  return serialized === undefined ? String(block) : serialized;
}

/** 与 compact-tools 一致：文本块取正文，非文本块 JSON 序列化 */
export function fullResultText(result: any): string {
  const content = typeof result?.content === "string"
    ? [result.content]
    : Array.isArray(result?.content) ? result.content.map(serializedBlock) : [];
  return content.join("\n");
}

function firstStringArg(args: any): string {
  const value = Object.values(args ?? {}).find((entry) => typeof entry === "string" && entry.trim());
  return collapseWhitespace(value);
}

function title(name: string, detail: string, theme: any): string {
  return `${theme.fg("toolTitle", theme.bold(name))}${detail ? ` ${detail}` : ""}`;
}

function asyncFlag(args: any, theme: any): string {
  return args?.async === true ? theme.fg("warning", "[async]") : "";
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/** 标题行 detail 段（不含工具名与状态 glyph） */
export function callDetail(name: string, args: any, theme: any): string {
  const paint = (color: string, value: unknown) => {
    const text = collapseWhitespace(value);
    return text ? theme.fg(color, text) : "";
  };
  const accent = (value: unknown) => paint("accent", value);
  const dim = (value: unknown) => paint("dim", value);

  switch (name) {
    case "subagent": {
      if (typeof args?.action === "string" && args.action.trim()) {
        return joinParts([
          accent(args.action),
          typeof args.id === "string" && args.id.trim() ? dim(`#${collapseWhitespace(args.id)}`) : "",
          typeof args.message === "string" && args.message.trim() ? dim(args.message) : "",
        ]);
      }
      if (args?.workflow !== undefined) {
        return joinParts([accent("workflow"), dim(args.label || args.task), asyncFlag(args, theme)]);
      }
      if (typeof args?.agent === "string" && args.agent.trim()) {
        return joinParts([
          accent(args.agent),
          dim(args.label || args.task),
          typeof args.model === "string" && args.model.trim() ? dim(`@${collapseWhitespace(args.model)}`) : "",
          asyncFlag(args, theme),
        ]);
      }
      return accent(firstStringArg(args));
    }
    case "subagent_launch":
      return joinParts([
        accent(args?.agent || args?.key || args?.workflowRunId),
        dim(args?.task),
        asyncFlag(args, theme),
      ]);
    case "bg_wait":
      return joinParts([
        accent(args?.id || (args?.all ? "all" : "any")),
        args?.nonBlocking === true ? dim("non-blocking") : "",
      ]);
    default:
      return accent(firstStringArg(args));
  }
}

/** `details.results` 非空而正文为空时的简明结果文本（展开态使用） */
export function formatResultsText(results: unknown[]): string {
  return results.map((entry: any, index: number) => {
    const head = joinParts([
      `[${index + 1}]`,
      collapseWhitespace(entry?.agent ?? entry?.name ?? entry?.key),
      typeof entry?.status === "string" ? `(${entry.status})` : "",
    ]);
    const body = typeof entry?.text === "string"
      ? entry.text
      : typeof entry?.output === "string" ? entry.output : typeof entry?.error === "string" ? entry.error : "";
    return body.trim() ? `${head}\n${body.trim().split("\n").map((line) => `    ${line}`).join("\n")}` : head;
  }).join("\n");
}

function isFailedEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.isError === true || entry.ok === false) return true;
  return typeof entry.status === "string" && FAILED_STATUSES.has(entry.status);
}

function isDoneEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (isFailedEntry(entry)) return true;
  if (entry.ok === true || entry.done === true) return true;
  return typeof entry.status === "string" && DONE_STATUSES.has(entry.status);
}

/** 折叠态摘要：loading 优先步骤进度，成功态按异步启动 / 多结果 / 文本行数归纳 */
export function resultSummary(details: any, text: string, status: CompactRenderStatus): string {
  const currentStepIndex = details?.currentStepIndex;
  const totalSteps = details?.totalSteps;
  if (status === "loading") {
    if (typeof currentStepIndex === "number" && typeof totalSteps === "number") {
      return `step ${currentStepIndex + 1}/${totalSteps}`;
    }
    const progress = Array.isArray(details?.progress) ? details.progress : [];
    return progress.length ? `running ${progress.filter(isDoneEntry).length}/${progress.length}` : "";
  }
  if (details?.mode === "async" || details?.async === true) {
    const id = typeof details.id === "string" && details.id ? details.id : typeof details.runId === "string" ? details.runId : "";
    return id ? `launched #${id}` : "launched";
  }
  const results = Array.isArray(details?.results) ? details.results : [];
  if (results.length > 1) {
    const ok = results.filter((entry: any) => !isFailedEntry(entry)).length;
    return `${ok}/${results.length} done`;
  }
  const lines = nonEmptyLineCount(text);
  return lines ? `${lines} lines` : "done";
}

function summarySuffix(theme: any, context: any): string {
  const summary = context?.expanded ? undefined : context?.state?.[SUMMARY_KEY];
  return summary ? theme.fg("dim", ` · ${summary}`) : "";
}

function setStatus(context: any, status: CompactRenderStatus): void {
  setRenderStatus(context, status, STATUS_KEY);
  if (!context?.state) return;
  if (status !== "success") delete context.state[SUMMARY_KEY];
}

export interface SubagentsRendererDependencies {
  Text: any;
  visibleWidth: (text: string) => number;
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
}

export function createSubagentsRenderer({ Text, visibleWidth, truncateToWidth }: SubagentsRendererDependencies): ToolRendererResolver {
  const owned = new Set<string>(SUBAGENT_TOOL_NAMES);

  const singleLine = (name: string, args: any, theme: any, context: any): Component => {
    const body = title(name, callDetail(name, args, theme), theme);
    return {
      render(width: number) {
        const status = context?.state?.[STATUS_KEY] as CompactRenderStatus | undefined;
        syncStatusAnimation(context, status);
        const glyph = statusGlyph(theme, status);
        const summary = summarySuffix(theme, context);
        const budget = Math.max(0, width - visibleWidth(glyph) - 1 - visibleWidth(summary));
        return [`${glyph} ${truncateToWidth(body, budget, "…")}${summary}`];
      },
      invalidate() {},
    };
  };

  const renderResult = (result: any, options: any, theme: any, context: any) => {
    const text = textOutput(result);
    const details = result?.details;
    const failed = context?.isError === true || result?.isError === true;
    const partial = options?.isPartial === true;
    const status = resultStatus(result, options, context);
    setStatus(context, status);
    if (context?.state) delete context.state[SUMMARY_KEY];

    if (options?.expanded) {
      const fullText = fullResultText(result)
        || (Array.isArray(details?.results) && details.results.length ? formatResultsText(details.results) : "");
      if (fullText) return createExpandedToolText(Text, theme.fg(failed ? "error" : "toolOutput", fullText));
      return new Text(theme.fg("dim", `  └ ${failed ? "失败" : "done"}`), 1, 0);
    }

    if (failed) return failedResultLine({ truncateToWidth, text, theme });

    if (context?.state) {
      const summary = resultSummary(details, text, partial ? "loading" : "success");
      if (summary) context.state[SUMMARY_KEY] = summary;
    }
    return new Text("", 0, 0);
  };

  return (name, next) => {
    if (!owned.has(name)) return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        return singleLine(name, args, theme, context);
      },
      renderResult,
    };
  };
}
