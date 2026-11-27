import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TaskStore,
  getProcessSignature,
  groupTasksByParentSession,
  loadWorkerConfig,
  loadWorkerDefaultConfig,
  resolveStateDir,
  resolveWorkerTierProfile,
} from "../plugins/pi-worker/src/store.ts";

function makeRecord(store, overrides = {}) {
  const taskId = overrides.taskId ?? "11111111-1111-4111-8111-111111111111";
  const paths = store.allocateTaskPaths(taskId);
  const now = new Date().toISOString();
  return {
    taskId,
    cwd: "/repo/a",
    sessionDir: paths.sessionDir,
    logPath: paths.logPath,
    eventsPath: paths.eventsPath,
    outcomePath: paths.outcomePath,
    steerPath: paths.steerPath,
    status: "running",
    pid: 12345,
    excludeTools: ["ask_question", "ask_user_question", "bash_async", "bash_async_status"],
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    turnCount: 0,
    roundCount: 1,
    lastTool: null,
    recentEvents: [],
    summary: null,
    question: null,
    options: [],
    verifiedCommands: [],
    executedCommands: [],
    stopReason: null,
    exitCode: null,
    error: null,
    gitChanges: [],
    ...overrides,
  };
}

test("test_save_and_load_enforces_private_permissions_and_dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-"));
  try {
    assert.equal(resolveStateDir({ PI_WORKER_STATE_DIR: dir }), dir);
    const store = new TaskStore(dir, { isPidAlive: () => true });
    const record = makeRecord(store, { status: "done", pid: null, summary: "all green" });
    store.save(record);

    for (const sub of ["", "tasks", "sessions", "logs", "locks", "outcomes", "steers"]) {
      const target = sub ? join(dir, sub) : dir;
      assert.equal(statSync(target).mode & 0o777, 0o700, `dir ${target} must be 0700`);
    }

    const { taskFile, sessionDir, outcomePath } = store.allocateTaskPaths(record.taskId);
    assert.equal(statSync(taskFile).mode & 0o777, 0o600);
    assert.equal(sessionDir, join(dir, "sessions"));
    assert.equal(outcomePath, join(dir, "outcomes", `${record.taskId}.json`));
    assert.deepEqual(store.load(record.taskId), record);

    // 兼容历史磁盘记录：缺少 executedCommands 时加载补空数组；缺少 steerPath 时按状态目录回退兜底
    const legacy = { ...record };
    delete legacy.executedCommands;
    delete legacy.steerPath;
    writeFileSync(taskFile, JSON.stringify(legacy), { mode: 0o600 });
    assert.deepEqual(store.load(record.taskId)?.executedCommands, []);
    assert.equal(store.load(record.taskId)?.steerPath, join(dir, "steers", `${record.taskId}.jsonl`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_load_reconciles_dead_pid_but_skips_in_flight_tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-"));
  try {
    const store = new TaskStore(dir, { isPidAlive: () => false });
    const record = makeRecord(store, { status: "running", pid: 999999 });
    store.save(record);

    // inFlight 保护期不得被覆写为 orphan_process
    const protectedRec = store.load(record.taskId, { inFlightTaskIds: new Set([record.taskId]) });
    assert.equal(protectedRec?.status, "running");
    assert.equal(protectedRec?.pid, 999999);

    // 移出 inFlight 后自动校正为 orphan_process 并回写磁盘
    const reconciled = store.load(record.taskId);
    assert.equal(reconciled?.status, "failed");
    assert.equal(reconciled?.pid, null);
    assert.equal(reconciled?.error, "orphan_process");

    // 再次读取验证已持久化
    const persisted = new TaskStore(dir, { isPidAlive: () => true }).load(record.taskId);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.error, "orphan_process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cwd_lock_prevents_cross_process_conflict_and_reclaims_dead_owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-"));
  try {
    const alivePids = new Set([1001, 2002]);
    const store = new TaskStore(dir, { isPidAlive: (pid) => alivePids.has(pid) });

    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.save(makeRecord(store, { taskId: idA, cwd: "/repo/shared", status: "running", pid: 1001 }));

    const lockA = store.acquireCwdLock("/repo/shared", { taskId: idA, ownerPid: 1001 });
    assert.ok("lockPath" in lockA);
    assert.equal(statSync(lockA.lockPath).mode & 0o777, 0o600);

    // 活进程持锁期间，另一任务无法获锁
    const conflict = store.acquireCwdLock("/repo/shared", { taskId: idB, ownerPid: 2002 });
    assert.ok("conflictTaskId" in conflict);
    assert.equal(conflict.conflictTaskId, idA);

    // 非锁主调用 release 不得误删 A 的锁
    store.releaseCwdLock("/repo/shared", idB);
    assert.ok("conflictTaskId" in store.acquireCwdLock("/repo/shared", { taskId: idB, ownerPid: 2002 }));

    // A 进程死亡后，B 自动回收陈旧锁，同时将 A 校正为 orphan_process
    alivePids.delete(1001);
    const lockB = store.acquireCwdLock("/repo/shared", { taskId: idB, ownerPid: 2002 });
    assert.ok("lockPath" in lockB);
    assert.equal(store.load(idA)?.status, "failed");
    assert.equal(store.load(idA)?.error, "orphan_process");

    store.releaseCwdLock("/repo/shared", idB);
    assert.ok("lockPath" in store.acquireCwdLock("/repo/shared", { taskId: idB, ownerPid: 2002 }));

    // 关键场景（Important #4c）：原 MCP ownerPid 已死，但 detached worker 子进程 record.pid 仍存活时不得回收锁
    store.releaseCwdLock("/repo/shared", idB);
    const idC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const idD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    alivePids.add(3003); // detached worker child PID 存活
    // MCP server ownerPid=3000 已死（不在 alivePids 中）
    store.save(makeRecord(store, { taskId: idC, cwd: "/repo/detached", status: "running", pid: 3003 }));
    const lockC = store.acquireCwdLock("/repo/detached", { taskId: idC, ownerPid: 3000 });
    assert.ok("lockPath" in lockC);

    const conflictWithLiveChild = store.acquireCwdLock("/repo/detached", { taskId: idD, ownerPid: 2002 });
    assert.ok("conflictTaskId" in conflictWithLiveChild);
    assert.equal(conflictWithLiveChild.conflictTaskId, idC);
    assert.equal(conflictWithLiveChild.ownerPid, 3003);
    assert.equal(store.load(idC)?.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_list_returns_compact_summaries_and_rejects_invalid_task_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-"));
  try {
    const store = new TaskStore(dir, { isPidAlive: () => true });
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    const id3 = "33333333-3333-4333-8333-333333333333";

    store.save(makeRecord(store, {
      taskId: id1,
      cwd: "/repo/a",
      status: "done",
      pid: null,
      updatedAt: "2026-11-24T10:00:00.000Z",
      summary: "big summary",
      recentEvents: [{ kind: "turn_end", timestamp: "2026-11-24T10:00:00.000Z" }],
    }));
    store.save(makeRecord(store, {
      taskId: id2,
      cwd: "/repo/b",
      status: "needs_input",
      pid: null,
      question: "A or B?",
      updatedAt: "2026-11-24T12:00:00.000Z",
    }));
    store.save(makeRecord(store, {
      taskId: id3,
      cwd: "/repo/a",
      status: "done",
      pid: null,
      updatedAt: "2026-11-24T11:00:00.000Z",
    }));

    const all = store.list();
    assert.deepEqual(all.map((t) => t.taskId), [id2, id3, id1]);
    assert.equal("recentEvents" in all[0], false);
    assert.equal("summary" in all[0], false);

    assert.deepEqual(store.list({ status: "done", cwd: "/repo/a", limit: 1 }).map((t) => t.taskId), [id3]);

    assert.throws(() => store.allocateTaskPaths("../escape"));
    assert.throws(() => store.load("bad/id"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_load_skips_orphan_reconcile_when_cwd_lock_owner_is_still_alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-owner-"));
  try {
    const alivePids = new Set([4001]); // ownerPid 存活，worker child pid 4002 已死（模拟 finalize 窗口）
    const store = new TaskStore(dir, { isPidAlive: (pid) => alivePids.has(pid) });
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    store.save(makeRecord(store, { taskId: id, cwd: "/repo/finalizing", status: "running", pid: 4002 }));
    const lock = store.acquireCwdLock("/repo/finalizing", { taskId: id, ownerPid: 4001 });
    assert.ok("lockPath" in lock);

    // 跨进程 load（无 inFlightTaskIds）见 cwd 锁仍被活 ownerPid 持有，不得误判 orphan_process
    const stillRunning = store.load(id);
    assert.equal(stillRunning?.status, "running");
    assert.equal(stillRunning?.error, null);

    // ownerPid 也死亡后，正常校正为 orphan_process 并释放锁
    alivePids.delete(4001);
    const reconciled = store.load(id);
    assert.equal(reconciled?.status, "failed");
    assert.equal(reconciled?.error, "orphan_process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_load_default_config_resolves_file_env_precedence_and_validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-cfg-"));
  try {
    const store = new TaskStore(dir);
    assert.deepEqual(store.loadDefaultConfig({}), {});

    // 1. 从 <stateDir>/config.json 读取默认配置
    writeFileSync(
      store.configPath,
      JSON.stringify({ provider: "zai-coding-cn", model: "glm-5.4", thinking: "medium" }),
      "utf8",
    );
    assert.deepEqual(store.loadDefaultConfig({}), {
      provider: "zai-coding-cn",
      model: "glm-5.4",
      thinking: "medium",
    });

    // 2. 环境变量覆盖：仅设 PI_WORKER_DEFAULT_MODEL 时不混用 config.json 中的旧 provider
    assert.deepEqual(
      loadWorkerDefaultConfig(dir, { PI_WORKER_DEFAULT_MODEL: "openai/gpt-4o", PI_WORKER_DEFAULT_THINKING: "low" }),
      { model: "openai/gpt-4o", thinking: "low" },
    );

    // 3. 环境变量同时覆盖 provider 与 model
    assert.deepEqual(
      loadWorkerDefaultConfig(dir, { PI_WORKER_DEFAULT_PROVIDER: "qoder-pool", PI_WORKER_DEFAULT_MODEL: "GLM-5.3" }),
      { provider: "qoder-pool", model: "GLM-5.3", thinking: "medium" },
    );

    // 4. 非法配置报错（缺 model、非法 thinking、非 JSON）
    assert.throws(
      () => loadWorkerDefaultConfig(dir, { PI_WORKER_DEFAULT_PROVIDER: "qoder-pool" }),
      /PI_WORKER_DEFAULT_MODEL/,
    );
    assert.throws(
      () => loadWorkerDefaultConfig(dir, { PI_WORKER_DEFAULT_THINKING: "ultra" }),
      /thinking/,
    );

    writeFileSync(store.configPath, JSON.stringify({ provider: "only-provider" }), "utf8");
    assert.throws(() => store.loadDefaultConfig({}), /缺少 model/);

    // 5. 分层 tiers 配置与未配置档位自动回退 default
    writeFileSync(
      store.configPath,
      JSON.stringify({
        default: { provider: "zai-coding-cn", model: "glm-5.4", thinking: "medium" },
        tiers: {
          fast: { provider: "zai-coding-cn", model: "glm-5.3-flash", thinking: "low" },
          heavy: { thinking: "high" },
        },
      }),
      "utf8",
    );
    const loadedCfg = loadWorkerConfig(dir, {});
    assert.equal(loadedCfg.default.model, "glm-5.4");
    assert.equal(loadedCfg.tiers.fast?.model, "glm-5.3-flash");
    assert.deepEqual(resolveWorkerTierProfile(dir, "fast", {}), {
      provider: "zai-coding-cn",
      model: "glm-5.3-flash",
      thinking: "low",
    });
    // heavy 仅配置 thinking 时继承 default 的 provider/model
    assert.deepEqual(resolveWorkerTierProfile(dir, "heavy", {}), {
      provider: "zai-coding-cn",
      model: "glm-5.4",
      thinking: "high",
    });
    // 环境变量可覆盖单档位
    assert.deepEqual(
      resolveWorkerTierProfile(dir, "fast", {
        PI_WORKER_TIER_FAST_PROVIDER: "qoder-pool",
        PI_WORKER_TIER_FAST_MODEL: "GLM-5.3-Flash",
      }),
      { provider: "qoder-pool", model: "GLM-5.3-Flash", thinking: "low" },
    );
    // 档位完全未配置时回退 default，零报错
    writeFileSync(
      store.configPath,
      JSON.stringify({ default: { provider: "zai-coding-cn", model: "glm-5.4" } }),
      "utf8",
    );
    assert.deepEqual(resolveWorkerTierProfile(dir, "fast", {}), {
      provider: "zai-coding-cn",
      model: "glm-5.4",
    });
    assert.throws(() => resolveWorkerTierProfile(dir, "invalid-tier", {}), /非法 tier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_parent_session_filter_and_group_tasks_by_parent_session", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-group-"));
  try {
    const store = new TaskStore(dir, { isPidAlive: () => true });
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    const id3 = "33333333-3333-4333-8333-333333333333";
    const id4 = "44444444-4444-4444-8444-444444444444";

    store.save(makeRecord(store, {
      taskId: id1,
      cwd: "/repo/harness-config",
      parentSessionId: "sess-a",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T10:00:00.000Z",
      lastActivityAt: "2026-11-25T10:00:00.000Z",
    }));
    store.save(makeRecord(store, {
      taskId: id2,
      cwd: "/repo/new-api-account-pool",
      parentSessionId: "sess-b",
      status: "running",
      pid: 12345,
      updatedAt: "2026-11-25T09:00:00.000Z",
      lastActivityAt: "2026-11-25T09:00:00.000Z",
    }));
    store.save(makeRecord(store, {
      taskId: id3,
      cwd: "/repo/harness-config",
      parentSessionId: "sess-a",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T11:00:00.000Z",
      lastActivityAt: "2026-11-25T11:00:00.000Z",
    }));
    // 未标记 parentSessionId 的历史任务按 cwd 回退归组
    store.save(makeRecord(store, {
      taskId: id4,
      cwd: "/repo/legacy",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T08:00:00.000Z",
      lastActivityAt: "2026-11-25T08:00:00.000Z",
    }));

    assert.deepEqual(store.list({ parentSessionId: "sess-a" }).map((t) => t.taskId), [id3, id1]);
    assert.deepEqual(store.list({ parentSessionId: "sess-b" }).map((t) => t.taskId), [id2]);

    const groups = groupTasksByParentSession(store.list());
    assert.equal(groups.length, 3);
    // 有运行中任务的组排第一
    assert.equal(groups[0].groupKey, "session:sess-b");
    assert.equal(groups[0].parentSessionId, "sess-b");
    assert.equal(groups[0].runningCount, 1);
    assert.deepEqual(groups[0].tasks.map((t) => t.taskId), [id2]);

    assert.equal(groups[1].groupKey, "session:sess-a");
    assert.equal(groups[1].parentSessionId, "sess-a");
    assert.deepEqual(groups[1].tasks.map((t) => t.taskId), [id3, id1]);

    assert.equal(groups[2].groupKey, "cwd:/repo/legacy");
    assert.equal(groups[2].parentSessionId, null);
    assert.deepEqual(groups[2].tasks.map((t) => t.taskId), [id4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_title_and_parent_session_title_storage_summary_and_group_aggregation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-store-title-"));
  try {
    const store = new TaskStore(dir, { isPidAlive: () => true });
    const idOld = "21111111-1111-4111-8111-111111111111";
    const idNew = "22222222-2222-4222-8222-222222222222";
    const idNoTitle = "23333333-3333-4333-8333-333333333333";
    const idLegacy = "24444444-4444-4444-8444-444444444444";

    store.save(makeRecord(store, {
      taskId: idOld,
      parentSessionId: "sess-t",
      title: "修复登录崩溃",
      parentSessionTitle: "旧会话标题",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T08:00:00.000Z",
      lastActivityAt: "2026-11-25T08:00:00.000Z",
    }));
    store.save(makeRecord(store, {
      taskId: idNew,
      parentSessionId: "sess-t",
      parentSessionTitle: "新会话标题",
      status: "running",
      pid: 12345,
      updatedAt: "2026-11-25T09:00:00.000Z",
      lastActivityAt: "2026-11-25T09:00:00.000Z",
    }));
    // 同会话更新的任务缺标题：不得覆盖已有的最新非空标题
    store.save(makeRecord(store, {
      taskId: idNoTitle,
      parentSessionId: "sess-t",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T10:00:00.000Z",
      lastActivityAt: "2026-11-25T10:00:00.000Z",
    }));
    // 历史任务完全没有标题字段：分组标题保持 null（向后兼容）
    store.save(makeRecord(store, {
      taskId: idLegacy,
      parentSessionId: "sess-legacy",
      status: "done",
      pid: null,
      updatedAt: "2026-11-25T07:00:00.000Z",
      lastActivityAt: "2026-11-25T07:00:00.000Z",
    }));

    // 落盘往返保留两个可选字段
    const loaded = store.load(idOld);
    assert.equal(loaded.title, "修复登录崩溃");
    assert.equal(loaded.parentSessionTitle, "旧会话标题");

    // list 摘要条件携带：有则带上，无则不出现字段
    const summaries = store.list({ limit: 10 });
    const byId = new Map(summaries.map((t) => [t.taskId, t]));
    assert.equal(byId.get(idOld).title, "修复登录崩溃");
    assert.equal(byId.get(idOld).parentSessionTitle, "旧会话标题");
    assert.equal(byId.get(idNew).parentSessionTitle, "新会话标题");
    assert.equal("title" in byId.get(idNew), false);
    assert.equal("title" in byId.get(idLegacy), false);
    assert.equal("parentSessionTitle" in byId.get(idLegacy), false);

    // 分组聚合：取组内最新非空 parentSessionTitle；无标题历史组保持 null
    const groups = groupTasksByParentSession(summaries);
    const byKey = new Map(groups.map((g) => [g.groupKey, g]));
    assert.equal(byKey.get("session:sess-t").parentSessionTitle, "新会话标题");
    assert.equal(byKey.get("session:sess-legacy").parentSessionTitle, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cwd_lock_reclaim_mutex_protects_concurrent_reclaim_and_corrupt_grace_period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-reclaim-"));
  try {
    const store = new TaskStore(dir);
    store.ensureDirs();

    // 1. 0 字节损坏锁在 2s 宽限期内不得误删；超过 2s 后经 .reclaim 互斥安全回收
    const corruptCwd = "/repo/corrupt";
    const corruptHash = createHash("sha256").update(corruptCwd).digest("hex");
    const corruptLockPath = join(dir, "locks", `${corruptHash}.lock`);
    writeFileSync(corruptLockPath, "", { mode: 0o600 });

    const freshConflict = store.acquireCwdLock(corruptCwd, {
      taskId: "11111111-1111-4111-8111-111111111111",
      ownerPid: process.pid,
    });
    assert.ok("conflictTaskId" in freshConflict, "fresh 0-byte lock within 2s grace must not be deleted");
    assert.equal(statSync(corruptLockPath).size, 0);

    const threeSecAgo = (Date.now() - 3000) / 1000;
    utimesSync(corruptLockPath, threeSecAgo, threeSecAgo);
    const reclaimedCorrupt = store.acquireCwdLock(corruptCwd, {
      taskId: "11111111-1111-4111-8111-111111111111",
      ownerPid: process.pid,
    });
    assert.ok("lockPath" in reclaimedCorrupt, "corrupt lock older than 2s must be reclaimed");
    assert.equal(readdirSync(join(dir, "locks")).some((n) => n.endsWith(".reclaim")), false);
    store.releaseCwdLock(corruptCwd, "11111111-1111-4111-8111-111111111111");

    // 2. 并发回收陈旧锁：4 个独立子进程同时抢锁，恰好 1 个成功、其余均看到胜者为 conflict，无 ABA 误删新活锁
    const sharedCwd = "/repo/concurrent-reclaim";
    const sharedHash = createHash("sha256").update(sharedCwd).digest("hex");
    const sharedLockPath = join(dir, "locks", `${sharedHash}.lock`);
    const deadTaskId = "99999999-9999-4999-8999-999999999999";
    store.save(makeRecord(store, { taskId: deadTaskId, cwd: sharedCwd, status: "running", pid: 99999999 }));
    writeFileSync(sharedLockPath, JSON.stringify({
      taskId: deadTaskId,
      ownerPid: 99999999,
      cwd: sharedCwd,
      acquiredAt: new Date().toISOString(),
      token: "stale-token",
    }) + "\n", { mode: 0o600 });

    const storeUrl = new URL("../plugins/pi-worker/src/store.ts", import.meta.url).href;
    const workerCode = `
      import { TaskStore } from ${JSON.stringify(storeUrl)};
      const store = new TaskStore(process.env.TEST_STATE_DIR);
      const res = store.acquireCwdLock(process.env.TEST_CWD, {
        taskId: process.env.TEST_TASK_ID,
        ownerPid: process.pid,
      });
      process.stdout.write(JSON.stringify({ ...res, pid: process.pid, taskId: process.env.TEST_TASK_ID }) + "\\n");
      if ("lockPath" in res) {
        await new Promise((r) => setTimeout(r, 250));
      }
    `;

    const results = await Promise.all(
      [1, 2, 3, 4].map((idx) => new Promise((resolveDone, rejectDone) => {
        const taskId = `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${idx}`;
        const child = spawn(process.execPath, ["--input-type=module", "-e", workerCode], {
          env: {
            ...process.env,
            TEST_STATE_DIR: dir,
            TEST_CWD: sharedCwd,
            TEST_TASK_ID: taskId,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => { out += d.toString("utf8"); });
        child.stderr.on("data", (d) => { err += d.toString("utf8"); });
        child.once("close", (code) => {
          if (code !== 0) {
            rejectDone(new Error(`child ${idx} exited ${code}: ${err}`));
            return;
          }
          resolveDone(JSON.parse(out.trim()));
        });
      })),
    );

    const winners = results.filter((r) => "lockPath" in r);
    const losers = results.filter((r) => "conflictTaskId" in r);
    assert.equal(winners.length, 1, `expected exactly 1 winner, got ${JSON.stringify(results)}`);
    assert.equal(losers.length, 3);
    for (const loser of losers) {
      assert.equal(loser.conflictTaskId, winners[0].taskId);
    }
    assert.equal(store.load(deadTaskId)?.status, "failed");
    assert.equal(store.load(deadTaskId)?.error, "orphan_process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cwd_lock_reclaims_when_owner_signature_mismatches_on_pid_reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-sig-"));
  try {
    const mySig = getProcessSignature(process.pid);
    assert.ok(typeof mySig === "string" && mySig.length > 0, "getProcessSignature must return lstart for live pid");
    assert.equal(getProcessSignature(99999999), null);

    let activeSig = "Mon Jan 01 00:00:00 2024";
    const storeA = new TaskStore(dir, {
      isPidAlive: () => true,
      getProcessSignature: () => activeSig,
    });
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    storeA.save(makeRecord(storeA, { taskId: idA, cwd: "/repo/pid-reuse", status: "running", pid: 7777 }));

    const lockA = storeA.acquireCwdLock("/repo/pid-reuse", { taskId: idA, ownerPid: 7777 });
    assert.ok("lockPath" in lockA);

    // 同一 PID 存活但 lstart 指纹已变化 -> 判定为 PID 复用并安全回收
    activeSig = "Tue Feb 02 00:00:00 2024";
    const lockB = storeA.acquireCwdLock("/repo/pid-reuse", { taskId: idB, ownerPid: 8888 });
    assert.ok("lockPath" in lockB, "mismatched ownerSignature must trigger stale lock reclaim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_list_caches_terminal_records_by_ino_mtime_size", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-list-cache-"));
  try {
    const store = new TaskStore(dir, { isPidAlive: () => true });
    const idDone1 = "11111111-1111-4111-8111-111111111111";
    const idDone2 = "22222222-2222-4222-8222-222222222222";
    const idRun = "33333333-3333-4333-8333-333333333333";

    store.save(makeRecord(store, { taskId: idDone1, status: "done", pid: null, updatedAt: "2026-11-25T08:00:00.000Z" }));
    store.save(makeRecord(store, { taskId: idDone2, status: "cancelled", pid: null, updatedAt: "2026-11-25T09:00:00.000Z" }));
    store.save(makeRecord(store, { taskId: idRun, status: "running", pid: 12345, updatedAt: "2026-11-25T10:00:00.000Z" }));

    const loadCalls = [];
    const origLoad = store.load.bind(store);
    store.load = (taskId, options) => {
      loadCalls.push(taskId);
      return origLoad(taskId, options);
    };

    const first = store.list();
    assert.equal(first.length, 3);
    assert.equal(loadCalls.length, 3);

    // 再次 list：两个终态任务命中 (ino, mtimeMs, size) 缓存，仅 running 任务调用 load
    loadCalls.length = 0;
    const second = store.list();
    assert.equal(second.length, 3);
    assert.deepEqual(loadCalls, [idRun]);

    // 更新其中一个终态任务（变更 ino/mtimeMs/size）后，该任务与 running 任务重读，另一终态仍命中缓存
    store.save(makeRecord(store, {
      taskId: idDone1,
      status: "done",
      pid: null,
      summary: "updated",
      updatedAt: "2026-11-25T11:00:00.000Z",
    }));
    loadCalls.length = 0;
    const third = store.list();
    assert.equal(third.length, 3);
    assert.deepEqual(loadCalls.sort(), [idDone1, idRun].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
