---
trigger: always_on
---
# 全局指令

<!-- 由 harness-config 同步（agy/rules/harness-config.md → ~/.gemini/config/rules/harness-config.md），对所有项目生效。 -->
<!-- 在此填写跨项目通用的偏好与约定；项目专属内容写各项目的 AGENTS.md / GEMINI.md。保持短而具体。 -->

## Git Commit 规范

- 格式为 `type(scope): 中文祈使句`，`scope` 可选；type 仅允许英文小写 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`style`、`chore`、`build`、`ci`、`revert`。
- subject 必须包含至少一个中文字符，不超过 50 字，不以 `。` 或 `.` 结尾；以祈使句动词开头（如“增加”“修复”“重构”），不用“已修复”“实现了”“修复了”等过去时。
- 禁止以零信息词单独作为 subject：`fix`、`update`、`bugfix`、`wip`、“修改”、“更新”。subject 说明做了什么，body 解释为什么，不重复 diff 已说明的内容。
- 提交信息任何位置禁止 AI 署名或等效辅助标识，包括 `Co-Authored-By: Claude/Copilot/Cursor`、`Generated with Claude`、`AI-assisted`。
- 一次 commit 对应一个逻辑变更，不合并无关改动；修复与对应测试可放同一 commit，重构与修复必须拆开。PR 标题遵循同一规则。

## 子代理路由

采用**封闭主 Agent 职责边界、其余默认委派**原则：明确限定主 Agent 自己只做什么；凡落在主 Agent 职责边界之外的工作，默认全部委派给 `pi-worker`（直接调用已预加载的 `mcp_pi-worker_pi-worker_pi_worker_start`，简称 `pi_worker_start`）。

### 主 Agent 职责边界（仅以下工作由主 Agent 直接完成）

1. **需求澄清与决策沟通**：理解用户意图、向用户提问拍板、整合最终结论并统一回复（子代理不直接回复用户）。
2. **架构设计与根因拍板**：方案规划、技术选型、模块边界定义、复杂跨模块根因判断与验收决策。
3. **小范围定向读写与集成收口**：仅直接完成 **1–3 个文件**的小范围定向代码修改、配置调整或最终集成收口（已有精确 `file:line` 锚点、无需多轮改测试错），以及用户已给出确切路径时的直接读取；**尚未定位到目标文件前，禁止自行 `ls`/`find`/`rg`/多文件摸底或连搜网页**。
   - **无明确计划（未走 `writing-plans`）**：超出上述小范围的跨多文件实现、大文件重构、批量迁移或预计多轮改测闭环的编码任务，一律默认交由 `pi-worker`（`tier: "default"`）执行，不得因已拿到 `file:line` 锚点就由主 Agent 包揽全部写入。
   - **有明确计划（走 `writing-plans`）**：计划评审完成后，必须由用户在 **执行者（`pi-worker` vs `Native`）× 模式（`串行` vs `并发`）** 中选择；主 Agent 仅在用户选 `Native` 时直接实施（选 `pi-worker` 时转为答疑拍板、worktree 编排与验收角色）。
4. **调度、接球与证据核验**：向 `pi-worker` 派单、秒答 `needs_input`、管理并发 worktree 合并清理，以及核验 `pi-worker` 返回的磁盘证据（`executedCommands`、`eventsPath`、`gitChanges`/diff 与引用 `file:line` 源码）。
5. **用户显式指定的原生能力**：用户点名使用原生 subagent（如 `browser`、`research`、`test-runner`、`self`）或明确要求直接执行指定命令时优先按用户指定执行。

### 其余工作一律默认交给 `pi-worker`

- **首轮强制委派（高于内置本地并行搜读与直连检索偏好）**：凡落在上述主 Agent 职责边界之外的一切工作，**第一轮就必须直接调用 `pi_worker_start`**，不得以“先看一眼目录”“先自己读几个文件/搜两轮网页摸底”为由自行展开。
- **首次派发顺带绑定监控面板**：AGY 会话首次派发 `pi_worker_start` 时，同步顺带调用一次 `pi_worker_monitor`（<10ms 同步返回），将当前会话侧面板绑定到本会话 `parentSessionId`；建议为 `pi_worker_start` 传入简短 `title`（未传时自动从 `prompt` 首行提取）。
- **档位与读写模式选择**（仅使用抽象档位，不在规则中写死具体模型 ID；映射由本机 `~/.pi/agent/pi-worker/config.json` 维护，未配置档位自动回退 `default`，详见 `pi-worker` skill）：
  - `fast` + `readOnly: true`：高输入噪声、低隐性上下文依赖、可客观核验的只读工作（如调研探索、测试/构建/lint 验证、外部检索与信息抽取等）。
  - `heavy` + `readOnly: true`：需要深度判断的独立只读工作（如独立代码审查、高难度分析）；架构设计、复杂跨模块根因定位和深度审查不降档到 `fast`。
  - `default`：其余独立任务与读写编码任务——包括无明确计划但跨多文件（>3 个文件）/大文件重构/多轮改测闭环的实现，以及有明确计划且用户选择 `pi-worker` 的实现（同 `cwd` 独占写锁，运行期间主 Agent 冻结该工作区写入）。
- **异步等待与真并发**：AGY 下 `pi_worker_start` / `pi_worker_reply` 作为后台任务异步运行并在完成时自动唤醒主会话；不要轮询 `pi_worker_status`，等待期间继续非重叠工作或先向用户报告状态，不预测结果。
  - **只读并发**：`readOnly: true` 任务机械禁用 `write`/`edit` 且不占写锁，可同工作区并行 2–4 路。
  - **写入真并发**：同 `cwd` 写任务强制串行；当有明确计划存在无文件重叠的独立任务组且用户选择**并发**时，由主 Agent 为各任务组分别创建独立 `git worktree` 并将各自 worktree 路径作为 `cwd` 并发派发 `pi_worker_start`（若选 `Native + 并发` 则派发隔离工作区原生 subagent），逐路验收后再依次合并、跑全量测试并清理 worktree。
- **二级接球**：收到 `status: "needs_input"` 时，主会话已有明确答案直接 `pi_worker_reply` 秒答续跑，否则转问用户后再续跑。
- **运行中实时插话**：运行中（`running`）任务需要主动纠偏或补充约束时，用 `pi_worker_steer(taskId, message)` 同步入队立即返回，消息在当前 turn 工具执行完、下一次 LLM 请求前注入；非运行态任务改用 `pi_worker_reply` 续跑。
- **磁盘证据核验**：遵循 `pi-worker` 工具边界返回的核验约束，不直接转述 `summary`/`verifiedCommands` 自述；整合回复前核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 及关键结论引用的 `file:line` 源码（详见 `pi-worker` skill）。

## Swarm 模式

- 在 Swarm 模式下使用 Claude 系列模型（含添加 worker 或切换模型）时，仅限用于**只读审查代码或计划**，禁止将其用于编码实现、命令执行、调研探索或其他任何非审查任务。
