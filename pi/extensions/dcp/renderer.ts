import { MouseRegion, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { failedResultLine, resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "../compact-tools/index.ts";

export function createDcpRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "compress") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args, theme, context) {
        const callArgs = args as { topic?: unknown } | undefined;
        const topic = typeof callArgs?.topic === "string" ? callArgs.topic : "";
        const body = topic ? `compress ${theme.fg("accent", topic)}` : "compress";
        const call: Component = {
          render(width) {
            const status = context?.state?.status as CompactRenderStatus | undefined;
            syncStatusAnimation(context, status);
            const glyph = statusGlyph(theme, status);
            const budget = Math.max(0, width - visibleWidth(glyph) - 1);
            return [`${glyph} ${truncateToWidth(body, budget, "…")}`];
          },
          invalidate() {},
        };
        return new MouseRegion(call, (event) => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          return (context?.state?.status as CompactRenderStatus | undefined) === "failure" ? undefined : { handled: true };
        });
      },
      renderResult(result, options, theme, context) {
        const status = resultStatus(result, options, context);
        setRenderStatus(context, status);
        if (status !== "failure") return swallowExpandClick(new Text("", 0, 0));
        const text = contentText(result);
        if (!options.expanded) return failedResultLine({ truncateToWidth, text, theme });
        return new Text(text ? theme.fg("error", text) : theme.fg("dim", "压缩失败"), 0, 0);
      },
    };
  };
}

function contentText(result: any): string {
  return Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n")
    : String(result?.content ?? "");
}

function swallowExpandClick(component: Component): MouseRegion {
  return new MouseRegion(component, (event) => (event.type === "click" && event.button === "left" ? { handled: true } : undefined));
}
