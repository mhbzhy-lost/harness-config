---
name: pi-worker
description: Use when delegating routed subagent tasks (broad exploration, test/build log compression, noisy retrieval/diff drafting, independent code review) or self-contained multi-step coding tasks to an isolated local Pi worker with abstract model tiers (fast/default/heavy), readOnly concurrency, tail context compression, and suspend-resume Q&A. Do NOT use inside a Pi session itself or for 1-2 step localized reads/edits.
---

# pi-worker：跨 Harness 子代理与独立长任务工作器

通过 MCP 将本地自定义 Pi 封装为可异步执行、支持抽象档位映射、只读并发、内部尾部 DCP 压缩与挂起提问续跑（Suspend-Resume）的独立执行器，统一承接路由表子代理任务与长程编码任务，不污染主会话上下文。

## 何时使用 vs 何时不要使用

- **适用场景**：
  1. **只读子代理任务（`readOnly: true`，支持同 `cwd` 并发 2–4 路）**：
     - 跨目录广泛探索、调用链调查、仓库调研 → `tier: "fast"` + `readOnly: true`；
     - 常规测试、构建、lint、类型检查与报错日志压缩 → `tier: "fast"` + `readOnly: true`；
     - 多源网络调研/查外部技术文档、重噪声外部检索/长文档与大 JSON 抽取、Git 历史考古、基于最终 Diff 生成 PR/文档初稿 → `tier: "fast"` + `readOnly: true`；
     - 独立代码审查（只读审查） → `tier: "heavy"` + `readOnly: true`。
  2. **多步编码 / 长程任务（默认 `readOnly: false`，同 `cwd` 独占写锁）**：
     - 规格与红线清晰、具备可执行验收命令、预计多轮编辑与试错闭环 → `tier: "default"`（或按复杂度传 `heavy`）。
- **不要使用**：
  - 1–2 步就能直达的定向文件读写或极小改动 → 主会话直接完成；
  - 需求高度模糊、需要和人类边聊边改方向的探索开发 → 直接打开 Pi 交互式 TUI 窗口；
  - 用户显式指定其他原生 subagent（如 `browser`）时按用户指定执行；
  - **当前已经处在 Pi 会话内部 → 严禁自我委派嵌套**。

## MCP 工具

- `pi_worker_start(cwd, prompt, parentSessionId?, tier?, readOnly?, model?, provider?, thinking?, excludeTools?, waitSeconds?)`：在独立隔离 Session 启动任务（不设总墙钟超时）。
  - `parentSessionId`：父会话标识（如宿主的对话/会话 ID；缺省时回退 `PI_WORKER_PARENT_SESSION_ID` 环境变量），用于公有核心层的父会话分组与作用域过滤。凡宿主上下文提供会话 ID 时，派单与打开监控均应透传，避免多项目/多会话任务混杂。
  - `tier`：抽象模型档位 `fast` / `default` / `heavy`（缺省为 `default`），按本机独立配置文件映射到实际模型。
  - `readOnly`：设为 `true` 时机械禁用 `write` / `edit` 工具并追加只读约束，且不占 `cwd` 写锁，允许同工作区多路只读任务并发；默认 `false`（同 `cwd` 独占写锁）。
  - 在 Antigravity 下自动作为后台任务执行并在本轮结束时唤醒主会话；其他 Harness 下立即返回 `taskId`。
- `pi_worker_status(taskId, waitSeconds?)`：查看实时进度（`turnCount`/`lastTool`/`lastActivityAt`/`recentEvents`）、挂起问题或最终摘要与 `gitChanges`；非 Antigravity 环境下可传 `waitSeconds: 0–30` 短等。
- `pi_worker_reply(taskId, reply, tier?, model?, provider?, thinking?, waitSeconds?)`：向非运行中的任务（`needs_input`/`done`/`blocked`/`failed`/`cancelled`）发送回复沿原隔离 Session 续跑，支持按需切换 `tier` 或覆盖模型与思考档位；在 Antigravity 下同样作为后台任务异步唤醒。
- `pi_worker_cancel(taskId)`：优雅取消运行中或挂起的任务。
- `pi_worker_list(status?, cwd?, parentSessionId?, limit?)`：列出任务摘要及按父会话聚合的 `groups`（未标记 `parentSessionId` 的旧任务按 `cwd` 回退归组）。
- `pi_worker_monitor(taskId?, parentSessionId?, cwd?)`（仅 AGY 模式）：打开右侧实时进度监控面板，传入 `parentSessionId`/`cwd` 时默认锁定到对应父会话/项目作用域。

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

1. **读写期间冻结同工作区写入**：非 `readOnly` 任务运行期间，主会话严禁同时修改同一 `cwd` 的文件；`readOnly: true` 任务允许同 `cwd` 并行 2–4 路。
2. **收到 `status: "needs_input"` 时二级接球**：
   - 先检查主会话上下文是否已有明确答案（如用户早前拍板的取舍）；**能自答就直接 `pi_worker_reply` 秒答续跑**（在几分钟内续跑可命中 Pi 的前缀缓存，省成本且不打扰用户）；
   - 若确实属于需要人类拍板的产品/架构歧义，向用户简明呈现 `question` 与 `options`，拿到答复后再 `pi_worker_reply` 续跑。
3. **收到 `status: "done"` 后核验交付**：主会话必须按上方“磁盘证据核验”核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 与关键 `file:line`，必要时再以 `tier: "heavy"` + `readOnly: true` 对最终 diff 发起独立代码审查。
4. **收到 `status: "blocked"` 或 `"failed"`**：先查看 `error`、`stopReason`、`executedCommands` 与 `eventsPath`，补充条件（或按需在 `pi_worker_reply` 切换 `tier`/模型）后续跑，或改由主会话接手处理。
