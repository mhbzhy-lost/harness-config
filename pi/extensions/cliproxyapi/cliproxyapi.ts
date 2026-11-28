// cliproxyapi 懒加载入口：只做 Host API 绑定与默认参数解析，探测/拉起逻辑全部位于同目录 controller.ts。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCliproxyapiExtension, resolveCliproxyapiOptions } from "./controller.ts";

export default function cliproxyapi(pi: ExtensionAPI): void {
  createCliproxyapiExtension(pi, resolveCliproxyapiOptions(process.env, import.meta.url));
}
