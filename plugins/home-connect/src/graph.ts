/**
 * ComfyUI API 格式图的校验与参数化补丁（纯函数，无 IO）。
 * 补丁规则见 patchComfyGraph：条件节点沿采样器链接回溯，采样参数按键名匹配，
 * pose scene_json 等字符串内嵌配置不动。
 */

export interface ComfyNode { class_type: string; inputs: Record<string, unknown>; }
export type ComfyGraph = Record<string, ComfyNode>;

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

export function patchComfyGraph(graph: ComfyGraph, o: {
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
