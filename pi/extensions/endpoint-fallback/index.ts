/**
 * endpoint-fallback 核心实现 — 通用 provider 级 baseUrl 静默按需故障切换
 *
 * 在 models.json 的 provider 里声明备用端点（对任何 provider 生效，不限本地模型）：
 *
 *   "home-qwen": {
 *     "baseUrl": "http://192.168.31.25:8888/v1",          // 默认端点（主）
 *     "fallbackBaseUrl": "https://relay.example.com/v1",  // 备用端点
 *     "fallbackApiKey": "REDACTED",                       // 可选：备用端点鉴权 key
 *     "fallback": {
 *       "healthPath": "/health",
 *       "fallbackHealthPath": "/health",
 *       "retryPrimaryAfterMs": 60000                      // fallback 态下距上次请求超过该间隔时回试主端点（兼容 minHoldMs）
 *     }
 *   }
 *
 * 设计约束：
 * - 无后台定时轮询：绝不在空闲或使用其他 provider 时发起探测。
 * - 完全静默：自动切换/切回/双端点异常不弹 UI 通知、不写状态栏；仅手动 `/endpoint-status` 展示状态。
 * - 按需触发：仅当当前活跃模型命中受管 provider 并执行请求时生效；处于 fallback 态且距上次请求间隔超过阈值时自动重探主端点并切回。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface FallbackOptions {
	healthPath?: string;
	fallbackHealthPath?: string;
	retryPrimaryAfterMs?: number;
	minHoldMs?: number;
}

interface ProviderDef {
	baseUrl?: string;
	fallbackBaseUrl?: string;
	fallbackApiKey?: string;
	fallback?: FallbackOptions;
}

interface Monitored {
	name: string;
	primaryBaseUrl: string;
	fallbackBaseUrl: string;
	fallbackApiKey?: string;
	primaryHealthUrl: string;
	fallbackHealthUrl: string;
	retryPrimaryAfterMs: number;
	mode: "primary" | "fallback";
	switchedAt: number;
	lastRequestAt: number;
	lastProbeAt: number;
	bothDown: boolean;
}

const NETWORK_ERROR_RE =
	/fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EPROTO|socket hang up|network|timed? ?out|terminated|UND_ERR|aborted/i;

const DEFAULT_RETRY_PRIMARY_AFTER_MS = 60_000;
const PROBE_TIMEOUT_MS = 3000;

/** 默认探测 URL：去掉 baseUrl 尾部 /v1，再拼 /health。 */
export function defaultHealthUrl(baseUrl: string): string {
	const stripped = baseUrl.replace(/\/v1\/?$/, "");
	return stripped.replace(/\/+$/, "") + "/health";
}

export function resolveHealthUrl(baseUrl: string, healthPath?: string): string {
	if (!healthPath) return defaultHealthUrl(baseUrl);
	if (/^https?:\/\//i.test(healthPath)) return healthPath;
	const base = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
	return base + (healthPath.startsWith("/") ? healthPath : "/" + healthPath);
}

/** status < 500 视为可用（404/401 也说明服务在应答）；网络错误/超时/5xx 不可用。 */
export async function defaultProbe(url: string): Promise<boolean> {
	let res: Response | undefined;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "follow" });
		return res.status < 500;
	} catch {
		return false;
	} finally {
		await res?.body?.cancel().catch(() => {});
	}
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
	const num = Number(value);
	return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

function defaultModelsPath(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configured || join(homedir(), ".pi", "agent");
	return join(agentDir, "models.json");
}

export type EndpointFallbackDeps = {
	modelsPath?: () => string;
	probe?: (url: string) => Promise<boolean>;
	now?: () => number;
};

export function createEndpointFallbackExtension(pi: ExtensionAPI, deps: EndpointFallbackDeps = {}) {
	const resolveModelsPath = deps.modelsPath ?? defaultModelsPath;
	const probe = deps.probe ?? defaultProbe;
	const nowFn = deps.now ?? Date.now;

	let providers: Monitored[] = [];
	let preparedByBeforeAgent = false;

	const restoreFallbacks = (): void => {
		for (const m of providers) {
			if (m.mode === "fallback") {
				try {
					pi.unregisterProvider(m.name);
				} catch {
					// ignore
				}
			}
		}
	};

	const load = (): void => {
		restoreFallbacks();
		providers = [];
		preparedByBeforeAgent = false;
		let raw: string;
		try {
			raw = readFileSync(resolveModelsPath(), "utf8");
		} catch {
			return;
		}
		let doc: { providers?: Record<string, ProviderDef> };
		try {
			doc = JSON.parse(raw);
		} catch {
			return;
		}
		for (const [name, p] of Object.entries(doc.providers ?? {})) {
			if (typeof p?.baseUrl !== "string" || typeof p?.fallbackBaseUrl !== "string") continue;
			const opt = p.fallback ?? {};
			const retryRaw = opt.retryPrimaryAfterMs ?? opt.minHoldMs;
			providers.push({
				name,
				primaryBaseUrl: p.baseUrl,
				fallbackBaseUrl: p.fallbackBaseUrl,
				fallbackApiKey: typeof p.fallbackApiKey === "string" ? p.fallbackApiKey : undefined,
				primaryHealthUrl: resolveHealthUrl(p.baseUrl, opt.healthPath),
				fallbackHealthUrl: resolveHealthUrl(p.fallbackBaseUrl, opt.fallbackHealthPath),
				retryPrimaryAfterMs: clampNonNegativeInt(retryRaw, DEFAULT_RETRY_PRIMARY_AFTER_MS),
				mode: "primary",
				switchedAt: 0,
				lastRequestAt: 0,
				lastProbeAt: 0,
				bothDown: false,
			});
		}
	};

	const doFailover = (m: Monitored): void => {
		if (m.mode === "fallback") return;
		try {
			pi.registerProvider(
				m.name,
				m.fallbackApiKey ? { baseUrl: m.fallbackBaseUrl, apiKey: m.fallbackApiKey } : { baseUrl: m.fallbackBaseUrl },
			);
		} catch {
			return;
		}
		m.mode = "fallback";
		m.switchedAt = nowFn();
	};

	const doFailback = (m: Monitored): boolean => {
		if (m.mode !== "fallback") return false;
		try {
			pi.unregisterProvider(m.name);
		} catch {
			return false;
		}
		m.mode = "primary";
		m.switchedAt = 0;
		m.bothDown = false;
		return true;
	};

	const probeAndSync = async (m: Monitored, now: number): Promise<void> => {
		m.lastProbeAt = now;
		const primaryOk = await probe(m.primaryHealthUrl);
		if (primaryOk) {
			if (m.mode === "fallback") doFailback(m);
			m.bothDown = false;
			return;
		}
		if (m.mode === "primary") {
			doFailover(m);
		}
		const fallbackOk = await probe(m.fallbackHealthUrl);
		m.bothDown = !fallbackOk;
	};

	const prepareForRequest = async (providerName: string | undefined): Promise<void> => {
		if (!providerName) return;
		const m = providers.find((p) => p.name === providerName);
		if (!m) return;
		const now = nowFn();
		if (m.mode === "primary") {
			if (m.lastRequestAt === 0) {
				m.lastProbeAt = now;
				const primaryOk = await probe(m.primaryHealthUrl);
				if (!primaryOk) {
					doFailover(m);
				}
			}
		} else if (now - m.lastRequestAt >= m.retryPrimaryAfterMs) {
			m.lastProbeAt = now;
			const primaryOk = await probe(m.primaryHealthUrl);
			if (primaryOk) {
				doFailback(m);
			}
		}
		m.lastRequestAt = now;
	};

	pi.on("session_start", async () => {
		load();
	});

	pi.on("session_shutdown", async () => {
		restoreFallbacks();
		providers = [];
		preparedByBeforeAgent = false;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		preparedByBeforeAgent = true;
		await prepareForRequest(ctx.model?.provider);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (preparedByBeforeAgent) {
			preparedByBeforeAgent = false;
			return;
		}
		await prepareForRequest(ctx.model?.provider);
	});

	pi.on("agent_end", async () => {
		preparedByBeforeAgent = false;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const m = providers.find((p) => p.name === msg.provider);
		if (!m) return;
		const now = nowFn();
		m.lastRequestAt = now;
		if (msg.stopReason !== "error" || !msg.errorMessage) {
			m.bothDown = false;
			return;
		}
		if (!NETWORK_ERROR_RE.test(msg.errorMessage)) return;
		m.lastProbeAt = now;
		if (m.mode === "primary") {
			const ok = await probe(m.primaryHealthUrl);
			if (!ok) {
				doFailover(m);
			}
		} else {
			const ok = await probe(m.fallbackHealthUrl);
			m.bothDown = !ok;
		}
	});

	pi.registerCommand("endpoint-status", {
		description: "显示 endpoint-fallback 状态；带 probe 参数立即强制探测一轮",
		handler: async (args, ctx: ExtensionContext) => {
			if (providers.length === 0) {
				ctx.ui.notify("endpoint-fallback: models.json 中没有声明 fallbackBaseUrl 的 provider", "info");
				return;
			}
			const force = /probe/i.test(args ?? "");
			if (force) {
				const now = nowFn();
				for (const m of providers) {
					await probeAndSync(m, now);
				}
			}
			for (const m of providers) {
				const lastReq = m.lastRequestAt ? `${Math.round((nowFn() - m.lastRequestAt) / 1000)}s 前` : "尚无请求";
				const retrySec = Math.round(m.retryPrimaryAfterMs / 1000);
				ctx.ui.notify(
					`${m.name}: ${m.mode.toUpperCase()}  上次请求 ${lastReq}  回试主端点间隔 ${retrySec}s` +
						(m.bothDown ? "  ⚠ 双端点不可用" : ""),
					m.mode === "fallback" ? "warning" : "info",
				);
			}
		},
	});
}
