/**
 * comfyui 工具：经 home-connect 连接层（wsl 通道）驱动 ComfyUI HTTP API 生图。
 *
 * 控制面仅暴露：正/负提示词、基础分辨率、模型、超分倍率、LoRA 选择。
 * 模型 → workflow 的绑定在 MODEL_BINDINGS 内置（调用方不感知 workflow）；
 * 采样细节（steps/cfg/sampler/scheduler/denoise）一律由绑定的 workflow 决定。
 * 全部远程操作走 execRemote/copyFile。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { HOST_MODE, PLUGIN_ROOT, RUNTIME_ROOT, acquireCopy, comfyCurl, copyBusy, copyFile, execRemote, releaseCopy } from "./connection.ts";
import { patchComfyGraph, type ComfyGraph } from "./graph.ts";
import { failure, textResult, type ToolDefinition } from "./mcp.ts";

const COMFY_PORT = 8188;
const COMFY_START_SCRIPT = "~/.config/comfy-start.sh";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 超分链绑定：scale_by = 目标净倍率 / modelFactor；upscale=1 时删除整条 hires 链（含 finalSave）。 */
interface HiresBinding {
	scaleNode: string;
	modelFactor: number;
	finalSave: string;
	pruneNodes: string[];
}

interface ModelBinding {
	/** local=true 时为相对插件根的仓内路径；否则为 WSL 侧路径（~ 开头）。 */
	workflow: string;
	local?: boolean;
	defaultUpscale?: number;
	hires?: HiresBinding;
}

/** 模型 → workflow 绑定。节点 ID 为对应图的内部契约，改图时需同步更新。 */
const MODEL_BINDINGS: Record<string, ModelBinding> = {
	"oneObsessionAnima_v40.safetensors": {
		// 抄自 Mac ~/yugang/src/tools/draw/workflow-interaction-single.json（API 格式）；
		// 原图 node4 为 AnimaLoRARemapTagLoader（lab 实例未装），仓内副本已适配为 LoraLoader（输出槽同 MODEL/CLIP）。
		workflow: "workflows/anima-interaction-single.json",
		local: true,
		defaultUpscale: 2,
		hires: {
			scaleNode: "23",
			modelFactor: 4,
			finalSave: "38",
			pruneNodes: ["21", "22", "23", "24", "25", "26", "27", "28"],
		},
	},
	"Moody-Krea2-Mix-v7-fp8.safetensors": {
		// 由 anima-prod 的 UI 图 Krea2_Moody_v7.json 转换而来（Krea2 管线，无超分链/LoRA）
		workflow: "workflows/krea2-moody-v7.json",
		local: true,
		defaultUpscale: 1,
	},
};
const DEFAULT_MODEL = "oneObsessionAnima_v40.safetensors";

async function comfyuiGenerate(args: Record<string, unknown>) {
	try {
		return await comfyuiGenerateInner(args);
	} catch (error) {
		return failure(`comfyui_generate 异常: ${(error as Error).message}`);
	}
}

async function comfyuiGenerateInner(args: Record<string, unknown>) {
	const timeoutSec = typeof args.timeoutSec === "number" ? Math.min(Math.max(args.timeoutSec, 30), 1800) : 600;
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSec * 1000;

	const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : DEFAULT_MODEL;
	const binding = MODEL_BINDINGS[model];
	if (!binding) {
		return failure(`模型 ${model} 未绑定 workflow；已绑定: ${Object.keys(MODEL_BINDINGS).join(", ")}（comfyui_list 可查可用模型与绑定状态）`);
	}

	const exec = (command: string, t = 60) => execRemote("wsl", command, t);

	// 1) API 存活；未运行时自启（经用户的 comfy-start.sh，脱离 SSH 存活）
	const stats = await comfyCurl("/system_stats", { curlTimeoutSec: 8, execTimeoutSec: 45 });
	let autostarted = false;
	if (stats.result.code !== 0 || !stats.result.stdout.trim()) {
		const start = await exec(`nohup bash ${COMFY_START_SCRIPT} >/dev/null 2>&1 & echo comfyui-started`, 60);
		if (start.result.code !== 0) return failure(`ComfyUI 自启失败: ${start.result.stderr.trim()}`);
		autostarted = true;
		let up = false;
		for (let i = 0; i < 36 && Date.now() < deadline; i++) {
			await sleep(5000);
			const probe = await comfyCurl("/system_stats", { curlTimeoutSec: 8, execTimeoutSec: 45 });
			if (probe.result.code === 0 && probe.result.stdout.includes("comfyui_version")) { up = true; break; }
		}
		if (!up) return failure("ComfyUI 自启后 180s 内仍未就绪；请在 WSL 上检查 ~/anima-lab/comfy.log");
	}

	// 2) 按绑定加载图（仓内文件或 WSL 侧文件）
	let graph: ComfyGraph;
	if (binding.local) {
		try {
			graph = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, binding.workflow), "utf8"));
		} catch (error) {
			return failure(`读取仓内 workflow 失败 ${binding.workflow}: ${(error as Error).message}`);
		}
	} else {
		const cat = await exec(`cat ${binding.workflow}`, 45);
		if (cat.result.code !== 0) return failure(`读取 workflow 失败 ${binding.workflow}: ${cat.result.stderr.trim()}`);
		try { graph = JSON.parse(cat.result.stdout); } catch { return failure(`${binding.workflow} 不是合法 JSON（需要 API 格式图）`); }
	}
	for (const [id, node] of Object.entries(graph)) {
		if (!node || typeof node !== "object" || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
			return failure(`图节点 ${id} 缺少 class_type/inputs：不是 API 格式（UI 图需先“导出 API”）`);
		}
	}

	// 3) 超分倍率：1 = bypass hires 链；>1 = 净倍率（scale_by = 倍率 / 放大模型倍率）
	const upscale = typeof args.upscale === "number" ? args.upscale : (binding.defaultUpscale ?? 1);
	if (!(upscale >= 1)) return failure("upscale 必须 >= 1");
	if (binding.hires) {
		if (upscale === 1) {
			// bypass：删除整条 hires 链与 finalSave，只留 initial SaveImage，避免重复输出
			for (const id of [...binding.hires.pruneNodes, binding.hires.finalSave]) delete graph[id];
		} else {
			const scaleNode = graph[binding.hires.scaleNode];
			if (!scaleNode) return failure(`绑定契约失效：图缺少节点 ${binding.hires.scaleNode}`);
			scaleNode.inputs.scale_by = upscale / binding.hires.modelFactor;
		}
	} else if (upscale !== 1) {
		return failure(`模型 ${model} 绑定的 workflow 无超分链，upscale 只能为 1`);
	}

	// 4) 参数化补丁（控制面之外的细节不动）
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filenamePrefix = `home-connect/${stamp}`;
	let patches: string[];
	try {
		patches = patchComfyGraph(graph, {
			prompt: typeof args.prompt === "string" ? args.prompt : undefined,
			negativePrompt: typeof args.negativePrompt === "string" ? args.negativePrompt : undefined,
			width: typeof args.width === "number" ? args.width : undefined,
			height: typeof args.height === "number" ? args.height : undefined,
			model,
			lora: typeof args.lora === "string" ? args.lora : undefined,
			filenamePrefix,
		});
	} catch (error) { return failure((error as Error).message); }

	// 5) 提交（stdio：heredoc 落盘 + curl -d @file；宿主模式：本机 curl 落临时文件；JSON 零转义）
	const submit = await comfyCurl("/prompt", { payload: { prompt: graph, client_id: "comfyui-mcp" }, curlTimeoutSec: 30, execTimeoutSec: 90 });
	if (submit.result.code !== 0) return failure(`提交失败: ${submit.result.stderr.trim() || submit.result.stdout.trim()}`);
	let submitted: { prompt_id?: string; number?: number; node_errors?: Record<string, unknown> };
	try { submitted = JSON.parse(submit.result.stdout); } catch { return failure(`提交响应非 JSON: ${submit.result.stdout.slice(0, 500)}`); }
	if (submitted.node_errors && Object.keys(submitted.node_errors).length > 0) {
		return failure(`图校验失败 node_errors: ${JSON.stringify(submitted.node_errors).slice(0, 2000)}`);
	}
	const promptId = submitted.prompt_id;
	if (!promptId) return failure(`提交响应缺少 prompt_id: ${submit.result.stdout.slice(0, 500)}`);

	// 6) 轮询 /history 至完成
	let history: { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type: string }> }>; status?: { status_str?: string; completed?: boolean; messages?: unknown } } | null = null;
	while (Date.now() < deadline) {
		await sleep(3000);
		const h = await comfyCurl(`/history/${promptId}`, { curlTimeoutSec: 10, execTimeoutSec: 45 });
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

	// 7) 收集输出并在 WSL 侧解析绝对路径（运行实例的 cwd / --base-directory 推导 output 根）
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
		`pids = subprocess.run(["pgrep", "-f", "main.py.*--port ${COMFY_PORT}"], capture_output=True, text=True).stdout.split()`,
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
	let paths: string[] = [];
	if (!HOST_MODE) {
		const resolved = await exec(resolveCmd, 60);
		if (resolved.result.code !== 0) return failure(`输出路径解析失败: ${resolved.result.stderr.trim()}`);
		paths = resolved.result.stdout.trim().split("\n");
	}

	// 8) 取回本地（进程内单飞门禁；跨进程见 connection.ts 说明）。
	//    宿主模式与 ComfyUI 同机可达，直接经 /view 下载；stdio 模式在 WSL 侧解析绝对路径后走连接层。
	const localDir = resolve(RUNTIME_ROOT, ".remote-files", "comfyui");
	mkdirSync(localDir, { recursive: true });
	while (copyBusy() && Date.now() < deadline) await sleep(2000);
	if (!acquireCopy()) return failure("文件传输通道忙，无法取回图片；稍后重试");
	const outputs: Array<Record<string, unknown>> = [];
	try {
		for (let i = 0; i < images.length; i++) {
			const entry: Record<string, unknown> = { nodeId: images[i].nodeId, filename: images[i].filename, subfolder: images[i].subfolder };
			let localPath = resolve(localDir, images[i].filename);
			if (existsSync(localPath)) localPath = resolve(localDir, `${Date.now()}-${images[i].filename}`);
			if (HOST_MODE) {
				outputs.push(entry);
				const view = `/view?filename=${encodeURIComponent(images[i].filename)}&subfolder=${encodeURIComponent(images[i].subfolder)}&type=output`;
				const got = await comfyCurl(view, { outputFile: localPath, curlTimeoutSec: 180, execTimeoutSec: 210 });
				if (got.result.code === 0 && got.result.stdout.trim() === "200" && existsSync(localPath)) {
					entry.localPath = localPath;
					entry.bytes = statSync(localPath).size;
				} else {
					entry.error = `取回失败: HTTP ${got.result.stdout.trim() || got.result.code} ${got.result.stderr.trim().slice(0, 300)}`;
				}
				continue;
			}
			const remotePath = paths[i] ?? "NOT_FOUND";
			entry.remotePath = remotePath;
			if (remotePath.startsWith("NOT_FOUND")) { entry.error = "WSL 上未找到输出文件"; outputs.push(entry); continue; }
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
	const ok = outputs.some((o) => o.localPath);
	return textResult({
		promptId,
		model,
		upscale,
		channel: stats.channel,
		woke: stats.woke,
		autostarted,
		filenamePrefix,
		elapsedSec: Math.round((Date.now() - startedAt) / 1000),
		patches,
		outputs,
	}, !ok);
}

/** 查询可用模型/LoRA/放大模型；模型附带 workflow 绑定状态。清单解析在本进程完成，两种模式共用。 */
async function comfyuiList() {
	const namesOf = (spec: unknown): string[] => {
		if (!Array.isArray(spec)) return [];
		if (spec.length > 0 && Array.isArray(spec[0])) return spec[0].filter((n): n is string => typeof n === "string");
		const extra = spec[1] as { options?: unknown } | undefined;
		if (extra && typeof extra === "object" && Array.isArray(extra.options)) {
			return extra.options.filter((n): n is string => typeof n === "string");
		}
		return [];
	};
	const sections: Record<string, string[]> = {};
	for (const node of ["CheckpointLoaderSimple", "UNETLoader", "LoraLoader", "UpscaleModelLoader"]) {
		const { result } = await comfyCurl(`/object_info/${node}`, { curlTimeoutSec: 15, execTimeoutSec: 90 });
		if (result.code !== 0) return failure(`查询失败（ComfyUI 未运行？先 comfyui_generate 自启或 home_status 诊断）: ${result.stderr.trim()}`);
		sections[node] = [];
		try {
			const info = JSON.parse(result.stdout) as Record<string, { input?: { required?: Record<string, unknown> } }>;
			for (const def of Object.values(info ?? {})) {
				const required = def?.input?.required ?? {};
				for (const key of ["ckpt_name", "unet_name", "lora_name", "model_name"]) {
					if (key in required) sections[node].push(...namesOf(required[key]));
				}
			}
		} catch { /* 该节点未安装（空响应），跳过 */ }
	}
	const models = [...new Set([...(sections.CheckpointLoaderSimple ?? []), ...(sections.UNETLoader ?? [])])];
	if (models.length === 0) return failure("ComfyUI 未返回模型清单（服务未就绪或 API 异常）");
	return textResult({
		models: models.map((name) => ({ name, bound: name in MODEL_BINDINGS })),
		loras: sections.LoraLoader ?? [],
		upscaleModels: sections.UpscaleModelLoader ?? [],
	});
}

export const COMFYUI_TOOLS: ToolDefinition[] = [
	{
		name: "comfyui_generate",
		description:
			"驱动 WSL 上的 ComfyUI 生图并把结果取回本地，复用 home-connect 连接层（LAN 直连/中继自动选路、WSL 自动唤醒）。控制面仅：prompt/negativePrompt、model、width/height（基础分辨率）、upscale（超分净倍率，1=关闭超分链）、lora（名称或 none  bypass）。模型→workflow 绑定内置（调用方不感知 workflow）；steps/cfg/sampler 等细节由 workflow 决定，seed 内部随机。ComfyUI 未运行时经 ~/.config/comfy-start.sh 自动启动。输出取回插件 .remote-files/comfyui/，返回 localPath 可直接查看。可用模型/LoRA 用 comfyui_list 查询；中继按流量计费，大图/多图优先 LAN。",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "正向提示词（场景与主体内容）；拼接在 workflow 内置基础质量提示词之后，只写场景不要堆质量词。" },
				negativePrompt: { type: "string", description: "负向提示词；拼接到 workflow 内置基础负向后（零化负向的管线如 Krea2 不支持，会报错）。" },
				model: { type: "string", description: `模型名（comfyui_list 中 bound=true 的可用）；默认 ${DEFAULT_MODEL}。` },
				width: { type: "number", description: "基础分辨率宽（不改动 pose scene_json）。" },
				height: { type: "number", description: "基础分辨率高。" },
				upscale: { type: "number", minimum: 1, description: "超分净倍率：1=仅基础分辨率（bypass 超分链），2=2 倍最终输出；默认取绑定值。无超分链的绑定只能为 1。" },
				lora: { type: "string", description: "LoRA 名（comfyui_list 查询）；none=零强度 bypass；省略=用 workflow 自带 LoRA。" },
				timeoutSec: { type: "number", minimum: 30, maximum: 1800, description: "整体超时秒数（运维参数），默认 600。" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "comfyui_list",
		description:
			"查询 WSL ComfyUI 当前可用的模型（checkpoints/diffusion models，附 workflow 绑定状态 bound）、LoRA 与放大模型清单。选 model/lora 前先查这个，不要猜名字。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true },
	},
];

/** 服务说明：stdio 与宿主模式的差别只在输出怎么到调用方手里。 */
export function comfyuiInstructions(): string {
	const output = HOST_MODE
		? "输出图片随结果直接返回（image 内容块）；outputs[].localPath 是 mac 上的保存路径，远端客户端读不到该文件。"
		: "输出取回本地 .remote-files/comfyui/，返回 localPath 可直接 read_file 查看。";
	return [
	"本服务负责 WSL ComfyUI 生图（comfyui_generate）与资源查询（comfyui_list）；连接层与 home-connect 共享。",
	"控制面只有 prompt/negativePrompt/model/width/height/upscale/lora；模型→workflow 绑定内置，不要试图传 workflow 或采样细节。",
	"提示词为拼接语义：基础质量词已固化在 workflow 图内；风格、角色触发词与场景由 prompt 提供，不要重复堆质量词。",
	"选 model/lora 前先 comfyui_list（bound=false 的模型未绑定 workflow，generate 会拒绝）。",
	"连接异常（WSL 休眠、通道不可达）先用 home 服务的 home_status 诊断，不要在本服务里拼 ssh。",
	"中继按流量计费：大图/多图优先在家庭 LAN 内生成；超时返回带 promptId，可稍后查 /history 而非盲目重试。",
	output,
	"从 Civitai 下载模型/LoRA 用 comfyui-download skill（经 home_exec wsl 通用操作），本服务不提供下载工具。",
	].join("\n");
}

export async function callComfyuiTool(name: string, args: Record<string, unknown>) {
	if (name === "comfyui_generate") return comfyuiGenerate(args);
	if (name === "comfyui_list") return comfyuiList();
	return failure(`未知工具: ${name}`);
}
