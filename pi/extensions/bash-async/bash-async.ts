import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { getDefaultBashOptions } from "../bash-cwd/bash-cwd.ts";
import { createBashAsyncCompleteRenderer, createBashAsyncExtension } from "./index.ts";

export default function bashAsync(pi: ExtensionAPI) {
  createBashAsyncExtension(pi, {
    workspaceRoot: process.cwd(),
    createBashToolDefinition,
    getBashOptions: getDefaultBashOptions,
  });
  pi.registerMessageRenderer("bash-async-complete", createBashAsyncCompleteRenderer({ Text, truncateToWidth }));
}
