# pi-worker 跨 Harness 独立长任务插件 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 在 `plugins/pi-worker/` 实现一个 Harness 无关的零依赖 MCP 插件，结合 Pi `--mode json` 实时进度流与随 `-e` 动态挂载的专属扩展 `worker-ext.ts`，将 Pi 封装为支持异步执行、独立 Session 隔离、确定性工具挂起续跑（Suspend-Resume）与准确退出码的长任务工作器。

**Architecture:** 五模块聚焦拆分：`src/protocol.ts` 负责静态附加提示词、Outcome 文件 Schema/原子读写、基于 `StringDecoder` 的 JSONL 分行器与实时进度事件抽取；`src/worker-ext.ts` 是随 `-e` 挂载到子 Pi 的轻量扩展，注册 `worker_ask_parent`/`worker_report_blocked`/`worker_finish` 并在 `turn_end` 调 `ctx.abort()`、在 `agent_end` 兜底写 outcome 并将 `error`/`aborted` 设为 `process.exitCode = 1`；`src/store.ts` 负责 `0700`/`0600` 原子持久化、跨进程 `O_CREAT|O_EXCL` 同 `cwd` 单写手锁与孤儿校正；`src/runner.ts` 负责解析真实 `pi`、经 piped stdin + `--session-dir`/`--session-id` + `-e worker-ext.ts` 管理子进程组生命周期；`src/server.ts` 实现零依赖 stdio JSON-RPC MCP 服务并配齐双清单与 `SKILL.md`。

**Tech Stack:** Node.js >= 22.19.0 原生 TypeScript（零第三方 npm 依赖）、`node:test`、`node:assert/strict`、Python `unittest`（仓内同步回归）

**Spec:** `docs/plans/2026-11-24-pi-worker-plugin-design.md`

## Global Constraints

- 零第三方 npm 依赖，且 `plugins/pi-worker/` 不创建 `package.json`；直接由 `node ./src/server.ts`（`mcp.json`）与 `node ${PLUGIN_ROOT}/src/server.ts`（`mcp_config.json`）运行。
- Node >= 22.19.0 原生 TypeScript 限制：类型导入一律使用 `import type`（或内联 `type`），相对导入带 `.ts` 后缀，禁用 `enum`、`namespace` 与构造函数参数属性（`constructor(private ...)`）。
- `worker-ext.ts` 仅通过 `-e <PLUGIN_ROOT>/src/worker-ext.ts` 动态挂载给 `pi-worker` 子进程，不注册到 `pi/settings.json`；工具参数采用纯 JSON Schema 字面量，不依赖第三方包，且仅在 `PI_WORKER_OUTCOME_FILE` 环境变量存在时激活。
- 严格遵守 Agent Plugins 1.0.0 + AGY 双清单规范：`plugin.json`、`mcp.json`、`mcp_config.json` 与 `skills/pi-worker/SKILL.md` 必须通过 `tests/test_agy_sync.py::test_plugin_mcp_configs_match_mcp_json`。
- Session 物理隔离（已核实 Pi v0.80.6 源码）：每个任务使用 `randomUUID()` 作为 `taskId`，统一传 `--session-dir <stateDir>/sessions --session-id <taskId>`，永不使用 `-c`/`--continue` 或 `--session <不存在路径>`。
- Prompt 经 `stdin` 管道传入（写完立即 `stdin.end()` 并监听 `stdin` `error` 事件防 `EPIPE`），不作为 CLI 位置参数拼接。
- 前缀缓存稳定：`start` 与 `reply` 传入字节完全一致的 `--append-system-prompt` 静态文本，不含动态字段。
- 状态目录与子目录（`tasks/`、`sessions/`、`logs/`、`locks/`、`outcomes/`）权限 `0700`，任务 JSON、锁、日志与 outcome 文件权限 `0600`（session jsonl 退出后补 `0600`）；原子写入；绝不打印环境变量或凭据。
- 本仓 Git 操作优先使用 `git1`，提交遵循 `type(scope): 中文祈使句` 规范且不包含 AI 署名。
- 实施阶段在独立特性分支（如 `feat/pi-worker-plugin`）或隔离 worktree 中进行，不直接在 `main` 上提交；不主动 `push`。

## Review Focus

- **Pi 自嵌套递归与越权调用**：`lib-plugins.sh` 会将 `plugins/pi-worker` 链接到 `~/.agents/plugins`。当 `PI_WORKER_DEPTH >= 1 || PI_SUBAGENT_CHILD === "1"` 时，`server.ts` 必须让 `tools/list` 返回 `[]` 且 `callTool` 拒绝全部 5 个工具（含 `cancel`/`status`/`list`），`runner.ts` 拒绝 `start`/`reply`，且 `childEnv` 清除 `PI_SESSION_OWNER_ID`（Task 3 + Task 4 测试钉死）。
- **`worker_ask_parent` 挂起不能留下悬空 `tool_use` 且不被 `ctx.abort()` 误判为失败**：工具先原子写 `PI_WORKER_OUTCOME_FILE` 并正常返回 `tool_result`，等到 `turn_end`（`tool_use` + `tool_result` 成对落盘后）再调 `ctx.abort()`；`agent_end` 见 `terminalWritten === true` 时保持 `exitCode = 0` 不覆写为 `aborted` 失败（Task 1 测试钉死）。
- **`--mode json` 报错退出码收口 + 兜底**：`worker-ext.ts` 在 `agent_end` 遇到 `stopReason: "error" | "aborted"` 写 `failed` outcome 并置 `process.exitCode = 1`；同时 `runner.ts` 在 `outcomeFile` 缺失时仍保留流内 `stopReason`/`auto_retry_end`/`agent_settled` 兜底判 `failed`（Task 1 + Task 3 测试钉死）。
- **无头环境排除 `bash_async` 与交互提问工具，且 `\u2028`/`\u2029` 不撕裂 JSONL**：`DEFAULT_EXCLUDE_TOOLS` 精确列出 `["ask_question", "ask_user_question", "bash_async", "bash_async_status"]`（因 `sdk.js:134` 为 `Set.has` 精确匹配）；流解析用 `StringDecoder("utf8")` 按 `\n` 切分（禁 `node:readline`）（Task 1 + Task 3 测试钉死）。
- **退出后 `git status` 窗口期的 `orphan_process` 竞态 & 跨进程同 `cwd` 并发**：终结挂 `close`（非 `exit`）、开头 `clearTimeout` 并经 `inFlight` 集合保护直至终态与 `gitChanges` 落盘；`TaskStore` 用 `<stateDir>/locks/<sha256(cwd)>.lock`（`O_CREAT|O_EXCL`）做跨进程排他锁并回收死 PID；`resolvePiBinary` 检查原始路径与 `realpathSync` 跳过 `/pi/launcher.zsh`（Task 2 + Task 3 测试钉死）。

---

### Task 1: 协议/Outcome/流解析与 Pi 专属扩展 (`worker-ext.ts`)

**Files:**
- Create: `plugins/pi-worker/src/protocol.ts`
- Create: `plugins/pi-worker/src/worker-ext.ts`
- Test: `tests/test_pi_worker_protocol.mjs`
- Test: `tests/test_pi_worker_ext.mjs`

**Interfaces:**
- Consumes: Node.js 标准库（`node:fs`, `node:path`, `node:string_decoder`）。
- Produces (`src/protocol.ts`):
  - `PROTOCOL_APPEND_PROMPT: string`（固定静态文本：说明无头模式用同步 `bash` 不用 `bash_async`/交互提问工具、提问或阶段闭合前优先尾部 `compress`、需输入调 `worker_ask_parent`、遇外部阻塞调 `worker_report_blocked`、完工可调 `worker_finish`）
  - `WorkerOutcomeStatus = "done" | "needs_input" | "blocked" | "failed"`
  - `WorkerOutcome = { status: WorkerOutcomeStatus; summary: string; question: string | null; options: string[]; verifiedCommands: string[]; stopReason: string | null; error: string | null }`
  - `StreamEventSummary = { kind: "session" | "tool_start" | "tool_end" | "assistant_message" | "turn_end" | "compact" | "retry_failed" | "agent_aborted" | "other"; toolName?: string; text?: string; stopReason?: string; errorMessage?: string; sessionId?: string; timestamp: string }`
  - `createLineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void }`
  - `extractAssistantMessage(line: string): { text: string; stopReason?: string; errorMessage?: string } | null`
  - `parsePiJsonLine(line: string): StreamEventSummary | null`（`text`/`errorMessage` 截断至 500 字符）
  - `writeOutcomeFile(filePath: string, outcome: WorkerOutcome): void`（`0600` 临时文件 + `renameSync` 原子写）
  - `readOutcomeFile(filePath: string): WorkerOutcome | null`（校验结构，不存在或损坏返回 `null`）
  - `truncateTail(text: string, maxChars?: number): string`
- Produces (`src/worker-ext.ts`):
  - `export default function piWorkerExtension(pi: PiExtensionApiLike): void`（仅当 `process.env.PI_WORKER_OUTCOME_FILE` 非空时注册 3 个工具与 `turn_end` / `agent_end` 钩子；同时导出 `registerPiWorkerExtension(pi, options)` 便于测试注入 `outcomeFile` 与 `setExitCode` 回调）

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_protocol.mjs` 与 `tests/test_pi_worker_ext.mjs`**

`tests/test_pi_worker_protocol.mjs` 断言：
- `test_protocol_prompt_is_static_and_mentions_worker_tools`：包含 `worker_ask_parent`、`worker_report_blocked`、`worker_finish`、`compress`、同步 `bash`（不用 `bash_async`）。
- `test_outcome_file_roundtrip_permissions_and_corrupt_handling`：`writeOutcomeFile` 写 `0o600` 文件并可被 `readOutcomeFile` 还原；损坏 JSON 或非法 `status` 返回 `null` 不抛异常。
- `test_line_splitter_preserves_unicode_line_separators`：含 `\u2028`/`\u2029` 的 JSON 拆块喂入后仍作为一整行输出。
- `test_parse_pi_json_line_and_extract_assistant_message`：覆盖真实 Pi JSONL 事件（`session`、`tool_execution_start/end`、`turn_end`、`session_compact`、`message_end` 按 `role === "assistant"` 过滤、`auto_retry_end`、`agent_settled`）、启动期非 JSON 杂行返回 `null`、`recentEvents` 文本 500 字符截断。

`tests/test_pi_worker_ext.mjs` 使用 mock `ExtensionAPI` 与 mock `ctx`（带 `abort()` 计数与自定义 `setExitCode`）断言：
- `test_extension_is_noop_when_outcome_env_absent`：未设 `PI_WORKER_OUTCOME_FILE` 时不注册任何工具或事件钩子。
- `test_worker_ask_parent_writes_outcome_returns_tool_result_then_aborts_on_turn_end`：调用 `worker_ask_parent({ question: "A 还是 B?", options: ["A", "B"], summary: "已调研" })` → 此时尚未调 `ctx.abort()`、返回非空 `tool_result`、磁盘 outcome 为 `needs_input`；触发 `turn_end` 后调用 `ctx.abort()` 一次；随后触发 `agent_end`（即便末条消息为 `aborted`）不覆写 outcome 且不设 `exitCode = 1`。
- `test_worker_report_blocked_and_worker_finish_write_structured_outcomes`：分别验证 `blocked`（含 `error`）与 `done`（含 `verifiedCommands`）在 `turn_end` 触发 `ctx.abort()`。
- `test_agent_end_handles_natural_done_and_sets_exit_code_on_error_stop_reason`：未调任何 worker 工具自然结束时，末条 assistant 为 `stop` 写 `done` 且不改 exitCode；末条 assistant 为 `stopReason: "error"` 或 `"aborted"` 时写 `failed`（含 `errorMessage`）并调用 `setExitCode(1)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_protocol.mjs tests/test_pi_worker_ext.mjs`
Expected: FAIL，报错找不到 `protocol.ts` 与 `worker-ext.ts`。

- [ ] **Step 3: 实现 `plugins/pi-worker/src/protocol.ts` 与 `plugins/pi-worker/src/worker-ext.ts`**

按上述接口最小化实现：
- `worker-ext.ts` 工具定义使用纯 JSON Schema 对象，不引入第三方包；
- 工具返回 `tool_result` 后仅置 `abortOnTurnEnd = true`，绝不在工具 `execute()` 内直接调 `ctx.abort()`，确保 `tool_use`/`tool_result` 成对落入 session；
- `agent_end` 兜底逻辑处理自然完成与 `stopReason === "error" | "aborted"`（通过 `process.exitCode = 1` 修正 `--mode json` 退出码）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/test_pi_worker_protocol.mjs tests/test_pi_worker_ext.mjs`
Expected: PASS（全部用例通过，退出码 0）。

- [ ] **Step 5: 提交 Task 1**

```bash
git1 add plugins/pi-worker/src/protocol.ts plugins/pi-worker/src/worker-ext.ts tests/test_pi_worker_protocol.mjs tests/test_pi_worker_ext.mjs
git1 commit -m "feat(pi-worker): 增加协议流解析与 Pi 挂起收口扩展"
```

---

### Task 2: 持久化任务存储、原子写入与跨进程单写手排他锁

**Files:**
- Create: `plugins/pi-worker/src/store.ts`
- Test: `tests/test_pi_worker_store.mjs`

**Interfaces:**
- Consumes: `import type { StreamEventSummary } from "./protocol.ts"`。
- Produces:
  - `TaskStatus = "running" | "needs_input" | "done" | "blocked" | "failed" | "cancelled"`
  - `TaskRecord`：包含 `taskId`（UUID）, `cwd`（规范化绝对路径）, `sessionDir`, `logPath`, `outcomePath`, `status`, `pid: number | null`, `model?: string`, `provider?: string`, `thinking?: string`, `excludeTools: string[]`, `createdAt`, `updatedAt`, `lastActivityAt`, `turnCount: number`, `roundCount: number`, `lastTool: string | null`, `recentEvents: StreamEventSummary[]`（最多 10 条）, `summary: string | null`, `question: string | null`, `options: string[]`, `verifiedCommands: string[]`, `stopReason: string | null`, `exitCode: number | null`, `error: string | null`, `gitChanges: string[]`
  - `TaskSummary`：`Pick<TaskRecord, "taskId" | "cwd" | "status" | "roundCount" | "turnCount" | "lastTool" | "createdAt" | "updatedAt" | "lastActivityAt" | "question" | "error">`
  - `resolveStateDir(env?: NodeJS.ProcessEnv): string`（优先 `PI_WORKER_STATE_DIR`，否则 `join(homedir(), ".pi", "agent", "pi-worker")`）
  - `class TaskStore`：
    - `constructor(stateDir?: string, options?: { isPidAlive?: (pid: number) => boolean })`
    - `ensureDirs(): void`（确保根与 `tasks/`、`sessions/`、`logs/`、`locks/`、`outcomes/` 均为 `0700`）
    - `allocateTaskPaths(taskId: string): { taskFile: string; sessionDir: string; logPath: string; outcomePath: string }`
    - `acquireCwdLock(canonicalCwd: string, owner: { taskId: string; ownerPid: number }, options?: { inFlightTaskIds?: ReadonlySet<string> }): { lockPath: string } | { conflictTaskId: string; ownerPid: number }`
    - `releaseCwdLock(canonicalCwd: string, taskId: string): void`
    - `save(record: TaskRecord): void`（同目录临时文件 `0600` + `renameSync` 原子替换）
    - `load(taskId: string, options?: { inFlightTaskIds?: ReadonlySet<string> }): TaskRecord | null`
    - `list(filter?: { status?: TaskStatus; cwd?: string; limit?: number }, options?: { inFlightTaskIds?: ReadonlySet<string> }): TaskSummary[]`

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_store.mjs`**

覆盖断言（临时 `mkdtempSync` 目录隔离）：
- `test_save_and_load_enforces_private_permissions_and_dirs`：验证根与 5 个子目录权限 `0o700`，任务 JSON 与锁文件权限 `0o600`。
- `test_load_reconciles_dead_pid_but_skips_in_flight_tasks`：`isPidAlive: () => false` 下，位于 `inFlightTaskIds` 中的任务保持 `running`，移出后自动校正为 `failed` + `error: "orphan_process"` 且回写磁盘。
- `test_cwd_lock_prevents_cross_process_conflict_and_reclaims_dead_owner`：活 `ownerPid` 持锁时二次获取返回冲突；死 `ownerPid` 时自动回收旧锁、将旧任务标 `orphan_process` 并允许新任务获锁；`releaseCwdLock` 不误删他人锁。
- `test_list_returns_compact_summaries_and_rejects_invalid_task_id`：过滤、倒序、`limit`、不含大段 `recentEvents`/`summary`，且 `../` 或 `/` 非法 `taskId` 抛错。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_store.mjs`
Expected: FAIL，报错找不到 `plugins/pi-worker/src/store.ts`。

- [ ] **Step 3: 实现 `plugins/pi-worker/src/store.ts`**

按接口实现：`taskId` 校验 `/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/`；`acquireCwdLock` 使用 `O_CREAT | O_EXCL | O_WRONLY`（`0o600`）；默认 `isPidAlive` 用 `process.kill(pid, 0)`（`ESRCH` 判死，`EPERM` 判活）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/test_pi_worker_store.mjs`
Expected: PASS（全部用例通过，退出码 0）。

- [ ] **Step 5: 提交 Task 2**

```bash
git1 add plugins/pi-worker/src/store.ts tests/test_pi_worker_store.mjs
git1 commit -m "feat(pi-worker): 增加任务持久化存储与跨进程单写手锁"
```

---

### Task 3: Pi 子进程编排器与 Suspend-Resume 闭环

**Files:**
- Create: `plugins/pi-worker/src/runner.ts`
- Test: `tests/test_pi_worker_runner.mjs`

**Interfaces:**
- Consumes: `./protocol.ts`、`./store.ts`。
- Produces:
  - `DEFAULT_TIMEOUT_SECONDS = 1800`、`MIN_TIMEOUT_SECONDS = 1`、`MAX_TIMEOUT_SECONDS = 7200`、`MAX_WAIT_SECONDS = 30`
  - `DEFAULT_EXCLUDE_TOOLS = ["ask_question", "ask_user_question", "bash_async", "bash_async_status"]`
  - `WORKER_EXTENSION_PATH: string`（基于 `import.meta.url` 解析到同目录 `worker-ext.ts` 绝对路径）
  - `isNestedWorkerEnv(env?: NodeJS.ProcessEnv): boolean`（`Number(env.PI_WORKER_DEPTH ?? "0") >= 1 || env.PI_SUBAGENT_CHILD === "1"`）
  - `resolvePiBinary(env?: NodeJS.ProcessEnv): string`（按 `PI_WORKER_BIN` → `PI_REAL_BIN` → `PATH` 物理 `pi` → `join(homedir(), ".local/share/pitty/node_modules/.bin/pi")` 查找；对路径及 `realpathSync` 跳过 `/pi/launcher.zsh`，校验文件存在且 `X_OK`）
  - `class PiWorkerRunner`：
    - `constructor(options?: { store?: TaskStore; env?: NodeJS.ProcessEnv; piBinary?: string })`
    - `start(input: { cwd: string; prompt: string; model?: string; provider?: string; thinking?: string; timeoutSeconds?: number; excludeTools?: string[]; waitSeconds?: number }): Promise<TaskRecord>`
    - `reply(input: { taskId: string; reply: string; timeoutSeconds?: number; waitSeconds?: number }): Promise<TaskRecord>`
    - `status(input: { taskId: string; waitSeconds?: number }): Promise<TaskRecord>`
    - `cancel(input: { taskId: string }): Promise<{ task: TaskRecord; wasRunning: boolean }>`
    - `list(input?: { status?: TaskStatus; cwd?: string; limit?: number }): TaskSummary[]`
    - `shutdown(): Promise<void>`

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_runner.mjs`**

构造可执行 Node `fake-pi` 脚本（经 `PI_WORKER_BIN` 注入），将每轮接收到的 `argv`、`stdin`、`env` 写入临时日志，按场景写 `PI_WORKER_OUTCOME_FILE` 并输出真实 Pi JSONL 事件流（含非 JSON 启动杂行），覆盖断言：
- `test_start_needs_input_then_reply_resumes_same_session_via_stdin`：
  - `prompt` 以 `- 检查 @src/index.ts` 开头，同时传 `excludeTools: ["write"]`；
  - 断言 `fake-pi` 收到 `--mode json`、`--print`、`--session-dir <stateDir>/sessions`、`--session-id <taskId>`、`-e <WORKER_EXTENSION_PATH>`、`--exclude-tools` 合并包含 `DEFAULT_EXCLUDE_TOOLS` 与 `"write"`、`--append-system-prompt <PROTOCOL_APPEND_PROMPT>`，**绝不含 `-c`/`--continue`/`--session`**，prompt 经 `stdin` 完整收到，环境含 `PI_SUBAGENT_CHILD=1`、`PI_WORKER_DEPTH=1`、`PI_WORKER_OUTCOME_FILE` 且不含 `PI_SESSION_OWNER_ID`；
  - 第 1 轮 `fake-pi` 写 `needs_input` outcome → 返回 `status === "needs_input"`, `question`, `roundCount === 1`；
  - 第 2 轮 `reply(taskId, "@confirm 选方案 A")`：校验旧 `outcomeFile` 启动前已清理、运行期旧 `question`/`summary` 已清零、`fake-pi` 收到完全相同的 `--session-dir`/`--session-id`/`-e`/`--append-system-prompt` 与经 `stdin` 传入的回复；写 `done` outcome（含 `verifiedCommands`）后断言 `status === "done"`, `roundCount === 2`, `question === null`。
- `test_fallback_when_outcome_file_missing_catches_error_stop_reason_on_exit_zero`：`fake-pi` 故意不写 `PI_WORKER_OUTCOME_FILE`，输出 `message_end`（`stopReason: "error", errorMessage: "429 Too Many Requests"`）并以 `exitCode = 0` 退出；断言 runner 兜底仍判 `status === "failed"`, `stopReason === "error"`, `error` 包含 `429 Too Many Requests`。
- `test_rejects_provider_without_model_and_recursive_env`：`provider` 无 `model` 拒绝；`PI_WORKER_DEPTH: "1"` 或 `PI_SUBAGENT_CHILD: "1"` 下 `start`/`reply` 拒绝。
- `test_concurrent_cwd_lock_cancel_semantics_and_no_finalizing_orphan_race`：同 `cwd`（含软链）并发 `start` 被拒；`cancel` 对 `running` 杀进程组置 `cancelled`（`wasRunning: true`），对 `needs_input` 置 `cancelled`（`wasRunning: false`），对 `done` 保持 `done`（`wasRunning: false`）；快速退出瞬间查询 `status` 不会误报 `orphan_process`。
- `test_timeout_terminates_detached_process_group`：`fake-pi` 阻塞，`timeoutSeconds: 1` 启动后等待退出，断言 `status === "failed"` 且 `error` 含 `timeout`。
- `test_resolve_pi_binary_skips_symlink_to_launcher_zsh`：前目录放指向 `pi/launcher.zsh` 的软链 `pi`、后目录放真实 `pi`，断言跳过软链命中后者。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_runner.mjs`
Expected: FAIL，报错找不到 `plugins/pi-worker/src/runner.ts`。

- [ ] **Step 3: 实现 `plugins/pi-worker/src/runner.ts`**

关键实现要点：
- 每轮启动前删除残留 `outcomePath`（若存在），确保读到的 outcome 必属当前轮次；
- 传 `-e <WORKER_EXTENSION_PATH>` 与环境变量 `PI_WORKER_OUTCOME_FILE=<outcomePath>`、`PI_SUBAGENT_CHILD=1`、`PI_WORKER_DEPTH=String(depth + 1)`，显式 `delete childEnv.PI_SESSION_OWNER_ID`；
- `detached: true` 启动，监听 `child.on("error")` 与 `child.stdin.on("error")`，`child.stdin.end(promptText, "utf8")`；
- stdout 用 `createLineSplitter` + `createWriteStream(logPath, { flags: "a", mode: 0o600 })` 实时更新进度；
- 终结顺序（挂 `close` 事件，期间保持 `taskId` 在 `this.inFlight`）：
  1. `clearTimeout(timer)`，flush `lineSplitter` 与 `logStream`；
  2. 判定终态：`cancelled` → `timeout` → `spawnError` → 优先读 `readOutcomeFile(outcomePath)`（若 `outcome.status === "needs_input" | "blocked" | "done" | "failed"` 直接采信；但若 `exitCode !== 0` 且 outcome 缺失则判 `failed`）→ outcome 缺失时按 `exitCode !== 0 || stopReason in ("error","aborted") || sawRetryFailed || sawAgentAborted` 判 `failed`，否则按末条 assistant 文本兜底 `done`；
  3. 跑短超时（2s）`git status --short` 采集 `gitChanges`（上限 50 行），并对 `<sessionDir>` 内匹配 `taskId` 的 `.jsonl` best-effort 补 `chmod 0o600`；
  4. 原子 `store.save(record)` → `store.releaseCwdLock(canonicalCwd, taskId)` → 移出 `inFlight` → 唤醒所有 `waitSeconds` 等待者。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/test_pi_worker_runner.mjs`
Expected: PASS（全部用例通过，退出码 0）。

- [ ] **Step 5: 提交 Task 3**

```bash
git1 add plugins/pi-worker/src/runner.ts tests/test_pi_worker_runner.mjs
git1 commit -m "feat(pi-worker): 实现异步 Pi 子进程编排与挂起续跑"
```

---

### Task 4: MCP Server、插件清单、通用 Skill 与仓内同步集成

**Files:**
- Create: `plugins/pi-worker/src/server.ts`
- Create: `plugins/pi-worker/plugin.json`
- Create: `plugins/pi-worker/mcp.json`
- Create: `plugins/pi-worker/mcp_config.json`
- Create: `plugins/pi-worker/skills/pi-worker/SKILL.md`
- Test: `tests/test_pi_worker_mcp.mjs`
- Modify: `tests/test_agy_sync.py`
- Modify: `tests/test_pi_sync.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: `./runner.ts`（`PiWorkerRunner`, `isNestedWorkerEnv`）、`./store.ts`（`TaskStore`）。
- Produces:
  - stdio MCP server 暴露 5 个工具：`pi_worker_start`、`pi_worker_reply`、`pi_worker_status`、`pi_worker_cancel`、`pi_worker_list`；
  - Agent Plugins 1.0.0 + AGY 双规范目录 `plugins/pi-worker/`；
  - 跨 Harness Skill `plugins/pi-worker/skills/pi-worker/SKILL.md`。

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_mcp.mjs` 并更新仓内同步测试断言**

`tests/test_pi_worker_mcp.mjs`（通过 `spawn("node", ["plugins/pi-worker/src/server.ts"])` 注入 `PI_WORKER_BIN=<fake-pi>` 与 `PI_WORKER_STATE_DIR=<tmp>`）：
- `initialize` → `serverInfo.name === "pi-worker"`、`capabilities.tools` 存在；
- `tools/list` → 精确暴露 5 个 `pi_worker_*` 工具；
- `tools/call` 跑通 `pi_worker_start(waitSeconds: 5)` → `needs_input` → `pi_worker_reply(waitSeconds: 5)` → `done` → `pi_worker_list` 完整闭环；
- 参数校验失败（缺 `cwd`、相对路径 `cwd`、`provider` 无 `model`、`waitSeconds: 99`、未知 `taskId`）→ 返回 `isError: true` 且服务进程存活；
- 以 `PI_WORKER_DEPTH=1` 启动 MCP server → `tools/list` 返回 `[]`，调用全部 5 个工具（含 `cancel`/`status`/`list`）均返回 `isError: true`；
- 运行长任务期间关闭 server `stdin` → server 优雅退出且拉起的 `fake-pi` 子进程被清理。

在 `tests/test_agy_sync.py` 与 `tests/test_pi_sync.py` 中：
- 插件软链断言列表补齐 `"pi-worker"`；
- `test_agy_sync.py::test_plugin_mcp_configs_match_mcp_json` 将 `assertGreaterEqual(checked, 3)` 更新为 `4`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_mcp.mjs && python3 -m unittest tests/test_agy_sync.py tests/test_pi_sync.py`
Expected: FAIL，报错 `plugins/pi-worker/src/server.ts` 及插件清单尚不存在。

- [ ] **Step 3: 实现 `server.ts`、插件清单、`SKILL.md` 并更新 `README.md`**

- `plugins/pi-worker/src/server.ts`：参照 `plugins/deepseek-search/src/server.ts` 实现零依赖 stdio JSON-RPC 2.0 MCP server：
  - `isNestedWorkerEnv(process.env)` 为真时 `tools/list` 返回 `{ tools: [] }`，`tools/call` 全返回 `isError: true`；
  - 已知工具校验与执行错统一返回 `textResult({ error }, true)`（`isError: true`），未知 JSON-RPC 方法返回 `-32601`；
  - 单例 `gracefulExit()` 监听 `SIGINT`、`SIGTERM`、`process.stdin.on("end")`，`await runner.shutdown()` 后再 `process.exit(0)`。
- `plugins/pi-worker/plugin.json`、`mcp.json`、`mcp_config.json`（严格满足 `test_plugin_mcp_configs_match_mcp_json`）。
- `plugins/pi-worker/skills/pi-worker/SKILL.md`：何时委派/何时不用（严禁在 Pi 会话内自我委派）、派单契约模板、Suspend-Resume 问答闭环（收到 `needs_input` 时主 Agent 优先自答秒续跑保缓存，拍不了板再转问人类）、单写手纪律与收工 `git diff` 核验。
- `README.md`：在 `plugins/` 说明行补充 `pi-worker`。

- [ ] **Step 4: 运行全套测试验证**

Run: `node --test tests/test_pi_worker_*.mjs && python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: 全部 Node 测试与全量 Python 回归测试（含 `test_agy_sync.py`、`test_qwen_routing.py`、`test_pi_sync.py`）PASS，退出码 0。

- [ ] **Step 5: 提交 Task 4**

```bash
git1 add plugins/pi-worker tests/test_pi_worker_mcp.mjs tests/test_agy_sync.py tests/test_pi_sync.py README.md
git1 commit -m "feat(pi-worker): 增加跨 Harness Pi 长任务委派插件与 MCP 服务"
```

---

## Independent Plan Review

- **Reviewer**：fresh 只读 `research` 子代理（`pro` 档位），2026-11-24；叠加本机 `@earendil-works/pi-coding-agent@0.80.6` 与本仓 `pi/` 扩展源码实机核验。
- **Critical（5 项，全部已合入）**：
  - **C1**：`--mode json` 下 LLM 报错仍返回退出码 `0` → 升级为 `-e src/worker-ext.ts` 在 `agent_end` 写 `failed` outcome 并置 `process.exitCode = 1`（`main.js:694-696` 实测不覆写），同时 `runner.ts` 保留 `outcomeFile` 缺失时的流内 `stopReason` 兜底。
  - **C2**：`-p <prompt>` 对 `-`/`@` 开头误解析与 `ARG_MAX` → 改为 piped `stdin`（写完立即 `stdin.end()` 并处理 `EPIPE`）。
  - **C3**：子 Pi 加载 `pi-worker` MCP 越权调用 → `isNestedWorkerEnv` 时 `tools/list` 返回 `[]` 且全部 5 个工具拒调，`childEnv` 清除 `PI_SESSION_OWNER_ID`。
  - **C4**：退出后 `2s git status` 期间与 `TaskStore` 孤儿清理竞态 → 终结挂 `close` 事件、立即 `clearTimeout`、经 `inFlightTaskIds` 保护直至终态与 `gitChanges` 原子落盘。
  - **C5**：`pi/GLOBAL.md` 强推 `bash_async` 在无头模式必抛错 → 经 `--exclude-tools` 精确排除 `bash_async,bash_async_status`（同步排除 `ask_question,ask_user_question`）并在附加提示词指明用同步 `bash`。
- **Suggestion & Minor（9 项，全部已合入）**：
  - 禁用 `node:readline` 改用 `StringDecoder` 按 `\n` 切分（S1）；统一 `timeoutSeconds` `1..7200`、扁平 `TaskRecord`/精简 `TaskSummary`、`excludeTools` 合并、拒绝无 `model` 仅传 `provider`（S2）；`reply` 清零旧轮字段与旧 outcome、`cancel` 分态语义、`ensureDirs()` `0700` 与 session jsonl 补 `0600`（S3）；`resolvePiBinary` 走 `realpathSync` 跳过 `/pi/launcher.zsh` 并兜底 `~/.local/share/pitty/node_modules/.bin/pi`（S4）；`server.ts` 单例 `await runner.shutdown()`、`detached: true` 按进程组清理、校验错返回 `isError: true`（S5）；`TaskStore` 增加按 `sha256(cwd)` 的 `O_CREAT|O_EXCL` 跨进程排他锁并同步更新 `test_pi_sync.py`（S6）；真实事件名、`createWriteStream` 日志流 + 500 字符截断、Node 22 原生 TS 语法约束（M1–M3）。
- **扩展机制追加核验（已合入）**：
  - 核实 `print-mode` 下 `ctx.shutdown()` 为 no-op，**`ctx.abort()` 才真正中止循环**；`worker_ask_parent`/`worker_report_blocked`/`worker_finish` 先返回 `tool_result` 再在 `turn_end` 调 `ctx.abort()`，保证 `tool_use`/`tool_result` 成对落盘不断裂续跑。
- **Unresolved / Deferred**：无。
