import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseGitStatusFileUri } from "../plugins/pi-worker/ui-src/git-uri.ts";
import { createCoalescingRunner } from "../plugins/pi-worker/ui-src/poller.ts";
import {
  EMPTY_SCOPE,
  INITIAL_FALLBACK_MS,
  LOCKED_IDLE_POLL_MS,
  buildSnapshotScopeArgs,
  canFetchSnapshot,
  fallbackGroupTasks,
  formatGroupLabel,
  formatSessionBadge,
  formatTaskOptionLabel,
  isConversationSurface,
  isSessionLocked,
  mergeToolResultScope,
  parseToolInputScope,
  pickAutoFocusTaskId,
  resolvePollDelayMs,
  resolveScopeMode,
  shouldPollOnToolInput,
  shouldScheduleInitialFallback,
  shortDir,
  truncateLabel,
} from "../plugins/pi-worker/ui-src/scope.ts";
import {
  iconForEvent,
  isExpandableDetail,
  reduceTimelineItems,
  summarizeDetailPreview,
} from "../plugins/pi-worker/ui-src/timeline.ts";
import {
  EXPANDABLE_SELECTOR,
  OPEN_EXPANDABLE_SELECTOR,
  clearExpandedKeys,
  collapseAll,
  collapseExpandables,
  hasExpandedItem,
  pruneExpandedKeys,
  setExpandedKey,
} from "../plugins/pi-worker/ui-src/collapse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_HTML = join(ROOT, "plugins", "pi-worker", "ui", "monitor.html");
const UI_SRC = join(ROOT, "plugins", "pi-worker", "ui-src");
const UI_NODE_MODULES = join(UI_SRC, "node_modules");
const SERVER_PATH = join(ROOT, "plugins", "pi-worker", "src", "server.ts");

test("test_git_status_uri_parser_handles_renames_spaces_and_unicode", () => {
  assert.equal(parseGitStatusFileUri("/repo", " M src/a.ts"), "file:///repo/src/a.ts");
  assert.equal(
    parseGitStatusFileUri("/repo", "?? docs/中文 计划.md"),
    "file:///repo/docs/%E4%B8%AD%E6%96%87%20%E8%AE%A1%E5%88%92.md",
  );
  assert.equal(
    parseGitStatusFileUri("/repo", "R  old.ts -> src/new name.ts"),
    "file:///repo/src/new%20name.ts",
  );
  assert.equal(
    parseGitStatusFileUri("/repo", '?? "dir/a b.ts"'),
    "file:///repo/dir/a%20b.ts",
  );
  // 非重命名文件名包含字面 " -> " 不得被误截断
  assert.equal(
    parseGitStatusFileUri("/repo", " M docs/a -> b.md"),
    "file:///repo/docs/a%20-%3E%20b.md",
  );
  // git core.quotePath 默认八进制 UTF-8 转义（"中" = \344\270\255）
  assert.equal(
    parseGitStatusFileUri("/repo", '?? "docs/\\344\\270\\255.md"'),
    "file:///repo/docs/%E4%B8%AD.md",
  );
  assert.equal(parseGitStatusFileUri("/repo", "D  removed.ts"), null);
  assert.equal(parseGitStatusFileUri("/repo", "?? src/"), null);
});

test("test_coalescing_runner_never_drops_task_switch_while_in_flight", async () => {
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });

  const runner = createCoalescingRunner(async (req) => {
    calls.push(req);
    if (calls.length === 1) await firstGate;
  });

  const p1 = runner.trigger({ forceReset: false });
  // 在途期间连续触发普通刷新与切任务 forceReset，合并后 forceReset 必须保留并在 p1 结束后立刻执行
  const p2 = runner.trigger({ forceReset: true });
  const p3 = runner.trigger({ forceReset: false });

  assert.equal(calls.length, 1);
  releaseFirst();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(calls, [{ forceReset: false }, { forceReset: true }]);
});

test("test_timeline_helpers_avoid_misleading_caret_and_gate_expandable_details", () => {
  // 静态事件图标不得使用 "▶"，避免看起来像可展开的折叠三角却无法点击
  for (const kind of ["tool_start", "tool_end", "assistant", "text_delta", "thinking", "compact", "retry_failed", "status", "turn_end", "session"]) {
    assert.notEqual(iconForEvent({ kind }), "▶", `static icon for ${kind} must not look like a disclosure triangle`);
  }
  assert.equal(iconForEvent({ kind: "tool_start" }), "⚙");
  assert.equal(iconForEvent({ kind: "tool_end", isError: false }), "✓");
  assert.equal(iconForEvent({ kind: "tool_end", isError: true }), "✖");

  // 短单行详情不折叠，多行或超长详情才渲染为可展开 <details>
  assert.equal(isExpandableDetail(undefined), false);
  assert.equal(isExpandableDetail('{"target":"mac"}'), false);
  assert.equal(isExpandableDetail("line1\nline2"), true);
  assert.equal(isExpandableDetail("a".repeat(120)), true);

  assert.equal(summarizeDetailPreview("line1\n  line2"), "line1 line2");
  const longPreview = summarizeDetailPreview("x".repeat(150), 40);
  assert.equal(longPreview.length, 41);
  assert.ok(longPreview.endsWith("…"));
});

test("test_reduce_timeline_merges_streaming_blocks_tool_pairs_and_multi_round_keys", () => {
  const t = "2026-11-25T10:00:00.000Z";
  const events = [
    // Round 1: 分片 thinking 无损拼接
    { seq: 1, round: 1, blockId: 1, kind: "thinking", title: "思考中", detail: "第一步分析，", thinkingChars: 6, timestamp: t },
    { seq: 2, round: 1, blockId: 1, kind: "thinking", title: "思考中", detail: "第二步验证。", thinkingChars: 12, timestamp: t },
    // Round 1: 成对 tool_start + tool_end 按 toolCallId 合并为单张工具卡
    { seq: 3, round: 1, kind: "tool_start", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "npm test", preview: "npm test", timestamp: t },
    { seq: 4, round: 1, kind: "tool_end", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "ALL PASS\n" + "ok\n".repeat(100), isError: false, durationMs: 420, timestamp: t },
    // Round 1: text_delta 流式拼接并由同 blockId 的 assistant 收口
    { seq: 5, round: 1, blockId: 2, kind: "text_delta", title: "助手输出", detail: "## 进度\n", timestamp: t },
    { seq: 6, round: 1, blockId: 2, kind: "text_delta", title: "助手输出", detail: "- 已完成", timestamp: t },
    { seq: 7, round: 1, blockId: 2, kind: "assistant", title: "助手输出", detail: "## 进度\n- 已完成全部测试", timestamp: t },
    // Round 2: seq 重置为 1，自动插入 round 分隔且所有 key 唯一；模拟正在流式的 text_delta 与运行中工具
    { seq: 1, round: 2, kind: "tool_start", toolName: "read", toolCallId: "tc-2", title: "read", detail: "src/index.ts", preview: "src/index.ts", timestamp: t },
    { seq: 2, round: 2, blockId: 1, kind: "text_delta", title: "助手输出", detail: "正在输出第二轮...", timestamp: t },
  ];

  const runningItems = reduceTimelineItems(events, true);
  assert.equal(runningItems.length, 6);
  // 1. 思考块完整无损拼接且已关闭流式态
  assert.equal(runningItems[0].type, "thinking");
  assert.equal(runningItems[0].text, "第一步分析，第二步验证。");
  assert.equal(runningItems[0].isStreaming, false);
  // 2. 工具卡合并了输入输出和耗时
  assert.equal(runningItems[1].type, "tool");
  assert.equal(runningItems[1].status, "done");
  assert.equal(runningItems[1].input, "npm test");
  assert.match(runningItems[1].output ?? "", /^ALL PASS/);
  assert.equal(runningItems[1].durationMs, 420);
  // 3. Round 1 助手消息由定稿收口
  assert.equal(runningItems[2].type, "assistant");
  assert.equal(runningItems[2].text, "## 进度\n- 已完成全部测试");
  assert.equal(runningItems[2].isStreaming, false);
  // 4. Round 分隔
  assert.equal(runningItems[3].type, "round");
  assert.equal(runningItems[3].round, 2);
  // 5. Round 2 未结束工具在任务 running 时保持 running
  assert.equal(runningItems[4].type, "tool");
  assert.equal(runningItems[4].status, "running");
  // 6. Round 2 流式文本保持 isStreaming: true
  assert.equal(runningItems[5].type, "assistant");
  assert.equal(runningItems[5].text, "正在输出第二轮...");
  assert.equal(runningItems[5].isStreaming, true);

  // 所有 key 必须全局唯一
  const keys = runningItems.map((it) => it.key);
  assert.equal(new Set(keys).size, keys.length);

  // 当任务已离开 running，未收口工具自动降级为 interrupted，流式文本置 isStreaming: false
  const settledItems = reduceTimelineItems(events, false);
  assert.equal(settledItems[4].status, "interrupted");
  assert.equal(settledItems[5].isStreaming, false);
});

test("test_monitor_html_is_self_contained_csp_safe_and_served_by_mcp", async () => {
  const st = statSync(MONITOR_HTML);
  assert.ok(st.size > 1024 && st.size < 4 * 1024 * 1024, `unexpected monitor.html size: ${st.size}`);
  const html = readFileSync(MONITOR_HTML, "utf8");
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<style>/i);
  assert.match(html, /<script>/i);
  assert.match(html, /<div id="root"><\/div>/i);
  // 严格遵守 default-src 'none' 默认 CSP：禁止外部 http(s) script/link
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  // 可展开进度条目须使用原生 <details> + ev-expandable，且不得再用 ▶ 作为 tool_start 静态图标
  assert.match(html, /ev-expandable/);
  assert.doesNotMatch(html, /tool_start"\?"▶"/);

  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ui-mcp-"));
  const childEnv = { ...process.env, PI_WORKER_AGY: "1", PI_WORKER_STATE_DIR: join(dir, "state") };
  delete childEnv.PI_SUBAGENT_CHILD;
  delete childEnv.PI_WORKER_DEPTH;
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const readRes = await new Promise((resolveDone, rejectDone) => {
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            resolveDone(msg);
            return;
          }
        }
      });
      child.once("error", rejectDone);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "ui://pi-worker/monitor.html" },
      })}\n`);
    });
    assert.equal(readRes.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.equal(readRes.result.contents[0].text, html);
  } finally {
    await new Promise((r) => {
      child.once("close", () => r());
      child.stdin.end();
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScopeTask(overrides = {}) {
  return {
    taskId: "31111111-1111-4111-8111-111111111111",
    cwd: "/repo/app",
    status: "running",
    roundCount: 2,
    turnCount: 5,
    updatedAt: "2026-11-25T08:00:00.000Z",
    lastActivityAt: "2026-11-25T08:00:00.000Z",
    ...overrides,
  };
}

test("test_parse_tool_input_scope_locks_session_before_first_snapshot", () => {
  // ontoolinput 首屏即可解析作用域与 taskId
  const parsed = parseToolInputScope({
    arguments: {
      parentSessionId: " conv-abc ",
      parentSessionTitle: " 会话标题 ",
      cwd: "/repo/app",
      taskId: "31111111-1111-4111-8111-111111111111",
    },
  });
  assert.deepEqual(parsed.scope, {
    parentSessionId: "conv-abc",
    parentSessionTitle: "会话标题",
    cwd: "/repo/app",
  });
  assert.equal(parsed.taskId, "31111111-1111-4111-8111-111111111111");

  // 缺失/非法参数一律安全回退空作用域
  for (const params of [undefined, null, {}, { arguments: null }, { arguments: [] }, { arguments: { parentSessionId: 42, cwd: "  " } }]) {
    const empty = parseToolInputScope(params);
    assert.deepEqual(empty.scope, EMPTY_SCOPE);
    assert.equal(empty.taskId, null);
  }

  // 严格会话锁定：有 parentSessionId 即 session 模式且锁定
  assert.equal(resolveScopeMode(parsed.scope), "session");
  assert.equal(isSessionLocked(parsed.scope), true);
  assert.equal(resolveScopeMode({ ...EMPTY_SCOPE, cwd: "/repo/app" }), "cwd");
  assert.equal(isSessionLocked({ ...EMPTY_SCOPE, cwd: "/repo/app" }), false);
  assert.equal(resolveScopeMode(EMPTY_SCOPE), "all");

  // 兜底与锁定空闲轮询常量
  assert.equal(INITIAL_FALLBACK_MS, 600);
  assert.equal(LOCKED_IDLE_POLL_MS, 2500);
});

test("test_snapshot_scope_args_never_mix_session_with_cwd_filter", () => {
  const scope = { parentSessionId: "conv-abc", parentSessionTitle: "会话标题", cwd: "/repo/app" };
  // session 模式仅传 parentSessionId（可带标题），绝不叠加 cwd
  assert.deepEqual(buildSnapshotScopeArgs("session", scope), {
    parentSessionId: "conv-abc",
    parentSessionTitle: "会话标题",
  });
  assert.deepEqual(buildSnapshotScopeArgs("session", { ...scope, parentSessionTitle: null }), {
    parentSessionId: "conv-abc",
  });
  assert.deepEqual(buildSnapshotScopeArgs("cwd", scope), { cwd: "/repo/app" });
  assert.deepEqual(buildSnapshotScopeArgs("all", scope), {});
  assert.deepEqual(buildSnapshotScopeArgs("session", EMPTY_SCOPE), {});
});

test("test_task_option_and_group_labels_prefer_readable_titles", () => {
  assert.equal(shortDir("/repo/app/"), "app");
  assert.equal(truncateLabel("短标题", 40), "短标题");
  assert.equal(truncateLabel("字".repeat(50), 40), `${"字".repeat(40)}…`);

  // 下拉项：[status] 标题（或目录名）· R轮 T轮 (id8)
  const task = makeScopeTask({ title: "修复监控面板" });
  assert.equal(formatTaskOptionLabel(task), "[running] 修复监控面板 · R2 T5 (31111111)");
  assert.equal(formatTaskOptionLabel(makeScopeTask()), "[running] app · R2 T5 (31111111)");
  assert.equal(
    formatTaskOptionLabel(makeScopeTask({ title: "长".repeat(60) })),
    `[running] ${"长".repeat(40)}… · R2 T5 (31111111)`,
  );

  // 会话徽章：标题优先，无标题回退 会话 id8
  assert.equal(formatSessionBadge("conv-abcdef123", "会话标题"), "会话标题");
  assert.equal(formatSessionBadge("conv-abcdef123"), "会话 conv-abc");
  assert.equal(formatSessionBadge("conv-abcdef123", "  "), "会话 conv-abc");

  // 分组标签：标题优先 ${title} · ${dir}，无标题 ${dir} · 会话 ${id8}，无会话 ${dir} · 未标记会话
  const group = {
    groupKey: "session:conv-abcdef123",
    parentSessionId: "conv-abcdef123",
    parentSessionTitle: "会话标题",
    cwd: "/repo/app",
    runningCount: 1,
    latestActivityAt: "2026-11-25T08:00:00.000Z",
    tasks: [task],
  };
  assert.equal(formatGroupLabel(group), "会话标题 · app (1 · 1 运行中)");
  assert.equal(formatGroupLabel({ ...group, parentSessionTitle: null }), "app · 会话 conv-abc (1 · 1 运行中)");
  assert.equal(
    formatGroupLabel({ ...group, parentSessionId: null, parentSessionTitle: null, runningCount: 0 }),
    "app · 未标记会话 (1)",
  );
});

test("test_fallback_grouping_aggregates_latest_session_title_and_auto_focus", () => {
  const older = makeScopeTask({
    taskId: "32222222-2222-4222-8222-222222222222",
    parentSessionId: "sess-x",
    parentSessionTitle: "旧标题",
    status: "done",
    lastActivityAt: "2026-11-25T08:00:00.000Z",
  });
  const newer = makeScopeTask({
    taskId: "33333333-3333-4333-8333-333333333333",
    parentSessionId: "sess-x",
    parentSessionTitle: "新标题",
    status: "running",
    lastActivityAt: "2026-11-25T09:00:00.000Z",
  });
  const legacy = makeScopeTask({ taskId: "34444444-4444-4444-8444-444444444444", status: "done" });
  const groups = fallbackGroupTasks([older, newer, legacy]);
  assert.equal(groups.length, 2);
  const byKey = new Map(groups.map((g) => [g.groupKey, g]));
  assert.equal(byKey.get("session:sess-x").parentSessionTitle, "新标题");
  assert.equal(byKey.get("session:sess-x").runningCount, 1);
  assert.equal(byKey.get("cwd:/repo/app").parentSessionTitle, null);

  // 自动聚焦：优先最新运行中，否则首个；空列表 null
  assert.equal(pickAutoFocusTaskId([older, newer]), newer.taskId);
  assert.equal(pickAutoFocusTaskId([older, legacy]), older.taskId);
  assert.equal(pickAutoFocusTaskId([]), null);
});

test("test_is_conversation_surface_follows_agy_host_capabilities", () => {
  // 对话内侧面板具备 message / updateModelContext；左侧栏 global 视图两者皆无
  assert.equal(isConversationSurface(undefined), false);
  assert.equal(isConversationSurface(null), false);
  assert.equal(isConversationSurface({}), false);
  assert.equal(isConversationSurface({ serverTools: {} }), false);
  assert.equal(isConversationSurface({ message: {} }), true);
  assert.equal(isConversationSurface({ updateModelContext: {} }), true);
  assert.equal(isConversationSurface({ message: {}, updateModelContext: {} }), true);
});

test("test_merge_tool_result_scope_never_downgrades_locked_session", () => {
  const locked = { parentSessionId: "conv-abc", parentSessionTitle: "会话标题", cwd: "/repo/a" };

  // 1. 锁定新会话：接受 payload；同会话且服务端无标题时保留已锁定标题，换会话则不沿用旧标题
  const same = mergeToolResultScope(locked, { parentSessionId: "conv-abc", parentSessionTitle: null, cwd: null }, true);
  assert.deepEqual(same, {
    nextScope: { parentSessionId: "conv-abc", parentSessionTitle: "会话标题", cwd: null },
    acceptPayload: true,
    preservePreviousSession: false,
  });
  const switched = mergeToolResultScope(locked, { parentSessionId: "conv-new", parentSessionTitle: "新会话", cwd: "/repo/b" }, true);
  assert.equal(switched.acceptPayload, true);
  assert.deepEqual(switched.nextScope, { parentSessionId: "conv-new", parentSessionTitle: "新会话", cwd: "/repo/b" });
  const switchedNoTitle = mergeToolResultScope(locked, { parentSessionId: "conv-new", parentSessionTitle: null, cwd: null }, false);
  assert.equal(switchedNoTitle.nextScope.parentSessionTitle, null);

  // 2. 拒绝 {} 降级：已锁定会话收到 parentSessionId=null 的重载/重放 payload，不覆盖、要求按锁定会话重拉
  for (const incoming of [null, undefined, EMPTY_SCOPE, { parentSessionId: null, parentSessionTitle: "x", cwd: "/other" }]) {
    const refused = mergeToolResultScope(locked, incoming, true);
    assert.deepEqual(refused, { nextScope: locked, acceptPayload: false, preservePreviousSession: true });
  }

  // 3. 对话面未绑定会话：fail-closed，不展示跨会话任务
  const failClosed = mergeToolResultScope(EMPTY_SCOPE, { parentSessionId: null, parentSessionTitle: null, cwd: "/repo" }, true);
  assert.deepEqual(failClosed, { nextScope: EMPTY_SCOPE, acceptPayload: false, preservePreviousSession: false });
  assert.deepEqual(mergeToolResultScope(EMPTY_SCOPE, null, true), failClosed);

  // 4. global 视图：允许全量 payload，沿用服务端作用域
  const globalAll = mergeToolResultScope(EMPTY_SCOPE, { parentSessionId: null, parentSessionTitle: null, cwd: "/repo" }, false);
  assert.equal(globalAll.acceptPayload, true);
  assert.equal(globalAll.preservePreviousSession, false);
  assert.deepEqual(globalAll.nextScope, { parentSessionId: null, parentSessionTitle: null, cwd: "/repo" });
  assert.deepEqual(mergeToolResultScope(EMPTY_SCOPE, null, false).nextScope, EMPTY_SCOPE);
  // global 视图已锁定会话时同样拒绝降级
  assert.equal(mergeToolResultScope(locked, null, false).preservePreviousSession, true);
});

test("test_tool_input_polling_and_snapshot_gates_fail_closed_in_conversation_surface", () => {
  const convParsed = parseToolInputScope({ arguments: { parentSessionId: "conv-abc", cwd: "/repo" } });
  const emptyParsed = parseToolInputScope({});
  const cwdParsed = parseToolInputScope({ arguments: { cwd: "/repo" } });
  const locked = { parentSessionId: "conv-abc", parentSessionTitle: null, cwd: null };

  // 对话面：仅当入参或本地已有会话 id 才抢跑；空 {} / 仅 cwd 时等待 ontoolresult
  assert.equal(shouldPollOnToolInput(convParsed, EMPTY_SCOPE, true), true);
  assert.equal(shouldPollOnToolInput(emptyParsed, locked, true), true);
  assert.equal(shouldPollOnToolInput(emptyParsed, EMPTY_SCOPE, true), false);
  assert.equal(shouldPollOnToolInput(cwdParsed, EMPTY_SCOPE, true), false);
  // global 视图：总是允许
  assert.equal(shouldPollOnToolInput(emptyParsed, EMPTY_SCOPE, false), true);

  // 快照闸：对话面仅允许带会话 id 的 session 模式
  assert.equal(canFetchSnapshot("session", locked, true), true);
  assert.equal(canFetchSnapshot("session", { ...locked, parentSessionId: null }, true), false);
  assert.equal(canFetchSnapshot("cwd", { ...EMPTY_SCOPE, cwd: "/repo" }, true), false);
  assert.equal(canFetchSnapshot("all", EMPTY_SCOPE, true), false);
  assert.equal(canFetchSnapshot("all", EMPTY_SCOPE, false), true);
  assert.equal(canFetchSnapshot("cwd", EMPTY_SCOPE, false), true);

  // 600ms 兜底仅用于 global 视图
  assert.equal(shouldScheduleInitialFallback(false), true);
  assert.equal(shouldScheduleInitialFallback(true), false);
});

test("test_locked_session_keeps_low_frequency_polling_when_idle", () => {
  const running = makeScopeTask();
  const done = makeScopeTask({ status: "done" });
  // 会话锁定空闲态维持 2500ms 低频轮询，让同会话新任务自动出现
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: null, tasks: [], sessionLocked: true }), LOCKED_IDLE_POLL_MS);
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: "done", tasks: [done], sessionLocked: true }), LOCKED_IDLE_POLL_MS);
  // 非锁定空闲态停止轮询
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: "done", tasks: [done], sessionLocked: false }), null);
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: null, tasks: [], sessionLocked: false }), null);
  // 活跃态节奏不受锁定影响
  assert.equal(resolvePollDelayMs({ hasMore: true, taskStatus: "running", tasks: [running], sessionLocked: true }), 80);
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: "running", tasks: [running], sessionLocked: true }), 500);
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: "needs_input", tasks: [running], sessionLocked: false }), 3000);
  assert.equal(resolvePollDelayMs({ hasMore: false, taskStatus: null, tasks: [running], sessionLocked: false }), 1500);
});

test("test_monitor_html_contains_session_lock_and_title_markers", () => {
  const html = readFileSync(MONITOR_HTML, "utf8");
  // 构建产物须包含会话锁定标识、任务标题样式与徽章回退文案
  assert.ok(html.includes("当前会话"), "monitor.html missing locked-session badge text");
  assert.ok(html.includes("scope-locked"), "monitor.html missing scope-locked class");
  assert.ok(html.includes("task-title"), "monitor.html missing task-title class");
  assert.ok(html.includes("会话 "), "monitor.html missing session badge fallback text");
  assert.ok(html.includes("未标记会话"), "monitor.html missing unlabeled-session group text");
});

test("test_timeline_renders_steer_events_with_compass_icon_and_source", () => {
  assert.equal(iconForEvent({ kind: "steer" }), "🧭");
  const t = "2026-11-25T10:00:00.000Z";
  const events = [
    { seq: 1, round: 1, kind: "tool_start", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "long build", preview: "long build", timestamp: t },
    { seq: 2, round: 1, kind: "steer", title: "Steer 插话（主代理）", detail: "改用方案 B 并补测试", timestamp: t },
    { seq: 3, round: 1, kind: "steer", title: "Steer 插话（面板）", detail: "第一行\n第二行", timestamp: t },
    { seq: 4, round: 1, kind: "tool_end", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "ok", isError: false, timestamp: t },
  ];
  const items = reduceTimelineItems(events, true);
  // steer 事件保持独立时间线条目，不打断工具卡合并
  const steerItems = items.filter((it) => it.type === "event" && it.kind === "steer");
  assert.equal(steerItems.length, 2);
  assert.match(steerItems[0].title, /主代理/);
  assert.equal(steerItems[0].detail, "改用方案 B 并补测试");
  assert.match(steerItems[1].title, /面板/);
  assert.equal(steerItems[1].isError, false);
  const toolItems = items.filter((it) => it.type === "tool");
  assert.equal(toolItems.length, 1);
  assert.equal(toolItems[0].status, "done");
  assert.equal(new Set(items.map((it) => it.key)).size, items.length);
});

test("test_monitor_html_contains_running_steer_bar_markers", () => {
  const html = readFileSync(MONITOR_HTML, "utf8");
  // 运行态实时插话栏：输入框、发送按钮、成功提示与 app-only 工具名须进入构建产物
  assert.ok(html.includes("steer-bar"), "monitor.html missing steer-bar class");
  assert.ok(html.includes("steer-input"), "monitor.html missing steer-input class");
  assert.ok(html.includes("btn-steer"), "monitor.html missing btn-steer class");
  assert.ok(html.includes("pi_worker_app_steer"), "monitor.html missing pi_worker_app_steer call");
  assert.ok(html.includes("已入队，将在当前 turn 结束后注入"), "monitor.html missing steer queued notice");
  assert.ok(html.includes("🧭"), "monitor.html missing steer compass icon");
  assert.ok(html.includes("Shift+Enter"), "monitor.html missing steer input hint");
});

test("test_app_tsx_and_monitor_html_enforce_ui_event_window_and_memo", () => {
  const appSource = readFileSync(join(ROOT, "plugins", "pi-worker", "ui-src", "app.tsx"), "utf8");
  assert.match(appSource, /MAX_UI_EVENTS\s*=\s*2000/);
  assert.match(appSource, /useMemo\(\s*\(\)\s*=>\s*reduceTimelineItems\(events,\s*isRunning\)/);
  assert.match(appSource, /slice\(/);
  // 根因修复：对话面 fail-closed 闸门必须接入 poller、ontoolinput、ontoolresult 与兜底定时器
  assert.match(appSource, /canFetchSnapshot\(mode,\s*scope,\s*inConversationSurfaceRef\.current\)/);
  assert.match(appSource, /shouldPollOnToolInput\(parsed,\s*initialScopeRef\.current,\s*inConversationSurfaceRef\.current\)/);
  assert.match(appSource, /mergeToolResultScope\(initialScopeRef\.current,\s*payload\.scope,\s*inConversationSurfaceRef\.current\)/);
  assert.match(appSource, /shouldScheduleInitialFallback\(convSurface\)/);
  assert.match(appSource, /isConversationSurface\(app\?\.getHostCapabilities\(\)\)/);
  const html = readFileSync(MONITOR_HTML, "utf8");
  assert.ok(html.includes("当前侧面板尚未绑定会话"), "monitor.html missing unbound-session hint");
});

// ───────────────────────── 「全部折叠」按钮回归 ─────────────────────────

/** 时间线事件样本：覆盖全部可折叠块（thinking / 含正文 tool 卡 / 多行 detail 事件）与若干静态块 */
const COLLAPSE_T = "2026-11-25T10:00:00.000Z";
const COLLAPSE_EVENTS_BASE = [
  { seq: 1, round: 1, blockId: 1, kind: "thinking", title: "思考中", detail: "先读源码再改", thinkingChars: 6, timestamp: COLLAPSE_T },
  { seq: 2, round: 1, kind: "tool_start", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "npm test", preview: "npm test", timestamp: COLLAPSE_T },
  { seq: 3, round: 1, kind: "tool_end", toolName: "bash", toolCallId: "tc-1", title: "bash", detail: "ALL PASS\nok", isError: false, durationMs: 100, timestamp: COLLAPSE_T },
  { seq: 4, round: 1, kind: "tool_start", toolName: "glob", toolCallId: "tc-2", title: "glob", preview: "src/**", timestamp: COLLAPSE_T },
  { seq: 5, round: 1, kind: "tool_end", toolName: "glob", toolCallId: "tc-2", title: "glob", isError: false, durationMs: 5, timestamp: COLLAPSE_T },
  { seq: 6, round: 1, kind: "steer", title: "Steer 插话（主代理）", detail: "改用方案 B\n并补测试", timestamp: COLLAPSE_T },
  { seq: 7, round: 1, kind: "steer", title: "Steer 插话（面板）", detail: "继续", timestamp: COLLAPSE_T },
  { seq: 8, round: 1, blockId: 2, kind: "text_delta", title: "助手输出", detail: "## 进度\n- 已完成", timestamp: COLLAPSE_T },
  { seq: 9, round: 1, blockId: 2, kind: "assistant", title: "助手输出", detail: "## 进度\n- 已完成全部测试", timestamp: COLLAPSE_T },
];
const COLLAPSE_EVENTS_INCREMENT = [
  { seq: 10, round: 1, blockId: 3, kind: "thinking", title: "思考中", detail: "第二轮分析", thinkingChars: 5, timestamp: COLLAPSE_T },
  { seq: 11, round: 1, kind: "tool_start", toolName: "read", toolCallId: "tc-3", title: "read", detail: "src/index.ts", preview: "src/index.ts", timestamp: COLLAPSE_T },
  { seq: 12, round: 1, kind: "tool_end", toolName: "read", toolCallId: "tc-3", title: "read", detail: "line1\nline2", isError: true, durationMs: 20, timestamp: COLLAPSE_T },
  { seq: 13, round: 1, kind: "status", title: "状态更新", detail: "x".repeat(150), isError: false, timestamp: COLLAPSE_T },
];

/** 按类型/特征从 reduce 结果中定位 key，避免硬编码 key 格式 */
function itemKey(items, pred) {
  const found = items.find(pred);
  assert.ok(found, `timeline item not found: ${pred}`);
  return found.key;
}

/** 最小 DOM 桩：只实现 querySelectorAll 对 EXPANDABLE/OPEN 选择器的匹配 */
function makeFakeTimelineRoot(nodes) {
  const matches = (node, selector) => {
    if (!node.details || !node.expandable) return false;
    return selector === EXPANDABLE_SELECTOR || (selector === OPEN_EXPANDABLE_SELECTOR && node.open);
  };
  return {
    nodes,
    querySelectorAll(selector) {
      return nodes.filter((node) => matches(node, selector));
    },
  };
}
const fakeDetails = (open, expandable = true) => ({ details: true, expandable, open });

test("test_collapse_state_helpers_track_expand_clear_prune_and_dom_collapse", () => {
  const items = reduceTimelineItems(COLLAPSE_EVENTS_BASE, true);
  // thinking + 含正文 tool 卡(tc-1) 为 <details>；无正文 tool 卡(tc-2)、单行 steer、assistant 为静态块
  assert.deepEqual(items.map((it) => it.type), ["thinking", "tool", "tool", "event", "event", "assistant"]);
  assert.equal(items[2].status, "done");
  assert.equal(items[2].input ?? items[2].output, undefined, "无正文工具卡不渲染为可折叠块");
  assert.equal(isExpandableDetail(items[4].detail), false);
  const thinking = items[0];
  const toolWithBody = items[1];
  const steerMulti = items[3];

  // 1. 初始无展开块：集合为空 → 无已展开项
  let expanded = clearExpandedKeys();
  assert.equal(expanded.size, 0);
  assert.equal(hasExpandedItem(expanded, items), false);

  // 2. 用户点击展开多种可折叠块
  expanded = setExpandedKey(expanded, thinking.key, true);
  expanded = setExpandedKey(expanded, toolWithBody.key, true);
  expanded = setExpandedKey(expanded, steerMulti.key, true);
  assert.equal(expanded.size, 3);
  assert.equal(hasExpandedItem(expanded, items), true);
  // 幂等：重复 set 同值返回同一引用
  assert.equal(setExpandedKey(expanded, thinking.key, true), expanded);
  // 单个折叠同步启用态
  const oneCollapsed = setExpandedKey(expanded, thinking.key, false);
  assert.equal(oneCollapsed.size, 2);
  assert.equal(hasExpandedItem(oneCollapsed, items), true);

  // 3. 全部折叠：DOM 同步关闭 + 内部集合清空
  const root = makeFakeTimelineRoot([
    fakeDetails(true),                        // thinking
    fakeDetails(true),                        // tool 卡
    fakeDetails(false),                       // 已折叠块不计
    fakeDetails(true, false),                 // 非 ev-expandable 的 <details>（如 Markdown 内）不受影响
    fakeDetails(true),                        // 多行 steer
  ]);
  const result = collapseAll(expanded, root);
  assert.equal(result.closedCount, 3);
  assert.equal(result.expanded.size, 0);
  assert.deepEqual(root.nodes.map((n) => n.open), [false, false, false, true, false]);
  assert.equal(hasExpandedItem(result.expanded, items), false);
  // 空容器 / 无容器安全
  assert.equal(collapseExpandables(null), 0);
  assert.equal(collapseExpandables(makeFakeTimelineRoot([])), 0);

  // 4. 增量重渲染：残留 key 剔除、折叠状态不反弹
  const allEvents = [...COLLAPSE_EVENTS_BASE, ...COLLAPSE_EVENTS_INCREMENT];
  const nextItems = reduceTimelineItems(allEvents, true);
  // 模拟仅残留一个已滚出窗口 key 的集合：按新时间线剔除后不再点亮按钮
  const stale = new Set(["gone:key"]);
  assert.equal(hasExpandedItem(stale, nextItems), false);
  assert.equal(pruneExpandedKeys(stale, nextItems).size, 0);
  // 折叠后的空集合在增量重渲染后保持为空（不反弹）
  const afterIncrement = pruneExpandedKeys(result.expanded, nextItems);
  assert.equal(afterIncrement.size, 0);
  assert.equal(hasExpandedItem(afterIncrement, nextItems), false);
  // 新增的可折叠块（read 报错卡、超长 status 事件）默认折叠，不影响既有折叠块
  const readKey = itemKey(nextItems, (it) => it.type === "tool" && it.toolName === "read");
  const statusKey = itemKey(nextItems, (it) => it.type === "event" && it.title === "状态更新");
  assert.equal(afterIncrement.has(readKey), false);
  assert.equal(afterIncrement.has(statusKey), false);
  // 无残留时 prune 返回原引用，避免无谓重渲染
  const live = setExpandedKey(afterIncrement, steerMulti.key, true);
  assert.equal(pruneExpandedKeys(live, nextItems), live);
  assert.equal(hasExpandedItem(pruneExpandedKeys(live, nextItems), nextItems), true);
});

/** 经 esbuild（UI 构建同链路）打包真实 TimelineCard，校验 <details open> 受控渲染与按钮禁用态 */
async function loadBundledTimelineCard() {
  let esbuild;
  try {
    const req = createRequire(join(UI_SRC, "package.json"));
    esbuild = req("esbuild");
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ui-collapse-"));
  const entry = join(dir, "entry.mjs");
  const outfile = join(dir, "bundle.mjs");
  writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineCard } from ${JSON.stringify(join(UI_SRC, "app.tsx"))};
export { renderToStaticMarkup, TimelineCard };
`);
  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: ["es2022"],
      jsx: "automatic",
      nodePaths: [UI_NODE_MODULES],
      define: { "process.env.NODE_ENV": '"production"' },
      // react-dom/server 等 CJS 依赖在 ESM 产物中经 createRequire 兜底
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      logLevel: "silent",
    });
    const mod = await import(pathToFileURL(outfile).href);
    rmSync(dir, { recursive: true, force: true });
    return mod;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function countOpenDetails(html) {
  return (html.match(/<details[^>]*\sopen=""[^>]*>/g) ?? []).length;
}

test("test_collapse_all_button_renders_disabled_and_blocks_stay_collapsed_after_rerender", async (t) => {
  let mod;
  try {
    mod = await loadBundledTimelineCard();
  } catch (err) {
    if (String(err?.message ?? err).includes("Cannot find module")) {
      t.skip("ui-src/node_modules 未安装，跳过真实 React 渲染校验（npm install 后可运行）");
      return;
    }
    throw err;
  }
  if (!mod) {
    t.skip("ui-src/node_modules 未安装，跳过真实 React 渲染校验（npm install 后可运行）");
    return;
  }
  const { renderToStaticMarkup, TimelineCard } = mod;
  const items = reduceTimelineItems(COLLAPSE_EVENTS_BASE, true);
  const onToggle = () => () => {};
  const render = (list, expanded, hasExpanded, root = null) => renderToStaticMarkup(TimelineCard({
    items: list,
    expand: { expanded, onToggle },
    hasExpanded,
    onCollapseAll: () => {},
    onOpenLink: () => {},
    timelineRef: { current: root },
  }));

  // 1. 初始：按钮禁用，所有 details 均折叠；静态块（无正文工具卡 / 单行 steer / assistant）不渲染 <details>
  let expanded = clearExpandedKeys();
  let html = render(items, expanded, hasExpandedItem(expanded, items));
  assert.match(html, /<button[^>]*id="btn-collapse-all"[^>]*disabled=""[^>]*>全部折叠<\/button>/);
  assert.equal(countOpenDetails(html), 0);
  // thinking / 含正文 tool 卡 / 多行 steer 共 3 个 <details>；无正文 tool 卡、单行 steer、assistant 不渲染 <details>
  assert.equal((html.match(/<details /g) ?? []).length, 3);
  assert.equal((html.match(/ev-expandable/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<details[^>]*ev-tool_start ev-expandable"[^>]*>[^<]*<summary[^>]*>[^<]*<div class="ev-head">[^<]*<span class="ev-title">[^<]*<span>[^<]*glob/, "无正文工具卡不应渲染为 details");

  // 2. 展开多种可折叠块：按钮可用，三个块带 open
  expanded = setExpandedKey(expanded, items[0].key, true);
  expanded = setExpandedKey(expanded, items[1].key, true);
  expanded = setExpandedKey(expanded, items[3].key, true);
  html = render(items, expanded, hasExpandedItem(expanded, items));
  assert.match(html, /<button[^>]*id="btn-collapse-all"(?![^>]*disabled)[^>]*>全部折叠<\/button>/);
  assert.equal(countOpenDetails(html), 3);
  assert.match(html, /<details class="ev ev-thinking ev-expandable" open=""/);
  assert.match(html, /<details class="ev ev-tool_end ev-expandable" open=""/);
  assert.match(html, /<details class="ev ev-steer ev-expandable" open=""/);
  // 三类可折叠块（thinking / tool / steer）均受控展开
  assert.equal((html.match(/<details /g) ?? []).length, 3);

  // 3. 点击「全部折叠」：DOM 同步关闭 + 集合清空 → 重渲染全部折叠、按钮恢复禁用
  const root = makeFakeTimelineRoot([fakeDetails(true), fakeDetails(true), fakeDetails(false), fakeDetails(true)]);
  const { expanded: cleared, closedCount } = collapseAll(expanded, root);
  assert.equal(closedCount, 3);
  expanded = cleared;
  html = render(items, expanded, hasExpandedItem(expanded, items));
  assert.equal(countOpenDetails(html), 0);
  assert.match(html, /<button[^>]*id="btn-collapse-all"[^>]*disabled=""[^>]*>全部折叠<\/button>/);

  // 4. 再触发一轮增量重渲染：原展开块保持折叠不反弹，新增块默认折叠，按钮仍禁用
  const nextItems = reduceTimelineItems([...COLLAPSE_EVENTS_BASE, ...COLLAPSE_EVENTS_INCREMENT], true);
  expanded = pruneExpandedKeys(expanded, nextItems);
  html = render(nextItems, expanded, hasExpandedItem(expanded, nextItems));
  assert.equal(countOpenDetails(html), 0);
  // 新增第二轮 thinking、read 报错卡与超长 status 事件同样渲染为 <details>（共 6 个）且默认折叠
  assert.equal((html.match(/<details /g) ?? []).length, 6);
  assert.equal((html.match(/ev-expandable/g) ?? []).length, 6);
  assert.match(html, /<button[^>]*id="btn-collapse-all"[^>]*disabled=""[^>]*>全部折叠<\/button>/);
  assert.ok(html.includes(`实时进度流 (${nextItems.length})`));
  // 反向校验：受控 open 为 true 时确实渲染 open 属性，证明渲染契约为受控展开而非仅靠 DOM
  const oneOpen = setExpandedKey(
    expanded,
    itemKey(nextItems, (it) => it.type === "tool" && it.toolName === "read"),
    true,
  );
  html = render(nextItems, oneOpen, hasExpandedItem(oneOpen, nextItems));
  assert.equal(countOpenDetails(html), 1);
  assert.match(html, /<button[^>]*id="btn-collapse-all"(?![^>]*disabled)[^>]*>全部折叠<\/button>/);
});

test("test_app_tsx_wires_controlled_details_and_collapse_all_button", () => {
  const appSource = readFileSync(join(UI_SRC, "app.tsx"), "utf8");
  // 三类可折叠块（thinking / tool / 多行 detail 事件）均以 expandedKeys 受控 open 并挂接 onToggle
  assert.equal((appSource.match(/open=\{expand\.expanded\.has\(item\.key\)\}/g) ?? []).length, 3);
  assert.equal((appSource.match(/onToggle=\{expand\.onToggle\(item\.key\)\}/g) ?? []).length, 3);
  // 全部折叠：同步关闭 DOM + 清空状态；按钮启用态由当前视图中已展开块决定
  assert.match(appSource, /collapseExpandables\(timelineRef\.current\);\s*setExpandedKeys\(clearExpandedKeys\(\)\)/);
  assert.match(appSource, /disabled=\{!hasExpanded\}/);
  assert.match(appSource, /hasExpandedItem\(expandedKeys,\s*timelineItems\)/);
  assert.match(appSource, /pruneExpandedKeys\(prev,\s*timelineItems\)/);
  assert.match(appSource, /className="timeline" ref=\{timelineRef\}/);
  const html = readFileSync(MONITOR_HTML, "utf8");
  // 构建产物与源码一致：按钮文案 / id / 样式类均已进入 monitor.html
  assert.ok(html.includes("全部折叠"), "monitor.html missing 全部折叠 button text");
  assert.ok(html.includes("btn-collapse-all"), "monitor.html missing btn-collapse-all id");
  assert.ok(html.includes("btn-collapse"), "monitor.html missing btn-collapse class");
  assert.ok(html.includes("section-head"), "monitor.html missing section-head class");
});
