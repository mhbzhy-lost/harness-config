import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGitStatusFileUri } from "../plugins/pi-worker/ui-src/git-uri.ts";
import { renderMarkdown } from "../plugins/pi-worker/ui-src/markdown.ts";
import { createCoalescingRunner } from "../plugins/pi-worker/ui-src/poller.ts";
import { iconForEvent, isExpandableDetail, summarizeDetailPreview } from "../plugins/pi-worker/ui-src/timeline.ts";

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
  for (const kind of ["tool_start", "tool_end", "assistant", "compact", "retry_failed", "status", "turn_end", "session"]) {
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

test("test_markdown_renderer_supports_gfm_and_blocks_xss", () => {
  const md = [
    "## 排查报告",
    "",
    "状态：**正常**，调用 `pi_worker_start` 与 say_voice_route。",
    "",
    "| 项 | 现状 |",
    "|---|---|",
    "| `voices` | `{}` |",
    "",
    "```sh",
    "echo <script>alert(1)</script>",
    "```",
    "",
    "- 第一项",
    "  - 子项 *斜体*",
    "- [安全链接](https://example.com) / [危险链接](javascript:alert(1))",
    "",
    "<img src=x onerror=alert(1)>",
  ].join("\n");

  const html = renderMarkdown(md);
  assert.match(html, /<h2 class="md-h md-h2">排查报告<\/h2>/);
  assert.match(html, /<strong>正常<\/strong>/);
  assert.match(html, /<code>pi_worker_start<\/code>/);
  // 下划线标识符不得被误渲染成斜体
  assert.match(html, /say_voice_route/);
  assert.doesNotMatch(html, /<em>voice<\/em>/);
  // 表格与代码块
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>项<\/th>/);
  assert.match(html, /<pre class="md-code" data-lang="sh"><code>echo &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  // 嵌套列表
  assert.match(html, /<ul class="md-list"><li>第一项<ul class="md-list"><li>子项 <em>斜体<\/em><\/li><\/ul><\/li>/);
  // 链接协议白名单与原始 HTML 转义
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">安全链接<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("test_monitor_html_is_self_contained_csp_safe_and_served_by_mcp", async () => {
  const st = statSync(MONITOR_HTML);
  assert.ok(st.size > 1024 && st.size < 2 * 1024 * 1024, `unexpected monitor.html size: ${st.size}`);
  const html = readFileSync(MONITOR_HTML, "utf8");
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<style>/i);
  assert.match(html, /<script>/i);
  // 严格遵守 default-src 'none' 默认 CSP：禁止外部 http(s) script/link
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  // 可展开进度条目须使用原生 <details> + ev-expandable，且不得再用 ▶ 作为 tool_start 静态图标
  assert.match(html, /ev-expandable/);
  assert.doesNotMatch(html, /tool_start"\?"▶"/);

  const dir = mkdtempSync(join(tmpdir(), "pi-worker-ui-mcp-"));
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, PI_WORKER_AGY: "1", PI_WORKER_STATE_DIR: join(dir, "state") },
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
