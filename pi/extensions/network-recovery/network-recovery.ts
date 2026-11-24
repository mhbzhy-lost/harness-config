// 断网兜底入口：只做 Host API 绑定，状态机、探活与配置解析全部位于同目录。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNetworkRecoveryExtension } from "./index.ts";

export default function networkRecovery(pi: ExtensionAPI): void {
  const isChildProcess =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
  if (isChildProcess) return;
  createNetworkRecoveryExtension(pi);
}
