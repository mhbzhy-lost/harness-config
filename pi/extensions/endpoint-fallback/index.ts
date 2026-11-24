/**
 * endpoint-fallback 核心实现 — 通用 provider 级 baseUrl 自动故障切换
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
 *       "probeIntervalMs": 10000,
 *       "failAfter": 2,
 *       "recoverAfter": 2,
 *       "minHoldMs": 30000
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface FallbackOptions {
	healthPath?: string;
	fallbackHealthPath?: string;
	probeIntervalMs?: number;
	failAfter?: number;
	recoverAfter?: number;
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
	probeIntervalMs: number;
	failAfter: number;
	recoverAfter: number;
	minHoldMs: number;
	mode: "primary" | "fallback";
	primaryFailStreak: number;
	primaryOkStreak: number;
	fallbackFailStreak: number;
	switchedAt: number;
	lastProbeAt: number;
	bothDown: boolean;
}

const NETWORK_ERROR_RE =
	/fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EPROTO|socket hang up|network|timed? ?out|terminated|UND_ERR|aborted/i;

const MIN_PROBE_INTERVAL_MS = 1000;
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
async function defaultProbe(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "follow" });
		return res.status < 500;
	} catch {
		return false;
	}
}

function clampPositiveInt(value: unknown, fallback: number, min = 1): number {
	const num = Number(value);
	return Number.isFinite(num) && num >= min ? Math.floor(num) : fallback;
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
	let timer: ReturnType<typeof setInterval> | undefined;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	let probing = false;
	let lastCtx: ExtensionContext | undefined;

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
			providers.push({
				name,
				primaryBaseUrl: p.baseUrl,
				fallbackBaseUrl: p.fallbackBaseUrl,
				fallbackApiKey: typeof p.fallbackApiKey === "string" ? p.fallbackApiKey : undefined,
				primaryHealthUrl: resolveHealthUrl(p.baseUrl, opt.healthPath),
				fallbackHealthUrl: resolveHealthUrl(p.fallbackBaseUrl, opt.fallbackHealthPath),
				probeIntervalMs: clampPositiveInt(opt.probeIntervalMs, 10_000, MIN_PROBE_INTERVAL_MS),
				failAfter: clampPositiveInt(opt.failAfter, 2, 1),
				recoverAfter: clampPositiveInt(opt.recoverAfter, 2, 1),
				minHoldMs: clampPositiveInt(opt.minHoldMs, 30_000, 0),
				mode: "primary",
				primaryFailStreak: 0,
				primaryOkStreak: 0,
				fallbackFailStreak: 0,
				switchedAt: 0,
				lastProbeAt: 0,
				bothDown: false,
			});
		}
	};

	const notify = (text: string, kind: "info" | "warning" | "error"): void => {
		const ui = lastCtx?.hasUI ? lastCtx.ui : undefined;
		if (ui) ui.notify(text, kind);
	};

	const statusText = (): string | undefined => {
		const active = providers.filter((m) => m.mode === "fallback");
		if (active.length === 0) return undefined;
		return `endpoint-fallback: ${active.map((m) => m.name).join(", ")} → fallback`;
	};

	const doFailover = (m: Monitored): void => {
		if (m.mode === "fallback") return;
		try {
			pi.registerProvider(
				m.name,
				m.fallbackApiKey ? { baseUrl: m.fallbackBaseUrl, apiKey: m.fallbackApiKey } : { baseUrl: m.fallbackBaseUrl },
			);
		} catch (err) {
			notify(`endpoint-fallback: ${m.name} 切换失败: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		m.mode = "fallback";
		m.switchedAt = nowFn();
		m.primaryFailStreak = 0;
		m.primaryOkStreak = 0;
		notify(
			`endpoint-fallback: ${m.name} 主端点不可用，已切换到备用端点（${m.fallbackBaseUrl}）`,
			"warning",
		);
		if (lastCtx?.hasUI) lastCtx.ui.setStatus("endpoint-fallback", statusText());
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
		m.primaryFailStreak = 0;
		m.primaryOkStreak = 0;
		m.fallbackFailStreak = 0;
		m.bothDown = false;
		notify(`endpoint-fallback: ${m.name} 主端点已恢复，切回 ${m.primaryBaseUrl}`, "info");
		if (lastCtx?.hasUI) lastCtx.ui.setStatus("endpoint-fallback", statusText());
		return true;
	};

	const probeOne = async (m: Monitored, now: number): Promise<void> => {
		const primaryOk = await probe(m.primaryHealthUrl);
		if (m.mode === "primary") {
			if (primaryOk) {
				m.primaryFailStreak = 0;
				m.primaryOkStreak++;
			} else {
				m.primaryOkStreak = 0;
				m.primaryFailStreak++;
				if (m.primaryFailStreak >= m.failAfter) doFailover(m);
			}
			return;
		}
		if (primaryOk) {
			m.primaryOkStreak++;
			m.primaryFailStreak = 0;
			if (m.primaryOkStreak >= m.recoverAfter && now - m.switchedAt >= m.minHoldMs) {
				if (doFailback(m)) return;
			}
		} else {
			m.primaryOkStreak = 0;
		}
		const fallbackOk = await probe(m.fallbackHealthUrl);
		if (fallbackOk) {
			if (m.bothDown) {
				m.bothDown = false;
				notify(`endpoint-fallback: ${m.name} 备用端点已恢复`, "info");
			}
			m.fallbackFailStreak = 0;
		} else if (!m.bothDown) {
			m.bothDown = true;
			m.fallbackFailStreak++;
			notify(`endpoint-fallback: ${m.name} 主端点与备用端点均不可用，请求将失败`, "error");
		}
	};

	const tickAll = async (force: boolean): Promise<void> => {
		if (probing || providers.length === 0) return;
		probing = true;
		try {
			const now = nowFn();
			for (const m of providers) {
				if (!force && now - m.lastProbeAt < m.probeIntervalMs) continue;
				m.lastProbeAt = now;
				await probeOne(m, now);
			}
		} finally {
			probing = false;
		}
	};

	const stopTimer = (): void => {
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = undefined;
		}
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		stopTimer();
		load();
		if (providers.length === 0) return;
		void tickAll(true);
		startupTimer = setTimeout(() => {
			startupTimer = undefined;
			void tickAll(true);
		}, 1500);
		startupTimer.unref?.();
		const interval = Math.max(MIN_PROBE_INTERVAL_MS, Math.min(...providers.map((m) => m.probeIntervalMs)));
		timer = setInterval(() => void tickAll(false), interval);
		timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		restoreFallbacks();
		providers = [];
		lastCtx = undefined;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if (msg.stopReason !== "error" || !msg.errorMessage) return;
		if (!NETWORK_ERROR_RE.test(msg.errorMessage)) return;
		const m = providers.find((p) => p.name === msg.provider);
		if (!m) return;
		if (m.mode === "primary") {
			const ok = await probe(m.primaryHealthUrl);
			if (!ok) {
				m.primaryFailStreak = m.failAfter;
				doFailover(m);
			}
		} else {
			const ok = await probe(m.fallbackHealthUrl);
			if (!ok && !m.bothDown) {
				m.bothDown = true;
				notify(`endpoint-fallback: ${m.name} 主端点与备用端点均不可用，请求将失败`, "error");
			}
		}
	});

	pi.registerCommand("endpoint-status", {
		description: "显示 endpoint-fallback 状态；带 probe 参数立即强制探测一轮",
		handler: async (args, ctx) => {
			const force = /probe/i.test(args ?? "");
			if (force) await tickAll(true);
			if (providers.length === 0) {
				ctx.ui.notify("endpoint-fallback: models.json 中没有声明 fallbackBaseUrl 的 provider", "info");
				return;
			}
			for (const m of providers) {
				const age = m.lastProbeAt ? `${Math.round((nowFn() - m.lastProbeAt) / 1000)}s 前` : "尚未探测";
				ctx.ui.notify(
					`${m.name}: ${m.mode.toUpperCase()}  主端点连续成功 ${m.primaryOkStreak} / 失败 ${m.primaryFailStreak}  上次探测 ${age}` +
						(m.bothDown ? "  ⚠ 双端点不可用" : ""),
					m.mode === "fallback" ? "warning" : "info",
				);
			}
		},
	});
}
