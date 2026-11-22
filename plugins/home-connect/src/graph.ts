/**
 * ComfyUI API 格式图的参数化补丁（纯函数，无 IO）。
 * 控制面仅：正/负提示词、基础分辨率、模型、LoRA、SaveImage 前缀；
 * 采样细节（steps/cfg/sampler/scheduler/denoise 等）一律由 workflow 自身决定，
 * 唯一例外是 seed 由工具内部随机化（不暴露给调用方）。
 * 提示词为拼接语义：质量词/LoRA 触发词等基础面固化在 workflow 图内，
 * 调用方传入的提示词追加其后，不整体覆盖。
 * 超分链的 bypass/倍率由 tools-comfyui.ts 按模型绑定处理，不在本模块。
 */

export interface ComfyNode { class_type: string; inputs: Record<string, unknown>; }
export type ComfyGraph = Record<string, ComfyNode>;

function isLink(v: unknown): v is [string, number] {
	return Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
}

/** 拼接提示词：图内基础文本在前，调用方文本在后；基础以句号结尾时用空格连接，否则用逗号。 */
function joinPrompt(base: unknown, add: string): string {
	const b = typeof base === "string" ? base.trim() : "";
	const a = add.trim();
	if (!b) return a;
	if (!a) return b;
	return /[.!?。！？]$/.test(b) ? `${b} ${a}` : `${b}, ${a}`;
}

/** 沿 conditioning 链接回溯 CLIPTextEncode 节点（穿过 ConditioningCombine 等中间节点）。
 *  ConditioningZeroOut 截断：零化条件不携带文本语义（Krea2 管线的负向即零化正向）。 */
function traceConditioning(graph: ComfyGraph, link: unknown, depth = 0): string[] {
	if (!isLink(link) || depth > 6) return [];
	const node = graph[link[0]];
	if (!node) return [];
	if (node.class_type === "CLIPTextEncode") return [link[0]];
	if (node.class_type === "ConditioningZeroOut") return [];
	const out: string[] = [];
	for (const v of Object.values(node.inputs)) {
		if (isLink(v)) out.push(...traceConditioning(graph, v, depth + 1));
	}
	return out;
}

export function patchComfyGraph(graph: ComfyGraph, o: {
	prompt?: string; negativePrompt?: string;
	width?: number; height?: number;
	model?: string; lora?: string; filenamePrefix: string;
}): string[] {
	const notes: string[] = [];
	const pos = new Set<string>();
	const neg = new Set<string>();
	let loraNodes = 0;
	for (const [id, node] of Object.entries(graph)) {
		const ins = node.inputs;
		if ("positive" in ins && "negative" in ins) {
			for (const t of traceConditioning(graph, ins.positive)) pos.add(t);
			for (const t of traceConditioning(graph, ins.negative)) neg.add(t);
		}
		if (o.prompt !== undefined && typeof ins.prompt === "string") { ins.prompt = joinPrompt(ins.prompt, o.prompt); notes.push(`${id}.prompt`); }
		if (o.negativePrompt !== undefined && typeof ins.negative_prompt === "string") { ins.negative_prompt = joinPrompt(ins.negative_prompt, o.negativePrompt); notes.push(`${id}.negative_prompt`); }
		// seed 不暴露：内部随机化，避免固定 seed 导致同 prompt 重复出同一张图
		if (typeof ins.seed === "number") { ins.seed = Math.floor(Math.random() * 2 ** 32); notes.push(`${id}.seed`); }
		if (o.width !== undefined && typeof ins.width === "number") { ins.width = o.width; notes.push(`${id}.width`); }
		if (o.height !== undefined && typeof ins.height === "number") { ins.height = o.height; notes.push(`${id}.height`); }
		if (o.model !== undefined) {
			if (typeof ins.unet_name === "string") { ins.unet_name = o.model; notes.push(`${id}.unet_name`); }
			if (typeof ins.ckpt_name === "string") { ins.ckpt_name = o.model; notes.push(`${id}.ckpt_name`); }
		}
		if (node.class_type === "LoraLoader" && typeof ins.lora_name === "string") {
			loraNodes++;
			if (o.lora !== undefined) {
				if (o.lora === "none") {
					ins.strength_model = 0;
					ins.strength_clip = 0;
					notes.push(`${id}.lora(bypass)`);
				} else {
					ins.lora_name = o.lora;
					notes.push(`${id}.lora_name`);
				}
			}
		}
		if (node.class_type === "SaveImage" && typeof ins.filename_prefix === "string") { ins.filename_prefix = o.filenamePrefix; notes.push(`${id}.filename_prefix`); }
	}
	if (o.lora !== undefined && loraNodes === 0) throw new Error("指定了 lora 但该 workflow 没有 LoraLoader 节点（其 LoRA 由图内建节点管理或不含 LoRA）");
	if (o.prompt !== undefined) {
		if (pos.size === 0 && !notes.some((n) => n.endsWith(".prompt"))) throw new Error("指定了 prompt 但图中没有可补丁的正向条件节点（CLIPTextEncode 或 prompt 输入）");
		for (const id of pos) { graph[id].inputs.text = joinPrompt(graph[id].inputs.text, o.prompt); notes.push(`${id}.text(positive+base)`); }
	}
	if (o.negativePrompt !== undefined) {
		if (neg.size === 0 && !notes.some((n) => n.endsWith(".negative_prompt"))) throw new Error("指定了 negativePrompt 但图中没有可补丁的负向条件节点（如 Krea2 管线负向为零化条件）");
		for (const id of neg) { graph[id].inputs.text = joinPrompt(graph[id].inputs.text, o.negativePrompt); notes.push(`${id}.text(negative+base)`); }
	}
	return notes;
}
