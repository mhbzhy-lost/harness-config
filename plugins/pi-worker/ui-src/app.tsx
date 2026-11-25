import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { Streamdown } from "streamdown";
import type { Components } from "streamdown";
import { useStickToBottom } from "use-stick-to-bottom";
import { z } from "zod";
import { parseGitStatusFileUri } from "./git-uri.ts";
import { createCoalescingRunner } from "./poller.ts";
import {
  iconForEvent,
  isExpandableDetail,
  reduceTimelineItems,
  summarizeDetailPreview,
} from "./timeline.ts";
import type { TimelineEventLike, TimelineItem } from "./timeline.ts";

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

interface EventsDeltaResult {
  offset: number;
  nextOffset: number;
  truncated: boolean;
  hasMore: boolean;
  events: TimelineEventLike[];
}

interface MonitorPayload {
  tasks?: TaskSummary[];
  task?: TaskRecord | null;
  stream?: EventsDeltaResult | null;
}

const ToggleAuxPaneResultSchema = z.object({
  isError: z.boolean().optional(),
}).passthrough();

const STREAMDOWN_CONTROLS = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
} as const;

const LINK_SAFETY = { enabled: false } as const;

function shortDir(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function fmtTime(iso?: string): string {
  return iso && iso.length >= 19 ? iso.slice(11, 19) : iso || "";
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 沙箱裁剪剪贴板权限时静默忽略
    }
  }, [text]);

  return (
    <button type="button" className="copy-btn" onClick={handleCopy}>
      {copied ? "已复制" : label}
    </button>
  );
}

function MarkdownView({
  content,
  isStreaming = false,
  onOpenLink,
}: {
  content: string;
  isStreaming?: boolean;
  onOpenLink: (url: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...rest }) => {
      const safeHref = typeof href === "string" && /^https?:\/\//i.test(href) ? href : undefined;
      if (!safeHref) {
        return <span>{children}</span>;
      }
      return (
        <a
          {...rest}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          data-streamdown="link"
          onClick={(e) => {
            e.preventDefault();
            onOpenLink(safeHref);
          }}
        >
          {children}
        </a>
      );
    },
  }), [onOpenLink]);

  return (
    <div className="md-body">
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        isAnimating={isStreaming}
        animated={isStreaming}
        controls={STREAMDOWN_CONTROLS}
        linkSafety={LINK_SAFETY}
        components={components}
        codeBlockMaxHeight={480}
        lineNumbers={false}
      >
        {content}
      </Streamdown>
    </div>
  );
}

function ThinkingBlock({ item }: { item: Extract<TimelineItem, { type: "thinking" }> }) {
  const preview = item.text ? summarizeDetailPreview(item.text, 100) : "";
  const label = item.isStreaming
    ? `思考中 (${item.thinkingChars} chars)`
    : `思考过程 (${item.thinkingChars} chars)`;

  return (
    <details className="ev ev-thinking ev-expandable">
      <summary className="ev-summary">
        <div className="ev-head">
          <span className="ev-title">
            <span className="ev-caret" aria-hidden="true" />
            {item.isStreaming && <span className="dot-pulse" />}
            <span>💭 {label}</span>
          </span>
          <span className="muted">{fmtTime(item.updatedAt)}</span>
        </div>
        {preview && <div className="ev-preview">{preview}</div>}
      </summary>
      <div className="thinking-body">
        <div className="block-toolbar">
          <span className="muted">完整思考内容</span>
          {item.text && <CopyButton text={item.text} />}
        </div>
        <pre className="ev-detail ev-code ev-thinking-text">{item.text}</pre>
      </div>
    </details>
  );
}

function ToolCard({ item }: { item: Extract<TimelineItem, { type: "tool" }> }) {
  const isError = item.status === "error";
  const isRunning = item.status === "running";
  const dur = fmtDuration(item.durationMs);
  const icon = isRunning ? "⚙" : isError ? "✖" : item.status === "interrupted" ? "◌" : "✓";
  const preview = item.inputPreview
    ?? (item.input ? summarizeDetailPreview(item.input, 100) : undefined)
    ?? (item.output ? summarizeDetailPreview(item.output, 100) : undefined);

  const cardClass = isError
    ? "ev ev-error ev-expandable"
    : isRunning
      ? "ev ev-tool_start ev-expandable"
      : "ev ev-tool_end ev-expandable";

  const hasBody = Boolean(item.input || item.output);

  if (!hasBody) {
    return (
      <div className={cardClass.replace(" ev-expandable", "")}>
        <div className="ev-head">
          <span className="ev-title">
            {isRunning && <span className="dot-pulse" />}
            <span>{icon} {item.toolName}{dur ? ` (${dur})` : ""}</span>
          </span>
          <span className="muted">{fmtTime(item.endedAt ?? item.startedAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <details className={cardClass}>
      <summary className="ev-summary">
        <div className="ev-head">
          <span className="ev-title">
            <span className="ev-caret" aria-hidden="true" />
            {isRunning && <span className="dot-pulse" />}
            <span>{icon} {item.toolName}{dur ? ` (${dur})` : ""}</span>
          </span>
          <span className="muted">{fmtTime(item.endedAt ?? item.startedAt)}</span>
        </div>
        {preview && <div className="ev-preview mono">{preview}</div>}
      </summary>
      <div className="tool-sections">
        {item.input && (
          <div className="tool-section">
            <div className="block-toolbar">
              <span className="muted">参数</span>
              <CopyButton text={item.input} />
            </div>
            <pre className="ev-detail ev-code">{item.input}</pre>
          </div>
        )}
        {item.output && (
          <div className="tool-section">
            <div className="block-toolbar">
              <span className="muted">{isError ? "报错输出" : "输出"}</span>
              <CopyButton text={item.output} />
            </div>
            <pre className={`ev-detail ev-code${isError ? " ev-code-error" : ""}`}>{item.output}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function AssistantCard({
  item,
  onOpenLink,
}: {
  item: Extract<TimelineItem, { type: "assistant" }>;
  onOpenLink: (url: string) => void;
}) {
  const cls = item.isError ? "ev ev-error" : "ev ev-assistant";
  return (
    <div className={cls}>
      <div className="ev-head">
        <span className="ev-title">
          {item.isStreaming && <span className="dot-pulse" />}
          <span>💬 {item.title}</span>
        </span>
        <span className="muted">{fmtTime(item.timestamp)}</span>
      </div>
      {item.isError ? (
        <pre className="ev-detail ev-code ev-code-error">{item.text}</pre>
      ) : (
        <div className="ev-detail">
          <MarkdownView content={item.text} isStreaming={item.isStreaming} onOpenLink={onOpenLink} />
        </div>
      )}
    </div>
  );
}

function GenericEventRow({
  item,
  onOpenLink,
}: {
  item: Extract<TimelineItem, { type: "event" }>;
  onOpenLink: (url: string) => void;
}) {
  if (item.kind === "turn_end") {
    return (
      <div className="turn-divider">
        <span>{item.title} · {fmtTime(item.timestamp)}</span>
      </div>
    );
  }

  const cls = item.isError ? "ev ev-error" : `ev ev-${item.kind}`;
  const icon = iconForEvent({ kind: item.kind, isError: item.isError });
  const renderBody = (text: string) => {
    if (item.kind === "status" && !item.isError) {
      return (
        <div className="ev-detail">
          <MarkdownView content={text} onOpenLink={onOpenLink} />
        </div>
      );
    }
    return <pre className={`ev-detail ev-code${item.isError ? " ev-code-error" : ""}`}>{text}</pre>;
  };

  if (item.detail && isExpandableDetail(item.detail)) {
    return (
      <details className={`${cls} ev-expandable`}>
        <summary className="ev-summary">
          <div className="ev-head">
            <span className="ev-title">
              <span className="ev-caret" aria-hidden="true" />
              <span>{icon} {item.title}</span>
            </span>
            <span className="muted">{fmtTime(item.timestamp)}</span>
          </div>
          <div className="ev-preview">{summarizeDetailPreview(item.detail)}</div>
        </summary>
        {renderBody(item.detail)}
      </details>
    );
  }

  return (
    <div className={cls}>
      <div className="ev-head">
        <span className="ev-title">{icon} {item.title}</span>
        <span className="muted">{fmtTime(item.timestamp)}</span>
      </div>
      {item.detail && renderBody(item.detail)}
    </div>
  );
}

function MonitorApp() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEventLike[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  const appRef = useRef<McpApp | null>(null);
  const offsetRef = useRef(0);
  const selectedTaskIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: "instant",
    initial: "instant",
  });

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const applyPayloadRef = useRef<(payload: MonitorPayload, resetStream: boolean) => boolean>(() => false);
  const schedulePollRef = useRef<(hasMore: boolean, nextTask: TaskRecord | null, nextTasks: TaskSummary[]) => void>(() => {});

  const poller = useMemo(() => createCoalescingRunner(async ({ forceReset }) => {
    const mcpApp = appRef.current;
    if (!mcpApp) return;
    const myEpoch = requestEpochRef.current;
    const reqOffset = forceReset ? 0 : offsetRef.current;
    const targetId = selectedTaskIdRef.current;

    try {
      const res = await mcpApp.callServerTool({
        name: "pi_worker_app_snapshot",
        arguments: {
          ...(targetId ? { taskId: targetId } : {}),
          offset: reqOffset,
        },
      });
      if (myEpoch !== requestEpochRef.current) return;
      const sc = (res as { structuredContent?: MonitorPayload } | undefined)?.structuredContent;
      if (sc) {
        const hasMore = applyPayloadRef.current(sc, forceReset);
        schedulePollRef.current(hasMore, sc.task ?? null, Array.isArray(sc.tasks) ? sc.tasks : []);
      } else {
        setLoadingInitial(false);
        schedulePollRef.current(false, null, []);
      }
    } catch {
      if (myEpoch === requestEpochRef.current) {
        setLoadingInitial(false);
        schedulePollRef.current(false, null, []);
      }
    }
  }), []);

  const pollSnapshot = useCallback((forceReset = false) => {
    return poller.trigger({ forceReset });
  }, [poller]);

  schedulePollRef.current = (hasMore: boolean, nextTask: TaskRecord | null, nextTasks: TaskSummary[]) => {
    clearPoll();
    const status = nextTask?.status;
    let delayMs: number | null = null;
    if (hasMore) {
      delayMs = 80;
    } else if (status === "running") {
      delayMs = 500;
    } else if (status === "needs_input") {
      delayMs = 3000;
    } else if (!nextTask && nextTasks.some((t) => t.status === "running")) {
      delayMs = 1500;
    }
    if (delayMs !== null) {
      pollTimerRef.current = window.setTimeout(() => {
        void pollSnapshot(false);
      }, delayMs);
    }
  };

  applyPayloadRef.current = (payload: MonitorPayload, resetStream: boolean): boolean => {
    setLoadingInitial(false);
    if (Array.isArray(payload.tasks)) {
      setTasks(payload.tasks);
    }

    const incomingTask = payload.task ?? null;
    const prevTaskId = currentTaskIdRef.current;
    const switched = Boolean(incomingTask && prevTaskId && incomingTask.taskId !== prevTaskId);
    const shouldReset = resetStream || switched || !incomingTask;

    currentTaskIdRef.current = incomingTask?.taskId ?? null;
    setCurrentTask(incomingTask);
    if (incomingTask) {
      selectedTaskIdRef.current = incomingTask.taskId;
      setSelectedTaskId(incomingTask.taskId);
    }

    if (shouldReset) {
      offsetRef.current = 0;
    }

    let hasMore = false;
    if (payload.stream) {
      const streamReset = shouldReset || payload.stream.truncated;
      offsetRef.current = payload.stream.nextOffset;
      hasMore = payload.stream.hasMore;
      const incomingEvents = payload.stream.events;
      if (streamReset) {
        setEvents(incomingEvents);
      } else if (incomingEvents.length > 0) {
        setEvents((prev) => [...prev, ...incomingEvents]);
      }
    } else if (shouldReset) {
      setEvents([]);
    }

    return hasMore;
  };

  const { app, isConnected, error } = useApp({
    appInfo: { name: "Pi Worker", version: "0.3.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      appRef.current = createdApp;
      createdApp.ontoolinput = () => {
        if (!currentTaskIdRef.current) {
          setLoadingInitial(true);
        }
      };
      createdApp.ontoolresult = (result) => {
        const sc = (result as { structuredContent?: MonitorPayload } | undefined)?.structuredContent;
        if (!sc) return;
        requestEpochRef.current += 1;
        const hasMore = applyPayloadRef.current(sc, true);
        schedulePollRef.current(hasMore, sc.task ?? null, Array.isArray(sc.tasks) ? sc.tasks : []);
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  useEffect(() => {
    if (app) appRef.current = app;
  }, [app]);

  useEffect(() => {
    if (!isConnected) return;
    if (!currentTaskIdRef.current) {
      void pollSnapshot(true);
    }
    return () => clearPoll();
  }, [isConnected, pollSnapshot, clearPoll]);

  const handleSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextId = e.target.value || null;
    if (nextId === selectedTaskIdRef.current) return;
    selectedTaskIdRef.current = nextId;
    setSelectedTaskId(nextId);
    requestEpochRef.current += 1;
    offsetRef.current = 0;
    setEvents([]);
    clearPoll();
    void pollSnapshot(true);
  }, [clearPoll, pollSnapshot]);

  const handleRefresh = useCallback(() => {
    void pollSnapshot(false);
  }, [pollSnapshot]);

  const handleCancel = useCallback(async () => {
    const mcpApp = appRef.current;
    if (!mcpApp || !currentTask) return;
    setCancelling(true);
    try {
      await mcpApp.callServerTool({
        name: "pi_worker_app_cancel",
        arguments: { taskId: currentTask.taskId },
      });
      await pollSnapshot(false);
    } finally {
      setCancelling(false);
    }
  }, [currentTask, pollSnapshot]);

  const handleOpenFile = useCallback(async (uri: string) => {
    const mcpApp = appRef.current;
    if (!mcpApp) return;
    try {
      await mcpApp.request(
        {
          method: "com.google.antigravity/toggle-aux-pane",
          params: { tabType: "fileView", uri },
        },
        ToggleAuxPaneResultSchema,
      );
    } catch {
      // 非 AGY 宿主或全局视图无侧面板时静默降级
    }
  }, []);

  const handleOpenLink = useCallback(async (url: string) => {
    const mcpApp = appRef.current;
    if (!mcpApp) return;
    try {
      await mcpApp.openLink({ url });
    } catch {
      // 宿主未开放 openLinks 时静默降级
    }
  }, []);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [tasks]);

  const isRunning = currentTask?.status === "running";
  const timelineItems = useMemo(
    () => reduceTimelineItems(events, isRunning),
    [events, isRunning],
  );

  const canCancel = Boolean(
    !cancelling && (currentTask?.status === "running" || currentTask?.status === "needs_input"),
  );

  const modelLabel = currentTask
    ? [currentTask.provider, currentTask.model].filter(Boolean).join("/") || "默认模型"
    : "";
  const thinkingLabel = currentTask?.thinking ? ` · thinking=${currentTask.thinking}` : "";

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Pi Worker</span>
        <select
          id="task-select"
          className="task-select"
          aria-label="选择任务"
          value={selectedTaskId ?? ""}
          onChange={handleSelectChange}
        >
          {sortedTasks.length === 0 ? (
            <option value="">暂无任务</option>
          ) : (
            sortedTasks.map((t) => (
              <option key={t.taskId} value={t.taskId}>
                [{t.status}] {shortDir(t.cwd)} · R{t.roundCount} T{t.turnCount} ({t.taskId.slice(0, 8)})
              </option>
            ))
          )}
        </select>
        <button id="btn-refresh" className="btn" type="button" onClick={handleRefresh}>
          刷新
        </button>
        <button
          id="btn-cancel"
          className="btn btn-danger"
          type="button"
          disabled={!canCancel}
          onClick={() => void handleCancel()}
        >
          {cancelling ? "取消中…" : "取消"}
        </button>
      </header>

      <div className="main-wrap">
        <main id="main" className="main" ref={scrollRef}>
          <div className="main-content" ref={contentRef}>
            {error && (
              <div className="card callout-error">
                <div className="section-title">连接失败</div>
                <p className="pre-wrap mono">{error.message}</p>
              </div>
            )}

            {!currentTask ? (
              <div className="empty">
                {loadingInitial ? (
                  "正在加载 Pi Worker 监控数据..."
                ) : (
                  <>
                    当前没有可展示的 Pi Worker 任务。
                    <br />
                    发起 <code>pi_worker_start</code> 后将自动在此显示实时进度。
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="card">
                  <div className="meta-row">
                    <span className={`badge badge-${currentTask.status}`}>
                      {isRunning && <span className="dot-pulse" />}
                      {currentTask.status}
                    </span>
                    <span>Round {currentTask.roundCount} · Turn {currentTask.turnCount}</span>
                    <span className="muted">{modelLabel}{thinkingLabel}</span>
                  </div>
                  <div className="muted mono" style={{ marginTop: 6 }}>{currentTask.cwd}</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    最近工具：<code>{currentTask.lastTool ?? "-"}</code> · 活跃：{fmtTime(currentTask.lastActivityAt)}
                  </div>
                </div>

                {currentTask.status === "needs_input" && currentTask.question && (
                  <div className="card callout-question">
                    <div className="section-title">等待确认 (needs_input)</div>
                    <MarkdownView content={currentTask.question} onOpenLink={handleOpenLink} />
                    {currentTask.options.length > 0 && (
                      <ul className="option-list">
                        {currentTask.options.map((opt, idx) => (
                          <li key={idx}>• {opt}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {currentTask.error && (
                  <div className="card callout-error">
                    <div className="section-title">错误</div>
                    <p className="pre-wrap mono">{currentTask.error}</p>
                  </div>
                )}

                {currentTask.summary && (
                  <div className="card">
                    <div className="section-title">任务摘要</div>
                    <MarkdownView content={currentTask.summary} onOpenLink={handleOpenLink} />
                    {currentTask.verifiedCommands.length > 0 && (
                      <>
                        <div className="section-title" style={{ marginTop: 8 }}>已验证命令</div>
                        <ul className="cmd-list">
                          {currentTask.verifiedCommands.map((cmd, idx) => (
                            <li key={idx} className="mono">✓ {cmd}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}

                {currentTask.gitChanges.length > 0 && (
                  <div className="card">
                    <div className="section-title">工作区变更 ({currentTask.gitChanges.length})</div>
                    <ul className="file-list">
                      {currentTask.gitChanges.map((line, idx) => {
                        const uri = parseGitStatusFileUri(currentTask.cwd, line);
                        return uri ? (
                          <li key={idx}>
                            <button
                              type="button"
                              className="file-btn"
                              onClick={() => void handleOpenFile(uri)}
                            >
                              {line}
                            </button>
                          </li>
                        ) : (
                          <li key={idx} className="file-static">{line}</li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <div className="card">
                  <div className="section-title">实时进度流 ({timelineItems.length})</div>
                  {timelineItems.length === 0 ? (
                    <div className="muted">等待流式事件...</div>
                  ) : (
                    <div className="timeline">
                      {timelineItems.map((item) => {
                        if (item.type === "round") {
                          return (
                            <div key={item.key} className="round-divider">
                              <span>Round {item.round} · {fmtTime(item.timestamp)}</span>
                            </div>
                          );
                        }
                        if (item.type === "thinking") {
                          return <ThinkingBlock key={item.key} item={item} />;
                        }
                        if (item.type === "tool") {
                          return <ToolCard key={item.key} item={item} />;
                        }
                        if (item.type === "assistant") {
                          return <AssistantCard key={item.key} item={item} onOpenLink={handleOpenLink} />;
                        }
                        return <GenericEventRow key={item.key} item={item} onOpenLink={handleOpenLink} />;
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </main>

        {!isAtBottom && currentTask && (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={() => void scrollToBottom()}
          >
            ↓ 回到底部
          </button>
        )}
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<MonitorApp />);
}
