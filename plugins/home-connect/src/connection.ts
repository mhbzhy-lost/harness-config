/**
 * 连接层：家中 Mac / Windows / WSL 的传输与执行原语，供 home 与 comfyui 两个 MCP server 共享。
 *
 * SSH/SCP 拼接、通道选择、引号与 heredoc、ControlMaster、WSL idle 唤醒、输出截断
 * 全部在这一层完成；工具模块只组合这些原语，不碰 ssh 细节。
 *
 * 脚本随插件分发（scripts/）；凭据与身份在仓内插件目录的 config/ 与 .ssh/（gitignore），
 * 运行时根优先 HARNESS_CONFIG_ROOT 锚点（init-qwen.sh 写入设置 env），无锚点回退插件自定位。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

export const PLUGIN_ROOT = resolve(import.meta.dirname, "..");
/** 宿主模式（HOME_CONNECT_HOST=mac）：进程就跑在家中的 mac 上，给没有 bash 环境的远端客户端当入口。
 *  mac 目标即本机直接执行；Windows 只走 LAN（用 HOME_CONNECT_WIN_KEY 指定的本机已有密钥）；
 *  WSL 没有密钥，经 Windows 的 wsl.exe 操作；ComfyUI 从本机直连。 */
export const HOST_MODE = process.env.HOME_CONNECT_HOST === "mac";
/** 配置/身份根：优先仓库锚点 HARNESS_CONFIG_ROOT 下的仓内位置；无锚点时回退插件自定位。 */
export const RUNTIME_ROOT = resolve(
	process.env.HARNESS_CONFIG_ROOT
		? resolve(process.env.HARNESS_CONFIG_ROOT, "plugins", "home-connect")
		: PLUGIN_ROOT,
);
const CONNECT = resolve(PLUGIN_ROOT, "scripts", "connect.sh");

/** 单流输出上限：超出后截断并标注，避免把上下文塞满。 */
const MAX_OUTPUT_CHARS = 60_000;
export const CHECK_TIMEOUT_SEC = 45;
export const DEFAULT_EXEC_TIMEOUT_SEC = 120;
export const WAKE_TIMEOUT_SEC = 120;
const CONNECTION_FAILURE = /connection refused|connection timed out|no route to host|kex_exchange|broken pipe|closed by remote host|operation timed out|network is unreachable/i;
const CM_DIR = `/tmp/home-connect-cm-${process.getuid?.() ?? "unknown"}`;

export type Target = "mac" | "windows" | "wsl";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function capOutput(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n");
	if (normalized.length <= MAX_OUTPUT_CHARS) return normalized;
	return `${normalized.slice(0, MAX_OUTPUT_CHARS)}\n[输出截断：原始长度 ${normalized.length} 字符]`;
}

/** 读取 `key=value` 形态的检查输出，便于结构化返回。 */
export function keyValues(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([a-z0-9_]+)=(.*)$/i);
		if (match) result[match[1]] = match[2];
	}
	return result;
}

const activeChildren = new Set<import("node:child_process").ChildProcess>();
let resetInProgress = false;

export function isResetInProgress(): boolean {
	return resetInProgress;
}

function stopChild(child: import("node:child_process").ChildProcess): void {
	if (!child.pid) return;
	try {
		// run() 使用 detached 子进程，因此负 PID 会终止整个 shell/ssh 子进程组。
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
	}
}

export function run(args: string[], options: { input?: string; timeoutSec?: number } = {}): Promise<RunResult> {
	const child = spawn("/bin/bash", [CONNECT, ...args], {
		detached: true,
		cwd: RUNTIME_ROOT,
		env: { ...process.env, HOME_CONNECT_ROOT: RUNTIME_ROOT },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return settle(child, options);
}

/** 宿主模式的本机执行：mac 目标就是这台机器，命令交给登录 shell，不经 ssh。 */
export function runLocal(command: string, timeoutSec: number): Promise<RunResult> {
	return settle(spawn("/bin/bash", ["-l", "-s"], { detached: true, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] }), { input: command, timeoutSec });
}

/** 宿主模式的本机二进制执行（cp / curl），参数走 argv，不过 shell。 */
export function runLocalBinary(file: string, args: string[], options: { input?: string; timeoutSec?: number } = {}): Promise<RunResult> {
	return settle(spawn(file, args, { detached: true, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] }), options);
}

function settle(child: ChildProcess, options: { input?: string; timeoutSec?: number }): Promise<RunResult> {
	const timeoutSec = options.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC;
	return new Promise((settleDone) => {
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
			settleDone({ code: 127, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(killTimer);
			activeChildren.delete(child);
			settleDone({ code: code ?? 1, stdout, stderr, timedOut });
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
export function channelFor(target: Target, lan: boolean): string {
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

export async function reachable(target: Target, lan: boolean): Promise<RunResult> {
	if (target === "mac") {
		if (HOST_MODE) return runLocal("hostname", 10);
		return run(["mac", lan ? "lan-check" : "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	}
	if (target === "windows") return run(["windows", "windows-check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	const prefix = wslPrefix();
	const direct = await run([...prefix, "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	if (direct.code === 0) return direct;
	await run([...prefix, "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
	const retried = await run([...prefix, "--check"], { timeoutSec: CHECK_TIMEOUT_SEC });
	return retried.code === 0 ? retried : direct;
}

function execPrefix(target: Target, lan: boolean): string[] {
	if (target === "mac") return lan ? ["mac", "lan", "sh"] : ["mac", "sh"];
	if (target === "windows") return ["windows", "win-sh"];
	return [...wslPrefix(), "sh"];
}

/** WSL 通道脚本：有密钥走 wsl.sh，宿主模式没有 WSL 密钥则经 Windows 的 wsl.exe。 */
export function wslPrefix(): string[] {
	return HOST_MODE ? ["wslwin"] : ["wsl"];
}

/** 实际走的路径；宿主模式下 LAN 探测失败即无备路（没有中继凭据）。 */
function hostChannel(lan: boolean): string {
	return lan ? "lan" : "lan_unproven";
}

export async function execRemote(target: Target, command: string, timeoutSec: number) {
	if (HOST_MODE && target === "mac") return { result: await runLocal(command, timeoutSec), channel: "local", woke: false };
	const lan = await isLan();
	const prefix = execPrefix(target, lan);
	const first = await run(prefix, { input: command, timeoutSec });
	let woke = false;
	let result = first;
	if (target === "wsl" && first.code !== 0 && CONNECTION_FAILURE.test(`${first.stdout}${first.stderr}`)) {
		const wake = await run([...wslPrefix(), "wake"], { timeoutSec: WAKE_TIMEOUT_SEC });
		if (wake.code === 0) {
			woke = true;
			result = await run(prefix, { input: command, timeoutSec });
		}
	}
	return { result, channel: HOST_MODE ? hostChannel(lan) : channelFor(target, lan), woke };
}

export async function copyFile(target: Target, direction: "put" | "get", localPath: string, remotePath: string) {
	if (HOST_MODE && target === "mac") {
		return { result: await runLocalBinary("/bin/cp", ["-f", direction === "put" ? localPath : remotePath, direction === "put" ? remotePath : localPath], { timeoutSec: 300 }), channel: "local" };
	}
	if (HOST_MODE && target === "wsl") {
		const args = direction === "put" ? ["wslwin", "put", localPath, remotePath] : ["wslwin", "get", remotePath, localPath];
		return { result: await run(args, { timeoutSec: 300 }), channel: "lan" };
	}
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
export async function copyBatchWindows(pairs: Array<{ localPath: string; remotePath: string }>) {
	const args = ["windows", "win-put-batch"];
	for (const p of pairs) args.push(p.localPath, p.remotePath);
	return { result: await run(args), channel: "auto" };
}

/** 传输单飞门禁：并发多路复用上传会卡死 Windows OpenSSH 多数通道（实测 7 并发 6 个 hang >60s）。
 *  门禁为进程内：home server 的 windows 传输与 comfyui server 的 wsl 取图分属不同进程/通道。 */
let copyInFlight = false;

export function copyBusy(): boolean {
	return copyInFlight;
}

export function acquireCopy(): boolean {
	if (copyInFlight) return false;
	copyInFlight = true;
	return true;
}

export function releaseCopy(): void {
	copyInFlight = false;
}

export async function resetHomeConnect() {
	resetInProgress = true;
	const children = [...activeChildren];
	for (const child of children) stopChild(child);
	// 清理 reload 前遗留的旧 server 进程创建的复用主连接；路径严格限定为本插件的 UID 目录。
	// 脚本可能经仓库实体路径或 extensions/.agents 软链接路径启动，两种 cmdline 都要匹配。
	const patterns = [
		`ssh: ${CM_DIR}/`,
		`/(plugins|extensions)/home-connect/scripts/(connect|windows|wsl|mac|relay|windows-ssh)\\.sh|/home-connect-host/scripts/`,
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

const COMFY_LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/** ComfyUI 基址：stdio 模式的 curl 在 WSL 内执行，固定回环 8188；宿主模式从本机直连（默认 mac 上到 WSL 的回环隧道 18190）。 */
export function comfyBaseUrl(): string {
	if (!HOST_MODE) return "http://127.0.0.1:8188";
	const url = process.env.COMFYUI_URL ?? "http://127.0.0.1:18190";
	if (!COMFY_LOOPBACK.test(url)) throw new Error("COMFYUI_URL 只接受回环地址");
	return url;
}

/**
 * ComfyUI HTTP 请求，返回与远程执行同形的 RunResult，供两种模式共用同一套解析。
 * 宿主模式在本机 curl（payload 落临时文件，outputFile 指定时 stdout 只有 HTTP 状态码）；
 * stdio 模式在 WSL 内 curl（payload 经 heredoc 落盘，JSON 零转义）。
 */
export async function comfyCurl(pathAndQuery: string, options: { payload?: unknown; outputFile?: string; curlTimeoutSec: number; execTimeoutSec: number }) {
	const url = `${comfyBaseUrl()}${pathAndQuery}`;
	const { curlTimeoutSec, execTimeoutSec } = options;
	if (HOST_MODE) {
		const args = ["-s", "-m", String(curlTimeoutSec)];
		let payloadFile: string | undefined;
		if (options.outputFile) args.push("-o", options.outputFile, "-w", "%{http_code}");
		if (options.payload !== undefined) {
			payloadFile = `${tmpdir()}/comfyui-mcp-${process.pid}-${Date.now()}.json`;
			writeFileSync(payloadFile, JSON.stringify(options.payload));
			args.push("-X", "POST", "-H", "Content-Type: application/json", "-d", `@${payloadFile}`);
		}
		try {
			return { result: await runLocalBinary("/usr/bin/curl", [...args, url], { timeoutSec: execTimeoutSec }), channel: "local", woke: false };
		} finally {
			if (payloadFile) rmSync(payloadFile, { force: true });
		}
	}
	if (options.payload === undefined) {
		return execRemote("wsl", `curl -s -m ${curlTimeoutSec} '${url}'`, execTimeoutSec);
	}
	const submitCmd = [
		"cat > /tmp/comfyui-mcp-$$.json <<'__COMFY_PAYLOAD__'",
		JSON.stringify(options.payload),
		"__COMFY_PAYLOAD__",
		`curl -s -m ${curlTimeoutSec} -X POST -H 'Content-Type: application/json' -d @/tmp/comfyui-mcp-$$.json '${url}'`,
		"rc=$?",
		"rm -f /tmp/comfyui-mcp-$$.json",
		"exit $rc",
	].join("\n");
	return execRemote("wsl", submitCmd, execTimeoutSec);
}
