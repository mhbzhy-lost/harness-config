# pi-worker 真机端到端测试计划（覆盖 `needs_input` 挂起与恢复续跑）

日期：2026-11-24

## 1. 测试目标

在真实本机环境（真实 `pi` 可执行文件 + 真实 LLM 模型 + 真实 `pi-worker` stdio MCP Server）下，端到端验证以下核心契约：

1. **跨 Harness 同步与加载**：`init-agy.sh` / `init-qwen.sh` / `init-pi.sh` 正确建立 `pi-worker` 插件软链，MCP Server 正常响应 `initialize` 与 5 个 `pi_worker_*` 工具。
2. **实时流可观测性**：`--mode json` 运行期间 `pi_worker_status` 能观测到 `turnCount`、`lastTool` 与 `recentEvents`。
3. **确定性 `needs_input` 挂起**：子 Pi 遇到未决歧义调用 `worker_ask_parent` 写入 outcome 并通过 `terminate: true` 干净退出（`exitCode === 0`、无多余第 2 轮、无伪 `aborted` 记录、不提前改脏仓库、释放 `cwd` 锁）。
4. **同 Session 恢复续跑（Suspend-Resume）**：通过 `pi_worker_reply` 沿同一 `--session-dir` + `--session-id` 续跑，复用同一个 `0600` 权限 `.jsonl` session 文件并继续推进到 `status: "done"`，产出的代码变更与单测经宿主机独立运行全绿。
5. **二级接球体验（手工演练）**：主会话 Agent（AGY / Qwen）收到 `needs_input` 时，对主会话已有约定的问题直接秒答续跑（命中前缀缓存），对真正需要人类拍板的歧义转问用户后再续跑。
6. **对交互式 Pi TTY 零干涉**：平时直接运行 `pi` / `pi -c` 不加载 `worker-ext.ts`，且 `~/.pi/agent/sessions/` 不被委派任务污染。

---

## 2. 前置条件

1. 确认本机 `pi` 已配置可用模型或完成 `/login`：
   ```bash
   /opt/homebrew/bin/pi --list-models
   ```
   期望输出至少一个可用模型（不报 `No models available`）。
2. 同步本仓插件链接（按实际使用的 Harness 执行）：
   ```bash
   ./init-agy.sh
   ./init-qwen.sh
   ./init-pi.sh
   ```

---

## 3. 验收流程 A：自动化真机 E2E 脚本

运行仓内自带的真机验证脚本（操作全部隔离在临时目录，绿灯后自动清理）：

```bash
node plugins/pi-worker/scripts/live-e2e.mjs
```

### 脚本执行阶段与硬性断言

| 阶段 | 执行动作 | 必过断言 |
|---|---|---|
| **Stage 0：环境准备** | 在临时目录初始化 Git 仓库（`src/greet.mjs`、`test.mjs`）与隔离 `PI_WORKER_STATE_DIR`，启动真实 `plugins/pi-worker/src/server.ts` | `initialize` 返回 `serverInfo.name === "pi-worker"`；`tools/list` 精确暴露 5 个 `pi_worker_*` 工具 |
| **Stage 1：挂起（`needs_input`）** | 调 `pi_worker_start` 要求新增 `formatUser(name)` 并补单测，刻意留“方案 A（全大写）vs 方案 B（全小写）”未决歧义并禁止自猜；循环 `pi_worker_status(waitSeconds: 15)` 观测进度 | `status === "needs_input"`、`exitCode === 0`、`question` 非空、`gitChanges === []`；`<stateDir>/sessions/` 下仅 1 个 `0600` `.jsonl` 文件且 `abortedCount === 0` |
| **Stage 2：恢复续跑（`reply` → `done`）** | 调 `pi_worker_reply` 明确选定方案 A 并要求写实现、补单测、跑 `node --test test.mjs` 后调 `worker_finish`；循环 `pi_worker_status` 等待终态 | `status === "done"`、`roundCount === 2`、`exitCode === 0`、`question === null`、`gitChanges` 含 `src/greet.mjs` 与 `test.mjs`；复用**同一个** `.jsonl` 文件且行数增加、`abortedCount === 0` |
| **Stage 3：宿主机独立核验** | 宿主机直接执行 `node --test test.mjs` 并动态导入 `src/greet.mjs` | 测试全绿且 `formatUser("alice") === "Hello, ALICE!"` |

失败时会保留临时目录路径（含 `logs/<taskId>.jsonl`、`tasks/<taskId>.json`、`outcomes/<taskId>.json` 与 `sessions/*.jsonl`）供排障。

---

## 4. 验收流程 B：真实 AGY / Qwen 会话手工演练（二级接球）

1. 在临时目录创建一个极简项目：
   ```bash
   mkdir -p /tmp/pi-worker-manual-demo/src && cd /tmp/pi-worker-manual-demo && git init -q
   ```
2. 重启并打开新的 AGY 或 Qwen 会话，输入以下测试指令：
   > 下面我们约定本项目的错误处理统一用自定义 `AppError` 类，但日志输出格式（JSON 还是纯文本）还没定。请使用 `pi-worker` 委派任务到 `/tmp/pi-worker-manual-demo`：给项目写一个配置解析器模块与 `node:test` 单测并跑通。**派单时故意不要把错误处理约定写进 prompt**，同时要求子任务遇到未写明的错误处理方式或日志格式时调用 `worker_ask_parent` 提问。

### 人工验收勾选表

- [ ] 主 Agent 正确使用 `pi_worker_start` 派单且委派期间未并发改写该目录文件；
- [ ] 子 Pi 挂起返回 `needs_input` 询问错误处理方式时，**主 Agent 直接依据对话约定（`AppError`）通过 `pi_worker_reply` 秒答续跑**，未打扰用户；
- [ ] 子 Pi 挂起返回 `needs_input` 询问日志格式时，主 Agent 转问用户，拿到答复后再通过 `pi_worker_reply` 续跑；
- [ ] 最终任务返回 `status: "done"`，主 Agent 核验 `gitChanges` 与测试输出后统一回复；
- [ ] 单独在终端运行 `pi`（TUI 模式）与 `pi -c`：界面与 `bash_async` / `ask_user_question` 均不受 `worker-ext.ts` 影响，且 `pi -c` 不会误切到委派任务会话。
