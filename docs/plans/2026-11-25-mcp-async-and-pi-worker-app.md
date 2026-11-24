# MCP 原生后台异步机制、跨 Harness 进度出口与 pi-worker MCP App 实施计划

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 为 `pi-worker` 补齐续跑控制面（`reply` 覆盖模型/thinking + 放开 `failed`/`cancelled` 续跑）、跨 Harness 统一流式进度出口（`events.jsonl` + MCP `notifications/progress` + 只读 CLI）、AGY 原生后台异步（`start`/`reply` 直接 `background: "always"` + `notifications/cancelled` 联动）与 AGY MCP App 侧面板（`ui://pi-worker/monitor.html`），并将 AGY 后台双入口推广至 `home-connect`（`home_exec_bg` / `home_copy_bg` 与 `comfyui_generate` 无超时后台）。

**Architecture:**
- **生产与消费解耦（`pi-worker`）**：`plugins/pi-worker/src/stream.ts` 统一将 Pi 原始事件翻译为精简结构化事件流，同时向 3 个正交出口输出：① `logs/<taskId>.events.jsonl`（`0600`，`TaskRecord.eventsPath` 暴露，思考按 1.5s 节流、单行截断封顶）；② MCP 标准 `notifications/progress`（调用方带 `_meta.progressToken` 时实时推单行进度）；③ `node plugins/pi-worker/src/stream.ts <taskId> [--follow] [--json]` 只读 CLI（供终端或任意非 AGY 工具消费）。
- **AGY 原生异步无多余工具**：通过 AGY `mcp_config.json` 注入 `PI_WORKER_AGY=1` + `timeoutSeconds: -1` + `tools.pi_worker_start.background: "always"` + `tools.pi_worker_reply.background: "always"`：AGY 下 `start`/`reply` 内部直接等待本轮离开 `running` 后返回（并监听 `notifications/cancelled` 联动 `runner.cancel`），无需 `pi_worker_wait`；未设 `PI_WORKER_AGY` 时（Qwen/Pi）保持非阻塞秒返 + `waitSeconds` 短等。
- **AGY MCP App 侧面板**：仅 `pi_worker_monitor`（前台工具，所有参数可选）挂 `aux_pane` + `global` entrypoints 渲染 `ui://pi-worker/monitor.html`，通过 `visibility: ["app"]` 工具增量消费 `events.jsonl`，避免 `start`/`reply` 产生多余 inline iframe。
- **`home-connect` 双入口后台**：`mcp_config.json` 注入 `HOME_CONNECT_AGY_ASYNC=1` + `timeoutSeconds: -1`，暴露同实现的 `home_exec_bg` / `home_copy_bg`（默认 `timeoutSec = 0` 不设本地截断）与 `comfyui_generate` 后台配置，Qwen/Pi 与宿主 HTTP 模式（`server-http.ts`）完全纯净。

**Tech Stack:** Node.js >= 22.19.0 原生 TypeScript（`plugins/pi-worker/src/` 与 `plugins/home-connect/src/` 运行期零第三方依赖）、`@modelcontextprotocol/ext-apps` + `zod` + `esbuild`（仅在 `plugins/pi-worker/ui-src/` 开发期打包单文件 HTML `plugins/pi-worker/ui/monitor.html`）、`node:test`、`node:assert/strict`、Python `unittest`。

**Spec:** 基于 `docs/plans/2026-11-24-pi-worker-plugin-design.md` 及本轮已确认决议：移除 `pi-worker` 总墙钟超时（基线，先独立提交）；`reply` 支持覆盖配置并放开 `failed`/`cancelled` 续跑；去掉 `pi_worker_wait`，AGY 下 `start`/`reply` 直接原生后台化；提供跨 Harness 统一进度出口（`events.jsonl` / `notifications/progress` / 只读 CLI）；接入 AGY MCP App 侧面板；`home-connect` 推广同实现双入口后台模式。

## Global Constraints

- 运行期零第三方依赖：`plugins/pi-worker/src/*.ts` 与 `plugins/home-connect/src/*.ts` 不引入第三方 npm 包；`plugins/pi-worker/` 根目录不建 `package.json`。MCP App 构建配置仅放在 `plugins/pi-worker/ui-src/`，单文件产物 `plugins/pi-worker/ui/monitor.html` 直接提交入库，`node_modules/` 由根 `.gitignore` 忽略。
- Node >= 22.19.0 原生 TypeScript 语法约束：类型导入一律使用 `import type`（或内联 `type`），相对导入带 `.ts` 后缀，禁用 `enum`、`namespace` 与构造函数参数属性。
- 跨 Harness 零污染：AGY 专属工具、`_meta`、`resources` 及专属 `INSTRUCTIONS` 提示行**仅在**对应 env 开关开启（`PI_WORKER_AGY=1`、`HOME_CONNECT_AGY_ASYNC=1`）时激活；未设开关时（Qwen / Pi / `home-connect` 宿主 HTTP 模式）工具列表、资源列表与 `INSTRUCTIONS` 与原版保持纯净。
- 嵌套防护不降级：`PI_WORKER_DEPTH >= 1 || PI_SUBAGENT_CHILD === "1"` 时，`pi-worker` `tools/list` 返回 `[]`、`resources/list` 返回 `[]`、`resources/read` 与全部工具调用一律拒绝，即便同时设置了 `PI_WORKER_AGY=1`。
- MCP App 安全与 CSP 约束：`plugins/pi-worker/ui/monitor.html` 为单文件自包含 HTML（< 10 MiB），满足默认 CSP（`default-src 'none'`，无任何外链 `http(s)://` `<script>`/`<link>`），通过 `import.meta.dirname` 定位，支持 `PI_WORKER_APP_HTML` 热加载覆写；单次 RPC 远低于 1 MiB；前端严格单飞（最多 1 个 in-flight `callServerTool`）。
- 双清单同步：`mcp_config.json` 与 `mcp.json` 通过 `tests/test_agy_sync.py`，且 `mcp.json` 不含 AGY 专属字段（`timeoutSeconds`、`tools`、`PI_WORKER_AGY`、`HOME_CONNECT_AGY_ASYNC`）。
- Git 提交规范：优先使用 `git1`（不可用时回退 `git`）；格式 `type(scope): 中文祈使句`，无 AI 署名；一 commit 一逻辑变更（开始 Task 1 前先把工作区已完成的去超时改动单独提交为基线 commit）；不主动 `push`。

## Review Focus

1. **跨进程 `finalize()` 2s 窗口期防误判 `orphan_process`（`store.ts`）**：`finalize()` 收集 `git status` 期间 `record.pid` 已死但 `tasks/<id>.json` 仍为 `running`；`TaskStore.reconcileIfNeeded()` 必须同时检查 `<stateDir>/locks/<sha256(cwd)>.lock` 是否仍由同一 `taskId` 的活 `ownerPid` 持有，持有则不误判 `orphan_process`（Task 1 测试钉死）。
2. **`reply` 配置覆盖校验、状态放开与 `outcomePath` 删除顺序**：`reply` 仅拒绝 `running`（放开 `needs_input`/`done`/`blocked`/`failed`/`cancelled`），支持覆盖 `model`/`provider`/`thinking`（最终 `provider` 非空但 `model` 为空时拒绝），且 `launchRound` 必须先 `acquireCwdLock` 成功后再删除旧 `outcomePath`；AGY 模式下 `notifications/cancelled` 按 `requestId` 映射到在途 `taskId` 并触发 `runner.cancel`（Task 1 测试钉死）。
3. **增量读取多字节 UTF-8、超长行与 `maxEvents` 对齐（`stream.ts`）**：`events.jsonl` 单行本身截断封顶，且 `readFormattedEventsDelta(path, offset, { maxBytes, maxEvents })` 显式处理单行 > `maxBytes`（扫描到下一 `\n` 跳过并推进 `nextOffset`，绝不 livelock）、末尾半行回退至最后 `\n` 边界、以及达到 `maxEvents` 时把 `nextOffset` 精准停在第 `maxEvents` 行的 `\n` 后并设 `hasMore: true`（Task 2 测试钉死）。
4. **MCP App 空参启动、嵌套封锁、LLM `content` 精简与 `file://` URI 解析**：`pi_worker_monitor({})` 空参返回有效结果且 `content[0].text` 仅含紧凑摘要（不把大段事件流塞进模型上下文）；`PI_WORKER_AGY=1` + `PI_WORKER_DEPTH=1` 下 `resources/read` 仍被拒；`app.ts` 正确解析 `git status --short`（剥 `XY `、处理 `old -> new` 重命名与编码空格/中文）生成合法 `file://` URI（Task 2 & Task 3 测试钉死）。
5. **`home-connect` `timeoutSec=0` 无截断、全分支透传与隔离**：`settle()` 在 `timeoutSec === 0` 时不创建 `killTimer` 且仍注册 `activeChildren` 受 `home_reset` 回收；`home_exec_bg` 独立校验 `timeoutSec`（`undefined`/`0` → `0`，正数不设 1800 上限，负数报错）；`copyFile` 全分支（含 `HOST_MODE`）透传 `options?.timeoutSec`；`HOME_INSTRUCTIONS` 与 `*_bg` 工具在非 AGY 环境下完全隔离（Task 4 测试钉死）。

---

### Task 0（前置基线提交）：提交工作区已完成的移除总超时改动

**Files:**
- Already modified in working tree: `plugins/pi-worker/src/runner.ts`, `plugins/pi-worker/src/server.ts`, `plugins/pi-worker/skills/pi-worker/SKILL.md`, `plugins/pi-worker/scripts/live-e2e.mjs`, `tests/test_pi_worker_runner.mjs`, `tests/test_pi_worker_mcp.mjs`

- [ ] **Step 1: 确认工作区回归测试全绿并独立提交基线**

Run: `node --test tests/test_pi_worker_*.mjs && python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: PASS（Node 23/23，Python 35/35）。

```bash
GIT_BIN="$(command -v git1 || echo git)"
"$GIT_BIN" add plugins/pi-worker/src/runner.ts plugins/pi-worker/src/server.ts plugins/pi-worker/skills/pi-worker/SKILL.md plugins/pi-worker/scripts/live-e2e.mjs tests/test_pi_worker_runner.mjs tests/test_pi_worker_mcp.mjs
"$GIT_BIN" commit -m "refactor(pi-worker): 移除单轮总墙钟超时限制"
```

---

### Task 1: `pi-worker` 续跑控制面增强、防跨进程孤儿竞态与 AGY 原生后台化

**Files:**
- Modify: `plugins/pi-worker/src/store.ts`
- Modify: `plugins/pi-worker/src/runner.ts`
- Modify: `plugins/pi-worker/src/server.ts`
- Modify: `plugins/pi-worker/mcp_config.json`
- Modify: `plugins/pi-worker/skills/pi-worker/SKILL.md`
- Test: `tests/test_pi_worker_store.mjs`
- Test: `tests/test_pi_worker_runner.mjs`
- Test: `tests/test_pi_worker_mcp.mjs`

**Interfaces:**
- Consumes: `store.ts`、`runner.ts`、`server.ts`。
- Produces (`plugins/pi-worker/src/store.ts`):
  - `TaskRecord` 新增 `eventsPath: string`（默认兼容旧记录，读取缺省时按 `logs/<taskId>.events.jsonl` 补齐）
  - `allocateTaskPaths(taskId)` 返回 `{ taskFile, sessionDir, logPath, eventsPath, outcomePath }`
  - `reconcileIfNeeded`：在 `record.status === "running"` 且 `record.pid` 已死时，若 `lockPathForCwd(record.cwd)` 仍存在且 `lock.taskId === record.taskId` 且 `isPidAlive(lock.ownerPid)` 为真，**跳过**孤儿校正（说明拥有者进程正在 `finalize()` 中）
- Produces (`plugins/pi-worker/src/runner.ts`):
  - `StartTaskInput` 新增可选：`waitUntilSettled?: boolean; onProgress?: (event: FormattedStreamEvent) => void`
  - `ReplyTaskInput` 新增可选：`model?: string; provider?: string; thinking?: string; waitUntilSettled?: boolean; onProgress?: (event: FormattedStreamEvent) => void`
  - `reply()`：仅拒绝 `status === "running"`（放开 `needs_input` / `done` / `blocked` / `failed` / `cancelled`）；支持覆盖 `model`/`provider`/`thinking`（合并后若 `provider` 有值但 `model` 为空则抛错）
  - `launchRound()`：先 `acquireCwdLock` 成功，再 `unlinkSync(record.outcomePath)`；当 `waitUntilSettled === true` 时，`start()` / `reply()` 返回 `await active.settled`（供 AGY `background: "always"` 模式直接阻塞到离开 `running` 返回，并支持 `onTaskCreated?: (taskId: string) => void` 回调供 `server.ts` 绑定 `notifications/cancelled`）
- Produces (`plugins/pi-worker/src/server.ts`):
  - `const agyMode = process.env.PI_WORKER_AGY === "1"`
  - `pi_worker_reply` schema 补充 `model`、`provider`、`thinking`（与 `pi_worker_start` 相同的 `enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"]`）
  - 当 `agyMode` 为真时，`pi_worker_start` 与 `pi_worker_reply` 传入 `waitUntilSettled: true`（忽略/覆盖短等），同时记录 `inFlightRequests: Map<string | number, string>`（`jsonrpcId -> taskId`）；处理 `notifications/cancelled`（`params.requestId`），命中则异步调 `runner.cancel({ taskId })`
  - `INSTRUCTIONS` 仅在 `agyMode` 为真时追加 AGY 后台执行提示，未设 `PI_WORKER_AGY` 时保持原样
  - `plugins/pi-worker/mcp_config.json` 配置：
    ```json
    {
      "mcpServers": {
        "pi-worker": {
          "command": "node",
          "args": ["${PLUGIN_ROOT}/src/server.ts"],
          "cwd": "${PLUGIN_ROOT}",
          "timeoutSeconds": -1,
          "env": { "PI_WORKER_AGY": "1" },
          "tools": {
            "pi_worker_start": { "background": "always" },
            "pi_worker_reply": { "background": "always" }
          }
        }
      }
    }
    ```

- [ ] **Step 1: 编写失败测试（`tests/test_pi_worker_store.mjs`、`tests/test_pi_worker_runner.mjs`、`tests/test_pi_worker_mcp.mjs`）**

- `tests/test_pi_worker_store.mjs` 新增：
  - `test_load_skips_orphan_reconcile_when_cwd_lock_owner_is_still_alive`：模拟 `record.pid` 已死、`inFlightTaskIds` 为空，但 `cwd` 锁被同一 `taskId` 的活 `ownerPid` 持有 → `store.load()` 保持 `running` 不误标 `orphan_process`；当 `ownerPid` 也死亡时正常校正为 `failed / orphan_process`。
- `tests/test_pi_worker_runner.mjs` 新增：
  - `test_reply_overrides_model_thinking_and_resumes_failed_and_cancelled_tasks`：覆盖从 `failed` 和 `cancelled` 续跑、`--provider`/`--model`/`--thinking` 覆盖生效、`provider` 无 `model` 拒绝、以及并发锁冲突时不删除既有 `outcomePath`。
  - `test_wait_until_settled_blocks_until_round_finishes`：`start({ ..., waitUntilSettled: true })` 直接等到 `needs_input` 返回，`reply({ ..., waitUntilSettled: true })` 直接等到 `done` 返回。
- `tests/test_pi_worker_mcp.mjs` 新增：
  - `test_mcp_agy_mode_blocks_start_reply_and_cancels_via_notification`：设置 `PI_WORKER_AGY: "1"` 启动 `server.ts`：`pi_worker_start`（不传 `waitSeconds`）直接阻塞至 `needs_input` 返回；`pi_worker_reply`（带 `thinking: "low"`）直接阻塞至 `done` 返回；对 `sleep` 任务发 `pi_worker_start` 后立即发 JSON-RPC `notifications/cancelled`（带对应 `requestId`）→ 断言子进程被终止、`start` 请求返回 `status: "cancelled"`；
  - 未设 `PI_WORKER_AGY` 时 `start(waitSeconds: 0)` 仍立即返回 `running`，且 `initialize.instructions` 不含 AGY 专属文案。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_store.mjs tests/test_pi_worker_runner.mjs tests/test_pi_worker_mcp.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 `store.ts`、`runner.ts`、`server.ts`、`mcp_config.json` 与 `SKILL.md`**

按上述接口最小化实现。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/test_pi_worker_*.mjs && python3 -m unittest tests/test_agy_sync.py`
Expected: PASS（退出码 0）。

- [ ] **Step 5: 提交 Task 1**

```bash
GIT_BIN="$(command -v git1 || echo git)"
"$GIT_BIN" add plugins/pi-worker/src/store.ts plugins/pi-worker/src/runner.ts plugins/pi-worker/src/server.ts plugins/pi-worker/mcp_config.json plugins/pi-worker/skills/pi-worker/SKILL.md tests/test_pi_worker_store.mjs tests/test_pi_worker_runner.mjs tests/test_pi_worker_mcp.mjs
"$GIT_BIN" commit -m "feat(pi-worker): 支持续跑覆盖配置、异常续跑与 AGY 原生后台化"
```

---

### Task 2: 跨 Harness 统一进度流出口（`events.jsonl` + MCP `notifications/progress` + 只读 CLI）与 MCP App 服务端

**Files:**
- Create: `plugins/pi-worker/src/stream.ts`
- Modify: `plugins/pi-worker/src/runner.ts`
- Modify: `plugins/pi-worker/src/server.ts`
- Test: `tests/test_pi_worker_stream.mjs`
- Test: `tests/test_pi_worker_mcp.mjs`

**Interfaces:**
- Consumes: `protocol.ts`（`extractTextFromContent`）、`store.ts`（`TaskStore`, `resolveStateDir`）、`runner.ts`。
- Produces (`plugins/pi-worker/src/stream.ts`):
  - `FormattedStreamEvent = { seq: number; kind: "session" | "thinking" | "tool_start" | "tool_end" | "assistant" | "turn_end" | "compact" | "retry_failed" | "aborted" | "status"; title: string; detail?: string; toolName?: string; toolCallId?: string; isError?: boolean; durationMs?: number; thinkingChars?: number; timestamp: string }`
  - `createEventFormatter(options?: { thinkingThrottleMs?: number; now?: () => number })`:
    - `feedRawLine(rawLine: string): FormattedStreamEvent[]`（解析真实 Pi JSONL：聚合 `obj.type === "message_update" && obj.assistantMessageEvent?.type === "thinking_delta"` 中的 `assistantMessageEvent.delta` 按 `thinkingThrottleMs = 1500` 节流产出 `kind: "thinking"` 摘要事件并在思考段结束/工具开始时 flush 一次；解析 `tool_execution_start`（记录开始时间与截断 200 字符参数摘要）、`tool_execution_end`（算 `durationMs` 与 `obj.isError`）、`message_end`（assistant 文本截断 1200 字符）、`turn_end`、`session_compact`/`compaction_end`、`auto_retry_end(success=false)`、`agent_settled(aborted=true)`）；
    - `flush(): FormattedStreamEvent[]`；
    - `formatTerminalLine(ev: FormattedStreamEvent): string`（单行人类可读格式化，如 `[01:30:12] ▶ bash: node --test`、`[01:30:13] ✓ bash (0.2s)`、`[01:30:15] 💭 思考中 (2400 chars): ...`，供 MCP `notifications/progress` 与 CLI 共享）。
  - `EventsDeltaResult = { offset: number; nextOffset: number; truncated: boolean; hasMore: boolean; events: FormattedStreamEvent[] }`
  - `readFormattedEventsDelta(eventsPath: string, offset?: number, options?: { maxBytes?: number; maxEvents?: number }): EventsDeltaResult`：
    - 默认 `maxBytes = 128 * 1024`，`maxEvents = 100`；
    - 文件不存在返回空；文件大小 < `offset` 置 `truncated: true` 从 `0` 重读；
    - 按字节扫描每一完整 `\n` 结尾行：遇到单行 > `maxBytes` 时前向扫描跳过至下一个 `\n` 并推进 `nextOffset`（绝不 livelock）；遇到达到 `maxEvents` 时将 `nextOffset` 停在最后一条已消费行的 `\n` 字节边界并设 `hasMore: true`；末尾半行不消费、`nextOffset` 停在最后完整 `\n` 后。
  - CLI 入口（仅当 `process.argv[1]` 指向本文件时运行）：
    - `node plugins/pi-worker/src/stream.ts <taskId> [--follow] [--json]`：输出人类可读时间线（或 `--json` 输出原始 NDJSON）；`--follow` 持续增量跟随 `events.jsonl` 直至 `store.load(taskId)` 离开 `running` 后 flush 退出（纯只读，不获取写锁）。
- Produces (`plugins/pi-worker/src/runner.ts`):
  - `launchRound` 内挂载 `createEventFormatter()` 与 `eventsStream`（`createWriteStream(record.eventsPath, { flags: "a", mode: 0o600 })`），实时写入格式化事件并在 `finalize()` 补写一条 `kind: "status"` 终态事件；同步回调 `onProgress?.(ev)`。
- Produces (`plugins/pi-worker/src/server.ts`):
  - **跨 Harness 标准进度通知**：`tools/call` 解析 `params._meta?.progressToken`；存在时把 `onProgress` 接到 `send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ev.seq, message: formatTerminalLine(ev) } })`（无论是否 AGY 模式，只要调用方带了 `progressToken` 就发）。
  - **AGY MCP App 服务端（仅 `PI_WORKER_AGY === "1"` 且 `!nested`）**：
    - `APP_RESOURCE_URI = "ui://pi-worker/monitor.html"`，`APP_MIME_TYPE = "text/html;profile=mcp-app"`，默认路径 `join(import.meta.dirname, "..", "ui", "monitor.html")`（可被 `PI_WORKER_APP_HTML` 覆盖）；
    - `initialize` 声明 `capabilities: { tools: {}, resources: {} }`；
    - `resources/list` 返回 `ui://pi-worker/monitor.html`；`resources/read` 仅在 `agyMode && !nested` 且 URI 匹配时返回 HTML，否则抛 `-32602` / 拒绝；
    - 新增可见工具 `pi_worker_monitor({ taskId? })`（全部参数可选；`{}` 自动选最新 `running` 或最近任务），挂 `aux_pane` + `global` entrypoints；**`content[0].text` 仅放紧凑文本摘要（不内联 `events`）**，`structuredContent` 放 `{ tasks, task, stream }`；
    - 新增 app-only 工具（`_meta: { ui: { visibility: ["app"] } }`）：
      - `pi_worker_app_snapshot({ taskId?, offset?, tasksLimit?, maxEvents? })` → `{ tasks, task, stream }`（`tasksLimit` 默认 20 控制 `tasks` 列表，`maxEvents` 默认 100 控制增量事件条数）；
      - `pi_worker_app_cancel({ taskId })` → `{ task, wasRunning }`；
    - `pi_worker_start`/`reply`/`status` **不**附加 inline `resourceUri`（避免每次工具调用在聊天流生成重复轮询 iframe），改为在 AGY `INSTRUCTIONS` 提示打开 `pi_worker_monitor` 侧面板。

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_stream.mjs` 与扩展 `tests/test_pi_worker_mcp.mjs`**

`tests/test_pi_worker_stream.mjs` 断言：
- `test_formatter_throttles_thinking_and_tracks_tool_duration`：喂入多条 `thinking_delta`（中文）、`tool_execution_start/end`、`message_end`、`turn_end`，验证思考节流合并、工具参数摘要与耗时计算、`formatTerminalLine` 输出可读。
- `test_read_events_delta_handles_partial_utf8_oversized_line_and_max_events`：
  - 半行中文 UTF-8：`nextOffset` 停在最后 `\n`，补全后完整读出；
  - 单行 > `maxBytes`（如 `maxBytes: 128`，写入 512 字节超长行后接正常行）：验证不会 livelock，`nextOffset` 推进越过超长行并读出后续正常行；
  - `maxEvents: 2` 时 5 行事件：首批返回 2 条、`hasMore: true`，二批从 `nextOffset` 精准读第 3–4 条无遗漏；
  - 文件缺失/被截断安全处理。
- `test_stream_cli_outputs_formatted_lines_and_json`：运行 `node plugins/pi-worker/src/stream.ts <taskId>` 与 `--json` 验证退出码 0 与输出格式。

`tests/test_pi_worker_mcp.mjs` 扩展断言：
- 传入 `_meta: { progressToken: "tok-1" }` 调用 `pi_worker_start` → 收到标准 `notifications/progress` 通知且含可读 `message`；
- `PI_WORKER_AGY=1` 时：`resources/list`、`resources/read`（临时 `PI_WORKER_APP_HTML`）、`pi_worker_monitor({})` 空参成功且 `content[0].text` 不含大段 `events`、`pi_worker_app_snapshot` / `pi_worker_app_cancel` 带 `_meta.ui.visibility: ["app"]`；
- `PI_WORKER_AGY=1` + `PI_WORKER_DEPTH=1` 时：`resources/list` 返回 `[]`，`resources/read` 被拒绝；
- 未设 `PI_WORKER_AGY` 时：`resources/list` 为 `[]`，`tools/list` 不含 `pi_worker_monitor` 和 `pi_worker_app_*`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_stream.mjs tests/test_pi_worker_mcp.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 `plugins/pi-worker/src/stream.ts` 并接入 `runner.ts` 与 `server.ts`**

按上述接口实现。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/test_pi_worker_*.mjs`
Expected: PASS（退出码 0）。

- [ ] **Step 5: 提交 Task 2**

```bash
GIT_BIN="$(command -v git1 || echo git)"
"$GIT_BIN" add plugins/pi-worker/src/stream.ts plugins/pi-worker/src/runner.ts plugins/pi-worker/src/server.ts tests/test_pi_worker_stream.mjs tests/test_pi_worker_mcp.mjs
"$GIT_BIN" commit -m "feat(pi-worker): 增加跨 Harness 格式化进度流与 MCP App 服务端接口"
```

---

### Task 3: `pi-worker` MCP App 单文件前端（`ui/monitor.html`）

**Files:**
- Create: `plugins/pi-worker/ui-src/package.json`
- Create: `plugins/pi-worker/ui-src/app.ts`
- Create: `plugins/pi-worker/ui-src/styles.css`
- Create: `plugins/pi-worker/ui-src/build.mjs`
- Create: `plugins/pi-worker/ui/monitor.html`（构建产物，自包含单文件 HTML，入库）
- Test: `tests/test_pi_worker_app_ui.mjs`

**Interfaces:**
- Consumes: Task 2 暴露的 `pi_worker_monitor`、`pi_worker_app_snapshot`、`pi_worker_app_cancel`、`com.google.antigravity/toggle-aux-pane`。
- Produces: `plugins/pi-worker/ui/monitor.html`（< 2 MiB，无任何外链 `http(s)://` 资源，遵循 `default-src 'none'` 默认 CSP）。

- [ ] **Step 1: 编写失败测试 `tests/test_pi_worker_app_ui.mjs`**

断言：
- `test_monitor_html_is_self_contained_csp_safe_and_served_by_mcp`：
  - `plugins/pi-worker/ui/monitor.html` 存在、字节数在 `(1024, 2 * 1024 * 1024)` 内；
  - 含 `<!DOCTYPE html>`、内联 `<style>`、内联 `<script>`；
  - 不含外部 `<script src="http` 或 `<link` 外链；
  - 启动 `server.ts`（`PI_WORKER_AGY=1`，不设 `PI_WORKER_APP_HTML`），调 `resources/read("ui://pi-worker/monitor.html")` 返回 MIME `text/html;profile=mcp-app` 且正文与文件一致。
- `test_git_status_uri_parser_handles_renames_spaces_and_unicode`（导出纯函数 `parseGitStatusFileUri(cwd, line)` 到 `ui-src/git-uri.ts` 以便 Node 单测直接验证）：
  - `" M src/a.ts"` → `file:///repo/src/a.ts`
  - `"?? docs/中文 计划.md"` → 正确编码的 `file:///repo/docs/%E4%B8%AD%E6%96%87%20%E8%AE%A1%E5%88%92.md`
  - `"R  old.ts -> src/new name.ts"` → `file:///repo/src/new%20name.ts`
  - `"D  removed.ts"` → `null`（已删文件不尝试打开）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_pi_worker_app_ui.mjs`
Expected: FAIL。

- [ ] **Step 3: 搭建 `plugins/pi-worker/ui-src/` 并打包 `plugins/pi-worker/ui/monitor.html`**

- `ui-src/package.json`：明确声明开发依赖 `@modelcontextprotocol/ext-apps`、`zod`、`esbuild`；安装后绝不提交 `ui-src/node_modules/`。
- `ui-src/git-uri.ts`：实现 `parseGitStatusFileUri(cwd, statusLine)`，正确剥离 3 字符 `XY `、处理 `old -> new` 重命名与 git 引号、逐段 `encodeURIComponent`。
- `ui-src/app.ts`：
  - 注册 `ontoolinput`、`ontoolresult`、`onhostcontextchanged` 后调用 `await app.connect()`，应用 `applyDocumentTheme` 与 `applyHostStyleVariables`；
  - 从初始 `ontoolresult` 读取 `tasks`/`task`/`stream` 并初始化 `offset = stream.nextOffset`（避免重复从 0 拉取）；
  - 顶部任务下拉切换（按 `running` 优先排序，带状态徽章、目录名、`round`/`turn`）+「刷新」+「取消」按钮（`running`/`needs_input` 可点，调 `pi_worker_app_cancel`）；
  - 状态机与单飞轮询：维护 `requestEpoch`（切换任务时递增，丢弃过期 in-flight 响应）；同一时刻最多 1 个 `callServerTool` 在飞；`truncated === true` 时清空旧时间线重绘；`hasMore === true` 时 100ms 快速追赶，否则 `running` 800ms、`needs_input` 3000ms、终态停止轮询；
  - 实时渲染：可折叠思考卡片（展示最新思考字符数与预览）、格式化事件时间线（工具卡片含耗时/错误高亮、助手消息、压缩标记）、`needs_input` 醒目问题框、`verifiedCommands`、`gitChanges` 点击调 `app.request({ method: "com.google.antigravity/toggle-aux-pane", params: { tabType: "fileView", uri } }, z.object({ isError: z.boolean().optional() }).passthrough())`（不支持宿主静默降级）。
- `ui-src/styles.css`：使用 AGY 标准 `--color-background-*` / `--color-text-*` / `--color-border-*` / `--font-sans` 变量及 fallback，适配窄侧面板（>= 320px）与浅/深主题。
- `ui-src/build.mjs`：`esbuild` 打包 `app.ts` 为 IIFE，安全转义 `</script>` 并内联 `styles.css` 输出 `../ui/monitor.html`。

- [ ] **Step 4: 构建并运行测试确认通过**

Run: `(cd plugins/pi-worker/ui-src && npm run build) && node --test tests/test_pi_worker_*.mjs`
Expected: 构建成功，全部 `test_pi_worker_*.mjs` 用例 PASS。

- [ ] **Step 5: 提交 Task 3**

```bash
GIT_BIN="$(command -v git1 || echo git)"
"$GIT_BIN" add plugins/pi-worker/ui-src/package.json plugins/pi-worker/ui-src/package-lock.json plugins/pi-worker/ui-src/git-uri.ts plugins/pi-worker/ui-src/app.ts plugins/pi-worker/ui-src/styles.css plugins/pi-worker/ui-src/build.mjs plugins/pi-worker/ui/monitor.html tests/test_pi_worker_app_ui.mjs
"$GIT_BIN" commit -m "feat(pi-worker): 增加 Antigravity MCP App 实时流式进度侧面板"
```

---

### Task 4: `home-connect` AGY 后台双入口与双清单同步回归

**Files:**
- Modify: `plugins/home-connect/src/connection.ts`
- Modify: `plugins/home-connect/src/tools-home.ts`
- Modify: `plugins/home-connect/mcp_config.json`
- Modify: `plugins/home-connect/skills/home-connect/SKILL.md`
- Modify: `plugins/home-connect/skills/comfyui/SKILL.md`
- Modify: `plugins/home-connect/skills/comfyui-download/SKILL.md`
- Create: `tests/test_home_connect_async.mjs`
- Modify: `tests/test_agy_sync.py`

**Interfaces:**
- Consumes: `plugins/home-connect/src/connection.ts`、`plugins/home-connect/src/tools-home.ts`、`plugins/home-connect/src/mcp.ts`。
- Produces (`plugins/home-connect/src/connection.ts`):
  - `settle(child, options)`：`const timeoutSec = options.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC; const killTimer = timeoutSec > 0 ? setTimeout(...) : null;`（`timeoutSec === 0` 时不创建超时定时器，子进程仍加入 `activeChildren` 受 `home_reset` 回收）
  - `copyFile(..., options?: { timeoutSec?: number })`：所有分支（含 `HOST_MODE` 的 `mac`/`wsl` 分支，默认仍为 `300`，以及非 `HOST_MODE` 分支）透传 `options?.timeoutSec`
  - `copyBatchWindows(pairs, options?: { timeoutSec?: number })`：透传 `options?.timeoutSec`
- Produces (`plugins/home-connect/src/tools-home.ts`):
  - `const AGY_ASYNC_ENABLED = process.env.HOME_CONNECT_AGY_ASYNC === "1"`（仅在 AGY `mcp_config.json` 注入，不影响 Qwen / Pi / `server-http.ts` 宿主模式）
  - `AGY_ASYNC_ENABLED` 为真时，`HOME_TOOLS` 额外暴露：
    - `home_exec_bg`（复用 `execRemote`，独立 `timeoutSec` 校验：`undefined` 或 `0` → `0` 不限时，正有限数直接透传不封顶 1800，负数/NaN 报错）
    - `home_copy_bg`（复用 `acquireCopy()`/`releaseCopy()` 与 `copyFile`/`copyBatchWindows`，固定传 `{ timeoutSec: 0 }`）
  - `HOME_INSTRUCTIONS`：仅当 `AGY_ASYNC_ENABLED` 为真时追加一行短命令用 `home_exec`、长命令/大传输用 `home_exec_bg`/`home_copy_bg` 的说明；关闭时与原版一字不差（保护 `server-http.ts` 与 Qwen/Pi）。
- Produces (`plugins/home-connect/mcp_config.json`):
  - `home`：`"timeoutSeconds": -1`、`"env": { "HOME_CONNECT_AGY_ASYNC": "1" }`、`"tools": { "home_exec_bg": { "background": "always" }, "home_copy_bg": { "background": "always" } }`
  - `comfyui`：`"timeoutSeconds": -1`、`"tools": { "comfyui_generate": { "background": "always" } }`

- [ ] **Step 1: 编写失败测试 `tests/test_home_connect_async.mjs` 与更新 `tests/test_agy_sync.py`**

`tests/test_home_connect_async.mjs` 断言：
- `test_home_connect_hides_bg_tools_and_keeps_instructions_clean_without_agy_flag`：未设 `HOME_CONNECT_AGY_ASYNC` 时 `tools/list` 精确为原 5 个工具，`initialize.instructions` 不含 `home_exec_bg` / `home_copy_bg`，调用 `home_exec_bg` 与 `home_copy_bg` 均返回 `isError: true`。
- `test_home_connect_exposes_bg_tools_with_agy_flag_and_validates_args`：设 `HOME_CONNECT_AGY_ASYNC=1` 时 `tools/list` 含 `home_exec_bg`（`timeoutSec` schema `minimum: 0` 无 `maximum: 1800`）与 `home_copy_bg`；`home_exec_bg` 传负数 `timeoutSec` 或空 `command`、`home_copy_bg` 传非法参数均返回 `isError: true`。
- `test_connection_settle_zero_timeout_and_reset`（直接导入 `runLocal` / `resetHomeConnect`）：验证 `timeoutSec = 0` 下运行 >1.2s 的本机 sleep 命令不会在 1s 被误杀，且能正常返回或被 `resetHomeConnect()` 终止。

`tests/test_agy_sync.py` 新增 `test_agy_mcp_configs_declare_async_background_settings`：
- 验证 `plugins/pi-worker/mcp_config.json`：`timeoutSeconds == -1`、`env["PI_WORKER_AGY"] == "1"`、`tools["pi_worker_start"]["background"] == "always"`、`tools["pi_worker_reply"]["background"] == "always"`；
- 验证 `plugins/home-connect/mcp_config.json`：`home` 与 `comfyui` 的 `timeoutSeconds == -1`、`env` 与 `tools.*.background == "always"`；
- 显式断言 `plugins/pi-worker/mcp.json` 与 `plugins/home-connect/mcp.json` **不包含** `timeoutSeconds`、`tools`、`PI_WORKER_AGY`、`HOME_CONNECT_AGY_ASYNC`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/test_home_connect_async.mjs && python3 -m unittest tests/test_agy_sync.py`
Expected: FAIL。

- [ ] **Step 3: 实现 `connection.ts`、`tools-home.ts`、`mcp_config.json` 与更新 3 个 skill 文档**

- `plugins/home-connect/skills/home-connect/SKILL.md`、`skills/comfyui/SKILL.md`、`skills/comfyui-download/SKILL.md` 补充说明时明确标注「在 Antigravity 下若暴露 `home_exec_bg` / `home_copy_bg` 则长任务优先选用，其他环境沿用 `home_exec` / `home_copy`」。

- [ ] **Step 4: 运行全量回归测试确认通过**

Run: `node --test tests/test_pi_worker_*.mjs tests/test_home_connect_async.mjs && python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: PASS（全部 Node 与 Python 测试全绿，退出码 0）。

- [ ] **Step 5: 提交 Task 4**

```bash
GIT_BIN="$(command -v git1 || echo git)"
"$GIT_BIN" add plugins/home-connect/src/connection.ts plugins/home-connect/src/tools-home.ts plugins/home-connect/mcp_config.json plugins/home-connect/skills/home-connect/SKILL.md plugins/home-connect/skills/comfyui/SKILL.md plugins/home-connect/skills/comfyui-download/SKILL.md tests/test_home_connect_async.mjs tests/test_agy_sync.py
"$GIT_BIN" commit -m "feat(home-connect): 增加 AGY 后台双入口与无超时配置"
```

---

## Independent Plan Review

- **Reviewer**：fresh 只读 `research` 子代理（`pro` 档位），2026-11-25；对照仓内 `plugins/pi-worker/`、`plugins/home-connect/`、`tests/test_agy_sync.py` 与内置 `mcp-app-development/SKILL.md` 核验。
- **Critical（5 项，全部已合入）**：
  - **C1**：跨进程 `finalize()` 2s `git status` 期间 `store.load()` 误判 `orphan_process` → Task 1 升级 `store.ts` `reconcileIfNeeded()` 检查 `cwd` 锁的 `ownerPid` 存活状态后再决定是否校正孤儿。
  - **C2**：增量读日志遇到单行 > `maxBytes` 时 livelock 及 `maxEvents` 丢事件 → Task 2 改为消费精简 `events.jsonl` 并在 `readFormattedEventsDelta` 显式处理超长行跳过与按 `maxEvents` 对齐 `\n` 字节边界。
  - **C3**：`home_exec_bg` 复用 `[1, 1800]` clamp 导致 `timeoutSec: 0` 被截断为 1s → Task 4 为 `home_exec_bg` 提供独立 `timeoutSec` schema（`minimum: 0`，无 1800 上限）与校验。
  - **C4**：无条件改写 `HOME_INSTRUCTIONS` / `INSTRUCTIONS` 污染 Qwen/Pi/HTTP 宿主模式 → Task 1 与 Task 4 全部按 `PI_WORKER_AGY=1` / `HOME_CONNECT_AGY_ASYNC=1` 条件拼接。
  - **C5**：`gitChanges` 原始 `git status --short` 行直接拼 `file://` URI 失败 → Task 3 抽出独立可测的 `parseGitStatusFileUri`（剥 `XY `、处理重命名与 URL 编码）。
- **Suggestion & Minor（11 项，全部已合入）**：
  - `pi_worker_monitor` 的 `content[0].text` 仅放紧凑摘要不注入大段流（S1）；结合用户决议取消 `pi_worker_wait` 改为 AGY 下 `start`/`reply` 直接 `background: "always"` + 监听 `notifications/cancelled` 联动清理（S2）；`copyFile` 全分支含 `HOST_MODE` 透传 `options?.timeoutSec`（S3）；仅 `pi_worker_monitor` 挂 `aux_pane`/`global` entrypoints 避免聊天流多余 inline iframe，并更新 `comfyui-download/SKILL.md` 且加 AGY 限定说明（S4）；`ui-src/package.json` 明确包含 `zod` 并规定 `requestEpoch`/防旧响应覆写/`hasMore` 追赶逻辑（S5）；Task 4 补齐 `timeoutSec=0`、`home_copy_bg` 开关、`INSTRUCTIONS` 隔离与 `mcp.json` 纯净度断言（S6）；基线去超时改动拆为 Task 0 独立 commit、`git1`/`git` 回退、`pi_worker_reply` 补完整 `thinking` enum、`resources/read` 走 `import.meta.dirname` 并受嵌套防护、`launchRound` 先拿锁再删旧 `outcomePath`（M1–M5）。
- **Unresolved / Deferred**：无。
