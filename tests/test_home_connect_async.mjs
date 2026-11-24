import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runLocal, resetHomeConnect } from "../plugins/home-connect/src/connection.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_SERVER = join(ROOT, "plugins", "home-connect", "src", "server.ts");

function startHomeMcp(envOverrides = {}) {
  const env = { ...process.env };
  delete env.HOME_CONNECT_AGY_ASYNC;
  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, [HOME_SERVER], {
    cwd: join(ROOT, "plugins", "home-connect"),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buf = "";
  let nextId = 1;
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
      if (msg.id !== undefined && pending.has(msg.id)) {
        const res = pending.get(msg.id);
        pending.delete(msg.id);
        res(msg);
      }
    }
  });

  const request = (method, params = {}) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const close = () => new Promise((res) => {
    child.once("close", (code) => res(code));
    child.stdin.end();
  });

  return { request, close };
}

test("test_home_connect_hides_bg_tools_and_keeps_instructions_clean_without_agy_flag", async () => {
  const client = startHomeMcp();
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.instructions.includes("home_exec_bg"), false);
    assert.equal(init.result.instructions.includes("home_copy_bg"), false);

    const list = await client.request("tools/list");
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      ["home_status", "home_exec", "home_copy", "home_wake", "home_reset"],
    );

    const callExecBg = await client.request("tools/call", {
      name: "home_exec_bg",
      arguments: { target: "mac", command: "echo hi" },
    });
    assert.equal(callExecBg.result.isError, true);

    const callCopyBg = await client.request("tools/call", {
      name: "home_copy_bg",
      arguments: { target: "mac", direction: "put", localPath: "/a", remotePath: "/b" },
    });
    assert.equal(callCopyBg.result.isError, true);
  } finally {
    await client.close();
  }
});

test("test_home_connect_exposes_bg_tools_with_agy_flag_and_validates_args", async () => {
  const client = startHomeMcp({ HOME_CONNECT_AGY_ASYNC: "1" });
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.match(init.result.instructions, /home_exec_bg/);

    const list = await client.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("home_exec_bg"));
    assert.ok(names.includes("home_copy_bg"));

    const execBgTool = list.result.tools.find((t) => t.name === "home_exec_bg");
    assert.equal(execBgTool.inputSchema.properties.timeoutSec.minimum, 0);
    assert.equal(execBgTool.inputSchema.properties.timeoutSec.maximum, undefined);

    // 参数校验失败不触发真实 SSH
    for (const badCall of [
      { name: "home_exec_bg", arguments: { target: "invalid", command: "echo hi" } },
      { name: "home_exec_bg", arguments: { target: "mac", command: "   " } },
      { name: "home_exec_bg", arguments: { target: "mac", command: "echo hi", timeoutSec: -5 } },
      { name: "home_copy_bg", arguments: { target: "mac", direction: "bad", localPath: "/a", remotePath: "/b" } },
      { name: "home_copy_bg", arguments: { target: "mac", direction: "put" } },
    ]) {
      const res = await client.request("tools/call", badCall);
      assert.equal(res.result.isError, true, `expected isError for ${JSON.stringify(badCall)}`);
    }
  } finally {
    await client.close();
  }
});

test("test_connection_settle_zero_timeout_and_reset", async () => {
  // timeoutSec = 0 不应设置本地 1s 截断，能正常完成 > 1.2s 的命令
  const res = await runLocal("sleep 1.2 && echo ok-zero-timeout", 0);
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.match(res.stdout, /ok-zero-timeout/);

  // timeoutSec = 0 运行中的命令依然受 resetHomeConnect() 管控可终止
  const longPromise = runLocal("sleep 30", 0);
  await new Promise((r) => setTimeout(r, 150));
  const resetRes = await resetHomeConnect();
  assert.ok(resetRes.terminated >= 1);
  const longRes = await longPromise;
  assert.notEqual(longRes.code, 0);
});
