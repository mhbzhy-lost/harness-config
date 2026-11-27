import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSensitivePath, checkShellPolicy, checkSynchronousBash } from "../pi/extensions/security-gates/shell-policy.ts";
import { createNetworkRecoveryExtension } from "../pi/extensions/network-recovery/extension.ts";
import { ensureScopedProxyFetch, installScopedProxyFetch, loadOpenAIProxyConfig } from "../pi/extensions/openai-proxy/index.ts";
import { createEndpointFallbackExtension, defaultProbe } from "../pi/extensions/endpoint-fallback/index.ts";
import { classifyPiLaunch, defaultPiSessionDir, resolveRecentSession } from "../pi/extensions/session-owner/contract.ts";
import { createBashCwdToolDefinition, createCachedBashOptions, prepareBashCwdExecution } from "../pi/extensions/bash-cwd/extension.ts";
import { createBashAsyncController } from "../pi/extensions/bash-async/controller.ts";
import { createToolTimingExtension } from "../pi/extensions/tool-timing/index.ts";
import { discoverPlugins } from "../pi/extensions/agent-plugins/manifest.ts";
import { clearAllStatusAnimations, syncStatusAnimation } from "../pi/extensions/compact-tools/status.ts";

// ---- 1. security-gates ----

test("security-gates: 不再误拦截非 git 命令或 git log 中含 commit 词的命令", () => {
  const cwd = process.cwd();
  for (const cmd of [
    "rg commit pi/",
    "grep -rn commit tests/",
    "echo commit",
    "git log --grep commit -n 5",
    "git status",
    'git commit -m "feat(pi): 迁移安全门禁扩展"',
  ]) {
    const res = checkShellPolicy({ command: cmd, cwd, workspaceRoot: cwd });
    assert.equal(res, undefined, `不应拦截合法命令: ${cmd}，实际返回: ${JSON.stringify(res)}`);
  }
});

test("security-gates: 拦截不合规 git commit、多行绕过与管道 sleep", () => {
  const cwd = process.cwd();
  assert.equal(checkShellPolicy({ command: 'git commit -m "fix"', cwd, workspaceRoot: cwd })?.code, "COMMIT_MESSAGE_INVALID");
  assert.equal(checkShellPolicy({ command: 'git commit -m "feat: 已修复一个问题"', cwd, workspaceRoot: cwd })?.code, "COMMIT_MESSAGE_INVALID");
  assert.equal(checkShellPolicy({ command: "echo ok\ngit reset --hard", cwd, workspaceRoot: cwd })?.code, "GIT_DESTRUCTIVE");
  assert.equal(checkShellPolicy({ command: "echo ok | git clean -fd", cwd, workspaceRoot: cwd })?.code, "GIT_DESTRUCTIVE");
  assert.equal(checkSynchronousBash("echo hi\nsleep 5", cwd)?.code, "SYNC_BASH_SLEEP");
  assert.equal(checkSynchronousBash("echo hi | sleep 1", cwd)?.code, "SYNC_BASH_SLEEP");
});

test("security-gates: 拦截 ~/.pi/agent/auth.json 与真实 PI_CODING_AGENT_DIR 删除，不误伤普通项目 pi/ 目录", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sg-test-")));
  const fakeAgentDir = join(root, "fake-pi-agent");
  const workspace = join(root, "workspace");
  mkdirSync(fakeAgentDir, { recursive: true });
  mkdirSync(join(workspace, "pi"), { recursive: true });
  try {
    assert.equal(
      checkSensitivePath({ toolName: "read", input: { path: "~/.pi/agent/auth.json" }, cwd: workspace })?.code,
      "SENSITIVE_AUTH_FILE",
    );
    assert.equal(
      checkSensitivePath({ toolName: "read", input: { path: ".env" }, cwd: workspace })?.code,
      "SENSITIVE_ENV_FILE",
    );
    assert.equal(
      checkSensitivePath({ toolName: "read", input: { path: ".env.example" }, cwd: workspace }),
      undefined,
    );
    // 保护真实 PI_CODING_AGENT_DIR
    assert.equal(
      checkShellPolicy({
        command: `rm -rf ${fakeAgentDir}/settings.json`,
        cwd: workspace,
        workspaceRoot: workspace,
        env: { PI_CODING_AGENT_DIR: fakeAgentDir },
      })?.code,
      "RM_PROTECTED_DIR",
    );
    // 不误伤无关项目的 workspace/pi 目录
    assert.equal(
      checkShellPolicy({
        command: "rm pi/temp.txt",
        cwd: workspace,
        workspaceRoot: workspace,
        env: { PI_CODING_AGENT_DIR: fakeAgentDir },
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 2. network-recovery ----

test("network-recovery: attempting 态看门狗到期且会话空闲时可正常再次唤醒重试", async () => {
  const handlers = new Map();
  const sent = [];
  const notices = [];
  const pi = {
    on(event, fn) { handlers.set(event, fn); },
    getSettings() { return { networkRecovery: { enabled: true, delayMs: 1000 } }; },
    sendUserMessage(msg) { sent.push(msg); },
  };
  let probeCalls = 0;
  createNetworkRecoveryExtension(pi, {
    probe: async () => { probeCalls += 1; return true; },
  });
  const ctx = {
    isIdle: () => true,
    model: { baseUrl: "https://api.example.com/v1" },
    ui: { notify(msg, lvl) { notices.push([lvl, msg]); } },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("turn_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "Connection error." } }, ctx);
  handlers.get("agent_settled")({ aborted: false }, ctx);

  // 等待第一轮唤醒 + 第二轮 attempting 看门狗重探（共 ~2.3s）
  await new Promise((r) => setTimeout(r, 2350));
  handlers.get("session_shutdown")({}, ctx);

  assert.ok(probeCalls >= 2, `期望看门狗至少触发 2 次探活，实际 ${probeCalls}`);
  assert.ok(sent.length >= 2, `期望看门狗在 attempting 态也能再次唤醒，实际 ${sent.length}`);
});

// ---- 3. openai-proxy ----

test("openai-proxy: ENOENT 静默跳过，installScopedProxyFetch 同步恢复包装", () => {
  const errors = [];
  const missing = loadOpenAIProxyConfig("/nonexistent/path/openai-proxy.json", { onError: (m) => errors.push(m) });
  assert.equal(missing, undefined);
  assert.equal(errors.length, 0);

  const calls = [];
  const fakeTarget = { fetch: (url) => { calls.push(["direct", url]); return "direct"; } };
  const fakeProxy = (url) => { calls.push(["proxy", url]); return "proxy"; };
  installScopedProxyFetch(fakeProxy, { target: fakeTarget });
  assert.equal(fakeTarget.fetch("https://auth.openai.com/token"), "proxy");
  assert.equal(fakeTarget.fetch("https://example.com/api"), "direct");

  // 模拟宿主重置全局 fetch，同步重装必须立即生效
  fakeTarget.fetch = (url) => { calls.push(["direct2", url]); return "direct2"; };
  installScopedProxyFetch(fakeProxy, { target: fakeTarget });
  assert.equal(fakeTarget.fetch("https://chatgpt.com/backend-api/codex"), "proxy");
});

// ---- 4. endpoint-fallback ----

test("endpoint-fallback: 零后台轮询、按活跃 provider 与请求间隔静默切换/回试主端点", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ef-test-")));
  const modelsFile = join(root, "models.json");
  writeFileSync(modelsFile, JSON.stringify({
    providers: {
      "home-llm": {
        baseUrl: "http://primary.local/v1",
        fallbackBaseUrl: "http://backup.local/v1",
        fallback: { retryPrimaryAfterMs: 30_000 },
      },
    },
  }));
  try {
    const handlers = new Map();
    const commands = new Map();
    const registered = [];
    const unregistered = [];
    const notices = [];
    const statusCalls = [];
    const probeLog = [];
    let primaryHealthy = false;
    let backupHealthy = true;
    let now = 100_000;

    const pi = {
      on(event, fn) { handlers.set(event, fn); },
      registerCommand(name, def) { commands.set(name, def); },
      registerProvider(name, cfg) { registered.push([name, cfg]); },
      unregisterProvider(name) { unregistered.push(name); },
    };
    createEndpointFallbackExtension(pi, {
      modelsPath: () => modelsFile,
      now: () => now,
      probe: async (url) => {
        probeLog.push(url);
        if (url.includes("primary")) return primaryHealthy;
        return backupHealthy;
      },
    });
    const makeCtx = (provider) => ({
      hasUI: true,
      model: provider ? { provider, id: "m1" } : undefined,
      ui: {
        notify(text, kind) { notices.push([kind, text]); },
        setStatus(k, v) { statusCalls.push([k, v]); },
      },
    });

    // 1. session_start 与非受管 provider 请求均不触发任何探测或通知
    await handlers.get("session_start")({}, makeCtx("cloud-provider"));
    await handlers.get("before_agent_start")({}, makeCtx("cloud-provider"));
    await handlers.get("turn_start")({}, makeCtx("cloud-provider"));
    assert.deepEqual(probeLog, []);
    assert.equal(registered.length, 0);
    assert.equal(notices.length, 0);
    assert.equal(statusCalls.length, 0);

    // 2. 首次使用 home-llm（主端点宕机）：静默切到 fallback，同轮 turn_start 不重复探测
    await handlers.get("before_agent_start")({}, makeCtx("home-llm"));
    await handlers.get("turn_start")({}, makeCtx("home-llm"));
    assert.deepEqual(probeLog, ["http://primary.local/health"]);
    assert.equal(registered.length, 1);
    assert.equal(registered[0][0], "home-llm");
    assert.equal(notices.length, 0);
    assert.equal(statusCalls.length, 0);

    await handlers.get("message_end")({ message: { role: "assistant", provider: "home-llm", stopReason: "stop" } });
    await handlers.get("agent_end")({});

    // 3. 间隔未超过 30s 的下一次请求：不探测主端点，直接走 fallback
    probeLog.length = 0;
    primaryHealthy = true;
    now += 15_000;
    await handlers.get("before_agent_start")({}, makeCtx("home-llm"));
    await handlers.get("turn_start")({}, makeCtx("home-llm"));
    assert.deepEqual(probeLog, []);
    assert.equal(unregistered.length, 0);
    await handlers.get("message_end")({ message: { role: "assistant", provider: "home-llm", stopReason: "stop" } });
    await handlers.get("agent_end")({});

    // 4. 间隔超过 30s 后再次请求：重探主端点并静默切回 primary
    now += 35_000;
    await handlers.get("before_agent_start")({}, makeCtx("home-llm"));
    await handlers.get("turn_start")({}, makeCtx("home-llm"));
    assert.deepEqual(probeLog, ["http://primary.local/health"]);
    assert.equal(unregistered.length, 1);
    assert.equal(notices.length, 0);
    assert.equal(statusCalls.length, 0);

    // 5. 已在 primary 态下继续请求：不再主动探测；仅网络报错时才故障切换
    probeLog.length = 0;
    now += 50_000;
    await handlers.get("before_agent_start")({}, makeCtx("home-llm"));
    assert.deepEqual(probeLog, []);

    primaryHealthy = false;
    await handlers.get("message_end")({
      message: { role: "assistant", provider: "home-llm", stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED" },
    });
    assert.deepEqual(probeLog, ["http://primary.local/health"]);
    assert.equal(registered.length, 2);
    assert.equal(notices.length, 0);

    // 6. 手动 /endpoint-status probe 才输出 UI 状态，切回主端点后不误探备用端点
    probeLog.length = 0;
    primaryHealthy = true;
    backupHealthy = false;
    await commands.get("endpoint-status").handler("probe", makeCtx("home-llm"));
    assert.deepEqual(probeLog, ["http://primary.local/health"]);
    assert.equal(unregistered.length, 2);
    assert.equal(notices.length, 1);
    assert.ok(!notices.some(([kind]) => kind === "error"), `主端点恢复后不应误报错误: ${JSON.stringify(notices)}`);

    await handlers.get("session_shutdown")({}, makeCtx("home-llm"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 5. session-owner ----

test("session-owner: --version/--help 归为 non-interactive，未设 SESSION_DIR 时回退默认 ~/.pi/agent/sessions", async () => {
  const tty = { stdinTty: true, stdoutTty: true };
  assert.equal(classifyPiLaunch(["--version"], tty).kind, "non-interactive");
  assert.equal(classifyPiLaunch(["-V"], tty).kind, "non-interactive");
  assert.equal(classifyPiLaunch(["--help"], tty).kind, "non-interactive");
  assert.equal(classifyPiLaunch(["-p", "--no-session"], tty).kind, "ephemeral");
  assert.equal(classifyPiLaunch(["--print", "--resume"], tty).kind, "resume");
  assert.equal(classifyPiLaunch(["--skill", "--resume"], tty).kind, "new");

  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-test-")));
  const agentDir = join(root, "agent");
  const workDir = join(root, "proj");
  mkdirSync(workDir, { recursive: true });
  const defaultDir = defaultPiSessionDir(workDir, { PI_CODING_AGENT_DIR: agentDir });
  mkdirSync(defaultDir, { recursive: true });
  const sessionFile = join(defaultDir, "2026-11-24_test.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "sess-1", cwd: workDir })}\n`);
  try {
    const recent = await resolveRecentSession({
      argv: ["-c"],
      cwd: workDir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(recent.kind, "found");
    assert.equal(recent.session.id, "sess-1");
    assert.equal(recent.session.path, realpathSync(sessionFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 6. bash-cwd & bash-async ----

test("bash-cwd: prepareBashCwdExecution 优先使用 ctx.cwd 而非初始化 workspaceRoot", async () => {
  const seen = [];
  const prepared = await prepareBashCwdExecution(
    {
      workspaceRoot: "/stale/root",
      createBashToolDefinition(cwd, opts) { seen.push({ cwd, opts }); return { execute() {} }; },
    },
    { cwd: "/active/session/dir" },
  );
  assert.equal(prepared.cwd, "/active/session/dir");
  assert.equal(seen[0].cwd, "/active/session/dir");
});

test("bash-async: controller 立即返回 launch 回执并在后台完成时投递一次 completion", async () => {
  const sent = [];
  const ctrl = createBashAsyncController({
    prepare: async () => ({
      cwd: "/tmp",
      evidence: {},
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { exit_code: 0 },
      }),
    }),
    send: (...args) => sent.push(args),
  });
  await ctrl.start("s1");
  const receipt = await ctrl.launch("tc1", { command: "echo ok" }, {
    mode: "tui",
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
    isIdle: () => true,
  });
  assert.equal(receipt.kind, "bash-async-launch");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].customType, "bash-async-complete");
  assert.equal(sent[0][0].details.outcome, "succeeded");
  await ctrl.shutdown("quit");
});

// ---- 7. tool-timing ----

test("tool-timing: 记录工具调用区间并幂等注入两行 ISO8601 时间戳", () => {
  const handlers = new Map();
  const entries = [];
  const pi = {
    on(event, fn) { handlers.set(event, fn); },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  createToolTimingExtension(pi);
  handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
  handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "toolCall", id: "call-1" }] } });
  handlers.get("tool_execution_end")({ toolCallId: "call-1" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "tool-timing.v1");

  const ctxEvent = {
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "result body" }] },
    ],
  };
  const out = handlers.get("context")(ctxEvent);
  assert.equal(out.messages[1].content.length, 2);
  const lines = out.messages[1].content[1].text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T/);
});

// ---- 8. agent-plugins ----

test("agent-plugins: 发现本仓全部 Agent Plugins v1 插件的技能与 MCP server 且无错误", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ap-test-"));
  try {
    const { plugins, diagnostics } = await discoverPlugins(join(process.cwd(), "plugins"), agentDir);
    const errors = diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], `插件校验不应报错: ${JSON.stringify(errors)}`);
    assert.deepEqual(plugins.map((p) => p.name), ["deepseek-search", "home-connect", "pi-worker", "playwright"]);
    const serverNames = plugins.flatMap((p) => p.servers.map((s) => s.name)).sort();
    assert.ok(serverNames.includes("deepseek-search__deepseek-search"));
    assert.ok(serverNames.includes("home-connect__home"));
    assert.ok(serverNames.includes("home-connect__comfyui"));
    assert.ok(serverNames.includes("pi-worker__pi-worker"));
    assert.ok(serverNames.includes("playwright__playwright"));
    const skillCount = plugins.flatMap((p) => p.skills).length;
    assert.ok(skillCount >= 5, `预期至少发现 5 个插件 skill，实际 ${skillCount}`);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---- 9. Task 4 稳定性与性能回归测试 ----

test("compact-tools: orphaned loading timer stops on maxLifetime expiry and clearAllStatusAnimations", async () => {
  let nowMs = 1000;
  let invalidations = 0;
  const ctx = {
    state: {},
    invalidate() { invalidations += 1; },
  };
  syncStatusAnimation(ctx, "loading", { now: () => nowMs, maxLifetimeMs: 250 });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(invalidations >= 1, `loading 期间应触发 invalidate，实际 ${invalidations}`);

  // 推进时钟超过 maxLifetimeMs，下一次 tick 后应自动停止
  nowMs += 300;
  await new Promise((r) => setTimeout(r, 160));
  const afterExpiry = invalidations;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(invalidations, afterExpiry, "超过 maxLifetimeMs 后不应再继续重绘");

  // 启动第二个 timer 并验证 clearAllStatusAnimations() 立即清理，且 compact-tools.ts 已挂接生命周期清理
  let secondInvalidations = 0;
  const ctx2 = { state: {}, invalidate() { secondInvalidations += 1; } };
  syncStatusAnimation(ctx2, "loading", { now: () => nowMs, maxLifetimeMs: 60_000 });
  clearAllStatusAnimations();
  const afterClear = secondInvalidations;
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(secondInvalidations, afterClear, "clearAllStatusAnimations 后不应再触发重绘");

  const entrySource = readFileSync(join(process.cwd(), "pi/extensions/compact-tools/compact-tools.ts"), "utf8");
  assert.match(entrySource, /session_shutdown/);
  assert.match(entrySource, /session_before_switch/);
  assert.match(entrySource, /clearAllStatusAnimations/);
});

test("security-gates: nested sh -c exceeding depth limit is blocked and non-string sensitive path fails closed", () => {
  const cwd = process.cwd();
  let nested = "echo ok";
  for (let i = 0; i < 10; i += 1) {
    nested = `sh -c "${nested.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  const blocked = checkShellPolicy({ command: nested, cwd, workspaceRoot: cwd });
  assert.equal(blocked?.block, true, "超过递归深度上限的嵌套 sh -c 必须被保守拦截");
  assert.equal(checkSynchronousBash(nested, cwd)?.code, "SYNC_BASH_SLEEP");

  const shallow = 'sh -c "sh -c \\"echo ok\\""';
  assert.equal(checkShellPolicy({ command: shallow, cwd, workspaceRoot: cwd }), undefined);

  for (const badInput of [{ path: 123 }, { path: null }, { filePath: { bad: true } }, { filename: [] }]) {
    const res = checkSensitivePath({ toolName: "read", input: badInput, cwd });
    assert.equal(res?.code, "SENSITIVE_PATH_UNCERTAIN", `非字符串路径 ${JSON.stringify(badInput)} 应 fail-closed`);
  }
});

test("endpoint-fallback: defaultProbe cancels response body after checking status", async () => {
  const originalFetch = globalThis.fetch;
  let cancelCalls = 0;
  globalThis.fetch = async () => ({
    status: 200,
    body: {
      async cancel() { cancelCalls += 1; },
    },
  });
  try {
    const ok = await defaultProbe("http://127.0.0.1:9999/health");
    assert.equal(ok, true);
    assert.equal(cancelCalls, 1, "探活后应调用一次 res.body.cancel()");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-proxy: re-applying proxy config updates delegate target and closes previous ProxyAgent", async () => {
  const target = { fetch: () => "direct" };
  const closed = [];
  const routed = [];
  const createProxyFetch = async (proxyUrl) => {
    const fn = (url) => {
      routed.push([proxyUrl, url]);
      return `via:${proxyUrl}`;
    };
    fn.close = async () => { closed.push(proxyUrl); };
    return fn;
  };

  await ensureScopedProxyFetch("http://127.0.0.1:8001", { createProxyFetch, target });
  assert.equal(target.fetch("https://auth.openai.com/token"), "via:http://127.0.0.1:8001");
  assert.deepEqual(closed, []);

  await ensureScopedProxyFetch("http://127.0.0.1:8002", { createProxyFetch, target });
  assert.deepEqual(closed, ["http://127.0.0.1:8001"], "切换代理时应关闭旧 ProxyAgent");
  assert.equal(target.fetch("https://chatgpt.com/backend-api/codex"), "via:http://127.0.0.1:8002");
  assert.equal(target.fetch("https://example.com/other"), "direct");
  assert.deepEqual(routed, [
    ["http://127.0.0.1:8001", "https://auth.openai.com/token"],
    ["http://127.0.0.1:8002", "https://chatgpt.com/backend-api/codex"],
  ]);
});

test("bash-cwd: createCachedBashOptions caches lookup per (cwd, projectTrusted)", async () => {
  let calls = 0;
  let nowMs = 1000;
  const baseGet = (ctx) => {
    calls += 1;
    return { cwd: ctx.cwd, trusted: ctx.isProjectTrusted?.() === true, calls };
  };
  const cachedGet = createCachedBashOptions(baseGet, { ttlMs: 5000, now: () => nowMs });
  const ctxA = { cwd: "/repo/a", isProjectTrusted: () => true };
  const ctxAUntrusted = { cwd: "/repo/a", isProjectTrusted: () => false };

  const first = cachedGet(ctxA);
  const second = cachedGet(ctxA);
  assert.equal(calls, 1, "同一 (cwd, projectTrusted) 连续查询应命中缓存");
  assert.deepEqual(second, first);

  const untrusted = cachedGet(ctxAUntrusted);
  assert.equal(calls, 2, "projectTrusted 变化应区分缓存键");
  assert.equal(untrusted.trusted, false);

  nowMs += 6000;
  cachedGet(ctxA);
  assert.equal(calls, 3, "TTL 过期后应重新查询");

  // 验证 createBashCwdToolDefinition 执行期同样命中缓存
  let toolCalls = 0;
  const tool = createBashCwdToolDefinition({
    workspaceRoot: "/repo/a",
    createBashToolDefinition: (_cwd, opts) => ({
      execute: async () => opts,
    }),
    getBashOptions: () => {
      toolCalls += 1;
      return { shellPath: "/bin/zsh" };
    },
  });
  await tool.execute("1", { command: "pwd" }, undefined, undefined, ctxA);
  await tool.execute("2", { command: "ls" }, undefined, undefined, ctxA);
  assert.equal(toolCalls, 1, "bash-cwd 工具连续执行应复用缓存配置");
});
