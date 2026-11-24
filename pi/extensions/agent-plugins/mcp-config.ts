/**
 * 插件 `mcp.json` 解析与校验（规范 §7.2.1、§9）。
 *
 * 失败边界：
 * - 顶层不合法（JSON 错误、`$schema` 不符、多余顶层字段、缺 `mcpServers`、文件逃逸插件根）
 *   → 禁用该插件的全部 MCP；
 * - 单个 server 不合法（变体字段、命令/cwd containment、保留环境变量名、URL/headers 规则）
 *   → 只跳过该条目；
 * - 声明了不支持的传输（`sse`）→ 跳过并报告。
 * 技能发现不受上述任一失败影响。
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { errorOf, isRecord } from "./diagnostics.ts";
import { expandPlaceholders, isContained, type PluginVariables } from "./paths.ts";
import type { Diagnostic } from "./diagnostics.ts";
import type { DiscoveredServer, ServerConfig } from "./types.ts";

export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["type", "url", "headers"]);
const RESERVED_ENV = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

interface ParsedServer {
	config?: ServerConfig;
	problem?: string;
}

function expand(value: string, variables: PluginVariables): string {
	return expandPlaceholders(value, variables);
}

/** §7.2.1：非同环回端点必须 HTTPS；loopback 允许 HTTP。 */
function isLoopback(hostname: string): boolean {
	const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (host === "localhost" || host === "::1") return true;
	if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false;
	return host.split(".").every((part) => Number(part) <= 255);
}

/** Windows 环境名大小写不敏感，其余平台精确匹配。 */
function withReservedEnv(
	env: Record<string, string> | undefined,
	variables: PluginVariables,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (process.platform === "win32" && RESERVED_ENV.has(key.toUpperCase())) continue;
		result[key] = value;
	}
	// §9.1：客户端提供的保留变量最后写入，替换同义名。
	result.PLUGIN_ROOT = variables.root;
	result.PLUGIN_DATA = variables.data;
	return result;
}

async function parseStdio(entry: Record<string, unknown>, variables: PluginVariables): Promise<ParsedServer> {
	for (const key of Object.keys(entry)) {
		if (!STDIO_FIELDS.has(key)) return { problem: `stdio server 含未知字段 ${key}` };
	}
	const rawCommand = entry.command;
	if (typeof rawCommand !== "string" || rawCommand.length === 0) return { problem: "command 必须是非空字符串" };
	let command = rawCommand;
	if (rawCommand.startsWith("./")) {
		command = resolve(variables.root, rawCommand);
		// §4.1：插件相对命令必须留在插件根内。
		if (!(await isContained(variables.root, command))) return { problem: `command 解析到插件根之外: ${rawCommand}` };
	} else if (/[\\/]/.test(rawCommand)) {
		return { problem: `command 必须是裸命令名或以 ./ 开头的插件内路径: ${rawCommand}` };
	}
	// §7.2.1：command 不做占位符展开。
	if (command.includes("${PLUGIN_ROOT}") || command.includes("${PLUGIN_DATA}")) {
		return { problem: "command 不支持占位符展开" };
	}

	const args = entry.args;
	if (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== "string"))) {
		return { problem: "args 必须是字符串数组" };
	}
	const env = entry.env;
	if (env !== undefined && (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string"))) {
		return { problem: "env 必须是字符串映射" };
	}
	if (isRecord(env)) {
		// §9.2：插件不得占用客户端保留变量名。
		for (const key of Object.keys(env)) {
			const normalized = process.platform === "win32" ? key.toUpperCase() : key;
			if (RESERVED_ENV.has(normalized)) return { problem: `env 不得声明保留变量 ${key}` };
		}
	}

	const cwd = entry.cwd;
	if (cwd !== undefined && typeof cwd !== "string") return { problem: "cwd 必须是字符串" };
	let resolvedCwd = variables.root;
	if (typeof cwd === "string") {
		const isDataRooted = cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/");
		const isRootRooted = cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/");
		if (!cwd.startsWith("./") && !isRootRooted && !isDataRooted) {
			return { problem: `cwd 必须是 ./、\${PLUGIN_ROOT} 或 \${PLUGIN_DATA} 开头: ${cwd}` };
		}
		resolvedCwd = expand(cwd, variables);
		// §7.2.1：展开后仍需落在插件根或 PLUGIN_DATA 内。
		const boundary = isDataRooted ? variables.data : variables.root;
		if (!(await isContained(boundary, resolvedCwd))) return { problem: `cwd 展开后越界: ${cwd}` };
	}

	return {
		config: {
			command,
			...(Array.isArray(args) ? { args: args.map((value) => expand(value as string, variables)) } : {}),
			env: withReservedEnv(
				isRecord(env)
					? (Object.fromEntries(
							Object.entries(env).map(([key, value]) => [key, expand(value as string, variables)]),
						) as Record<string, string>)
					: undefined,
				variables,
			),
			cwd: resolvedCwd,
		} as ServerConfig,
	};
}

function parseHttp(entry: Record<string, unknown>): ParsedServer {
	for (const key of Object.keys(entry)) {
		if (!HTTP_FIELDS.has(key)) return { problem: `http server 含未知字段 ${key}` };
	}
	if (typeof entry.url !== "string") return { problem: "url 必须是字符串" };
	let parsed: URL;
	try {
		parsed = new URL(entry.url);
	} catch {
		return { problem: `url 不是绝对地址: ${entry.url}` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { problem: `url 只支持 http/https: ${entry.url}` };
	}
	if (parsed.username || parsed.password) return { problem: "url 不得包含用户信息" };
	if (parsed.hash) return { problem: "url 不得包含 fragment" };
	if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
		return { problem: `非同环回端点必须使用 https: ${entry.url}` };
	}
	// §7.2.1：url 与 headers 不做占位符/环境变量展开。
	if (/\$\{[^}]+\}/.test(entry.url)) return { problem: "url 不得包含占位符" };

	const headers = entry.headers;
	if (headers !== undefined) {
		if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string")) {
			return { problem: "headers 必须是字符串映射" };
		}
		const seen = new Set<string>();
		for (const [name, value] of Object.entries(headers)) {
			if (!HEADER_NAME.test(name)) return { problem: `header 名不合法: ${name}` };
			if (!HEADER_VALUE.test(value as string)) return { problem: `header 值含非法字符: ${name}` };
			const lowered = name.toLowerCase();
			if (seen.has(lowered)) return { problem: `header 名重复（大小写不敏感）: ${name}` };
			seen.add(lowered);
		}
	}
	return {
		config: {
			url: entry.url,
			...(isRecord(headers) ? { headers: headers as Record<string, string> } : {}),
		} as ServerConfig,
	};
}

/**
 * 读取插件根 `mcp.json`，返回可注册的 server 列表。
 * 规范要求 MCP 配置只来自根 `mcp.json`，不接受 `plugin.json` 内联或其它路径。
 */
export async function collectServers(
	plugin: { name: string; root: string; description?: string },
	variables: PluginVariables,
	diagnostics: Diagnostic[],
): Promise<DiscoveredServer[]> {
	const mcpPath = join(plugin.root, "mcp.json");
	const metadata = await stat(mcpPath).catch(() => undefined);
	if (!metadata) return [];
	if (!metadata.isFile()) {
		diagnostics.push(errorOf("mcp.json 必须是常规文件，已禁用该插件的 MCP", mcpPath));
		return [];
	}
	if (!(await isContained(plugin.root, mcpPath))) {
		diagnostics.push(errorOf("mcp.json 解析到插件根之外，已禁用该插件的 MCP", mcpPath));
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(mcpPath, "utf8"));
	} catch (error) {
		diagnostics.push(errorOf(`mcp.json 无法解析（${(error as Error).message}），已禁用该插件的 MCP`, mcpPath));
		return [];
	}
	if (!isRecord(parsed)) {
		diagnostics.push(errorOf("mcp.json 顶层必须是对象", mcpPath));
		return [];
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "$schema" && key !== "mcpServers") {
			diagnostics.push(errorOf(`mcp.json 含未知顶层字段 ${key}，已禁用该插件的 MCP`, mcpPath));
			return [];
		}
	}
	if (parsed.$schema !== MCP_SCHEMA) {
		diagnostics.push(errorOf(`mcp.json 的 $schema 不是 ${MCP_SCHEMA}，已禁用该插件的 MCP`, mcpPath));
		return [];
	}
	if (!isRecord(parsed.mcpServers)) {
		diagnostics.push(errorOf("mcp.json 缺少 mcpServers 对象", mcpPath));
		return [];
	}

	const servers: DiscoveredServer[] = [];
	const usedNames = new Set<string>();
	for (const [serverName, entry] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(entry)) {
			diagnostics.push(errorOf(`server ${serverName} 配置必须是对象`, mcpPath));
			continue;
		}
		if (entry.type === "sse") {
			// §7.2.2：声明了不支持的传输 → 跳过并报告，不影响其它条目。
			diagnostics.push(errorOf(`server ${serverName} 的 sse 传输不受支持，已跳过`, mcpPath));
			continue;
		}
		const parsedServer =
			entry.type === "stdio"
				? await parseStdio(entry, variables)
				: entry.type === "streamable-http"
					? parseHttp(entry)
					: undefined;
		if (!parsedServer) {
			diagnostics.push(errorOf(`server ${serverName} 的 type 不受支持: ${String(entry.type)}`, mcpPath));
			continue;
		}
		if (!parsedServer.config) {
			diagnostics.push(errorOf(`server ${serverName}: ${parsedServer.problem}`, mcpPath));
			continue;
		}
		// pi 只接受字母数字与 _-；规范不约束 server 名，因此做可注入映射而不是拒绝。
		const base = `${plugin.name}__${serverName}`.replace(/[^A-Za-z0-9_-]/g, "_");
		let qualified = base;
		for (let suffix = 2; usedNames.has(qualified); suffix += 1) qualified = `${base}_${suffix}`;
		usedNames.add(qualified);
		servers.push({
			name: PI_SERVER_NAME.test(qualified) ? qualified : `plugin_${servers.length}`,
			config: { ...parsedServer.config, ...(plugin.description ? { description: plugin.description } : {}) },
		});
	}
	return servers;
}
