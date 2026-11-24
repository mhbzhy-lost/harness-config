import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { parseGitStatusFileUri } from "./git-uri.ts";
import { createCoalescingRunner } from "./poller.ts";

interface TaskSummary {
  taskId: string;
  cwd: string;
  status: string;
  roundCount: number;
  turnCount: number;
  lastTool: string | null;
  updatedAt: string;
  lastActivityAt: string;
}

interface TaskRecord extends TaskSummary {
  model?: string;
  provider?: string;
  thinking?: string;
  summary: string | null;
  question: string | null;
  options: string[];
  verifiedCommands: string[];
  stopReason: string | null;
  exitCode: number | null;
  error: string | null;
  gitChanges: string[];
}

interface FormattedStreamEvent {
  seq: number;
  kind: string;
  title: string;
  detail?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
  thinkingChars?: number;
  timestamp: string;
}

interface EventsDeltaResult {
  offset: number;
  nextOffset: number;
  truncated: boolean;
  hasMore: boolean;
  events: FormattedStreamEvent[];
}

interface MonitorPayload {
  tasks?: TaskSummary[];
  task?: TaskRecord | null;
  stream?: EventsDeltaResult | null;
}

const ToggleAuxPaneResultSchema = z.object({
  isError: z.boolean().optional(),
}).passthrough();

const app = new App({ name: "Pi Worker", version: "0.2.0" }, {});

let tasks: TaskSummary[] = [];
let currentTask: TaskRecord | null = null;
let selectedTaskId: string | null = null;
let offset = 0;
let events: FormattedStreamEvent[] = [];
let latestThinking: FormattedStreamEvent | null = null;
let requestEpoch = 0;
let pollTimer: number | null = null;
let followScroll = true;
let thinkingOpen = false;
let lastRenderKey = "";

const elSelect = document.getElementById("task-select") as HTMLSelectElement;
const elRefresh = document.getElementById("btn-refresh") as HTMLButtonElement;
const elCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const elMain = document.getElementById("main") as HTMLElement;

elMain.addEventListener("scroll", () => {
  const gap = elMain.scrollHeight - elMain.scrollTop - elMain.clientHeight;
  followScroll = gap < 48;
});

function shortDir(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function fmtTime(iso: string): string {
  return iso && iso.length >= 19 ? iso.slice(11, 19) : iso || "";
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clearPoll(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(hasMore: boolean): void {
  clearPoll();
  const status = currentTask?.status;
  let delayMs: number | null = null;
  if (hasMore) {
    delayMs = 100;
  } else if (status === "running") {
    delayMs = 800;
  } else if (status === "needs_input") {
    delayMs = 3000;
  } else if (!currentTask && tasks.some((t) => t.status === "running")) {
    delayMs = 1500;
  }
  if (delayMs !== null) {
    pollTimer = window.setTimeout(() => {
      void pollSnapshot();
    }, delayMs);
  }
}

function applyPayload(payload: MonitorPayload, resetStream: boolean): boolean {
  if (Array.isArray(payload.tasks)) {
    tasks = payload.tasks;
  }
  const incomingTask = payload.task ?? null;
  const switched = Boolean(incomingTask && currentTask && incomingTask.taskId !== currentTask.taskId);
  if (resetStream || switched || !incomingTask) {
    offset = 0;
    events = [];
    latestThinking = null;
  }
  currentTask = incomingTask;
  if (incomingTask) selectedTaskId = incomingTask.taskId;

  let hasMore = false;
  if (payload.stream) {
    if (payload.stream.truncated) {
      events = [];
      latestThinking = null;
    }
    offset = payload.stream.nextOffset;
    hasMore = payload.stream.hasMore;
    for (const ev of payload.stream.events) {
      if (ev.kind === "thinking") {
        latestThinking = ev;
      } else {
        events.push(ev);
      }
    }
    if (events.length > 400) {
      events = events.slice(events.length - 400);
    }
  }
  render();
  return hasMore;
}

const poller = createCoalescingRunner(async ({ forceReset }) => {
  const myEpoch = requestEpoch;
  const reqOffset = forceReset ? 0 : offset;
  const targetId = selectedTaskId;
  try {
    const res = await app.callServerTool({
      name: "pi_worker_app_snapshot",
      arguments: {
        ...(targetId ? { taskId: targetId } : {}),
        offset: reqOffset,
      },
    });
    if (myEpoch !== requestEpoch) return;
    const sc = (res as { structuredContent?: MonitorPayload } | undefined)?.structuredContent;
    const hasMore = sc ? applyPayload(sc, forceReset) : false;
    schedulePoll(hasMore);
  } catch {
    if (myEpoch === requestEpoch) schedulePoll(false);
  }
});

function pollSnapshot(forceReset = false): Promise<void> {
  return poller.trigger({ forceReset });
}

async function cancelCurrentTask(): Promise<void> {
  if (!currentTask) return;
  elCancel.disabled = true;
  try {
    await app.callServerTool({
      name: "pi_worker_app_cancel",
      arguments: { taskId: currentTask.taskId },
    });
    await pollSnapshot(false);
  } finally {
    renderTopbar();
  }
}

async function openFileInAuxPane(uri: string): Promise<void> {
  try {
    await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      },
      ToggleAuxPaneResultSchema,
    );
  } catch {
    // 非 AGY 宿主或全局视图无侧面板时静默降级
  }
}

function renderTopbar(): void {
  const prevValue = selectedTaskId ?? "";
  elSelect.innerHTML = "";
  if (tasks.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "暂无任务";
    elSelect.appendChild(opt);
  } else {
    const sorted = [...tasks].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    for (const t of sorted) {
      const opt = document.createElement("option");
      opt.value = t.taskId;
      opt.textContent = `[${t.status}] ${shortDir(t.cwd)} · R${t.roundCount} T${t.turnCount} (${t.taskId.slice(0, 8)})`;
      elSelect.appendChild(opt);
    }
    elSelect.value = prevValue;
  }
  const canCancel = currentTask?.status === "running" || currentTask?.status === "needs_input";
  elCancel.disabled = !canCancel;
}

function render(): void {
  renderTopbar();
  const renderKey = currentTask
    ? `${currentTask.taskId}|${currentTask.status}|${currentTask.roundCount}|${currentTask.turnCount}|${currentTask.lastTool ?? ""}|${currentTask.lastActivityAt}|${offset}|${events.length}|${latestThinking?.seq ?? 0}|${currentTask.gitChanges.length}`
    : "empty";
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  const prevScrollTop = elMain.scrollTop;
  const existingDetails = elMain.querySelector<HTMLDetailsElement>(".thinking-details");
  if (existingDetails) thinkingOpen = existingDetails.open;

  if (!currentTask) {
    elMain.innerHTML = `<div class="empty">当前没有可展示的 Pi Worker 任务。<br>发起 <code>pi_worker_start</code> 后将自动在此显示实时进度。</div>`;
    return;
  }

  const t = currentTask;
  const parts: string[] = [];

  const modelLabel = [t.provider, t.model].filter(Boolean).join("/") || "默认模型";
  const thinkingLabel = t.thinking ? ` · thinking=${t.thinking}` : "";
  const pulse = t.status === "running" ? `<span class="dot-pulse"></span>` : "";

  parts.push(`
    <div class="card">
      <div class="meta-row">
        <span class="badge badge-${escapeHtml(t.status)}">${pulse}${escapeHtml(t.status)}</span>
        <span>Round ${t.roundCount} · Turn ${t.turnCount}</span>
        <span class="muted">${escapeHtml(modelLabel + thinkingLabel)}</span>
      </div>
      <div class="muted mono" style="margin-top:6px;">${escapeHtml(t.cwd)}</div>
      <div class="muted" style="margin-top:4px;">
        最近工具：<code>${escapeHtml(t.lastTool ?? "-")}</code> · 活跃：${escapeHtml(fmtTime(t.lastActivityAt))}
      </div>
    </div>
  `);

  if (t.status === "needs_input" && t.question) {
    const optsHtml = t.options.length
      ? `<ul class="option-list">${t.options.map((o) => `<li>• ${escapeHtml(o)}</li>`).join("")}</ul>`
      : "";
    parts.push(`
      <div class="card callout-question">
        <div class="section-title">等待确认 (needs_input)</div>
        <p class="pre-wrap">${escapeHtml(t.question)}</p>
        ${optsHtml}
      </div>
    `);
  }

  if (t.error) {
    parts.push(`
      <div class="card callout-error">
        <div class="section-title">错误</div>
        <p class="pre-wrap mono">${escapeHtml(t.error)}</p>
      </div>
    `);
  }

  if (t.summary) {
    const cmdsHtml = t.verifiedCommands.length
      ? `<div class="section-title" style="margin-top:8px;">已验证命令</div><ul class="cmd-list">${t.verifiedCommands.map((c) => `<li class="mono">✓ ${escapeHtml(c)}</li>`).join("")}</ul>`
      : "";
    parts.push(`
      <div class="card">
        <div class="section-title">任务摘要</div>
        <p class="pre-wrap">${escapeHtml(t.summary)}</p>
        ${cmdsHtml}
      </div>
    `);
  }

  if (latestThinking) {
    parts.push(`
      <details class="thinking-details"${thinkingOpen ? " open" : ""}>
        <summary>💭 ${escapeHtml(latestThinking.title)} (${escapeHtml(fmtTime(latestThinking.timestamp))})</summary>
        <p class="ev-detail">${escapeHtml(latestThinking.detail ?? "")}</p>
      </details>
    `);
  }

  if (t.gitChanges.length > 0) {
    const items = t.gitChanges.map((line, i) => {
      const uri = parseGitStatusFileUri(t.cwd, line);
      if (uri) {
        return `<li><button class="file-btn" data-file-idx="${i}" data-uri="${escapeHtml(uri)}">${escapeHtml(line)}</button></li>`;
      }
      return `<li class="file-static">${escapeHtml(line)}</li>`;
    }).join("");
    parts.push(`
      <div class="card">
        <div class="section-title">工作区变更 (${t.gitChanges.length})</div>
        <ul class="file-list">${items}</ul>
      </div>
    `);
  }

  const timelineHtml = events.length === 0
    ? `<div class="muted">等待流式事件...</div>`
    : `<div class="timeline">${events.map((ev) => {
        const cls = ev.isError ? "ev ev-error" : `ev ev-${escapeHtml(ev.kind)}`;
        const dur = fmtDuration(ev.durationMs);
        const icon = ev.kind === "tool_start"
          ? "▶"
          : ev.kind === "tool_end"
            ? (ev.isError ? "✖" : "✓")
            : ev.kind === "assistant"
              ? "💬"
              : ev.kind === "compact"
                ? "🗜"
                : ev.kind === "status"
                  ? "●"
                  : "·";
        const detail = ev.detail ? `<div class="ev-detail">${escapeHtml(ev.detail)}</div>` : "";
        return `
          <div class="${cls}">
            <div class="ev-head">
              <span>${icon} ${escapeHtml(ev.title)}${dur ? ` (${escapeHtml(dur)})` : ""}</span>
              <span class="muted">${escapeHtml(fmtTime(ev.timestamp))}</span>
            </div>
            ${detail}
          </div>
        `;
      }).join("")}</div>`;

  parts.push(`
    <div class="card">
      <div class="section-title">实时进度流 (${events.length})</div>
      ${timelineHtml}
    </div>
  `);

  elMain.innerHTML = parts.join("");

  elMain.querySelectorAll<HTMLButtonElement>(".file-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uri = btn.dataset.uri;
      if (uri) void openFileInAuxPane(uri);
    });
  });

  if (followScroll) {
    elMain.scrollTop = elMain.scrollHeight;
  } else {
    elMain.scrollTop = prevScrollTop;
  }
}

elSelect.addEventListener("change", () => {
  const nextId = elSelect.value || null;
  if (nextId === selectedTaskId) return;
  selectedTaskId = nextId;
  requestEpoch += 1;
  offset = 0;
  events = [];
  latestThinking = null;
  clearPoll();
  void pollSnapshot(true);
});

elRefresh.addEventListener("click", () => {
  void pollSnapshot(false);
});

elCancel.addEventListener("click", () => {
  void cancelCurrentTask();
});

// 先注册全部宿主回调，再 connect()，避免丢失首次 tool result
app.ontoolinput = () => {
  if (!currentTask) {
    elMain.innerHTML = `<div class="empty">正在加载 Pi Worker 监控数据...</div>`;
  }
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: MonitorPayload } | undefined)?.structuredContent;
  if (!sc) return;
  requestEpoch += 1;
  const hasMore = applyPayload(sc, true);
  schedulePoll(hasMore);
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

void (async () => {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  // 若由入口点直接打开且尚未收到 toolresult，兜底拉取一次快照
  if (!currentTask) {
    void pollSnapshot(true);
  }
})();
