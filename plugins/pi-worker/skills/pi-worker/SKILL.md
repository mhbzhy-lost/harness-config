---
name: pi-worker
description: Use when delegating routed subagent tasks (broad exploration, test/build log compression, noisy retrieval/diff drafting, independent code review) or multi-file / multi-step coding tasks to an isolated local Pi subagent with abstract model tiers (fast/default/heavy), readOnly concurrency, worktree-based write parallelism, tail context compression, and suspend-resume Q&A. Do NOT use inside a Pi session itself or for 1-3 file localized direct edits.
---

# pi-worker：跨 Harness 通用子代理

通过 MCP 将本地自定义 Pi 封装为可异步执行、支持抽象档位映射、只读并发、内部尾部 DCP 压缩与挂起提问续跑（Suspend-Resume）的跨 Harness 通用子代理，统一承接探索、验证、审查与多步编码任务，不污染主会话上下文。

## 子进程加载约束（严格白名单）

worker 子进程始终以 `--no-extensions` + `--no-context-files` 启动，只显式注入白名单资源，与本机交互式 Pi 配置解耦：

- **扩展**：仅 `-e` 注入内置 `builtin:mcp` / `builtin:codemode` / `builtin:tool-search`、`pi/settings.json` 锁版的 `pi-dcp` 包、仓内受管扩展（`agent-plugins`、`bash-cwd`、`endpoint-fallback`、`network-recovery`、`cliproxyapi`、`security-gates`、`tool-timing`）与 `worker-ext.ts`；`builtin:llama.cpp`、`ask-user-question`、`bash-async`、`compact-tools`、`session-owner`、`tui-lite`、`pi-core-ask`、`pi-subagents` 等交互式/TUI/子代理扩展一律不加载（`--exclude-tools` 作为纵深防御继续屏蔽 `ask_question` / `bash_async` 等）。
- **上下文文件**：跳过 Pi 原生 `AGENTS.md` / `CLAUDE.md` 发现，由 `discoverProjectContextFiles` 仅收集目标项目自身的上下文文件（git 根 → `cwd` 每层，`AGENTS.md` 优先于 `CLAUDE.md`；非 git 目录仅 `cwd` 自身），再以 `--append-system-prompt <path>` 按序注入；`~/.pi/agent/AGENTS.md`（即 `pi/GLOBAL.md`）**绝不加载**，worker 适用的通用偏好（`fd`/`rg`/`apply_patch`、中文回复、不改无关代码）已内置于 `PROTOCOL_APPEND_PROMPT`。

## 何时使用 vs 何时不要使用

- **适用场景**：
  1. **只读子代理任务（`readOnly: true`，支持同 `cwd` 并发 2–4 路）**：
     - 跨目录广泛探索、调用链调查、仓库调研 → `tier: "fast"` + `readOnly: true`；
     - 常规测试、构建、lint、类型检查与报错日志压缩 → `tier: "fast"` + `readOnly: true`；
     - 多源网络调研/查外部技术文档、重噪声外部检索/长文档与大 JSON 抽取、Git 历史考古、基于最终 Diff 生成 PR/文档初稿 → `tier: "fast"` + `readOnly: true`；
     - 独立代码审查（只读审查） → `tier: "heavy"` + `readOnly: true`。
  2. **多步编码与大范围实现任务（默认 `readOnly: false`，同 `cwd` 独占写锁；跨独立 `git worktree` 支持真并发）**：
     - **无明确计划（未走 `writing-plans`）**：超出 1–3 个文件小范围定向修改的跨多文件实现、大文件重构、批量迁移或预计多轮改测闭环 → 默认直接委派 `tier: "default"`（复杂任务可传 `heavy`），不得因已拿到 `file:line` 锚点就由主会话包揽全部写入；
     - **有明确计划（如 `writing-plans`）**：由用户在 **执行者（`pi-worker` vs `Native`）× 模式（`串行` vs `并发`）** 中选择；选 `pi-worker + 并发` 时，由主代理为无文件重叠的独立任务组分别创建 `git worktree` 并将各自 worktree 路径作为 `cwd` 并发派发，逐路验收后再合并并清理 worktree。
- **不要使用**：
  - 1–3 个文件、已有明确锚点且无需多轮改测试错的小范围定向修改或局部集成收口 → 主会话直接完成；
  - 需求高度模糊、需要和人类边聊边改方向的探索开发 → 先澄清需求，或直接打开 Pi 交互式 TUI 窗口；
  - 用户显式指定其他原生 subagent（如 `browser`）时按用户指定执行；
  - **当前已经处在 Pi 会话内部 → 严禁自我委派嵌套**。

## MCP 工具

- `pi_worker_start(cwd, prompt, parentSessionId?, title?, parentSessionTitle?, tier?, readOnly?, model?, provider?, thinking?, excludeTools?, waitSeconds?)`：在独立隔离 Session 启动任务（不设总墙钟超时）。
  - `parentSessionId`：父会话标识（如宿主的对话/会话 ID；缺省时回退 `PI_WORKER_PARENT_SESSION_ID` 环境变量），用于公有核心层的父会话分组与作用域过滤。凡宿主上下文提供会话 ID 时，派单与打开监控均应透传，避免多项目/多会话任务混杂。
  - `title` / `parentSessionTitle`：任务与父会话的简短可读标题（清洗并截断到 48 字），供监控面板下拉与分组展示。建议派单时传入简短 `title`；未传时自动从 `prompt` 首条有意义文本行提取。AGY 下 `parentSessionTitle` 由 PreToolUse hook 自动注入（ConversationService 优先，降级取最近用户输入），显式传入则原样保留。
  - `tier`：抽象模型档位 `fast` / `default` / `heavy`（缺省为 `default`），按本机独立配置文件映射到实际模型。
  - `readOnly`：设为 `true` 时机械禁用 `write` / `edit` 工具并追加只读约束，且不占 `cwd` 写锁，允许同工作区多路只读任务并发；默认 `false`（同 `cwd` 独占写锁）。
  - 在 Antigravity 下自动作为后台任务执行并在本轮结束时唤醒主会话；其他 Harness 下立即返回 `taskId`。
- `pi_worker_status(taskId, waitSeconds?)`：查看实时进度（`turnCount`/`lastTool`/`lastActivityAt`/`recentEvents`）、挂起问题或最终摘要与 `gitChanges`；非 Antigravity 环境下可传 `waitSeconds: 0–30` 短等。
- `pi_worker_reply(taskId, reply, tier?, model?, provider?, thinking?, waitSeconds?)`：向非运行中的任务（`needs_input`/`done`/`blocked`/`failed`/`cancelled`）发送回复沿原隔离 Session 续跑，支持按需切换 `tier` 或覆盖模型与思考档位；在 Antigravity 下同样作为后台任务异步唤醒。
- `pi_worker_steer(taskId, message)`：向**运行中**（`status: "running"`）的任务实时插话纠偏：同步入队立即返回（非阻塞），消息在当前 turn 工具执行完、下一次 LLM 请求前注入运行中的 worker，不打断当前工具执行；支持跨进程 steer 其他 MCP server 启动的 detached 任务。仅限运行中任务；非运行态请改用 `pi_worker_reply` 续跑。AGY 监控侧面板底部也提供运行态实时插话输入栏（Enter 发送 / Shift+Enter 换行），插话记录以 🧭 事件展示在时间线中。
- `pi_worker_cancel(taskId)`：优雅取消运行中或挂起的任务。
- `pi_worker_list(status?, cwd?, parentSessionId?, limit?)`：列出任务摘要及按父会话聚合的 `groups`（未标记 `parentSessionId` 的旧任务按 `cwd` 回退归组）。
- `pi_worker_monitor(taskId?, parentSessionId?, parentSessionTitle?, cwd?)`（仅 AGY 模式）：打开右侧实时进度监控面板，传入 `parentSessionId` 时严格锁定到本会话（仅按会话过滤，不叠加 `cwd`，同会话跨 worktree 任务不会漏掉）；仅传 `cwd` 时按项目过滤。AGY 会话首次派发 `pi_worker_start` 时，应同步顺带调用一次本工具（<10ms 同步返回）将当前会话侧面板绑定到本会话 `parentSessionId`。

## 抽象档位与本机模型映射配置（per-machine，不入库）

路由表与调用侧**只使用抽象档位**（`fast` / `default` / `heavy`），不在仓内规则或模板里写死具体模型 ID；抽象档位到实际 `provider` / `model` / `thinking` 的映射统一放在独立本机配置文件中维护：

- **配置文件路径**：`~/.pi/agent/pi-worker/config.json`（受 `PI_WORKER_STATE_DIR` / `PI_CODING_AGENT_DIR` 覆盖，不提交入库；结构模板见 `plugins/pi-worker/config.example.json`）。
- **配置结构示例**：

```json
{
  "default": {
    "provider": "example-provider",
    "model": "example-default-model",
    "thinking": "medium"
  },
  "tiers": {
    "fast": {
      "provider": "example-provider",
      "model": "example-fast-model",
      "thinking": "low"
    },
    "heavy": {
      "provider": "example-provider",
      "model": "example-heavy-model",
      "thinking": "high"
    }
  }
}
```

- **解析优先级**（从高到低）：
  1. **显式入参**：本次 `pi_worker_start` / `pi_worker_reply` 传入的 `provider`、`model`、`thinking`（注意：仅显式传 `model` 而不传 `provider` 时，不会混用下层默认或档位里的 `provider`）；
  2. **抽象档位映射（`tier`）**：按 `PI_WORKER_TIER_<TIER>_{PROVIDER,MODEL,THINKING}` 环境变量覆盖 `config.json` 中对应的 `tiers.<tier>`；
  3. **默认配置（`default`）**：按 `PI_WORKER_DEFAULT_{PROVIDER,MODEL,THINKING}` 环境变量覆盖 `config.json` 中的 `default`（兼容顶层直接写 `provider`/`model`/`thinking` 的扁平写法）；
  4. **Pi 自身默认模型**：以上均未配置时，沿用本机 Pi 默认设置。
- **缺省回退与校验**：
  - 若本机未配置 `tiers.fast` 或 `tiers.heavy`，调用对应 `tier` 时**自动回退到 `default`**（新机器零报错）；若某档位仅配置了 `thinking` 而未配 `model`，则继承 `default` 的模型并应用该档位的思考级别。
  - 任何层级指定了 `provider` 时必须同时指定 `model`；`thinking` 须为合法档位（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。

## 标准派单模板（`prompt` 必须包含 4 要素）

1. **目标与范围**：明确要完成什么、不做什么；
2. **精确文件锚点**：给出相关文件/计划路径，避免子进程盲搜；
3. **硬性约束与红线**：禁止破坏的契约、只读约束、代码风格或提交纪律；
4. **验收命令 / 返回证据要求**：编码任务写明必跑验收命令；只读探索/验证/审查任务写明要求的证据格式（文件行号、真实退出码、失败栈帧等）。

## 磁盘证据核验（跨 Harness 工具边界机制，禁止轻信 Pi 自述）

`summary` 与 `verifiedCommands` 均由 Pi 通过 `worker_finish` 自述填报，存在遗漏失败、弱化 skip 或行号失真风险。该核验机制位于 `pi-worker` 工具边界（所有 Harness 共用，非某个宿主专属）：每次任务进入非运行态时，`pi_worker_start` / `pi_worker_reply` / `pi_worker_status` 均会返回防篡改磁盘证据并在回执中附带核验提醒，主代理向用户汇报结论前必须交叉核验：

1. **机器记录的命令索引（`executedCommands`）**：
   - `TaskRecord.executedCommands` 由 `runner.ts` 直接从 Pi 真实 `tool_execution_start`/`tool_execution_end` 机械提取（含 `{ round, startSeq, endSeq, command, isError, durationMs }`），Pi 无法篡改。先核对其中真实跑过的命令与 `isError`，再对比 `verifiedCommands`。
2. **未截断原始执行轨迹（`eventsPath`）**：
   - 路径在回执 `eventsPath` 中（`~/.pi/agent/pi-worker/logs/<taskId>.events.jsonl`），完整记录每条 `tool_start`（完整参数）与 `tool_end`（未截断完整 stdout/stderr、`isError`、耗时）。
   - 需要查证某次命令真实输出、报错栈帧或探索过程时，直接读取 `eventsPath`（或结合 `executedCommands` 的 `endSeq` 定向检索 / 运行 `node plugins/pi-worker/src/stream.ts <taskId> --json` 抽取对应 `seq`）。
3. **工作区真实文件与 Diff**：
   - **编码任务**：对 `gitChanges` 执行 `git diff` 或直接读取改动文件，确认代码契约与测试真实落地；
   - **验证任务**：以 `executedCommands` 及 `eventsPath` 对应 `tool_end` 的原始退出码与输出为准，不直接照抄 `summary`；
   - **探索 / 代码审查任务**：对 Pi 汇报的核心结论与高风险 finding，按其引用的 `file:line` 直接读取对应源码核实后再向用户定论。

## Suspend-Resume 协作协议

1. **读写隔离与真并发**：非 `readOnly` 任务运行期间，主会话严禁同时修改同一 `cwd` 的文件；`readOnly: true` 任务允许同 `cwd` 并行 2–4 路；多个读写任务需要真并发时，由主会话为无文件重叠的任务组分别建立独立 `git worktree` 并传入各自 worktree 路径作为 `cwd` 并发派发，完成后逐路验收、合并并清理 worktree。
2. **收到 `status: "needs_input"` 时二级接球**：
   - 先检查主会话上下文是否已有明确答案（如用户早前拍板的取舍）；**能自答就直接 `pi_worker_reply` 秒答续跑**（在几分钟内续跑可命中 Pi 的前缀缓存，省成本且不打扰用户）；
   - 若确实属于需要人类拍板的产品/架构歧义，向用户简明呈现 `question` 与 `options`，拿到答复后再 `pi_worker_reply` 续跑。
3. **收到 `status: "done"` 后核验交付**：主会话必须按上方“磁盘证据核验”核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 与关键 `file:line`，必要时再以 `tier: "heavy"` + `readOnly: true` 对最终 diff 发起独立代码审查。
4. **收到 `status: "blocked"` 或 `"failed"`**：先查看 `error`、`stopReason`、`executedCommands` 与 `eventsPath`，补充条件（或按需在 `pi_worker_reply` 切换 `tier`/模型）后续跑，或改由主会话接手处理。
