import { SkillInvocationMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCompactToolRendererResolver, installCompactSkillRenderer } from "./index.ts";

export default function compactTools(pi: ExtensionAPI) {
  pi.registerToolRenderer(createCompactToolRendererResolver({
    Text,
    Container,
    visibleWidth,
    sliceByColumn,
    truncateToWidth,
  }));
  pi.on("session_start", (_event, ctx) => {
    installCompactSkillRenderer({ SkillInvocationMessageComponent, Text, Markdown, theme: ctx.ui.theme });
  });
}
