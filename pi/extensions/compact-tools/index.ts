import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createCompactFallbackRenderers, createCompactToolRenderers } from "./renderer.ts";

export { createCompactFallbackRenderers, createCompactToolRenderers, failedResultLine, installCompactSkillRenderer } from "./renderer.ts";
export { COMPACT_STATUS_KEY, resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "./status.ts";
export { createExpandedToolText } from "./expanded-content.ts";

type Dependencies = Parameters<typeof createCompactToolRenderers>[0];

export function createCompactToolRendererResolver(dependencies: Dependencies): ToolRendererResolver {
  const nativeEditRenderers: { current?: ToolRenderers } = {};
  const renderers = createCompactToolRenderers({ ...dependencies, nativeEditRenderers });
  const owned = new Map<string, ToolRenderers>(Object.entries(renderers));
  const fallbackRenderers = createCompactFallbackRenderers(dependencies);
  return (name, next) => {
    const mine = owned.get(name);
    const base = next();
    if (mine) {
      if (name === "edit") nativeEditRenderers.current = base;
      return { ...(base ?? {}), ...mine };
    }
    if (!base) return { renderShell: "self", ...fallbackRenderers(name) };
    const hasCall = typeof base.renderCall === "function";
    const hasResult = typeof base.renderResult === "function";
    if (hasCall && hasResult) return base;
    const patch = fallbackRenderers(name);
    if (hasCall) return { ...base, renderResult: patch.renderResult };
    return {
      ...base,
      renderShell: "self",
      renderCall: patch.renderCall,
      renderResult: hasResult ? base.renderResult : patch.renderResult,
    };
  };
}
