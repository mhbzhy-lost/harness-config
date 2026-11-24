import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGitStatusFileUri } from "../plugins/pi-worker/ui-src/git-uri.ts";

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
  assert.equal(parseGitStatusFileUri("/repo", "D  removed.ts"), null);
  assert.equal(parseGitStatusFileUri("/repo", "?? src/"), null);
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
