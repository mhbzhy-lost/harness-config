/**
 * 远程 MCP server（Streamable HTTP）入口：跑在家中的 mac 上（HOME_CONNECT_HOST=mac），
 * 给没有 bash 环境、也不该持有 ssh 凭据的客户端（手机端 agent）当入口。
 *
 * 工具定义与连接层直接复用 stdio 版的同一份模块——home 与 comfyui 仍是两个独立 server，
 * 只是挂在同一监听的两条路径上（/home、/comfyui）。配置见 host.json（部署目录内，不入库）。
 */

import { createHash, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_ROOT } from "./connection.ts";
import { failure, type ToolDefinition } from "./mcp.ts";
import { COMFYUI_TOOLS, callComfyuiTool, comfyuiInstructions } from "./tools-comfyui.ts";
import { HOME_INSTRUCTIONS, HOME_TOOLS, callHomeTool } from "./tools-home.ts";

interface HostConfig {
	bind: string;
	port: number;
	apiKey: string;
	/** 中继路：TLS 在本机终结，中继（frp）只转发密文；省略则只开局域网的明文监听。ca 用于 GET /ca.crt 公开下发（证书是公开信息）。 */
	tls?: { port: number; cert: string; key: string; ca?: string };
	lanUrl: string;
	relayUrl?: string;
	auditPath: string;
	/** 生图结果内联为 image 内容块的单张上限（字节）。 */
	maxImageBytes?: number;
}

type Access = "lan" | "relay";
type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean };
interface ToolGroup {
	path: string;
	name: string;
	tools: ToolDefinition[];
	instructions: string;
	call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const configPath = process.env.HOME_CONNECT_HOST_CONFIG ?? resolve(PLUGIN_ROOT, "host.json");
const cfg = JSON.parse(readFileSync(configPath, "utf8")) as HostConfig;
for (const key of ["apiKey", "auditPath", "lanUrl"] as const) {
	if (typeof cfg[key] !== "string" || !cfg[key]) throw new Error(`host.json 缺少 ${key}`);
}
const MAX_IMAGE_BYTES = cfg.maxImageBytes ?? 8 * 1024 * 1024;
const AUDIT_PATH = cfg.auditPath.startsWith("~/") ? resolve(homedir(), cfg.auditPath.slice(2)) : cfg.auditPath;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 64;
const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const GROUPS: ToolGroup[] = [
	{ path: "/home", name: "home-connect", tools: HOME_TOOLS, instructions: HOME_INSTRUCTIONS, call: callHomeTool },
	{ path: "/comfyui", name: "comfyui", tools: COMFYUI_TOOLS, instructions: comfyuiInstructions(), call: callComfyuiTool },
];

function audit(entry: Record<string, unknown>): void {
	try {
		appendFileSync(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch { /* 审计写失败不影响工具结果 */ }
}

function parseJsonResult(result: ToolResult): Record<string, unknown> | undefined {
	const text = result.content[0]?.text;
	if (result.content.length !== 1 || typeof text !== "string") return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** 生图结果内联图片：远端客户端读不到 mac 上的 localPath，直接作为 image 内容块返回。 */
function withImages(result: ToolResult): ToolResult {
	const payload = parseJsonResult(result);
	if (!payload || !Array.isArray(payload.outputs)) return result;
	const content = [...result.content];
	for (const output of payload.outputs as Array<Record<string, unknown>>) {
		const localPath = output.localPath;
		if (typeof localPath !== "string") continue;
		const mime = MIME_BY_EXT[localPath.slice(localPath.lastIndexOf(".")).toLowerCase()];
		if (!mime) continue;
		try {
			if (statSync(localPath).size > MAX_IMAGE_BYTES) {
				output.inline = false;
				output.inlineNote = `超过内联上限 ${MAX_IMAGE_BYTES} 字节，未随结果返回`;
				continue;
			}
			content.push({ type: "image", data: readFileSync(localPath).toString("base64"), mimeType: mime });
			output.inline = true;
		} catch {
			output.inline = false;
		}
	}
	content[0] = { type: "text", text: JSON.stringify(payload, null, 2) };
	return { content, isError: result.isError };
}

/** home_status 附上两条接入地址与本次请求走的那条。 */
function withAccess(result: ToolResult, access: Access): ToolResult {
	const payload = parseJsonResult(result);
	if (!payload) return result;
	return { content: [{ type: "text", text: JSON.stringify({ ...payload, access: { via: access, lan: cfg.lanUrl, relay: cfg.relayUrl ?? null } }, null, 2) }], isError: result.isError };
}

interface Session { server: McpServer; transport: StreamableHTTPServerTransport; at: number }
const sessions = new Map<string, Session>();

function createSession(group: ToolGroup, access: Access, onId: (id: string) => void): Session {
	const server = new McpServer({ name: group.name, version: "2.0.0" }, { capabilities: { tools: {} }, instructions: group.instructions });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: group.tools }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		const started = Date.now();
		let result: ToolResult;
		try {
			result = (await group.call(name, request.params.arguments ?? {})) as ToolResult;
		} catch (error) {
			result = failure(`${name} 异常: ${(error as Error).message}`);
		}
		if (group.path === "/comfyui" && name === "comfyui_generate") result = withImages(result);
		if (group.path === "/home" && name === "home_status") result = withAccess(result, access);
		const text = String(result.content[0]?.text ?? "");
		audit({
			access,
			server: group.path,
			tool: name,
			result: result.isError ? "error" : "ok",
			...(!result.isError && group.path !== "/comfyui" ? { exitCode: exitCodeOf(text) } : {}),
			durationMs: Date.now() - started,
			outputBytes: Buffer.byteLength(text),
			sha: createHash("sha256").update(JSON.stringify(request.params.arguments ?? {})).digest("hex").slice(0, 16),
		});
		return result;
	});
	const transport = new StreamableHTTPServerTransport({
		stateless: false,
		enableJsonResponse: true,
		sessionIdGenerator: () => {
			const id = randomUUID();
			onId(id);
			return id;
		},
		onsessionclosed: (id) => { sessions.delete(id); },
	});
	void server.connect(transport);
	return { server, transport, at: Date.now() };
}

function exitCodeOf(text: string): number | undefined {
	try {
		const code = (JSON.parse(text) as { exitCode?: unknown }).exitCode;
		return typeof code === "number" ? code : undefined;
	} catch {
		return undefined;
	}
}

function groupFor(pathname: string): ToolGroup | undefined {
	return GROUPS.find((group) => pathname === group.path || pathname === `${group.path}/mcp`);
}

function authorized(req: IncomingMessage): boolean {
	const given = req.headers.authorization ?? "";
	const expected = `Bearer ${cfg.apiKey}`;
	return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, access: Access): Promise<void> {
	const pathname = (req.url ?? "/").split("?")[0];
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version",
			"Access-Control-Expose-Headers": "Mcp-Session-Id",
		});
		res.end();
		return;
	}
	if (pathname === "/healthz") { json(res, 200, { status: "ok", access }); return; }
	// CA 证书公开下发（不需要 token）：手机浏览器打开即下载，安装为用户 CA 后才信任中继路的 TLS。
	if (req.method === "GET" && pathname === "/ca.crt") {
		if (!caPem) { json(res, 404, { error: "no_ca" }); return; }
		res.writeHead(200, {
			"Content-Type": "application/x-pem-file",
			"Content-Disposition": "attachment; filename=\"home-connect-host-ca.crt\"",
			"Cache-Control": "no-store",
		});
		res.end(caPem);
		return;
	}
	if (!authorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
	if (req.method === "GET" && pathname === "/") {
		json(res, 200, {
			status: "ok",
			access: { via: access, lan: cfg.lanUrl, relay: cfg.relayUrl ?? null },
			servers: Object.fromEntries(GROUPS.map((group) => [group.path, group.tools.map((tool) => tool.name)])),
		});
		return;
	}
	const group = groupFor(pathname);
	if (!group) { json(res, 404, { error: "unknown_path" }); return; }
	if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) { json(res, 413, { error: "payload_too_large" }); return; }
	const id = req.headers["mcp-session-id"];
	try {
		let session: Session | undefined;
		if (typeof id === "string" && id) {
			session = sessions.get(id);
			if (!session) { json(res, 404, { error: "unknown_session" }); return; }
		} else {
			if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return; }
			if (sessions.size >= MAX_SESSIONS) {
				const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
				if (oldest) sessions.delete(oldest);
			}
			session = createSession(group, access, (newId) => sessions.set(newId, session as Session));
		}
		await session.transport.handleRequest(req, res);
	} catch (error) {
		if (!res.headersSent) json(res, 500, { error: (error as Error).message });
		else res.end();
	}
}

let httpServer: Server | undefined;
let httpsServer: Server | undefined;
let caPem: string | undefined;
if (cfg.tls) {
	if (cfg.tls.ca && existsSync(resolvePath(cfg.tls.ca))) caPem = readFileSync(resolvePath(cfg.tls.ca), "utf8");
	httpsServer = createHttpsServer({ cert: readFileSync(resolvePath(cfg.tls.cert)), key: readFileSync(resolvePath(cfg.tls.key)) }, (req, res) => {
		void handle(req, res, "relay");
	});
	httpsServer.listen(cfg.tls.port, "127.0.0.1", () => console.log(`home-connect 远程入口(中继路, TLS) 127.0.0.1:${cfg.tls.port}`));
	if (cfg.tls.ca && caPem) console.log(`CA 证书可下发：GET /ca.crt（SHA256 ${caFingerprint(caPem)}）`);
}
httpServer = createHttpServer((req, res) => {
	void handle(req, res, "lan");
});
httpServer.listen(cfg.port, cfg.bind, () => console.log(`home-connect 远程入口(局域网路) ${cfg.bind}:${cfg.port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		httpServer?.close();
		httpsServer?.close();
		process.exit(0);
	});
}

function resolvePath(path: string): string {
	if (path.startsWith("/")) return path;
	return resolve(PLUGIN_ROOT, path);
}

function caFingerprint(pem: string): string {
	return new X509Certificate(pem).fingerprint256;
}
