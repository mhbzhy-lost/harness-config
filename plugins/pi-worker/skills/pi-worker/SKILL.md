---
name: pi-worker
description: Use when delegating a self-contained, multi-step long-running coding task (with clear spec and verifiable test/build commands) to an isolated local Pi worker that supports tail context compression and suspend-resume Q&A. Do NOT use inside a Pi session itself, for small localized edits, or for pure read-only research/log checks.
---

# pi-worker：跨 Harness 独立长任务工作器

通过 MCP 将本地自定义 Pi 封装为可异步执行、可挂起提问续跑（Suspend-Resume）的独立长任务执行器，既保留 Pi 的尾部 DCP 压缩与长程容错能力，又不污染主会话上下文。

## 何时使用 vs 何时不要使用

- **适用场景（须同时满足）**：
  1. 规格、范围与约束红线已经明确（或已落盘为设计/计划文件）；
  2. 具备可执行的硬验收命令（编译、单测、lint、类型检查等）；
  3. 预计需要 15–50 轮编辑与试错闭环，放在主会话里会造成严重上下文膨胀。
- **不要使用**：
  - 1–5 轮就能完成的小改动或明确文件读写 → 主会话直接做；
  - 宽范围只读探索、单纯跑测试日志、Git 历史考古、写 Diff 文档 → 用更轻量的 `flash`/`fast` 只读或验证子代理；
  - 需求模糊、需要和人类频繁边聊边改方向的探索开发 → 直接打开 Pi 交互式 TUI 窗口；
  - **当前已经处在 Pi 会话内部 → 严禁自我委派嵌套**。

## MCP 工具

- `pi_worker_start(cwd, prompt, model?, provider?, thinking?, timeoutSeconds?, excludeTools?, waitSeconds?)`：在独立隔离 Session 启动新长任务（同一 `cwd` 仅允许 1 个运行中任务）。
- `pi_worker_status(taskId, waitSeconds?)`：查看实时进度（`turnCount`/`lastTool`/`recentEvents`）、挂起问题或最终摘要与 `gitChanges`；`waitSeconds` 可设 `0–30` 做短等待，避免高频空轮询。
- `pi_worker_reply(taskId, reply, timeoutSeconds?, waitSeconds?)`：向 `needs_input`（或 `done`/`blocked` 需续做）的任务发送回复，沿原隔离 Session 续跑。
- `pi_worker_cancel(taskId)`：优雅取消运行中或挂起的任务。
- `pi_worker_list(status?, cwd?, limit?)`：列出任务摘要。

## 标准派单模板（`prompt` 必须包含 4 要素）

1. **目标与范围**：明确要完成什么、不做什么；
2. **精确文件锚点**：给出相关文件/计划路径，避免子进程盲搜；
3. **硬性约束与红线**：禁止破坏的契约、兼容要求、代码风格或提交纪律；
4. **验收命令**：收工前必须运行并通过的具体测试/构建命令。

## Suspend-Resume 协作协议

1. **委派期间冻结同工作区写入**：`pi-worker` 运行期间，主会话严禁同时修改同一 `cwd` 的文件。
2. **收到 `status: "needs_input"` 时二级接球**：
   - 先检查主会话上下文是否已有明确答案（如用户早前拍板的取舍）；**能自答就直接 `pi_worker_reply` 秒答续跑**（在几分钟内续跑可命中 Pi 的前缀缓存，省成本且不打扰用户）；
   - 若确实属于需要人类拍板的产品/架构歧义，向用户简明呈现 `question` 与 `options`，拿到答复后再 `pi_worker_reply` 续跑。
3. **收到 `status: "done"` 后核验交付**：主会话核对 `summary`、`verifiedCommands` 与 `gitChanges`，必要时再对最终 diff 发起独立代码审查。
4. **收到 `status: "blocked"` 或 `"failed"`**：先查看 `error`、`stopReason` 与最近事件，补充条件后 `pi_worker_reply` 或改由主会话接手处理。
