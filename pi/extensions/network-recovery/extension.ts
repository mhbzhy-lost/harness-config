// 断网兜底状态机：pi 内置 agent 级重试（retry.maxRetries）耗尽后，若本轮 run 以
// 「连接错误」结束，则排一个 30 分钟的定时器，到点先探活再唤醒一轮工作；
// 唤醒后仍报连接错误则继续排下一轮，直到出现正常 assistant 回复为止。
//
// 触发信号只有一个：`agent_settled`（pi 已无自动重试/压缩/排队续跑的最终静止点）。
// 取消（“已有新的工作记录”）有三条路径：
// 1. 用户输入（`input` 且 source 非 extension）；
// 2. 外部工作开始（`agent_start` 落在 waiting 态）；
// 3. 出现非 error/aborted 的 assistant 回复（`turn_end`）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PROBE_TIMEOUT_MS, probeEndpointReachability, type ProbeOptions } from "./probe.ts";
import { resolveNetworkRecoveryConfig } from "./settings.ts";

/** 只匹配 pi 内置重试耗尽后仍存在的连接错误（TUI 显示为 `Error: Connection error.`）。 */
const CONNECTION_ERROR_PATTERN = /\bconnection error\b/i;

/** 连续探活失败上限：达到后 fail-open 强制唤醒一次。 */
const MAX_PROBE_FAILURES_BEFORE_FORCE = 2;

const RESUME_PROMPT = "（自动重连）网络连接已恢复，请继续之前未完成的工作，不要重复已经完成的步骤。";

const NOTICE_PREFIX = "[network-recovery]";

type Phase = "idle" | "waiting" | "attempting";

export type NetworkRecoveryState = {
  phase: Phase;
  attemptCount: number;
  probeFailures: number;
  lastErrorMessage: string;
  timer: NodeJS.Timeout | undefined;
  context: ExtensionContext | undefined;
};

export type NetworkRecoveryDeps = {
  probe?: (url: string, options?: ProbeOptions) => Promise<boolean>;
};

export function createNetworkRecoveryExtension(pi: ExtensionAPI, deps: NetworkRecoveryDeps = {}): void {
  const probeFn = deps.probe ?? probeEndpointReachability;

  const state: NetworkRecoveryState = {
    phase: "idle",
    attemptCount: 0,
    probeFailures: 0,
    lastErrorMessage: "",
    timer: undefined,
    context: undefined,
  };
  let tickGeneration = 0;

  const readConfig = () => {
    let settings: unknown;
    try {
      settings = pi.getSettings();
    } catch {
      settings = undefined;
    }
    return resolveNetworkRecoveryConfig(settings);
  };

  const notify = (message: string, level: "info" | "warning") => {
    const ui = state.context?.ui;
    if (!ui || typeof ui.notify !== "function") return;
    ui.notify(`${NOTICE_PREFIX} ${message}`, level);
  };

  const clearTimer = () => {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  };

  const reset = () => {
    tickGeneration += 1;
    clearTimer();
    state.phase = "idle";
    state.attemptCount = 0;
    state.probeFailures = 0;
  };

  const armTimer = (delayMs: number) => {
    clearTimer();
    const timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref?.();
    state.timer = timer;
  };

  const scheduleAttempt = (delayMs: number) => {
    state.attemptCount += 1;
    state.phase = "waiting";
    armTimer(delayMs);
    notify(`检测到连接错误，${formatDelay(delayMs)}后自动重试（第 ${state.attemptCount} 次）`, "info");
  };

  /**
   * 唤醒一轮工作。`sendUserMessage` 是提交型调用：真正的 run 由 Host 异步起，
   * 因此同时挂一个看门狗定时器——若到点后仍停在 attempting 且会话空闲，
   * 说明这轮唤醒没有产生有效 run（例如提交被拒），tick 会再试。
   */
  const wake = (delayMs: number) => {
    state.phase = "attempting";
    try {
      pi.sendUserMessage(RESUME_PROMPT);
    } catch (error) {
      state.phase = "waiting";
      armTimer(delayMs);
      notify(`唤醒提交失败（${messageOf(error)}），${formatDelay(delayMs)}后继续重试`, "warning");
      return;
    }
    armTimer(delayMs);
    notify("探活通过，正在恢复工作", "info");
  };

  const tick = async () => {
    const generation = ++tickGeneration;
    state.timer = undefined;
    const config = readConfig();
    if (!config.enabled) {
      reset();
      return;
    }
    const ctx = state.context;
    // 会话正忙说明已有工作在推进（可能是长任务），不打断，顺延到下一轮。
    if (!ctx || ctx.isIdle() !== true) {
      armTimer(config.delayMs);
      return;
    }
    const baseUrl = ctx.model?.baseUrl ?? "";
    const reachable = await probeFn(baseUrl, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    // 探活期间可能发生用户接管、session shutdown 或新的 agent run；
    // waiting 与 attempting（看门狗重探）两种活跃恢复态均可继续，idle 则丢弃。
    if (generation !== tickGeneration || state.context !== ctx || state.phase === "idle" || ctx.isIdle() !== true) return;
    const latestConfig = readConfig();
    if (!latestConfig.enabled) {
      reset();
      return;
    }
    if (!reachable) {
      state.probeFailures += 1;
      if (state.probeFailures < MAX_PROBE_FAILURES_BEFORE_FORCE) {
        state.phase = "waiting";
        armTimer(latestConfig.delayMs);
        return;
      }
      state.probeFailures = 0;
      notify(`连续 ${MAX_PROBE_FAILURES_BEFORE_FORCE} 次探活未通过，仍强制唤醒一次`, "warning");
      wake(latestConfig.delayMs);
      return;
    }
    state.probeFailures = 0;
    wake(latestConfig.delayMs);
  };

  pi.on("session_start", (_event, ctx) => {
    state.context = ctx;
    reset();
    state.lastErrorMessage = "";
  });

  pi.on("session_shutdown", () => {
    reset();
    state.lastErrorMessage = "";
    state.context = undefined;
  });

  pi.on("turn_end", (event, ctx) => {
    state.context = ctx;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason === "error") {
      state.lastErrorMessage = message.errorMessage ?? "";
      return;
    }
    if (message.stopReason === "aborted") return;
    const recovering = state.phase !== "idle";
    reset();
    state.lastErrorMessage = "";
    if (recovering) notify("已恢复正常工作，自动重连计时器已停止", "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    state.context = ctx;
    if (state.phase !== "waiting") return;
    reset();
    state.lastErrorMessage = "";
  });

  pi.on("agent_settled", (event, ctx) => {
    state.context = ctx;
    if (event.aborted) {
      reset();
      return;
    }
    if (state.phase === "waiting") return;
    if (!CONNECTION_ERROR_PATTERN.test(state.lastErrorMessage)) return;
    const config = readConfig();
    if (!config.enabled) {
      reset();
      return;
    }
    scheduleAttempt(config.delayMs);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    reset();
    state.lastErrorMessage = "";
  });
}

function formatDelay(delayMs: number): string {
  const minutes = Math.round(delayMs / 60000);
  if (minutes >= 1) return `${minutes} 分钟`;
  return `${Math.round(delayMs / 1000)} 秒`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
