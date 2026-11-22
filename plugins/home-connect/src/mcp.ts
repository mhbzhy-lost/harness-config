/**
 * MCP stdio 启动器：JSON-RPC over newline-delimited stdin/stdout。
 * home 与 comfyui 两个 server 入口共用；工具定义与分发由各工具模块提供。
 */

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export function textResult(payload: unknown, isError = false) {
	return {
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
		isError,
	};
}

export function failure(message: string) {
	return textResult({ error: message }, true);
}

export interface ServerOptions {
	name: string;
	version?: string;
	tools: ToolDefinition[];
	instructions: string;
	callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function startServer(opts: ServerOptions): void {
	async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
		const method = message.method ?? "";
		if (message.id === undefined) return null;
		if (method === "initialize") {
			const params = message.params as { protocolVersion?: string } | undefined;
			return {
				protocolVersion: params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: opts.name, version: opts.version ?? "0.1.0" },
				instructions: opts.instructions,
			};
		}
		if (method === "ping") return {};
		if (method === "tools/list") return { tools: opts.tools };
		if (method === "tools/call") {
			const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
			if (!params?.name) return { content: [{ type: "text", text: "缺少工具名" }], isError: true };
			return opts.callTool(params.name, params.arguments ?? {});
		}
		if (method === "resources/list") return { resources: [] };
		if (method === "prompts/list") return { prompts: [] };
		throw Object.assign(new Error(`未知方法: ${method}`), { code: -32601 });
	}

	function send(payload: unknown): void {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	}

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line) continue;
			let message: { id?: unknown; method?: string; params?: unknown };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			handleRequest(message)
				.then((result) => {
					if (result !== null) send({ jsonrpc: "2.0", id: message.id, result });
				})
				.catch((error: Error & { code?: number }) => {
					if (message.id === undefined) return;
					send({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } });
				});
		}
	});
	process.stdin.on("end", () => process.exit(0));
}
