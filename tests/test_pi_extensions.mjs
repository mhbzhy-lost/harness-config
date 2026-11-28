import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import { checkSensitivePath, checkShellPolicy, checkSynchronousBash } from "../pi/extensions/security-gates/shell-policy.ts";
import { createNetworkRecoveryExtension } from "../pi/extensions/network-recovery/extension.ts";
import { collectCliproxyapiStrictModeOverrides, createCliproxyapiExtension, createLazyProxyController, hasCredentials, portListening, resolveCliproxyapiOptions } from "../pi/extensions/cliproxyapi/controller.ts";
import { createEndpointFallbackExtension, defaultProbe } from "../pi/extensions/endpoint-fallback/index.ts";
import { agentDirFromArgv, classifyPiLaunch, defaultPiSessionDir, LaunchIntentError, resolveAgentDir, resolveLaunchTarget, resolveRecentSession } from "../pi/extensions/session-owner/contract.ts";
import { createBashCwdToolDefinition, createCachedBashOptions, prepareBashCwdExecution } from "../pi/extensions/bash-cwd/extension.ts";
import { createBashAsyncController } from "../pi/extensions/bash-async/controller.ts";
import { createToolTimingExtension } from "../pi/extensions/tool-timing/index.ts";
import { discoverPlugins } from "../pi/extensions/agent-plugins/manifest.ts";
import { clearAllStatusAnimations, syncStatusAnimation } from "../pi/extensions/compact-tools/status.ts";
import { createSubagentsRenderer, formatResultsText, SUBAGENT_TOOL_NAMES } from "../pi/extensions/subagents/renderer.ts";

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

function makeAgentLayout(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const workDir = join(root, "proj");
  mkdirSync(workDir, { recursive: true });
  const writeSession = (agentDir, id) => {
    const dir = join(agentDir, "sessions", `--${workDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, cwd: workDir })}\n`);
    return path;
  };
  return { root, workDir, writeSession };
}

test("session-owner: classifyPiLaunch 将 --agent-dir 视为带值参数，缺值时 fail-closed", () => {
  const tty = { stdinTty: true, stdoutTty: true };
  assert.equal(classifyPiLaunch(["--agent-dir", "/tmp/agent", "--resume"], tty).kind, "resume");
  assert.equal(classifyPiLaunch(["--agent-dir", "-c"], tty).kind, "new", "--agent-dir 的值按 Pi 行为被消费，不当作 -c");
  assert.equal(classifyPiLaunch(["--skill", "--agent-dir", "/tmp/agent", "-c"], tty).kind, "continue", "其他带值参数的值不得误认为 --agent-dir");
  assert.equal(classifyPiLaunch(["--", "--agent-dir"], tty).kind, "new", "`--` 之后的 token 不参与解析");
  for (const argv of [["--agent-dir"], ["--agent-dir", ""], ["--agent-dir", "--"]]) {
    assert.throws(() => classifyPiLaunch(argv, tty), (error) => error instanceof LaunchIntentError && error.code === "missing-value");
  }
});

test("session-owner: agentDirFromArgv 展开 ~、相对路径相对 cwd、后者覆盖前者并优先于 PI_CODING_AGENT_DIR", () => {
  const { root, workDir } = makeAgentLayout("so-agentdir-");
  try {
    assert.equal(agentDirFromArgv(["--agent-dir", "agent", "--agent-dir", "agent2"], workDir), join(workDir, "agent2"));
    assert.equal(agentDirFromArgv(["--agent-dir", "~"], workDir), realpathSync(join(homedir())));
    assert.equal(agentDirFromArgv(["--agent-dir", "~/pi-agent"], workDir), join(realpathSync(join(homedir())), "pi-agent"));
    assert.equal(agentDirFromArgv(["-c"], workDir), undefined);
    const env = { PI_CODING_AGENT_DIR: join(root, "env-agent") };
    assert.equal(resolveAgentDir(["--agent-dir", "agent"], workDir, env), join(workDir, "agent"));
    assert.equal(resolveAgentDir(["-c"], workDir, env), join(root, "env-agent"));
    assert.equal(resolveAgentDir(["-c"], workDir, {}), join(homedir(), ".pi", "agent"));
    const safePath = `--${workDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    assert.equal(defaultPiSessionDir(workDir, env, join(workDir, "agent")), join(workDir, "agent", "sessions", safePath));
    assert.equal(defaultPiSessionDir(workDir, env), join(root, "env-agent", "sessions", safePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-owner: resolveRecentSession 用 --agent-dir 定位默认会话目录，命中目标目录而非 env/默认目录", async () => {
  const { root, workDir, writeSession } = makeAgentLayout("so-recent-");
  try {
    const envAgentDir = join(root, "env-agent");
    const targetAgentDir = join(workDir, "target-agent");
    const envSession = writeSession(envAgentDir, "sess-env");
    const targetSession = writeSession(targetAgentDir, "sess-target");
    const env = { PI_CODING_AGENT_DIR: envAgentDir, HOME: root };

    const byEnv = await resolveRecentSession({ argv: ["-c"], cwd: workDir, env });
    assert.equal(byEnv.kind, "found");
    assert.equal(byEnv.session.id, "sess-env");
    // 相对路径相对 cwd 解析；优先级高于 PI_CODING_AGENT_DIR
    const byArgv = await resolveRecentSession({ argv: ["--agent-dir", "target-agent", "-c"], cwd: workDir, env });
    assert.equal(byArgv.kind, "found");
    assert.equal(byArgv.session.id, "sess-target");
    assert.equal(byArgv.session.path, realpathSync(targetSession));
    assert.notEqual(byArgv.session.path, envSession);
    // 显式 --session-dir 仍优先于 --agent-dir
    const bySessionDir = await resolveRecentSession({ argv: ["--agent-dir", "target-agent", "--session-dir", join(envAgentDir, "sessions", `--${workDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`), "-c"], cwd: workDir, env });
    assert.equal(bySessionDir.kind, "found");
    assert.equal(bySessionDir.session.id, "sess-env");
    // 缺值 fail-closed：目标目录中确有会话也不得命中
    const missing = await resolveRecentSession({ argv: ["--agent-dir", "--", "-c"], cwd: workDir, env: { ...env, PI_CODING_AGENT_DIR: targetAgentDir } });
    assert.equal(missing.kind, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-owner: resolveLaunchTarget 调用 list/listAll 期间按 --agent-dir 临时对齐 PI_CODING_AGENT_DIR 并在 finally 恢复", async () => {
  const { root, workDir, writeSession } = makeAgentLayout("so-target-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const envAgentDir = join(root, "env-agent");
    const targetAgentDir = join(workDir, "target-agent");
    writeSession(envAgentDir, "sess-env");
    const target = writeSession(targetAgentDir, "sess-target");
    const seen = [];
    const manager = {
      async list(cwd, sessionDir) {
        seen.push(["list", sessionDir, process.env.PI_CODING_AGENT_DIR]);
        return process.env.PI_CODING_AGENT_DIR === targetAgentDir ? [{ id: "sess-target", cwd: workDir, path: target }] : [{ id: "sess-env", cwd: workDir, path: join(envAgentDir, "x.jsonl") }];
      },
      async listAll(sessionDir) {
        seen.push(["listAll", sessionDir, process.env.PI_CODING_AGENT_DIR]);
        return [];
      },
    };
    const env = { PI_CODING_AGENT_DIR: envAgentDir };
    const intent = { kind: "session-id", value: "sess-target", continueArgIndex: null };

    const resolved = await resolveLaunchTarget({ argv: ["--agent-dir", "target-agent", "--session-id", "sess-target"], cwd: workDir, env, sessionManager: manager, intent });
    assert.equal(resolved.kind, "resolved");
    assert.equal(resolved.reservation.sessionFile, realpathSync(target));
    assert.deepEqual(seen, [["list", undefined, join(workDir, "target-agent")]]);
    assert.equal(process.env.PI_CODING_AGENT_DIR, previous);

    // 仅传 env、未传 --agent-dir：不触碰 process.env（mock 行为不变）
    seen.length = 0;
    const byEnv = await resolveLaunchTarget({ argv: ["--session-id", "sess-env"], cwd: workDir, env, sessionManager: manager, intent: { kind: "session-id", value: "sess-env", continueArgIndex: null } });
    assert.equal(byEnv.kind, "resolved");
    assert.deepEqual(seen, [["list", undefined, previous]]);

    // 显式 --session-dir：不触碰 process.env
    seen.length = 0;
    const bySessionDir = await resolveLaunchTarget({ argv: ["--agent-dir", "target-agent", "--session-dir", join(envAgentDir, "sessions"), "--session-id", "sess-env"], cwd: workDir, env, sessionManager: manager, intent: { kind: "session-id", value: "sess-env", continueArgIndex: null } });
    assert.equal(bySessionDir.kind, "resolved");
    assert.deepEqual(seen, [["list", join(envAgentDir, "sessions"), previous]]);

    // --session <id> 同时走 list 与 listAll；list 抛错时也应恢复原有 env 值
    delete process.env.PI_CODING_AGENT_DIR;
    const failing = {
      list() { throw new Error("boom"); },
      async listAll() { throw new Error("must not run"); },
    };
    const failed = await resolveLaunchTarget({ argv: ["--agent-dir", "target-agent", "--session", "sess"], cwd: workDir, env, sessionManager: failing, intent: { kind: "session", value: "sess", continueArgIndex: null } });
    assert.equal(failed.kind, "unavailable");
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
    seen.length = 0;
    const forked = await resolveLaunchTarget({ argv: ["--agent-dir", "target-agent", "--fork", "sess-target"], cwd: workDir, env, sessionManager: manager, intent: { kind: "fork", value: "sess-target", continueArgIndex: null } });
    assert.equal(forked.kind, "resolved");
    assert.equal(forked.reservation.kind, "fork-source");
    assert.deepEqual(seen, [["list", undefined, join(workDir, "target-agent")], ["listAll", undefined, join(workDir, "target-agent")]]);
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
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

// ---- 10. subagents 渲染器 ----

// spinner 帧随时间变化，比对前统一归一化为 ⠋
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const norm = (value) => (Array.isArray(value) ? value.map(norm) : String(value).replace(/<dim>[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]<\/dim>/g, "<dim>⠋</dim>"));

test("subagents: 仅接管 pi-subagents 工具并覆盖自带渲染器，其余透传 next()", () => {
  const { resolver, theme, context } = createSubagentsHarness();
  assert.deepEqual([...SUBAGENT_TOOL_NAMES], ["subagent", "subagent_launch", "bg_wait", "contact_supervisor", "subagent_supervisor", "watchdog_diff"]);

  const other = { renderCall() {}, renderResult() {} };
  assert.equal(resolver("bash", () => other), other, "非 subagents 工具应原样透传 next()");
  assert.equal(resolver("read", () => undefined), undefined);

  // 带有自带 renderCall/renderResult 的 base（pi-subagents 原生渲染器）必须被接管
  const native = { renderCall: () => "native-call", renderResult: () => "native-result", renderShell: "native" };
  const taken = resolver("subagent", () => native);
  assert.equal(taken.renderShell, "self");
  assert.notEqual(taken.renderCall, native.renderCall);
  assert.notEqual(taken.renderResult, native.renderResult);
  const call = taken.renderCall({ agent: "reviewer", task: "检查 代码" }, theme, context());
  assert.equal(norm(call.render(80)[0]), "<dim>⠋</dim> <toolTitle><bold>subagent</bold></toolTitle> <accent>reviewer</accent> <dim>检查 代码</dim>");

  // base 缺失时仍可用
  const noBase = resolver("bg_wait", () => undefined);
  assert.equal(norm(noBase.renderCall({ id: "job-1" }, theme, context()).render(80)[0]), "<dim>⠋</dim> <toolTitle><bold>bg_wait</bold></toolTitle> <accent>job-1</accent>");
});

test("subagents: 标题行格式、空白折叠与单行截断", () => {
  const { renderCall } = createSubagentsHarness();
  const line = (name, args, width = 200) => norm(renderCall(name, args, width)).join("\n");
  const T = (name) => `<dim>⠋</dim> <toolTitle><bold>${name}</bold></toolTitle>`;

  // subagent: agent 形态（label 优先于 task，model 带 @ 前缀，async 标记）
  assert.equal(
    line("subagent", { agent: "reviewer", label: "代码审查", task: "ignored", model: "gpt-5", async: true }),
    `${T("subagent")} <accent>reviewer</accent> <dim>代码审查</dim> <dim>@gpt-5</dim> <warning>[async]</warning>`,
  );
  // subagent: workflow 形态（workflow 为 true 或字符串均显示 workflow）
  assert.equal(
    line("subagent", { workflow: true, task: "多行\n  任务  描述", async: true }),
    `${T("subagent")} <accent>workflow</accent> <dim>多行 任务 描述</dim> <warning>[async]</warning>`,
  );
  assert.equal(line("subagent", { workflow: "parallel" }), `${T("subagent")} <accent>workflow</accent>`);
  // subagent: action 形态
  assert.equal(
    line("subagent", { action: "status", id: "run-42", message: "please\ncontinue" }),
    `${T("subagent")} <accent>status</accent> <dim>#run-42</dim> <dim>please continue</dim>`,
  );
  assert.equal(line("subagent", { action: "list" }), `${T("subagent")} <accent>list</accent>`);
  // subagent: 回退首个非空字符串参数
  assert.equal(line("subagent", { task: "  free   form  " }), `${T("subagent")} <accent>free form</accent>`);
  assert.equal(line("subagent", { agent: "   " }), `${T("subagent")}`);

  // subagent_launch
  assert.equal(
    line("subagent_launch", { agent: "worker", task: "写 测试", async: true }),
    `${T("subagent_launch")} <accent>worker</accent> <dim>写 测试</dim> <warning>[async]</warning>`,
  );
  assert.equal(line("subagent_launch", { key: "k1", workflowRunId: "w1" }), `${T("subagent_launch")} <accent>k1</accent>`);
  assert.equal(line("subagent_launch", { workflowRunId: "w1" }), `${T("subagent_launch")} <accent>w1</accent>`);

  // bg_wait
  assert.equal(line("bg_wait", { all: true }), `${T("bg_wait")} <accent>all</accent>`);
  assert.equal(line("bg_wait", { any: true }), `${T("bg_wait")} <accent>any</accent>`);
  assert.equal(
    line("bg_wait", { id: "job-7", nonBlocking: true }),
    `${T("bg_wait")} <accent>job-7</accent> <dim>non-blocking</dim>`,
  );

  // contact_supervisor / subagent_supervisor / watchdog_diff：首个非空字符串参数
  for (const name of ["contact_supervisor", "subagent_supervisor", "watchdog_diff"]) {
    assert.equal(line(name, { message: "hello\n world" }), `${T(name)} <accent>hello world</accent>`);
    assert.equal(line(name, {}), `${T(name)}`);
  }

  // 单行截断：按可见宽度裁剪并以 … 结尾，不换行
  const narrow = renderCall("subagent", { agent: "a-very-long-agent-name", task: "x".repeat(120) }, 40);
  const rendered = narrow[0];
  assert.equal(narrow.length, 1);
  assert.ok(stripAnsi(rendered).endsWith("…"), rendered);
  assert.ok(!rendered.includes("\n"), "标题应保持单行");
  assert.equal(stripAnsi(rendered).length, 40);
});

test("subagents: loading 态保持 spinner 并显示步骤进度摘要，返回空结果", () => {
  const { resolver, theme } = createSubagentsHarness();
  let invalidations = 0;
  const context = { state: {}, expanded: false, invalidate() { invalidations += 1; } };
  const r = resolver("subagent", () => undefined);

  const step = r.renderResult(
    { content: [{ type: "text", text: "partial" }], details: { mode: "single", currentStepIndex: 1, totalSteps: 4 } },
    { isPartial: true },
    theme,
    context,
  );
  assert.equal(step.render(80), "");
  assert.equal(context.state.subagentsStatus, "loading");
  assert.equal(context.state.subagentsSummary, "step 2/4");
  assert.equal(norm(r.renderCall({ workflow: true }, theme, context).render(80)[0]), "<dim>⠋</dim> <toolTitle><bold>subagent</bold></toolTitle> <accent>workflow</accent><dim> · step 2/4</dim>");

  // 无步骤信息时回退 progress 数组：running 已完成/总数
  r.renderResult(
    { content: [], details: { progress: [{ status: "done" }, { status: "running" }, { status: "failed" }] } },
    { isPartial: true },
    theme,
    context,
  );
  assert.equal(context.state.subagentsSummary, "running 2/3");
  // 两者皆无时仅显示 spinner
  r.renderResult({ content: [], details: {} }, { isPartial: true }, theme, context);
  assert.equal(context.state.subagentsSummary, undefined);

  clearAllStatusAnimations();
});

test("subagents: success 折叠态返回空结果并以 · summary 收尾", () => {
  const { resolver, theme } = createSubagentsHarness();
  const r = resolver("subagent", () => undefined);
  const run = (result) => {
    const context = { state: {}, expanded: false };
    const out = r.renderResult(result, {}, theme, context);
    assert.equal(out.render(80), "", "折叠态成功结果应为空");
    assert.equal(context.state.subagentsStatus, "success");
    return norm(r.renderCall({ agent: "reviewer" }, theme, context).render(80)[0]);
  };
  const title = "<success>✓</success> <toolTitle><bold>subagent</bold></toolTitle> <accent>reviewer</accent>";

  // 异步启动态
  assert.equal(run({ content: [{ type: "text", text: "launched" }], details: { mode: "async", id: "abc" } }), `${title}<dim> · launched #abc</dim>`);
  assert.equal(run({ content: [{ type: "text", text: "queued" }], details: { async: true } }), `${title}<dim> · launched</dim>`);
  // 多结果：未失败项/总数
  assert.equal(
    run({ content: [{ type: "text", text: "a\nb\nc" }], details: { results: [{ status: "done" }, { status: "failed" }, { status: "done" }] } }),
    `${title}<dim> · 2/3 done</dim>`,
  );
  // 单结果/无结果：非空文本行数，0 行时 done
  assert.equal(run({ content: [{ type: "text", text: "a\n\n  \nb" }] }), `${title}<dim> · 2 lines</dim>`);
  assert.equal(run({ content: [] }), `${title}<dim> · done</dim>`);
});

test("subagents: expanded 展开态隐藏摘要并以 createExpandedToolText 输出全文", () => {
  const { resolver, theme, Text } = createSubagentsHarness();
  const r = resolver("subagent", () => ({ renderResult: () => "native" }));
  const context = { state: {}, expanded: true };
  const result = {
    content: [
      { type: "text", text: "line 1\nline 2" },
      { type: "image", data: "abc" },
      { type: "text", text: "tail", extra: 1 },
    ],
  };
  const out = r.renderResult(result, { expanded: true }, theme, context);
  assert.ok(out instanceof Text, "展开态应返回 Text 组件");
  assert.equal(context.state.subagentsStatus, "success");
  assert.equal(context.state.subagentsSummary, undefined);
  assert.equal(out.render(80), "  <toolOutput>line 1\n  line 2\n  {\n    \"type\": \"image\",\n    \"data\": \"abc\"\n  }\n  tail\n  contentBlock:\n  {\n    \"type\": \"text\",\n    \"text\": \"tail\",\n    \"extra\": 1\n  }</toolOutput>");
  assert.equal(r.renderCall({ agent: "reviewer" }, theme, context).render(80)[0], "<success>✓</success> <toolTitle><bold>subagent</bold></toolTitle> <accent>reviewer</accent>");

  // 正文为空但 details.results 非空：格式化简明结果文本
  const text = formatResultsText([{ agent: "a", status: "done", text: "ok\nnext" }, { agent: "b", status: "failed", error: "boom" }]);
  assert.equal(text, "[1] a (done)\n    ok\n    next\n[2] b (failed)\n    boom");
  const fromDetails = r.renderResult({ content: [], details: { results: [{ agent: "a", status: "done" }] } }, { expanded: true }, theme, { state: {}, expanded: true });
  assert.equal(stripAnsi(fromDetails.render(80)), "  [1] a (done)");
  // 完全无正文：done 占位
  assert.equal(stripAnsi(r.renderResult({ content: [] }, { expanded: true }, theme, { state: {}, expanded: true }).render(80)), "   └ done");
});

test("subagents: failure 折叠态显示 ✗ 与红色错误行，展开态输出红色全文", () => {
  const { resolver, theme } = createSubagentsHarness();
  const r = resolver("subagent", () => undefined);

  const collapsed = { state: { subagentsSummary: "stale" }, expanded: false };
  const failed = r.renderResult({ content: [{ type: "text", text: "Error: boom\nmore" }], isError: true }, {}, theme, collapsed);
  assert.equal(collapsed.state.subagentsStatus, "failure");
  assert.equal(collapsed.state.subagentsSummary, undefined);
  assert.deepEqual(failed.render(80), ["<error>Error: boom</error>"]);
  assert.deepEqual(failed.render(10).map(stripAnsi), ["Error: bo…"]);
  assert.equal(r.renderCall({ agent: "reviewer" }, theme, collapsed).render(80)[0], "<error>✗</error> <toolTitle><bold>subagent</bold></toolTitle> <accent>reviewer</accent>");

  const expanded = { state: {}, expanded: true };
  const out = r.renderResult({ content: [{ type: "text", text: "Error: boom\nmore" }], isError: true }, { expanded: true }, theme, expanded);
  assert.equal(expanded.state.subagentsStatus, "failure");
  assert.equal(out.render(80), "  <error>Error: boom\n  more</error>");
  // 失败且无正文
  const empty = r.renderResult({ content: [], isError: true }, { expanded: true }, theme, { state: {}, expanded: true });
  assert.equal(stripAnsi(empty.render(80)), "   └ 失败");
  // context.isError 同样视为失败
  assert.deepEqual(r.renderResult({ content: [] }, {}, theme, { state: {}, isError: true }).render(80), ["<error>工具执行失败（未提供错误信息）</error>"]);
});

function createSubagentsHarness() {
  class Text {
    constructor(content, paddingX = 0, _paddingY = 0) {
      this.content = content;
      this.paddingX = paddingX;
    }
    render(width) {
      return String(this.content).split("\n").map((line) => `${" ".repeat(this.paddingX)}${truncate(line, width)}`).join("\n");
    }
  }
  const truncate = (text, width) => {
    const visible = stripAnsi(text);
    return visible.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  }
  // 简化的宽度裁剪：标签零宽，按可见字符数截断并补齐未闭合标签
  const truncateToWidth = (text, width, ellipsis = "…") => {
    const visible = stripAnsi(text);
    if (visible.length <= width) return text;
    if (width <= 0) return "";
    const keep = width - stripAnsi(ellipsis).length;
    let out = "";
    let count = 0;
    const open = [];
    for (const token of String(text).match(/<\/?[a-zA-Z]+>|[\s\S]+?(?=<|$)/g) ?? []) {
      const tag = /^<(\/?)([a-zA-Z]+)>$/.exec(token);
      if (tag) {
        if (tag[1]) open.pop(); else open.push(tag[2]);
        out += token;
        continue;
      }
      for (const ch of token) {
        if (count >= keep) break;
        out += ch;
        count += 1;
      }
    }
    return `${out}${ellipsis}${open.reverse().map((t) => `</${t}>`).join("")}`;
  };
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => `<bold>${text}</bold>`,
  };
  const resolver = createSubagentsRenderer({ Text, visibleWidth: (text) => stripAnsi(text).length, truncateToWidth });
  const renderCall = (name, args, width) => resolver(name, () => undefined).renderCall(args, theme, { state: {} }).render(width);
  return { resolver, theme, Text, renderCall, context: () => ({ state: {}, expanded: false }) };
}

function stripAnsi(text) {
  return String(text).replace(/<\/?[a-zA-Z]+>/g, "");
}

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

// ---- cliproxyapi（懒加载；完全隔离在临时目录 + 空闲端口，绝不触碰真实 ~/.qwen 或 8317） ----

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writeFakeManager(root) {
  // 假 manager.py：只记录被调用的参数；FAKE_EXIT 非零时以该码退出模拟启动失败
  const manager = join(root, "fake-manager.py");
  writeFileSync(manager, [
    "import os, sys",
    'with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as f: f.write(" ".join(sys.argv[1:]) + "\\n")',
    'sys.exit(int(os.environ.get("FAKE_EXIT", "0")))',
    "",
  ].join("\n"));
  return manager;
}

async function makeCliproxyapiFixture(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cliproxyapi-test-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const port = await freePort();
  const log = join(root, "manager.log");
  const managerPy = writeFakeManager(root);
  const opts = resolveCliproxyapiOptions({ HOME: root, FAKE_LOG: log, CLIPROXYAPI_STATE_DIR: stateDir, CLIPROXYAPI_API_PORT: String(port) }, import.meta.url, {
    managerPy,
    connectTimeoutMs: 200,
    startTimeoutMs: 12_000,
    // models.json 也锚定在临时目录：绝不读取真实 ~/.pi/agent/models.json
    modelsPath: join(root, "models.json"),
    ...overrides,
  });
  return { root, stateDir, port, log, opts, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function listenOnce(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(port, "127.0.0.1", () => resolve(() => new Promise((r) => srv.close(() => r()))));
  });
}

test("cliproxyapi: resolveCliproxyapiOptions 读取 CLIPROXYAPI_STATE_DIR / 端口优先级与 manager.py 相对路径", () => {
  const env = { CLIPROXYAPI_STATE_DIR: "/tmp/x", CODEX_PROXY_API_PORT: "9000" };
  const o = resolveCliproxyapiOptions(env, "file:///repo/pi/extensions/cliproxyapi/cliproxyapi.ts");
  assert.equal(o.stateDir, "/tmp/x");
  assert.equal(o.port, 9000, "旧名 CODEX_PROXY_API_PORT 仍兼容");
  assert.equal(o.managerPy, "/repo/qwen/extensions/cliproxyapi/scripts/manager.py");
  assert.equal(resolveCliproxyapiOptions({ CLIPROXYAPI_API_PORT: "9001", CODEX_PROXY_API_PORT: "9002" }, "file:///x/y.ts").port, 9001, "新名优先");
  assert.equal(resolveCliproxyapiOptions({}, "file:///x/y.ts").port, 8317, "默认 8317");
  assert.equal(resolveCliproxyapiOptions({ CLIPROXYAPI_API_PORT: "abc" }, "file:///x/y.ts").port, 8317, "非法端口回退默认");
});

test("cliproxyapi: hasCredentials 仅看 auth/*.json 文件名，目录缺失或无 json 均为 false", () => {
  const root = mkdtempSync(join(tmpdir(), "cliproxyapi-cred-"));
  try {
    assert.equal(hasCredentials(join(root, "missing")), false);
    mkdirSync(join(root, "auth"));
    assert.equal(hasCredentials(root), false);
    writeFileSync(join(root, "auth", "kv.db"), "");
    writeFileSync(join(root, "auth", "note.txt"), "{}");
    assert.equal(hasCredentials(root), false, "非 .json 运行态文件不算凭据");
    writeFileSync(join(root, "auth", "codex.json"), "");
    assert.equal(hasCredentials(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cliproxyapi: portListening 对空闲端口短超时返回 false，对监听端口返回 true", async () => {
  const port = await freePort();
  const t0 = Date.now();
  assert.equal(await portListening(port, 200), false);
  assert.ok(Date.now() - t0 < 2000, "空闲端口探测应快速返回");
  const close = await listenOnce(port);
  try {
    assert.equal(await portListening(port, 200), true);
  } finally {
    await close();
  }
});

test("cliproxyapi: 无凭据时静默跳过，不探测端口也不调用 manager", async () => {
  const f = await makeCliproxyapiFixture();
  try {
    assert.equal(hasCredentials(f.stateDir), false);
    await createLazyProxyController(f.opts).ensure();
    assert.deepEqual(f.calls(), []);
  } finally {
    f.cleanup();
  }
});

test("cliproxyapi: 端口已监听时零 Python 开销直接返回", async () => {
  const f = await makeCliproxyapiFixture();
  try {
    mkdirSync(join(f.stateDir, "auth"));
    writeFileSync(join(f.stateDir, "auth", "cred.json"), "{}");
    const close = await listenOnce(f.port);
    try {
      await createLazyProxyController(f.opts).ensure();
      assert.deepEqual(f.calls(), [], "端口已监听不得调用 manager.py");
    } finally {
      await close();
    }
  } finally {
    f.cleanup();
  }
});

test("cliproxyapi: 端口未监听触发 manager start，并发 ensure 合并为单次 in-flight", async () => {
  const f = await makeCliproxyapiFixture();
  try {
    mkdirSync(join(f.stateDir, "auth"));
    writeFileSync(join(f.stateDir, "auth", "cred.json"), "{}");
    const controller = createLazyProxyController(f.opts);
    const first = controller.ensure();
    assert.equal(controller.inflight(), first, "进行中的拉起应暴露为 in-flight");
    const results = await Promise.all([first, controller.ensure(), controller.ensure(), controller.ensure()]);
    assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
    assert.equal(controller.inflight(), undefined, "结束后 in-flight 应清空");
    assert.deepEqual(f.calls(), ["start"], "并发调用只应拉起一次");
  } finally {
    f.cleanup();
  }
});

test("cliproxyapi: manager 失败（非零退出 / 无法启动 python）不抛异常", async () => {
  const f = await makeCliproxyapiFixture();
  try {
    mkdirSync(join(f.stateDir, "auth"));
    writeFileSync(join(f.stateDir, "auth", "cred.json"), "{}");
    f.opts.env.FAKE_EXIT = "3";
    await createLazyProxyController(f.opts).ensure();
    assert.deepEqual(f.calls(), ["start"], "失败的一次调用仍被记录，且 ensure 正常 resolve");
  } finally {
    f.cleanup();
  }
  const broken = await makeCliproxyapiFixture();
  try {
    mkdirSync(join(broken.stateDir, "auth"));
    writeFileSync(join(broken.stateDir, "auth", "cred.json"), "{}");
    broken.opts.python = join(broken.root, "definitely-missing-python");
    await createLazyProxyController(broken.opts).ensure();
    assert.deepEqual(broken.calls(), [], "python 不存在时 spawn 失败应被吞掉");
  } finally {
    broken.cleanup();
  }
});

test("cliproxyapi: 扩展加载即后台懒加载，before_agent_start 等待 in-flight 且停止后可按需重拉，不注册退出回收", async () => {
  const f = await makeCliproxyapiFixture();
  try {
    mkdirSync(join(f.stateDir, "auth"));
    writeFileSync(join(f.stateDir, "auth", "cred.json"), "{}");

    const handlers = new Map();
    const pi = { on: (event, handler) => handlers.set(event, handler) };
    const controller = createCliproxyapiExtension(pi, f.opts);
    assert.ok(controller.inflight(), "扩展加载应立即在后台触发一次懒加载");
    assert.equal(typeof handlers.get("before_agent_start"), "function");
    assert.deepEqual([...handlers.keys()].filter((e) => /shutdown|end|exit/.test(e)), [], "未注册任何 provider 时不注册退出回收");

    // 初始化触发的拉起仍在进行：before_agent_start 等待其完成而不再重复拉起
    await handlers.get("before_agent_start")({}, {});
    assert.equal(controller.inflight(), undefined);
    assert.deepEqual(f.calls(), ["start"]);

    // 模拟代理被手动停止（端口未监听）：下一次 agent 启动按需重拉
    await handlers.get("before_agent_start")({}, {});
    assert.deepEqual(f.calls(), ["start", "start"]);
  } finally {
    f.cleanup();
  }
});

// ---- cliproxyapi: google-generative-ai 回环模型运行时兜底 supportsStrictMode: false ----

function strictModeModelsDoc() {
  return {
    providers: {
      "cliproxyapi-gemini": {
        name: "CLIProxyAPI Gemini",
        baseUrl: "http://127.0.0.1:8317/v1beta",
        api: "google-generative-ai",
        apiKey: "local",
        models: [
          { id: "gemini-4-carbon-high", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: "explicit-true", compat: { supportsStrictMode: true } },
          { id: "explicit-false", compat: { supportsStrictMode: false, other: 1 } },
          { id: "other-api-model", api: "openai-completions" },
        ],
      },
      "remote-gemini": {
        baseUrl: "https://proxy.example.com/v1beta",
        api: "google-generative-ai",
        models: [{ id: "gemini-3-pro" }],
      },
      "cliproxyapi-codex": {
        baseUrl: "http://localhost:8317/v1",
        api: "openai-responses",
        models: [{ id: "gpt-6.2" }],
      },
      "localhost-gemini-no-suffix": {
        baseUrl: "http://localhost:8317",
        api: "google-generative-ai",
        models: [{ id: "gemini-3-pro-preview" }, { id: "wrong-port", baseUrl: "http://127.0.0.1:9999/v1beta" }],
      },
      "model-level-override": {
        baseUrl: "https://elsewhere.example/v1beta",
        models: [
          { id: "via-provider", api: "google-generative-ai", baseUrl: "http://127.0.0.1:8317/v1beta" },
          { id: "not-loopback", api: "google-generative-ai" },
        ],
      },
      "no-models": { baseUrl: "http://127.0.0.1:8317/v1beta", api: "google-generative-ai" },
    },
  };
}

test("cliproxyapi: collectCliproxyapiStrictModeOverrides 仅对回环 CLIProxyAPI 的 google-generative-ai 模型补 supportsStrictMode: false", () => {
  const doc = strictModeModelsDoc();
  const frozen = JSON.stringify(doc);
  const overrides = collectCliproxyapiStrictModeOverrides(doc, 8317);
  assert.equal(JSON.stringify(doc), frozen, "纯函数：不得修改入参");
  const byName = Object.fromEntries(overrides.map((o) => [o.name, o.config]));
  assert.deepEqual(Object.keys(byName).sort(), ["cliproxyapi-gemini", "localhost-gemini-no-suffix", "model-level-override"]);

  const gemini = byName["cliproxyapi-gemini"];
  assert.equal(gemini.name, "CLIProxyAPI Gemini");
  assert.equal(gemini.baseUrl, "http://127.0.0.1:8317/v1beta");
  assert.equal(gemini.apiKey, "local");
  const models = Object.fromEntries(gemini.models.map((m) => [m.id, m]));
  assert.deepEqual(models["gemini-4-carbon-high"].compat, { supportsStrictMode: false }, "未显式配置的回环 gemini 模型被补齐");
  assert.equal(models["gemini-4-carbon-high"].contextWindow, 1048576, "保留原 model 全部字段");
  assert.deepEqual(models["explicit-true"].compat, { supportsStrictMode: true }, "显式 true 完全尊重");
  assert.deepEqual(models["explicit-false"].compat, { supportsStrictMode: false, other: 1 }, "显式 false 完全尊重且不改其它 compat 字段");
  assert.equal(models["other-api-model"].compat, undefined, "model 级覆盖为其它 api 的不受影响");

  assert.equal(byName["remote-gemini"], undefined, "远程 URL 不受影响");
  assert.equal(byName["cliproxyapi-codex"], undefined, "非 google-generative-ai provider 不受影响");
  const noSuffix = Object.fromEntries(byName["localhost-gemini-no-suffix"].models.map((m) => [m.id, m]));
  assert.deepEqual(noSuffix["gemini-3-pro-preview"].compat, { supportsStrictMode: false }, "localhost 无路径后缀也算回环");
  assert.equal(noSuffix["wrong-port"].compat, undefined, "model 级 baseUrl 端口不同则跳过");
  const modelLevel = Object.fromEntries(byName["model-level-override"].models.map((m) => [m.id, m]));
  assert.deepEqual(modelLevel["via-provider"].compat, { supportsStrictMode: false }, "model 级 api/baseUrl 覆盖生效");
  assert.equal(modelLevel["not-loopback"].compat, undefined);

  assert.deepEqual(collectCliproxyapiStrictModeOverrides(doc, 9000), [], "端口不匹配时无覆盖");
  for (const bad of [null, undefined, "x", 1, {}, { providers: null }, { providers: { a: null } }, { providers: { a: { models: "nope" } } }]) {
    assert.deepEqual(collectCliproxyapiStrictModeOverrides(bad, 8317), []);
  }
});

test("cliproxyapi: resolveCliproxyapiOptions 默认 modelsPath 跟随 PI_CODING_AGENT_DIR / ~/.pi/agent", () => {
  const base = "file:///repo/pi/extensions/cliproxyapi/cliproxyapi.ts";
  assert.equal(resolveCliproxyapiOptions({}, base).modelsPath, join(homedir(), ".pi", "agent", "models.json"));
  assert.equal(resolveCliproxyapiOptions({ PI_CODING_AGENT_DIR: " /tmp/agent-dir " }, base).modelsPath, join("/tmp/agent-dir", "models.json"));
});

test("cliproxyapi: 扩展加载时为回环 gemini 模型 registerProvider 补 supportsStrictMode: false，session_shutdown 仅注销自己注册的 provider", async () => {
  const f = await makeCliproxyapiFixture({ port: 8317 });
  try {
    const modelsFile = join(f.root, "models.json");
    writeFileSync(modelsFile, JSON.stringify(strictModeModelsDoc()));
    const before = readFileSync(modelsFile, "utf8");
    const handlers = new Map();
    const registered = [];
    const unregistered = [];
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerProvider(name, cfg) { registered.push([name, cfg]); },
      unregisterProvider(name) { unregistered.push(name); },
    };
    createCliproxyapiExtension(pi, { ...f.opts, modelsPath: modelsFile });
    assert.deepEqual(registered.map(([n]) => n).sort(), ["cliproxyapi-gemini", "localhost-gemini-no-suffix", "model-level-override"]);
    const gemini = registered.find(([n]) => n === "cliproxyapi-gemini")[1];
    assert.equal(gemini.models.find((m) => m.id === "gemini-4-carbon-high").compat.supportsStrictMode, false);
    assert.equal(gemini.models.find((m) => m.id === "explicit-true").compat.supportsStrictMode, true, "显式 true 不被覆盖");
    assert.equal(readFileSync(modelsFile, "utf8"), before, "绝不修改磁盘上的 models.json");

    assert.equal(typeof handlers.get("session_shutdown"), "function");
    assert.equal(typeof handlers.get("session_start"), "function");
    // session_start 重读：已注册的 provider 不重复注册
    handlers.get("session_start")({}, {});
    assert.equal(registered.length, 3);
    handlers.get("session_shutdown")({}, {});
    assert.deepEqual(unregistered.sort(), ["cliproxyapi-gemini", "localhost-gemini-no-suffix", "model-level-override"], "只注销本扩展注册过的 provider");
    // 等待后台懒加载结束，避免测试结束时仍有子进程
    await handlers.get("before_agent_start")({}, {});
  } finally {
    f.cleanup();
  }
});

test("cliproxyapi: models.json 缺失/损坏/无回环 gemini 模型时静默忽略，仅 mock pi.on 亦可正常工作", async () => {
  // 1. 文件不存在
  const f1 = await makeCliproxyapiFixture();
  try {
    const handlers = new Map();
    const calls = [];
    createCliproxyapiExtension({ on: (e, h) => handlers.set(e, h), registerProvider: (n) => calls.push(n), unregisterProvider: (n) => calls.push("un:" + n) }, f1.opts);
    assert.deepEqual(calls, []);
    assert.equal(handlers.get("session_shutdown"), undefined);
    await handlers.get("before_agent_start")({}, {});
  } finally {
    f1.cleanup();
  }
  // 2. 文件损坏
  const f2 = await makeCliproxyapiFixture();
  try {
    writeFileSync(join(f2.root, "models.json"), "{ not json");
    const handlers = new Map();
    const calls = [];
    const controller = createCliproxyapiExtension({ on: (e, h) => handlers.set(e, h), registerProvider: (n) => calls.push(n) }, f2.opts);
    assert.deepEqual(calls, []);
    await handlers.get("session_start")({}, {});
    assert.deepEqual(calls, []);
    await controller.ensure();
  } finally {
    f2.cleanup();
  }
  // 3. 只有显式配置 / 远程 provider：无需注册
  const f3 = await makeCliproxyapiFixture({ port: 8317 });
  try {
    writeFileSync(join(f3.root, "models.json"), JSON.stringify({ providers: { "cliproxyapi-gemini": { baseUrl: "http://127.0.0.1:8317/v1beta", api: "google-generative-ai", models: [{ id: "g", compat: { supportsStrictMode: false } }] }, remote: { baseUrl: "https://x.example/v1beta", api: "google-generative-ai", models: [{ id: "r" }] } } }));
    const handlers = new Map();
    const calls = [];
    createCliproxyapiExtension({ on: (e, h) => handlers.set(e, h), registerProvider: (n) => calls.push(n), unregisterProvider: (n) => calls.push("un:" + n) }, f3.opts);
    assert.deepEqual(calls, []);
    assert.equal(handlers.get("session_shutdown"), undefined, "未注册 provider 时不注册退出回收");
    await handlers.get("before_agent_start")({}, {});
  } finally {
    f3.cleanup();
  }
});
