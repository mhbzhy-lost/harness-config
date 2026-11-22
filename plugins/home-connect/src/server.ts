/**
 * home-connect MCP server（stdio）。
 *
 * 设计目标：把「家中 Mac / Windows / WSL」的连接自由度收敛成三个动作 ——
 * 选通道（target）、写平台原生命令、读回退出码与输出。SSH/SCP 拼接、通道选择、
 * 引号与 heredoc、ControlMaster、WSL idle 唤醒、输出截断全部在服务端完成，
 * agent 侧不再需要踩坑手册。
 *
 * 脚本随插件分发（scripts/），配置与身份留在运行时目录（默认 `~/.pi/agent/home-connect`）
 * 的 config/ 与 .ssh/，不进本插件包；两边通过 HOME_CONNECT_ROOT 对接。
 */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dirname, "..");
/** 配置/身份根：不随插件代码分发。 */
const RUNTIME_ROOT = resolve(
	process.env.HOME_CONNECT_ROOT ?? resolve(homedir(), ".pi", "agent", "home-connect"),
);
const CONNECT = resolve(PLUGIN_ROOT, "scripts", "connect.sh");

/** 单流输出上限：超出后截断并标注，避免把上下文塞满。 */
const MAX_OUTPUT_CHARS = 60_000;
const CHECK_TIMEOUT_SEC = 45;
const DEFAULT_EXEC_TIMEOUT_SEC = 120;
const WAKE_TIMEOUT_SEC = 120;
const CONNECTION_FAILURE = /connection refused|connection timed out|no route to host|kex_exchange|broken pipe|closed by remote host|operation timed out|network is unreachable/i;
const CM_DIR = `/tmp/home-connect-cm-${process.getuid?.() ?? "unknown"}`;

type Target = "mac" | "windows" | "wsl";

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

function capOutput(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n");
	if (normalized.length <= MAX_OUTPUT_CHARS) return normalized;
	return `${normalized.slice(0, MAX_OUTPUT_CHARS)}\n[输出截断：原始长度 ${normalized.length} 字符]`;
}

/** 读取 `key=value` 形态的检查输出，便于结构化返回。 */
function keyValues(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([a-z0-9_]+)=(.*)$/i);
		if (match) result[match[1]] = match[2];
	}
	return result;
}

const activeChildren = new Set<import("node:child_process").ChildProcess>();
let resetInProgress = false;

function stopChild(child: import("node:child_process").ChildProcess): void {
	if (!child.pid) return;
	try {
		// run() 使用 detached 子进程，因此负 PID 会终止整个 shell/ssh 子进程组。
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
	}
}

function run(args: string[], options: { input?: string; timeoutSec?: number } = {}): Promise<RunResult> {
	const timeoutSec = options.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC;
	return new Promise((settle) => {
		const child = spawn("/bin/bash", [CONNECT, ...args], {
			detached: true,
			cwd: RUNTIME_ROOT,
			env: { ...process.env, HOME_CONNECT_ROOT: RUNTIME_ROOT },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		activeChildren.add(child);
		const killTimer = setTimeout(() => {
			timedOut = true;
			stopChild(child);
			setTimeout(() => stopChild(child), 2_000).unref?.();
		}, timeoutSec * 1_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			clearTimeout(killTimer);
			activeChildren.delete(child);
			settle({ code: 127, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(killTimer);
			activeChildren.delete(child);
			settle({ code: code ?? 1, stdout, stderr, timedOut });
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
		else child.stdin?.end();
	});
}

async function lanAvailable(): Promise<boolean> {
	const result = await run(["lan", "status"], { timeoutSec: CHECK_TIMEOUT_SEC });
	return result.code === 0 && /lan=available/.test(result.stdout);
}

/** mac 需要显式选 LAN/中继；windows 与 wsl 由 connect.sh 内部按 LAN 优先自动选路。 */
function channelFor(target: Target, lan: boolean): string {
	if (target === "mac") return lan ? "lan" : "relay";
	return "auto";
}

async function isLan(): Promise<boolean> {
	try {
		return await lanAvailable();
	} catch {
		return false;
	}
}

async function reachable(target: Target, lan: boolean): Promise<RunResult> {
	if (target === "mac") return run(["mac", lan ? "lan-check" : "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	if (target === "windows") return run(["windows", "windows-check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	const direct = await run(["wsl", "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	if (direct.code === 0) return direct;
	await run(["wsl", "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
	const retried = await run(["wsl", "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	return retried.code === 0 ? retried : direct;
}

function execPrefix(target: Target, lan: boolean): string[] {
	if (target === "mac") return lan ? ["mac", "lan", "sh"] : ["mac", "sh"];
	if (target === "windows") return ["windows", "win-sh"];
	return ["wsl", "sh"];
}

async function execRemote(target: Target, command: string, timeoutSec: number) {
	const lan = await isLan();
	const prefix = execPrefix(target, lan);
	const first = await run(prefix, { input: command, timeoutSec });
	let woke = false;
	let result = first;
	if (target === "wsl" && first.code !== 0 && CONNECTION_FAILURE.test(`${first.stdout}${first.stderr}`)) {
		const wake = await run(["wsl", "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
		if (wake.code === 0) {
			woke = true;
			result = await run(prefix, { input: command, timeoutSec });
		}
	}
	return { result, channel: channelFor(target, lan), woke };
}

async function copyFile(target: Target, direction: "put" | "get", localPath: string, remotePath: string) {
	const lan = await isLan();
	if (target === "mac") {
		const args = direction === "put"
			? ["mac", "put-lan", localPath, remotePath]
			: lan
				? ["mac", "get-lan", remotePath, localPath]
				: ["mac", "get", remotePath, localPath];
		return { result: await run(args), channel: channelFor(target, lan) };
	}
	if (target === "windows") {
		if (direction === "get") {
			return {
				result: { code: 2, stdout: "", stderr: "Windows 通道只支持上传（win-put）。下载请用 home_exec 在 Windows 侧发起（远程 curl 直连下载），避免中继按流量计费。\n", timedOut: false } as RunResult,
				channel: channelFor(target, lan),
			};
		}
		return { result: await run(["windows", "win-put", localPath, remotePath]), channel: channelFor(target, lan) };
	}
	const args = direction === "put" ? ["wsl", "put", localPath, remotePath] : ["wsl", "get", remotePath, localPath];
	return { result: await run(args), channel: channelFor(target, lan) };
}

/** 批量上传（仅 windows put）：单条 sftp 会话内串行 put 全部文件 + 逐个大小核验。windows 通道恒为 auto。 */
async function copyBatchWindows(pairs: Array<{ localPath: string; remotePath: string }>) {
	const args = ["windows", "win-put-batch"];
	for (const p of pairs) args.push(p.localPath, p.remotePath);
	return { result: await run(args), channel: "auto" };
}

const TOOLS: ToolDefinition[] = [
	{
		name: "home_status",
		description:
			"检查家中设备的网络层与传输层状态：Tailscale 是否在线、是否在家庭局域网、指定通道（mac/windows/wsl）是否可达、实际会走 LAN 还是中继。任何连接失败先跑这个，不要先猜。",
		inputSchema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["mac", "windows", "wsl"],
					description: "要检查的通道；省略时只返回网络层（Tailscale + LAN）结论。",
				},
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: "home_exec",
		description:
			"在目标通道上执行命令，用平台原生语义：windows 是远程 PowerShell，mac/wsl 是远程 bash。命令可多行，无需自行转义引号或拼 ssh。返回真实退出码与 stdout/stderr。WSL 因 idle 关机导致的连接失败会自动唤醒并重试一次。",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["mac", "windows", "wsl"], description: "执行通道。" },
				command: { type: "string", minLength: 1, description: "平台原生命令；windows 用 PowerShell，mac/wsl 用 bash。" },
				timeoutSec: { type: "number", minimum: 1, maximum: 1800, description: "超时秒数，默认 120。" },
			},
			required: ["target", "command"],
			additionalProperties: false,
		},
	},
	{
		name: "home_copy",
		description:
			"在本地与家中设备之间传文件。mac 上传走 LAN、下载按 LAN 可用性选自连或中继；windows 只支持上传（下载应在远端直连拉取，避免中继计费）；wsl 支持双向。大文件不要走中继。单文件模式传 localPath/remotePath；批量模式传 files 数组（仅 windows put，单条 sftp 会话内串行传输）。同一时刻只允许一个传输任务（含批量），并发调用会立即报错。",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["mac", "windows", "wsl"], description: "文件通道。" },
				direction: { type: "string", enum: ["put", "get"], description: "put=本地上传，get=远端下载。" },
				localPath: { type: "string", description: "单文件模式：本地路径（绝对路径最稳）。与 files 二选一。" },
				remotePath: { type: "string", description: "单文件模式：远端路径；windows 必须是盘符绝对路径且不含空格。与 files 二选一。" },
				files: {
					type: "array",
					minItems: 1,
					description: "批量模式（仅 windows put）：一次传多个文件，单条 sftp 会话内串行传输。与 localPath/remotePath 二选一。",
					items: {
						type: "object",
						properties: {
							localPath: { type: "string", description: "本地路径（绝对路径最稳）。" },
							remotePath: { type: "string", description: "远端路径；盘符绝对路径且不含空格。" },
						},
						required: ["localPath", "remotePath"],
						additionalProperties: false,
					},
				},
			},
			required: ["target", "direction"],
			additionalProperties: false,
		},
	},
	{
		name: "home_wake",
		description: "唤醒 WSL（WSL2 约 60 秒无活动会自动关机，sshd 与反向隧道随之消失）。home_exec 遇到连接失败会自动尝试，仅在需要显式保活时单独调用。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "home_reset",
		description: "救援工具：终止 home-connect 当前正在执行的远程命令/传输，清理本机 SSH ControlMaster 复用状态。远端已启动且脱离 SSH 的后台任务不会被终止。遇到 home-connect 卡死或 Session open refused by peer 时调用。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { destructiveHint: true },
	},
];

function textResult(payload: unknown, isError = false) {
	return {
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
		isError,
	};
}

function asTarget(value: unknown): Target | undefined {
	return value === "mac" || value === "windows" || value === "wsl" ? value : undefined;
}

function failure(message: string) {
	return textResult({ error: message }, true);
}

/** home_copy 单飞门禁：并发多路复用上传会卡死 Windows OpenSSH 多数通道（实测 7 并发 6 个 hang >60s），
 * 同一时刻只放行一个传输任务，并发调用立即报错，由调用方串行重试。 */
let copyInFlight = false;

async function resetHomeConnect() {
		resetInProgress = true;
		const children = [...activeChildren];
		for (const child of children) stopChild(child);
		// 清理 reload 前遗留的旧 server 进程创建的复用主连接；路径严格限定为本插件的 UID 目录。
		const patterns = [
			`ssh: ${CM_DIR}/`,
			`/\.agents/plugins/home-connect/scripts/(connect|windows|wsl|mac|relay|windows-ssh)\\.sh`,
		];
		for (const pattern of patterns) {
			const killer = spawn("/usr/bin/pkill", ["-TERM", "-f", pattern], { stdio: "ignore" });
			await new Promise<void>((resolveDone) => killer.once("close", () => resolveDone()));
		}
		try { rmSync(CM_DIR, { recursive: true, force: true }); } catch { /* 无目录或已被清理 */ }
		try { rmSync(CM_DIR, { recursive: true, force: true }); } catch { /* 竞态下重试一次 */ }
		resetInProgress = false;
		return { terminated: children.length, controlMasterDir: CM_DIR };
	}

async function callTool(name: string, args: Record<string, unknown>) {
	if (name === "home_reset") return textResult(await resetHomeConnect());
	if (resetInProgress) return failure("home-connect 正在 reset，请稍后重试");
	if (name === "home_status") {
		const target = args.target === undefined ? undefined : asTarget(args.target);
		if (args.target !== undefined && !target) return failure(`未知 target: ${String(args.target)}`);
		const [ts, lan] = await Promise.all([
			run(["ts", "status"], { timeoutSec: CHECK_TIMEOUT_SEC }),
			run(["lan", "status"], { timeoutSec: CHECK_TIMEOUT_SEC }),
		]);
		const lanOk = lan.code === 0 && /lan=available/.test(lan.stdout);
		const report: Record<string, unknown> = {
			tailscale: { exitCode: ts.code, ...keyValues(ts.stdout), error: ts.stderr.trim() || undefined },
			lan: { exitCode: lan.code, available: lanOk, ...keyValues(lan.stdout) },
		};
		if (target) {
			const check = await reachable(target, lanOk);
			report[target] = {
				reachable: check.code === 0,
				exitCode: check.code,
				channel: channelFor(target, lanOk),
				output: capOutput(`${check.stdout}${check.stderr}`.trim()),
			};
		}
		return textResult(report);
	}

	if (name === "home_exec") {
		const target = asTarget(args.target);
		if (!target) return failure(`未知 target: ${String(args.target)}`);
		if (typeof args.command !== "string" || args.command.trim() === "") return failure("command 必须是非空字符串");
		const timeoutSec = typeof args.timeoutSec === "number" ? Math.min(Math.max(args.timeoutSec, 1), 1800) : DEFAULT_EXEC_TIMEOUT_SEC;
		const { result, channel, woke } = await execRemote(target, args.command, timeoutSec);
		const payload = {
			target,
			channel,
			woke,
			exitCode: result.code,
			...(result.timedOut ? { timedOut: true } : {}),
			stdout: capOutput(result.stdout),
			stderr: capOutput(result.stderr),
		};
		return textResult(payload, result.code !== 0);
	}

	if (name === "home_copy") {
		const target = asTarget(args.target);
		if (!target) return failure(`未知 target: ${String(args.target)}`);
		const direction = args.direction === "put" || args.direction === "get" ? args.direction : undefined;
		if (!direction) return failure(`direction 必须是 put 或 get`);
		// 批量模式（files 数组，仅 windows put）与单文件模式（localPath/remotePath）二选一
		const batch = args.files !== undefined;
		if (batch && (args.localPath !== undefined || args.remotePath !== undefined)) return failure("files 与 localPath/remotePath 二选一：批量模式只传 files");
		let pairs: Array<{ localPath: string; remotePath: string }> | undefined;
		if (batch) {
			if (target !== "windows" || direction !== "put") return failure("批量模式（files）仅支持 windows put");
			if (!Array.isArray(args.files) || args.files.length === 0) return failure("files 必须是非空数组");
			pairs = [];
			for (const [i, item] of (args.files as unknown[]).entries()) {
				const f = item as { localPath?: unknown; remotePath?: unknown } | null;
				if (typeof f?.localPath !== "string" || typeof f?.remotePath !== "string") return failure(`files[${i}] 必须含字符串 localPath 与 remotePath`);
				pairs.push({ localPath: f.localPath, remotePath: f.remotePath });
			}
		} else if (typeof args.localPath !== "string" || typeof args.remotePath !== "string") {
			return failure("localPath 与 remotePath 必须是字符串（批量模式改用 files）");
		}
		if (copyInFlight) return failure("已有 home_copy 任务进行中：同一时刻只允许一个文件传输（含批量），请等上一个完成后串行重试");
		copyInFlight = true;
		try {
			const { result, channel } = pairs
				? await copyBatchWindows(pairs)
				: await copyFile(target, direction, args.localPath as string, args.remotePath as string);
			const payload = {
				target,
				channel,
				direction,
				...(pairs ? { mode: "batch", count: pairs.length } : {}),
				exitCode: result.code,
				stdout: capOutput(result.stdout),
				stderr: capOutput(result.stderr),
			};
			return textResult(payload, result.code !== 0);
		} finally {
			copyInFlight = false;
		}
	}

	if (name === "home_wake") {
		const result = await run(["wsl", "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
		return textResult({ exitCode: result.code, stdout: capOutput(result.stdout), stderr: capOutput(result.stderr) }, result.code !== 0);
	}

	return failure(`未知工具: ${name}`);
}

const INSTRUCTIONS = [
	"家中设备连接只经这四个工具，禁止自行拼 ssh/scp/tailscale 命令：",
	"先 home_status 拿网络层与通道结论，再 home_exec 执行平台原生命令。",
	"windows 通道是 PowerShell，mac/wsl 是 bash；通道选择与引号处理由服务端完成。",
	"WSL 连接失败先 home_wake，或依赖 home_exec 的自动唤醒重试。",
	"home_copy 同一时刻只允许一个任务（含批量）；多文件优先用 files 批量模式（windows put），或串行单文件调用。",
	"home-connect 卡死或 SSH 复用通道损坏时调用 home_reset；它只清理本机连接状态，不终止远端脱离 SSH 的后台任务。",
].join("\n");

async function handleRequest(message: { id?: unknown; method?: string; params?: unknown }): Promise<unknown> {
	const method = message.method ?? "";
	if (message.id === undefined) return null;
	if (method === "initialize") {
		const params = message.params as { protocolVersion?: string } | undefined;
		return {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "home-connect", version: "0.1.0" },
			instructions: INSTRUCTIONS,
		};
	}
	if (method === "ping") return {};
	if (method === "tools/list") return { tools: TOOLS };
	if (method === "tools/call") {
		const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
		if (!params?.name) return { content: [{ type: "text", text: "缺少工具名" }], isError: true };
		return callTool(params.name, params.arguments ?? {});
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