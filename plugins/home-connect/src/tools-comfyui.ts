/**
 * comfyui 工具：经 home-connect 连接层（wsl 通道）驱动 ComfyUI HTTP API 生图。
 * 图默认取 WSL 侧 ~/anima-lab/graph-single1.json（API 格式），参数化补丁后提交，
 * 轮询 /history，输出经连接层取回本地。全部远程操作走 execRemote/copyFile。
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_ROOT, acquireCopy, copyBusy, copyFile, execRemote, releaseCopy } from "./connection.ts";
import { patchComfyGraph, type ComfyGraph } from "./graph.ts";
import { failure, textResult, type ToolDefinition } from "./mcp.ts";

const COMFY_DEFAULT_WORKFLOW = "~/anima-lab/graph-single1.json";
const COMFY_START_SCRIPT = "~/.config/comfy-start.sh";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function comfyuiGenerate(args: Record<string, unknown>) {
	try {
		return await comfyuiGenerateInner(args);
	} catch (error) {
		return failure(`comfyui_generate 异常: ${(error as Error).message}`);
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
	const payload = JSON.stringify({ prompt: graph, client_id: "comfyui-mcp" });
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

	// 7) 经连接层取回本地（进程内单飞门禁；跨进程见 connection.ts 说明）
	const localDir = typeof args.localDir === "string" && args.localDir.trim() ? resolve(args.localDir.trim()) : resolve(RUNTIME_ROOT, ".remote-files", "comfyui");
	const outputs: Array<Record<string, unknown>> = [];
	if (fetch) {
		mkdirSync(localDir, { recursive: true });
		while (copyBusy() && Date.now() < deadline) await sleep(2000);
		if (!acquireCopy()) return failure("文件传输通道忙，无法取回图片；稍后重试或 fetch=false");
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
		} finally { releaseCopy(); }
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

export const COMFYUI_TOOLS: ToolDefinition[] = [
	{
		name: "comfyui_generate",
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
];

export const COMFYUI_INSTRUCTIONS = [
	"本服务只负责 WSL ComfyUI 生图（comfyui_generate）；连接层与 home-connect 共享。",
	"连接异常（WSL 休眠、通道不可达）先用 home 服务的 home_status 诊断，不要在本服务里拼 ssh。",
	"默认图 ~/anima-lab/graph-single1.json；换图用 workflowPath 或内联 workflow（API 格式）。",
	"中继按流量计费：大图/多图优先在家庭 LAN 内生成；超时返回带 promptId，可稍后查 /history 而非盲目重试。",
	"输出默认取回本地 .remote-files/comfyui/，返回 localPath 可直接 read_file 查看。",
].join("\n");

export async function callComfyuiTool(name: string, args: Record<string, unknown>) {
	if (name === "comfyui_generate") return comfyuiGenerate(args);
	return failure(`未知工具: ${name}`);
}
