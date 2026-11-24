import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createOpenAIProxyExtension, loadOpenAIProxyConfig } from "./index.ts";

export default async function openAIProxyExtension(pi: any) {
  const envProxy = process.env.PI_OPENAI_PROXY?.trim();
  const configPath = join(getAgentDir(), "openai-proxy.json");
  const config = envProxy
    ? { proxy: envProxy }
    : loadOpenAIProxyConfig(configPath, { onError: (message) => console.warn(`[pi extension] ${message}`) });
  await createOpenAIProxyExtension(pi, config);
}
