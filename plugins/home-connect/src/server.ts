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
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dirname, "..");
/** 配置/身份根：优先仓库锚点 HARNESS_CONFIG_ROOT（init-qwen.sh 写入设置 env）下的仓内位置；
 *  无锚点时回退插件自定位，保证脱离 Qwen 直接运行也可用。 */
const RUNTIME_ROOT = resolve(
	process.env.HARNESS_CONFIG_ROOT
		? resolve(process.env.HARNESS_CONFIG_ROOT, "plugins", "home-connect")
		: PLUGIN_ROOT,
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

// ---------------------------------------------------------------------------
// home_comfyui：经 wsl 通道驱动 ComfyUI HTTP API 生图。
// 图默认取 WSL 侧 ~/anima-lab/graph-single1.json（API 格式），参数化补丁后提交，
// 轮询 /history，输出经连接层取回本地。全部远程操作走 execRemote/copyFile。
// ---------------------------------------------------------------------------

const COMFY_DEFAULT_WORKFLOW = "~/anima-lab/graph-single1.json";
const COMFY_START_SCRIPT = "~/.config/comfy-start.sh";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ComfyNode { class_type: string; inputs: Record<string, unknown>; }
type ComfyGraph = Record<string, ComfyNode>;

function isLink(v: unknown): v is [string, number] {
	return Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
}

/** 沿 conditioning 链接回溯 CLIPTextEncode 节点（穿过 ConditioningCombine 等中间节点）。 */
function traceConditioning(graph: ComfyGraph, link: unknown, depth = 0): string[] {
	if (!isLink(link) || depth > 6) return [];
	const node = graph[link[0]];
	if (!node) return [];
	if (node.class_type === "CLIPTextEncode") return [link[0]];
	const out: string[] = [];
	for (const v of Object.values(node.inputs)) {
		if (isLink(v)) out.push(...traceConditioning(graph, v, depth + 1));
	}
	return out;
}

function patchComfyGraph(graph: ComfyGraph, o: {
	prompt?: string; negativePrompt?: string; seed?: number;
	steps?: number; cfg?: number; denoise?: number; sampler?: string; scheduler?: string;
	width?: number; height?: number; checkpoint?: string; lora?: string; filenamePrefix: string;
}): string[] {
	const notes: string[] = [];
	const pos = new Set<string>();
	const neg = new Set<string>();
	for (const [id, node] of Object.entries(graph)) {
		const ins = node.inputs;
		if ("positive" in ins && "negative" in ins) {
			for (const t of traceConditioning(graph, ins.positive)) pos.add(t);
			for (const t of traceConditioning(graph, ins.negative)) neg.add(t);
		}
		if (o.prompt !== undefined && typeof ins.prompt === "string") { ins.prompt = o.prompt; notes.push(`${id}.prompt`); }
		if (o.negativePrompt !== undefined && typeof ins.negative_prompt === "string") { ins.negative_prompt = o.negativePrompt; notes.push(`${id}.negative_prompt`); }
		if (typeof ins.seed === "number") { ins.seed = o.seed ?? Math.floor(Math.random() * 2 ** 32); notes.push(`${id}.seed`); }
		if (o.steps !== undefined && typeof ins.steps === "number") { ins.steps = o.steps; notes.push(`${id}.steps`); }
		if (o.cfg !== undefined && typeof ins.cfg === "number") { ins.cfg = o.cfg; notes.push(`${id}.cfg`); }
		if (o.denoise !== undefined && typeof ins.denoise === "number") { ins.denoise = o.denoise; notes.push(`${id}.denoise`); }
		if (o.sampler !== undefined && typeof ins.sampler_name === "string") { ins.sampler_name = o.sampler; notes.push(`${id}.sampler_name`); }
		if (o.scheduler !== undefined && typeof ins.scheduler === "string") { ins.scheduler = o.scheduler; notes.push(`${id}.scheduler`); }
		if (o.width !== undefined && typeof ins.width === "number") { ins.width = o.width; notes.push(`${id}.width`); }
		if (o.height !== undefined && typeof ins.height === "number") { ins.height = o.height; notes.push(`${id}.height`); }
		if (o.checkpoint !== undefined) {
			if (typeof ins.unet_name === "string") { ins.unet_name = o.checkpoint; notes.push(`${id}.unet_name`); }
			if (typeof ins.ckpt_name === "string") { ins.ckpt_name = o.checkpoint; notes.push(`${id}.ckpt_name`); }
		}
		if (o.lora !== undefined && node.class_type === "LoraLoader" && typeof ins.lora_name === "string") { ins.lora_name = o.lora; notes.push(`${id}.lora_name`); }
		if (node.class_type === "SaveImage" && typeof ins.filename_prefix === "string") { ins.filename_prefix = o.filenamePrefix; notes.push(`${id}.filename_prefix`); }
	}
	if (o.prompt !== undefined) {
		if (pos.size === 0 && !notes.some((n) => n.endsWith(".prompt"))) throw new Error("指定了 prompt 但图中没有可补丁的正向条件节点（CLIPTextEncode 或 prompt 输入）");
		for (const id of pos) { graph[id].inputs.text = o.prompt; notes.push(`${id}.text(positive)`); }
	}
	if (o.negativePrompt !== undefined) {
		if (neg.size === 0 && !notes.some((n) => n.endsWith(".negative_prompt"))) throw new Error("指定了 negativePrompt 但图中没有可补丁的负向条件节点");
		for (const id of neg) { graph[id].inputs.text = o.negativePrompt; notes.push(`${id}.text(negative)`); }
	}
	return notes;
}

async function comfyuiGenerate(args: Record<string, unknown>) {
	try {
		return await comfyuiGenerateInner(args);
	} catch (error) {
		return failure(`home_comfyui 异常: ${(error as Error).message}`);
	}
}

async function comfyuiGenerateInner(args: Record<string, unknown>) {
	const port = typeof args.port === "number" && args.port > 0 ? Math.floor(args.port) : 8188;
	const base = `http://127.0.0.1:${port}`;
	const timeoutSec = typeof args.timeoutSec === "number" ? Math.min(Math.max(args.timeoutSec, 30), 1800) : 600;
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSec * 1000;
	const autostart = args.autostart !== false;
	const fetch = args.fetch !== false;
	const workflowPath = typeof args.workflowPath === "string" && args.workflowPath.trim() ? args.workflowPath.trim() : COMFY_DEFAULT_WORKFLOW;

	const exec = (command: string, t = 60) => execRemote("wsl", command, t);

	// 1) API 存活；未运行时可选自启（经用户的 comfy-start.sh，脱离 SSH 存活）
	const stats = await exec(`curl -s -m 8 ${base}/system_stats`, 45);
	let autostarted = false;
	if (stats.result.code !== 0 || !stats.result.stdout.trim()) {
		if (!autostart) return failure(`ComfyUI 未运行（${base}）；autostart=true 可经 ${COMFY_START_SCRIPT} 自动启动`);
		const start = await exec(`nohup bash ${COMFY_START_SCRIPT} >/dev/null 2>&1 & echo comfyui-started`, 60);
		if (start.result.code !== 0) return failure(`ComfyUI 自启失败: ${start.result.stderr.trim()}`);
		autostarted = true;
		let up = false;
		for (let i = 0; i < 36 && Date.now() < deadline; i++) {
			await sleep(5000);
			const probe = await exec(`curl -s -m 8 ${base}/system_stats`, 45);
			if (probe.result.code === 0 && probe.result.stdout.includes("comfyui_version")) { up = true; break; }
		}
		if (!up) return failure("ComfyUI 自启后 180s 内仍未就绪；请在 WSL 上检查 ~/anima-lab/comfy.log");
	}

	// 2) 加载图（内联 workflow 优先，否则读 WSL 侧文件）
	let graph: ComfyGraph;
	if (args.workflow !== undefined) {
		if (typeof args.workflow !== "object" || args.workflow === null || Array.isArray(args.workflow)) return failure("workflow 必须是 API 格式的图对象");
		graph = args.workflow as ComfyGraph;
	} else {
		const cat = await exec(`cat ${workflowPath}`, 45);
		if (cat.result.code !== 0) return failure(`读取 workflow 失败 ${workflowPath}: ${cat.result.stderr.trim()}`);
		try { graph = JSON.parse(cat.result.stdout); } catch { return failure(`${workflowPath} 不是合法 JSON（需要 API 格式图）`); }
	}
	for (const [id, node] of Object.entries(graph)) {
		if (!node || typeof node !== "object" || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
			return failure(`图节点 ${id} 缺少 class_type/inputs：不是 API 格式（UI 图需先“导出 API”）`);
		}
	}

	// 3) 参数化补丁
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filenamePrefix = typeof args.filenamePrefix === "string" && args.filenamePrefix.trim() ? args.filenamePrefix.trim() : `home-connect/${stamp}`;
	let patches: string[];
	try {
		patches = patchComfyGraph(graph, {
			prompt: typeof args.prompt === "string" ? args.prompt : undefined,
			negativePrompt: typeof args.negativePrompt === "string" ? args.negativePrompt : undefined,
			seed: typeof args.seed === "number" ? args.seed : undefined,
			steps: typeof args.steps === "number" ? args.steps : undefined,
			cfg: typeof args.cfg === "number" ? args.cfg : undefined,
			denoise: typeof args.denoise === "number" ? args.denoise : undefined,
			sampler: typeof args.sampler === "string" ? args.sampler : undefined,
			scheduler: typeof args.scheduler === "string" ? args.scheduler : undefined,
			width: typeof args.width === "number" ? args.width : undefined,
			height: typeof args.height === "number" ? args.height : undefined,
			checkpoint: typeof args.checkpoint === "string" ? args.checkpoint : undefined,
			lora: typeof args.lora === "string" ? args.lora : undefined,
			filenamePrefix,
		});
	} catch (error) { return failure((error as Error).message); }

	// 4) 提交（heredoc 落盘 + curl -d @file，JSON 零转义）
	const payload = JSON.stringify({ prompt: graph, client_id: "home-connect-mcp" });
	const submitCmd = [
		"cat > /tmp/comfyui-mcp-$$.json <<'__COMFY_PAYLOAD__'",
		payload,
		"__COMFY_PAYLOAD__",
		`curl -s -m 30 -X POST -H 'Content-Type: application/json' -d @/tmp/comfyui-mcp-$$.json ${base}/prompt`,
		"rc=$?",
		"rm -f /tmp/comfyui-mcp-$$.json",
		"exit $rc",
	].join("\n");
	const submit = await exec(submitCmd, 90);
	if (submit.result.code !== 0) return failure(`提交失败: ${submit.result.stderr.trim() || submit.result.stdout.trim()}`);
	let submitted: { prompt_id?: string; number?: number; node_errors?: Record<string, unknown> };
	try { submitted = JSON.parse(submit.result.stdout); } catch { return failure(`提交响应非 JSON: ${submit.result.stdout.slice(0, 500)}`); }
	if (submitted.node_errors && Object.keys(submitted.node_errors).length > 0) {
		return failure(`图校验失败 node_errors: ${JSON.stringify(submitted.node_errors).slice(0, 2000)}`);
	}
	const promptId = submitted.prompt_id;
	if (!promptId) return failure(`提交响应缺少 prompt_id: ${submit.result.stdout.slice(0, 500)}`);

	// 5) 轮询 /history 至完成
	let history: { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type: string }> }>; status?: { status_str?: string; completed?: boolean; messages?: unknown } } | null = null;
	while (Date.now() < deadline) {
		await sleep(3000);
		const h = await exec(`curl -s -m 10 ${base}/history/${promptId}`, 45);
		if (h.result.code !== 0) continue;
		try {
			const parsed = JSON.parse(h.result.stdout);
			if (parsed && parsed[promptId]) { history = parsed[promptId]; break; }
		} catch { /* 尚未完成 */ }
	}
	if (!history) return failure(`生图超时（${timeoutSec}s）；prompt_id=${promptId} 可能仍在 ComfyUI 队列/运行中，可稍后查 /history`);
	const status = history.status ?? {};
	if (status.status_str === "error" || status.completed === false) {
		return failure(`生图失败: ${JSON.stringify(status.messages ?? status).slice(0, 2000)}（prompt_id=${promptId}）`);
	}

	// 6) 收集输出并在 WSL 侧解析绝对路径（运行实例的 cwd / --base-directory 推导 output 根）
	const images: Array<{ nodeId: string; filename: string; subfolder: string }> = [];
	for (const [nodeId, out] of Object.entries(history.outputs ?? {})) {
		for (const img of out.images ?? []) {
			if (img.type === "output") images.push({ nodeId, filename: img.filename, subfolder: img.subfolder ?? "" });
		}
	}
	if (images.length === 0) return failure(`history 无输出图片（prompt_id=${promptId}）: ${JSON.stringify(history.outputs ?? {}).slice(0, 1000)}`);

	const itemsJson = JSON.stringify(images.map((i) => ({ filename: i.filename, subfolder: i.subfolder })));
	const resolveCmd = [
		"python3 -c '",
		"import json, os, subprocess, sys",
		"items = json.load(sys.stdin)",
		`pids = subprocess.run(["pgrep", "-f", "main.py.*--port ${port}"], capture_output=True, text=True).stdout.split()`,
		'pids = [p for p in pids if p != str(os.getpid())]',
		'pid = pids[0] if pids else ""',
		'cwd = os.readlink("/proc/" + pid + "/cwd") if pid else ""',
		'base = ""',
		"if pid:",
		'    parts = open("/proc/" + pid + "/cmdline", "rb").read().decode(errors="replace").split("\\0")',
		'    if "--base-directory" in parts:',
		'        i = parts.index("--base-directory")',
		"        if i + 1 < len(parts): base = parts[i + 1]",
		'roots = ([os.path.join(base, "output")] if base else []) + [os.path.join(cwd, "output"), os.path.join(cwd, "ComfyUI", "output"), os.path.expanduser("~/anima-prod/output"), os.path.expanduser("~/anima-lab/ComfyUI/output")]',
		"for it in items:",
		'    rel = os.path.join(it.get("subfolder") or "", it["filename"])',
		"    for r in roots:",
		"        p = os.path.join(r, rel)",
		"        if os.path.isfile(p):",
		"            print(p)",
		"            break",
		"    else:",
		'        print("NOT_FOUND:" + rel)',
		"' <<'__COMFY_ITEMS__'",
		itemsJson,
		"__COMFY_ITEMS__",
	].join("\n");
	const resolved = await exec(resolveCmd, 60);
	if (resolved.result.code !== 0) return failure(`输出路径解析失败: ${resolved.result.stderr.trim()}`);
	const paths = resolved.result.stdout.trim().split("\n");

	// 7) 经连接层取回本地（与 home_copy 共用单飞门禁）
	const localDir = typeof args.localDir === "string" && args.localDir.trim() ? resolve(args.localDir.trim()) : resolve(RUNTIME_ROOT, ".remote-files", "comfyui");
	const outputs: Array<Record<string, unknown>> = [];
	if (fetch) {
		mkdirSync(localDir, { recursive: true });
		while (copyInFlight && Date.now() < deadline) await sleep(2000);
		if (copyInFlight) return failure("文件传输通道忙（home_copy 进行中），无法取回图片；稍后重试或 fetch=false");
		copyInFlight = true;
		try {
			for (let i = 0; i < images.length; i++) {
				const remotePath = paths[i] ?? "NOT_FOUND";
				const entry: Record<string, unknown> = { nodeId: images[i].nodeId, filename: images[i].filename, subfolder: images[i].subfolder, remotePath };
				if (remotePath.startsWith("NOT_FOUND")) { entry.error = "WSL 上未找到输出文件"; outputs.push(entry); continue; }
				let localPath = resolve(localDir, images[i].filename);
				if (existsSync(localPath)) localPath = resolve(localDir, `${Date.now()}-${images[i].filename}`);
				const got = await copyFile("wsl", "get", localPath, remotePath);
				if (got.result.code === 0 && existsSync(localPath)) {
					entry.localPath = localPath;
					entry.bytes = statSync(localPath).size;
				} else {
					entry.error = `取回失败: ${got.result.stderr.trim().slice(0, 300)}`;
				}
				outputs.push(entry);
			}
		} finally { copyInFlight = false; }
	} else {
		for (let i = 0; i < images.length; i++) {
			outputs.push({ nodeId: images[i].nodeId, filename: images[i].filename, subfolder: images[i].subfolder, remotePath: paths[i] ?? "NOT_FOUND" });
		}
	}
	const ok = outputs.some((o) => (fetch ? o.localPath : !String(o.remotePath).startsWith("NOT_FOUND")));
	return textResult({
		promptId,
		channel: stats.channel,
		woke: stats.woke,
		autostarted,
		filenamePrefix,
		elapsedSec: Math.round((Date.now() - startedAt) / 1000),
		patches,
		outputs,
	}, !ok);
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
		name: "home_comfyui",
		description:
			"驱动 WSL 上的 ComfyUI 生图并把结果取回本地，复用 home-connect 连接层（LAN 直连/中继自动选路、WSL 自动唤醒）。默认加载 ~/anima-lab/graph-single1.json（单角色 txt2img + hires fix），可用 workflowPath 或内联 workflow（API 格式）换任意图。prompt/negativePrompt 自动补丁正/负向条件节点；seed 默认随机；steps/cfg/sampler/scheduler/denoise/width/height/checkpoint/lora 按需覆盖；SaveImage 前缀默认 home-connect/<时间戳>。ComfyUI 未运行时经 ~/.config/comfy-start.sh 自动启动（autostart=false 关闭）。输出默认下载到插件 .remote-files/comfyui/（fetch=false 仅留远端路径）。中继按流量计费：大图/多图优先在家庭 LAN 内使用。",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "正向提示词；补丁图中所有正向条件节点。" },
				negativePrompt: { type: "string", description: "负向提示词。" },
				workflowPath: { type: "string", description: `WSL 侧 API 格式图路径，默认 ${COMFY_DEFAULT_WORKFLOW}。` },
				workflow: { type: "object", description: "内联 API 格式图（优先于 workflowPath）。" },
				checkpoint: { type: "string", description: "覆盖 UNETLoader.unet_name / CheckpointLoaderSimple.ckpt_name。" },
				lora: { type: "string", description: "覆盖 LoraLoader.lora_name。" },
				width: { type: "number", description: "覆盖潜空间/采样器宽度（不改动 pose scene_json）。" },
				height: { type: "number", description: "覆盖潜空间/采样器高度。" },
				seed: { type: "number", description: "指定可复现；默认每个采样器独立随机。" },
				steps: { type: "number" },
				cfg: { type: "number" },
				denoise: { type: "number" },
				sampler: { type: "string", description: "如 euler_ancestral、res_multistep。" },
				scheduler: { type: "string", description: "如 sgm_uniform、karras、simple。" },
				filenamePrefix: { type: "string", description: "SaveImage 前缀（可含子目录），默认 home-connect/<时间戳>。" },
				timeoutSec: { type: "number", minimum: 30, maximum: 1800, description: "整体超时秒数，默认 600。" },
				autostart: { type: "boolean", description: "ComfyUI 未运行时自动启动，默认 true。" },
				fetch: { type: "boolean", description: "把输出图片取回本地，默认 true。" },
				localDir: { type: "string", description: "本地保存目录，默认 <运行时根>/.remote-files/comfyui。" },
				port: { type: "number", description: "ComfyUI 端口，默认 8188。" },
			},
			additionalProperties: false,
		},
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

	if (name === "home_comfyui") return comfyuiGenerate(args);

	return failure(`未知工具: ${name}`);
}

const INSTRUCTIONS = [
	"家中设备连接只经这四个工具，禁止自行拼 ssh/scp/tailscale 命令：",
	"先 home_status 拿网络层与通道结论，再 home_exec 执行平台原生命令。",
	"windows 通道是 PowerShell，mac/wsl 是 bash；通道选择与引号处理由服务端完成。",
	"WSL 连接失败先 home_wake，或依赖 home_exec 的自动唤醒重试。",
	"home_copy 同一时刻只允许一个任务（含批量）；多文件优先用 files 批量模式（windows put），或串行单文件调用。",
	"home_comfyui 驱动 WSL ComfyUI 生图（默认图 ~/anima-lab/graph-single1.json），复用 wsl 通道并自动取回输出；中继按流量计费，大图/多图优先 LAN。",
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