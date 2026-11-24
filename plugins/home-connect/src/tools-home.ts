/**
 * home 系工具：家中设备连接的状态/执行/传输/唤醒/救援。
 * 只组合 connection.ts 的原语，不碰 ssh 细节。
 */

import {
	CHECK_TIMEOUT_SEC, DEFAULT_EXEC_TIMEOUT_SEC, WAKE_TIMEOUT_SEC,
	acquireCopy, capOutput, channelFor, copyBatchWindows, copyFile, copyBusy,
	execRemote, isResetInProgress, keyValues, reachable, releaseCopy, resetHomeConnect, run, wslPrefix,
	type Target,
} from "./connection.ts";
import { failure, textResult, type ToolDefinition } from "./mcp.ts";

function asTarget(value: unknown): Target | undefined {
	return value === "mac" || value === "windows" || value === "wsl" ? value : undefined;
}

const AGY_ASYNC_ENABLED = process.env.HOME_CONNECT_AGY_ASYNC === "1";

const COPY_INPUT_SCHEMA: Record<string, unknown> = {
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
};

const BASE_HOME_TOOLS: ToolDefinition[] = [
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
		inputSchema: COPY_INPUT_SCHEMA,
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

const AGY_BG_HOME_TOOLS: ToolDefinition[] = [
	{
		name: "home_exec_bg",
		description:
			"后台异步执行长时远程命令（如大文件/模型下载、编译、安装依赖、长时间测试或训练脚本）。由 Antigravity 宿主自动作为后台任务执行并在完成后唤醒主会话，默认不设本地超时（timeoutSec=0）。短时查询/运维命令仍优先用前台 home_exec。",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["mac", "windows", "wsl"], description: "执行通道。" },
				command: { type: "string", minLength: 1, description: "平台原生命令；windows 用 PowerShell，mac/wsl 用 bash。" },
				timeoutSec: { type: "number", minimum: 0, description: "可选本地超时秒数；0 或省略表示不设本地超时（默认 0）。" },
			},
			required: ["target", "command"],
			additionalProperties: false,
		},
	},
	{
		name: "home_copy_bg",
		description:
			"后台异步传输大文件或大批量文件（与 home_copy 共用同一单飞传输门禁，默认不设本地超时）。由 Antigravity 宿主作为后台任务执行并在完成后唤醒主会话；小文件仍优先用前台 home_copy。",
		inputSchema: COPY_INPUT_SCHEMA,
	},
];

export const HOME_TOOLS: ToolDefinition[] = AGY_ASYNC_ENABLED
	? [...BASE_HOME_TOOLS, ...AGY_BG_HOME_TOOLS]
	: BASE_HOME_TOOLS;

const BASE_HOME_INSTRUCTIONS = [
	"家中设备连接只经本服务的工具，禁止自行拼 ssh/scp/tailscale 命令：",
	"先 home_status 拿网络层与通道结论，再 home_exec 执行平台原生命令。",
	"windows 通道是 PowerShell，mac/wsl 是 bash；通道选择与引号处理由服务端完成。",
	"WSL 连接失败先 home_wake，或依赖 home_exec 的自动唤醒重试。",
	"home_copy 同一时刻只允许一个任务（含批量）；多文件优先用 files 批量模式（windows put），或串行单文件调用。",
	"home-connect 卡死或 SSH 复用通道损坏时调用 home_reset；它只清理本机连接状态，不终止远端脱离 SSH 的后台任务。",
	"WSL ComfyUI 生图用独立的 comfyui 服务（comfyui_generate），不在本服务内。",
];

export const HOME_INSTRUCTIONS = (
	AGY_ASYNC_ENABLED
		? [
			...BASE_HOME_INSTRUCTIONS,
			"短时查询/运维命令用前台 home_exec，大文件/模型下载、编译安装等长时命令优先用后台 home_exec_bg；大文件或批量传输可用后台 home_copy_bg（均由宿主后台运行并在完成后自动唤醒）。",
		]
		: BASE_HOME_INSTRUCTIONS
).join("\n");

async function handleExec(args: Record<string, unknown>, isBg: boolean) {
	const target = asTarget(args.target);
	if (!target) return failure(`未知 target: ${String(args.target)}`);
	if (typeof args.command !== "string" || args.command.trim() === "") return failure("command 必须是非空字符串");
	let timeoutSec: number;
	if (isBg) {
		if (args.timeoutSec === undefined) {
			timeoutSec = 0;
		} else if (typeof args.timeoutSec !== "number" || !Number.isFinite(args.timeoutSec) || args.timeoutSec < 0) {
			return failure("timeoutSec 必须是非负有限数字（0 表示不设本地超时）");
		} else {
			timeoutSec = args.timeoutSec;
		}
	} else {
		timeoutSec = typeof args.timeoutSec === "number" ? Math.min(Math.max(args.timeoutSec, 1), 1800) : DEFAULT_EXEC_TIMEOUT_SEC;
	}
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

async function handleCopy(args: Record<string, unknown>, timeoutSec?: number) {
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
	if (!acquireCopy()) return failure("已有 home_copy 任务进行中：同一时刻只允许一个文件传输（含批量），请等上一个完成后串行重试");
	try {
		const copyOpts = timeoutSec !== undefined ? { timeoutSec } : {};
		const { result, channel } = pairs
			? await copyBatchWindows(pairs, copyOpts)
			: await copyFile(target, direction, args.localPath as string, args.remotePath as string, copyOpts);
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
		releaseCopy();
	}
}

export async function callHomeTool(name: string, args: Record<string, unknown>) {
	if (name === "home_reset") return textResult(await resetHomeConnect());
	if (isResetInProgress()) return failure("home-connect 正在 reset，请稍后重试");
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

	if (name === "home_exec") return handleExec(args, false);
	if (name === "home_exec_bg" && AGY_ASYNC_ENABLED) return handleExec(args, true);
	if (name === "home_copy") return handleCopy(args);
	if (name === "home_copy_bg" && AGY_ASYNC_ENABLED) return handleCopy(args, 0);

	if (name === "home_wake") {
		const result = await run([...wslPrefix(), "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
		return textResult({ exitCode: result.code, stdout: capOutput(result.stdout), stderr: capOutput(result.stderr) }, result.code !== 0);
	}

	return failure(`未知工具: ${name}`);
}
