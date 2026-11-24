/** Agent Plugins 客户端的共享类型。 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Diagnostic } from "./diagnostics.ts";

/** MCP server 配置类型直接取自 Host API，避免与 pi 的结构漂移。 */
export type ServerConfig = Parameters<ExtensionAPI["registerMcpServer"]>[1];

export interface DiscoveredServer {
	/** 注册到 pi 的限定名：`<plugin>__<server>`。 */
	name: string;
	config: ServerConfig;
}

export interface DiscoveredPlugin {
	name: string;
	root: string;
	description?: string;
	/** 已校验的 SKILL.md 绝对路径。 */
	skills: string[];
	servers: DiscoveredServer[];
	diagnostics: Diagnostic[];
}
