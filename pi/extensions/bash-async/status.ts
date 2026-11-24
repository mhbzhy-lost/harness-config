import type { BashAsyncLaunchReceipt, BashAsyncTerminalReceipt } from "./contracts.ts";

export type BashAsyncActiveSummary = {
  jobId: string; toolCallId: string; command: string; cwd: string; acceptedAt: string;
};
export type BashAsyncCompletedSummary = BashAsyncActiveSummary & {
  outcome: BashAsyncTerminalReceipt["outcome"]; exitCode?: number; elapsedMs: number;
  completionDelivery: BashAsyncTerminalReceipt["completionDelivery"]; deliveryError?: string;
};
export type BashAsyncStatusReport = {
  activeCount: number;
  completedCount: number;
  active: BashAsyncActiveSummary[];
  completed: BashAsyncCompletedSummary[];
  jobId?: string;
  found?: boolean;
};

function activeSummary(receipt: Pick<BashAsyncLaunchReceipt, "jobId" | "toolCallId" | "command" | "cwd" | "acceptedAt">): BashAsyncActiveSummary {
  return { jobId: receipt.jobId, toolCallId: receipt.toolCallId, command: receipt.command, cwd: receipt.cwd, acceptedAt: receipt.acceptedAt };
}
function completedSummary(receipt: BashAsyncTerminalReceipt): BashAsyncCompletedSummary {
  return {
    ...activeSummary(receipt), outcome: receipt.outcome,
    ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
    elapsedMs: receipt.elapsedMs, completionDelivery: receipt.completionDelivery,
    ...(receipt.deliveryError !== undefined ? { deliveryError: receipt.deliveryError } : {}),
  };
}

export function createBashAsyncStatusResult(
  snapshot: { active: BashAsyncLaunchReceipt[]; completed: BashAsyncTerminalReceipt[] },
  jobId?: string,
): { content: [{ type: "text"; text: string }]; details: BashAsyncStatusReport } {
  const active = snapshot.active.map(activeSummary);
  const completed = snapshot.completed.map(completedSummary);
  const report: BashAsyncStatusReport = {
    activeCount: active.length, completedCount: completed.length,
    active: jobId ? active.filter((job) => job.jobId === jobId) : active,
    completed: jobId ? completed.filter((job) => job.jobId === jobId) : completed,
    ...(jobId ? { jobId, found: active.some((job) => job.jobId === jobId) || completed.some((job) => job.jobId === jobId) } : {}),
  };
  const header = `本会话 bash_async 状态：活跃 ${report.activeCount} 个，已收束归档 ${report.completedCount} 个（归档最多保留最近 64 条）。`
    + (jobId ? (report.found ? `jobId ${jobId} 已命中，详见 JSON。` : `未找到 jobId ${jobId}：可能不属于本会话，或已超出归档上限。`) : "")
    + "命令输出全文不在本结果中，以 bash-async-complete 完成回执为准。";
  return { content: [{ type: "text", text: `${header}\n${JSON.stringify(report)}` }], details: report };
}
