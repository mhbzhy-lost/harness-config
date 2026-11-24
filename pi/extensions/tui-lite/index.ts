import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { BASH_ASYNC_FOOTER_EVENT, type BashAsyncFooterSnapshot } from "../bash-async/index.ts";

function stateLabel(state: string | undefined): string {
  return ({ running: "运行中", complete: "已完成", failed: "失败", stopped: "已停止" } as Record<string, string>)[state ?? ""] ?? state ?? "未知";
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function displayCwd(cwd: string): string {
  const home = homedir();
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function footerLine(left: string, right: string, width: number): string {
  const rightText = truncateToWidth(right, Math.max(0, width), "…");
  const leftBudget = Math.max(0, width - visibleWidth(rightText) - (rightText ? 1 : 0));
  const leftText = truncateToWidth(left, leftBudget, "…");
  const line = rightText && leftText
    ? `${leftText}${" ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)))}${rightText}`
    : truncateToWidth(leftText || rightText, Math.max(0, width), "…");
  return truncateToWidth(line, Math.max(0, width), "…");
}

/**
 * 极简主会话 footer：首行左对齐 cwd，右对齐 provider/model thinking context/contextWindow；
 * 下方列出当前活跃的 bash_async 后台任务。不依赖 pi-subagents。
 */
export function createTuiRuntime(pi: ExtensionAPI): void {
  let bashAsyncTasks: BashAsyncFooterSnapshot["tasks"] = [];
  let footerRequestRender: (() => void) | undefined;
  let unsubscribeBashAsync: (() => void) | undefined;

  const cleanup = () => {
    unsubscribeBashAsync?.();
    unsubscribeBashAsync = undefined;
    footerRequestRender = undefined;
    bashAsyncTasks = [];
  };

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui") return;
    unsubscribeBashAsync = pi.events?.on?.(BASH_ASYNC_FOOTER_EVENT, (value) => {
      const snapshot = value as BashAsyncFooterSnapshot;
      bashAsyncTasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      footerRequestRender?.();
    });
    ctx.ui.setFooter((tui, theme) => {
      footerRequestRender = () => tui.requestRender();
      return {
        render(width: number) {
          const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
          const usage = ctx.getContextUsage();
          const context = `${formatTokens(usage?.tokens)}/${formatTokens(usage?.contextWindow)}`;
          const right = `${model} ${ctx.thinkingLevel ?? "off"} ${context}`;
          const first = footerLine(displayCwd(ctx.cwd), right, width);
          const bash = bashAsyncTasks.map((task) =>
            `bash_async "${task.command.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()}" · ${stateLabel(task.state)}`,
          );
          return [theme.fg("dim", first), "", ...bash.map((task) => truncateToWidth(task, Math.max(0, width), "…"))];
        },
        invalidate() { tui.requestRender(); },
        dispose() { cleanup(); },
      };
    });
  });

  pi.on("session_shutdown", () => { cleanup(); });
}
