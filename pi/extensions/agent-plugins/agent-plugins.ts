/**
 * Agent Plugins 客户端入口：只做 Host 绑定、依赖注入与资源注册。
 *
 * 发现与校验在 `manifest.ts`，`mcp.json` 解析在 `mcp-config.ts`。
 * MCP server 通过 `pi.registerMcpServer()` 在内存注册，不写任何投影文件；
 * 技能通过 `resources_discover` 提供给 Host。插件按机器安装在
 * `~/.agents/plugins/<plugin>/`（可用 `AGENT_PLUGINS_HOME` 覆盖），不入库。
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Diagnostic } from "./diagnostics.ts";
import { discoverPlugins } from "./manifest.ts";

export default async function agentPlugins(pi: ExtensionAPI): Promise<void> {
	const pluginsHome = resolve(process.env.AGENT_PLUGINS_HOME ?? join(homedir(), ".agents", "plugins"));
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const { plugins, diagnostics } = await discoverPlugins(pluginsHome, agentDir);

	for (const plugin of plugins) {
		if (plugin.servers.length === 0) continue;
		// 规范 §9.1：PLUGIN_DATA 必须跨更新存活，放在插件包之外的 Host 配置根下。
		await mkdir(join(agentDir, "plugin-data", plugin.name), { recursive: true }).catch((error: Error) => {
			diagnostics.push({ severity: "warning", message: `无法创建 PLUGIN_DATA: ${error.message}` });
		});
	}

	for (const server of plugins.flatMap((plugin) => plugin.servers)) {
		try {
			pi.registerMcpServer(server.name, server.config);
		} catch (error) {
			diagnostics.push({ severity: "error", message: `注册 MCP server ${server.name} 失败: ${(error as Error).message}` });
		}
	}

	const skillPaths = plugins.flatMap((plugin) => plugin.skills);
	if (skillPaths.length > 0) {
		pi.on("resources_discover", () => ({ skillPaths }));
	}

	const errors: Diagnostic[] = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length === 0) return;
	pi.on("session_start", (_event, ctx) => {
		const detail = errors.slice(0, 3).map((item) => item.message).join("；");
		const summary = `Agent Plugins: ${errors.length} 个问题。${detail}`;
		// §11.3 SHOULD report：UI 走通知，headless/RPC 走 stderr，避免静默失败。
		if (ctx.hasUI) ctx.ui.notify(summary, "warning");
		else process.stderr.write(`${summary}\n`);
	});
}
