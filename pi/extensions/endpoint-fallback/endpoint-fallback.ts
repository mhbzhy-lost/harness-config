import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEndpointFallbackExtension } from "./index.ts";

export default function endpointFallback(pi: ExtensionAPI) {
	createEndpointFallbackExtension(pi, {
		modelsPath: () => join(getAgentDir(), "models.json"),
	});
}
