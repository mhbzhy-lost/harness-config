// 宿主模式入口的冒烟：按真实 MCP Streamable HTTP 流程走一遍（initialize → tools/list → tools/call）。
// 用法：node deploy/smoke.mjs <baseUrl> <apiKey> [--with-remote]
//   默认只测本机目标与 comfyui 清单；--with-remote 追加 windows / wsl 两条远程通道。
import { randomUUID } from "node:crypto";

const [baseUrl, apiKey, flag] = process.argv.slice(2);
if (!baseUrl || !apiKey) {
	console.error("用法: node deploy/smoke.mjs <baseUrl> <apiKey> [--with-remote]");
	process.exit(2);
}
const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
let failed = false;

async function rpc(path, method, params, sessionId) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
	});
	return { status: response.status, sessionId: response.headers.get("mcp-session-id"), body: await response.json().catch(() => null) };
}

function check(label, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failed = true;
}

async function session(path) {
	const init = await rpc(path, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
	check(`${path} initialize`, init.status === 200 && !!init.body?.result?.serverInfo, `${init.status} ${init.body?.result?.serverInfo?.name ?? ""}`);
	return init.sessionId;
}

async function listTools(path, sessionId) {
	const listed = await rpc(path, "tools/list", {}, sessionId);
	const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
	check(`${path} tools/list`, names.length > 0, names.join(","));
	return names;
}

async function call(path, sessionId, name, args, verify) {
	const result = await rpc(path, "tools/call", { name, arguments: args }, sessionId);
	const content = result.body?.result?.content ?? [];
	const text = String(content.find((item) => item.type === "text")?.text ?? "");
	const ok = result.status === 200 && !result.body?.result?.isError && verify(text, content);
	check(`${path} ${name}`, ok, ok ? "" : text.slice(0, 300).replace(/\s+/g, " "));
}

const unauthorized = await fetch(`${baseUrl}/`).then((response) => response.status);
check("无 token 返回 401", unauthorized === 401, String(unauthorized));

const home = await session("/home");
if (home) {
	await listTools("/home", home);
	await call("/home", home, "home_exec", { target: "mac", command: "echo smoke-ok-中文; hostname" }, (text) => /smoke-ok-中文/.test(text) && /"exitCode":\s*0/.test(text));
	await call("/home", home, "home_status", {}, (text) => /"access"[\s\S]*"via":\s*"(lan|relay)"/.test(text));
	if (flag === "--with-remote") {
		await call("/home", home, "home_exec", { target: "windows", command: 'Write-Output "WIN_SMOKE_OK"' }, (text) => /WIN_SMOKE_OK/.test(text));
		await call("/home", home, "home_exec", { target: "wsl", command: "echo WSL_SMOKE_OK; uname -r" }, (text) => /WSL_SMOKE_OK/.test(text));
	}
}

const comfy = await session("/comfyui");
if (comfy) {
	await listTools("/comfyui", comfy);
	await call("/comfyui", comfy, "comfyui_list", {}, (text) => /"models"/.test(text));
}

const stray = await fetch(`${baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((response) => response.status);
check("/messages 已下线（404）", stray === 404, String(stray));

console.log(failed ? "SMOKE FAILED" : "SMOKE OK");
process.exit(failed ? 1 : 0);
