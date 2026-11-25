import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGitStatusFileUri } from "../plugins/pi-worker/ui-src/git-uri.ts";
import { createCoalescingRunner } from "../plugins/pi-worker/ui-src/poller.ts";
import {
  iconForEvent,
  isExpandableDetail,
  reduceTimelineItems,
  summarizeDetailPreview,
} from "../plugins/pi-worker/ui-src/timeline.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_HTML = join(ROOT, "plugins", "pi-worker", "ui", "monitor.html");
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
