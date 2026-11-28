import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentsRenderer } from "./renderer.ts";

/** pi-subagents 工具的交互式渲染器：单行标题 + 状态 glyph + 折叠摘要，与 compact-tools 规范一致 */
export default function subagents(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createSubagentsRenderer({ Text, visibleWidth, truncateToWidth }));
}
