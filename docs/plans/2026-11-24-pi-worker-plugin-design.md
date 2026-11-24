# pi-worker 跨 Harness 独立长任务插件设计

日期：2026-11-24

## 1. 背景与目标

在复杂项目开发中，不同 Coding Harness 的能力存在互补：
- **主会话 Harness（如 AGY / Qwen Code / Claude Code）**：擅长人机交互对齐、快速只读探索、平台工具链调用与独立代码审查，但部分 Harness（如 AGY）未开放“发请求前改写历史消息”的扩展钩子，无法实现像 Pi / OpenCode DCP 那样不破坏前缀缓存的**尾部局部压缩**。
- **Pi（本仓自定义 `@earendil-works/pi-coding-agent`）**：已在本仓配齐尾部 DCP `compress`、`cacheWarming: streaming`、`endpoint-fallback`、`network-recovery` 等长程执行能力，并且原生支持通过 `-e <path>` 挂载 TypeScript 扩展对运行时行为做确定性定制。

本插件（`plugins/pi-worker/`）将自定义 Pi 封装为一个 **Harness 无关的 Agent Plugins 1.0.0 + AGY 兼容 MCP 插件**，把“主会话委派独立长任务 → Pi 内部带尾部压缩执行 → 遇到歧义调用强 Schema 工具挂起退出 → 主会话自答或转问人类后按同一 Session 续跑 → 完工交付核验”的模式沉淀为跨运行时复用的标准能力。

## 2. 事前实机调研结论（Pi v0.80.6 与仓内扩展源码核实）

以下结论基于本机安装的 `@earendil-works/pi-coding-agent@0.80.6`（`~/.local/share/pitty/node_modules/@earendil-works/pi-coding-agent/dist/`）及本仓 `pi/` 扩展源码核实：

1. **为什么保留 `--mode json` 而不是 `--mode text`**：
   - `dist/modes/print-mode.js:301-317` 仅在整轮结束后输出最终文本，长任务运行 5–20 分钟期间 `--mode text` 完全黑盒；
   - `--mode json` 实时吐出 `tool_execution_start/end`、`turn_end`、`session_compact` 等事件，`pi_worker_status` 可持续汇报当前轮数、工具与活跃时间，且天然隔离启动期非 JSON 日志杂行。
2. **用 `-e src/worker-ext.ts` 替代易碎的文本标签协议并收口 `json` 模式退出码**：
   - `dist/modes/print-mode.js` 仅在 `text` 分支里对 `stopReason === "error" | "aborted"` 置 `exitCode = 1`，而 `dist/main.js:694-696` 采用 `if (exitCode !== 0) process.exitCode = exitCode; return;`——因此扩展在 `agent_end` 里设置 `process.exitCode = 1` 不会被覆写，能干净修复 `--mode json` 报错返回 0 的问题；
   - `dist/core/agent-session.js:1874-1884`：`print-mode` 未绑定 `shutdownHandler`（`ctx.shutdown()` 为 no-op），但 **`ctx.abort()` 走 `this.abort()` 真实终止循环**；
   - `dist/core/agent-session.js:427-468`：`turn_end` 触发时，当轮 `assistant` 的 `tool_use` 与对应 `tool_result` 均已完成 `message_end` 落盘；因此在扩展工具（`worker_ask_parent` / `worker_report_blocked` / `worker_finish`）写入 outcome JSON 文件并返回 `tool_result` 后，于 `turn_end` 调 `ctx.abort()` 立刻停机，既零多余 LLM 轮次，又保证 session 中 `tool_use` 与 `tool_result` 严格成对（续跑绝不报 400）。
3. **TTY / 交互工具与 TUI-only `bash_async`**：
   - `dist/core/extensions/runner.js` 在无头模式下注入 `noOpUIContext`，UI API 不会阻塞；
   - `pi/GLOBAL.md` 强推 `bash_async`，但 `pi/extensions/bash-async/controller.ts:45` 在 `print`/`json` 下必抛错；
   - `dist/core/sdk.js:133-135`：`--exclude-tools` 基于 `Set.has(name)` 精确匹配（不支持 `*` 通配符），因此派发参数精确排除 `ask_question,ask_user_question,bash_async,bash_async_status`，并在附加提示词中声明无头模式使用同步 `bash`。
4. **Session 物理隔离与续跑**：
   - `dist/main.js:227-268`：`--session <不存在路径>` 会直接 `exit(1)`；而 **`--session-dir <stateDir>/sessions --session-id <uuid>`** 在首次启动自动创建、续跑时按精确 ID 重开原文件，且物理隔离于 `~/.pi/agent/sessions/--<cwd>--`，不与手工 `pi -c` 串台。
5. **Prompt 走 `stdin` 管道传入（写完立即 `stdin.end()`）**：
   - `dist/cli/args.js` 对 `-p` 后的 `-` / `@` 开头位置参数存在误解析风险；`dist/main.js:43-59`（`readPipedStdin`）原生支持从非 TTY 的 piped stdin 读取完整 prompt，彻底避开参数注入与 `ARG_MAX`。
6. **JSONL 分行与真实 `pi` 路径**：
   - 上游 `docs/json.md` 明确禁用 `node:readline`（`\u2028`/`\u2029` 会撕裂 JSON 行），须用 `StringDecoder("utf8")` 严格按 `\n` 切分并静默忽略启动期非 JSON 杂行；
   - 本机真实 `pi` 位于 `~/.local/share/pitty/node_modules/.bin/pi`（不在默认非交互 `PATH` 中）；`resolvePiBinary()` 按 `PI_WORKER_BIN` → `PI_REAL_BIN` → `PATH` 物理 `pi` → `~/.local/share/pitty/node_modules/.bin/pi` 顺序查找，同时检查路径与 `realpathSync` 跳过 `/pi/launcher.zsh`。
   - 上游 `main.ts` 禁止仅有 `--provider` 无 `--model`，入口校验须提前拒绝。

## 3. 核心工作流（Suspend-Resume + Extension 确定性协议）

```text
主 Agent（AGY / Qwen 等）
  │  1. pi_worker_start(cwd, prompt, ...)
  ▼
pi-worker MCP Server（运行在沙箱外，独立管理状态、锁与子进程）
  │  spawn: pi --mode json --print \
  │            --session-dir <stateDir>/sessions --session-id <taskId> \
  │            -e <PLUGIN_ROOT>/src/worker-ext.ts \
  │            --exclude-tools ask_question,ask_user_question,bash_async,bash_async_status \
  │            --append-system-prompt <PROTOCOL_APPEND_PROMPT>
  │  env:    PI_SUBAGENT_CHILD=1, PI_WORKER_DEPTH=1, PI_WORKER_OUTCOME_FILE=<outcome.json>
  │  stdin:  <prompt> (写入后立即 EOF)
  ▼
Pi 子进程（detached 进程组，内部尾部 compress + worker-ext.ts）
  │  - 运行中：--mode json 流式回报 turnCount / lastTool / recentEvents
  │  - 需提问：调 worker_ask_parent({question, options?, summary?})
  │            → 写 outcome(needs_input) → 返回 tool_result → turn_end 调 ctx.abort() 干净退出
  │  - 遇阻塞：调 worker_report_blocked({reason, summary?})
  │            → 写 outcome(blocked) → 返回 tool_result → turn_end 调 ctx.abort() 干净退出
  │  - 完工：调 worker_finish({summary, verifiedCommands?}) 或直接文本结束（agent_end 兜底写 done）
  │  - 模型错：agent_end 检测 stopReason in (error, aborted) → 写 outcome(failed) + process.exitCode = 1
  ▼
MCP Server 读 <outcome.json>（缺失时按流内末条 assistant / exitCode 兜底）+ 采 git status 落盘
  ├─ needs_input ──▶ 主 Agent 自答（秒续跑保缓存）或转问人类 → pi_worker_reply(taskId, answer)
  ├─ done        ──▶ 主 Agent 核验 git diff / 独立 Review → 交付
  └─ blocked/failed ▶ 主 Agent 评估阻塞或接手处理
```

## 4. 核心架构决策

### 4.1 零第三方依赖，纯 Node.js 原生 TypeScript
- 遵循 `plugins/deepseek-search` 惯例：Node.js >= 22.19.0 原生执行 `src/server.ts`，零 npm 依赖，不放插件内 `package.json`（遵守 `import type`、相对导入 `.ts` 后缀、禁用 `enum`/`namespace`/参数属性）。
- `worker-ext.ts` 使用**纯 JSON Schema 对象**定义工具参数（不额外依赖 `typebox` 打包），由子 Pi 经 `-e` 动态加载（不注册到 `pi/settings.json`，对交互式 Pi 零侵入），同时可在纯 Node 单测中直接 mock `ExtensionAPI` 全覆盖验证。
- 插件根目录同时提供 `plugin.json`、`mcp.json`、`mcp_config.json` 与 `skills/pi-worker/SKILL.md`。

### 4.2 工具面设计（5 个异步原语）
`start` / `reply` / `status` 统一返回扁平 `TaskRecord` 视图，`list` 返回精简 `TaskSummary[]`：

| 工具名 | 职责 | 关键入参 | 返回值 |
|---|---|---|---|
| `pi_worker_start` | 启动新长任务，分配 UUID `taskId` 与独立 `outcomeFile` | `cwd`（必填绝对路径）, `prompt`（必填）, `model?`, `provider?`（需配 `model`）, `thinking?`, `timeoutSeconds?`（默认 1800，范围 1–7200）, `excludeTools?`（始终与默认禁用列表合并）, `waitSeconds?`（0–30，默认 0） | `TaskRecord` |
| `pi_worker_reply` | 向 `needs_input` / `done` / `blocked` 任务发送回复并按同一 `--session-id` 续跑（启动前清零上一轮结果字段与旧 `outcomeFile`） | `taskId`（必填）, `reply`（必填）, `timeoutSeconds?`（1–7200）, `waitSeconds?`（0–30，默认 0） | `TaskRecord` |
| `pi_worker_status` | 查询实时进度、挂起问题或终态；支持短长轮询 | `taskId`（必填）, `waitSeconds?`（0–30，默认 0） | `TaskRecord` |
| `pi_worker_cancel` | `running` 时按进程组 `-pid` 优雅终止（`SIGTERM` → 3s → `SIGKILL`）；`needs_input` 时直接置 `cancelled`；已终态（`done`/`failed`/`cancelled`）保持原终态并返回 `wasRunning: false` | `taskId`（必填） | `{ task: TaskRecord, wasRunning: boolean }` |
| `pi_worker_list` | 列出精简任务摘要 | `status?`, `cwd?`, `limit?`（默认 20，上限 100） | `{ tasks: TaskSummary[] }` |

### 4.3 `worker-ext.ts` 扩展行为规范
仅在 `PI_WORKER_OUTCOME_FILE` 环境变量存在时激活（避免被误加载到普通会话）：
1. 注册 3 个确定性工具（纯 JSON Schema）：
   - `worker_ask_parent({ question: string, options?: string[], summary?: string })`：原子写入 `{ status: "needs_input", question, options, summary }`，标记 `terminalWritten = true` 与 `abortOnTurnEnd = true`，返回简短 `tool_result`。
   - `worker_report_blocked({ reason: string, summary?: string })`：原子写入 `{ status: "blocked", summary: summary ?? reason, error: reason }`，标记 `terminalWritten = true` 与 `abortOnTurnEnd = true`，返回简短 `tool_result`。
   - `worker_finish({ summary: string, verifiedCommands?: string[] })`：原子写入 `{ status: "done", summary, verifiedCommands }`，标记 `terminalWritten = true` 与 `abortOnTurnEnd = true`，返回简短 `tool_result`。
2. 钩子协同：
   - `turn_end`：若 `abortOnTurnEnd === true`，调用 `ctx.abort()` 立即停止后续 LLM 轮次（此时 `tool_use` + `tool_result` 已成对落入 session）。
   - `agent_end`：若 `terminalWritten === true`，保持 `process.exitCode = 0` 直接结束；否则检查 `event.messages` 末条 `role === "assistant"` 消息：
     - 若 `stopReason === "error" || stopReason === "aborted"` → 写入 `{ status: "failed", stopReason, error: errorMessage || stopReason }` 并设置 **`process.exitCode = 1`**；
     - 否则 → 写入 `{ status: "done", summary: truncateTail(assistantText, 4000), stopReason, verifiedCommands: [] }`。
3. 前缀缓存保护：`start` 与 `reply` 传入字节完全一致的静态 `--append-system-prompt`，指引 Pi 无头模式使用同步 `bash`、在提问或阶段闭合前优先执行尾部 `compress`、遇到歧义调用 `worker_ask_parent`、遇外部阻塞调用 `worker_report_blocked`、完成验证后调用 `worker_finish`。

### 4.4 安全、并发与生命周期边界
1. **多层防递归套娃**：
   - 拉起子进程时注入 `PI_SUBAGENT_CHILD=1`、`PI_WORKER_DEPTH=String(depth + 1)`，显式清除 `PI_SESSION_OWNER_ID`；
   - `server.ts` 检测到 `PI_WORKER_DEPTH >= 1 || PI_SUBAGENT_CHILD === "1"` 时，`tools/list` 返回空数组且 `callTool` 对**全部 5 个工具**直接拒绝；`runner.ts` 同样在 `start`/`reply` 拒绝；
   - `SKILL.md` 声明禁止在顶层交互式 Pi 会话内调用 `pi-worker`。
2. **跨进程单写手互斥锁**：规范化 `cwd` 后在 `<stateDir>/locks/<sha256(cwd)>.lock` 使用 `O_CREAT | O_EXCL`（`0600`）排他锁，死 PID 自动回收并校正旧任务为 `failed`（`orphan_process`）。
3. **无竞态终结与进程组清理**：
   - `detached: true` 按进程组 `-pid` 清理；绑定 `child.on("error")` 与 `child.stdin.on("error")`；
   - 终结挂在 `close` 事件，开头立即 `clearTimeout` 并保持 `taskId` 在内存 `inFlight` 集合中直至读取 `outcomeFile` + `git status --short` 完成并原子落盘、释放锁，彻底消除 `orphan_process` 竞态；
   - `server.ts` 监听 `SIGINT` / `SIGTERM` / `stdin end` 单例 `await runner.shutdown()` 后退出。
4. **私有权限与体积上限**：状态目录及 `tasks/`、`sessions/`、`logs/`、`locks/`、`outcomes/` 均为 `0700`，数据/锁/日志/outcome 文件 `0600`（session jsonl 退出后补 `0600`）；日志用 `createWriteStream` 异步写流；`recentEvents`（最多 10 条）单条文本截断 500 字符；绝不打印凭据。

## 5. 适用边界（写入 `SKILL.md`）

- **何时委派**：规格与约束清晰、有可执行验收命令、预计 15–50 轮多步骤编辑试错的长程独立任务。
- **何时不要委派**：1–5 轮定向小改动（主会话直做）；纯调研/单测日志/Diff 文档（用 `flash`/`fast` 子代理）；需高频人机协同改方向的探索开发（直接开 Pi 交互窗口）；当前已在 Pi 会话内部（禁止自嵌套）。

## 6. 验证策略

- Node.js 原生 `node:test` + `node:assert/strict`：
  1. `tests/test_pi_worker_protocol.mjs`：Outcome 文件读写校验、`StringDecoder` 分行器（含 `\u2028`/`\u2029`）、Pi JSONL 事件流抽取与角色过滤、非 JSON 启动杂行忽略、500 字符截断；
  2. `tests/test_pi_worker_ext.mjs`：直接加载 `src/worker-ext.ts` 注入 mock `ExtensionAPI` 与 `ctx`，单元测试 `worker_ask_parent` / `worker_report_blocked` / `worker_finish` 写入 `PI_WORKER_OUTCOME_FILE` + `turn_end` 触发 `ctx.abort()` + `agent_end` 对 `stopReason: "error"/"aborted"` 置 `process.exitCode = 1` 与正常文本兜底写 `done`；
  3. `tests/test_pi_worker_store.mjs`：`0700`/`0600` 权限、原子写、跨进程 `cwd` 锁与死 PID 回收、`inFlight` 防误杀；
  4. `tests/test_pi_worker_runner.mjs`：通过 `fake-pi` 脚本（按环境变量写 `PI_WORKER_OUTCOME_FILE` 与输出真实 JSONL 流）端到端测试 stdin 传 `-`/`@` prompt → `needs_input` → 同 `--session-dir`/`--session-id` `reply` → `done`、`outcomeFile` 缺失时流兜底 + `stopReason: "error"` 即使 exit 0 仍判 `failed`、`-e worker-ext.ts` 参数与 `--exclude-tools` 合并、`cancel`、`timeout`、递归阻断、同 `cwd` 并发锁、软链跳过 `launcher.zsh`；
  5. `tests/test_pi_worker_mcp.mjs`：stdio JSON-RPC 端到端闭环、递归环境空工具集与全拒、校验错误返回 `isError: true`、`stdin end` 优雅清理子进程。
- 全量 Python 回归套件 `python3 -m unittest discover -s tests -p 'test_*.py'`。
