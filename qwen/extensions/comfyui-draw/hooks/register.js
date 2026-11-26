// /draw 命令的 Mod 实现（需 experimental.mods）：
//   session.start：注册 Mod 命令 draw（替代 prompt.submit 拦截——实测 slash 命令输入
//                  不触发 prompt.submit，命令必须由 Mod 命令本体接管）；
//   command.run：解析 args 末尾 {...} 片段并缓存到模块变量，把自然语言部分经
//                $.prompt.submit(asUser) 作为 Mod 自己的 prompt 送入模型（模型零暴露片段）；
//   prompt.submit：为本插件来源的 prompt 附加生图契约 context；普通用户文本清残留片段；
//   tool.call：第一次 comfyui_generate 调用时把片段机械追加进 prompt 参数（消费一次）。
// Web Shell/ACP 中 $.prompt.submit 会被 drop（片段已缓存但无 prompt 触发模型）、Mods 禁用时命令不存在
// （需开启 experimental.mods）——两种情况均无降级路径，/draw 不可用。

let drawFragment = null;

const FRAGMENT_RE = /\{([^{}]*)\}\s*$/;

const CONTRACT_HEAD = [
	'[/draw] 用 comfyui MCP 服务生图（comfyui_generate / comfyui_list；模型→workflow 绑定与角色 LoRA 配方见 comfyui skill）。',
	'把场景、主体、风格、角色触发词写进 comfyui_generate 的 prompt 参数；不要堆通用质量词（workflow 已内置基础质量词，拼接语义）。',
];
const CONTRACT_TAIL = '生成完成后把 localPath 展示给用户（终端不可预览时用 open 打开）。';

function contract(hasFragment) {
	return [
		...CONTRACT_HEAD,
		hasFragment
			? '用户另钦定了一段固定提示词片段，已由系统机械缓存，会自动原样追加到你第一次 comfyui_generate 调用的 prompt 参数末尾——你不需要、也不要试图猜测或包含它，只按上面的自然语言要求写场景即可；若需第二次调用，同样不用管该片段。'
			: '本次没有 {} 钦定片段，按自然语言要求正常生图即可。',
		CONTRACT_TAIL,
	].join('\n');
}

export function register(on) {
	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'draw',
			description: 'ComfyUI 生图——自然语言交给 agent，{花括号}内文本机械进入正向提示词',
			argumentHint: '<自然语言要求> {固定片段}',
		});
		return next(e);
	});

	on('command.run', { command: 'draw' }, ($, e) => {
		let rest = (e.args || '').trim();
		let fragment = '';
		const fm = rest.match(FRAGMENT_RE);
		if (fm) {
			fragment = fm[1].trim();
			rest = rest.slice(0, fm.index).trim();
		}
		drawFragment = fragment || null;
		const text = rest || '按 /draw 契约调用 ComfyUI 生图并展示结果。';
		void $.prompt.submit({ text, asUser: true });
		return { text: fragment ? '片段已机械缓存，转交模型生图…' : '转交模型生图…' };
	});

	on('prompt.submit', ($, e, next) => {
		if (e.origin?.kind === 'plugin' && e.origin?.name === 'comfyui-draw')
			return next({ ...e, context: [...(e.context ?? []), contract(Boolean(drawFragment))] });
		drawFragment = null;
		return next(e);
	});

	on('tool.call', { tool: /comfyui_generate/ }, ($, e, next) => {
		const fragment = drawFragment;
		drawFragment = null;
		if (!fragment || typeof e.prompt !== 'string' || e.prompt.includes(fragment)) return next(e);
		const current = e.prompt.trim();
		return next({ ...e, prompt: current ? `${current}, ${fragment}` : fragment });
	});
}
