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

采用**封闭主 Agent 职责边界、其余默认委派 `pi-worker`** 原则（直接调用已预加载的 `mcp_pi-worker_pi-worker_pi_worker_start`，简称 `pi_worker_start`）。

### 1. 主 Agent 职责边界（仅直接完成以下工作）

1. **需求澄清与决策沟通**：理解用户意图、向用户提问拍板、整合最终结论并统一回复（子代理不直接回复用户）。
2. **架构设计与根因拍板**：方案规划、技术选型、模块边界定义、复杂跨模块根因判断与验收决策。
3. **定向读写与集成收口**：仅直接完成定向修改/配置调整（已有精确 `file:line` 锚点、无需多轮改测试错）、用户已给确切路径的直接读取，以及最终集成收口；**未定位目标文件前禁止自行 `ls`/`find`/`rg`/多文件摸底或连搜网页**。
4. **编排调度与证据核验**：向 `pi-worker` / `swarm` / 原生专用 subagent 派单、秒答 `needs_input`、管理并行工作区/worktree 合并清理，以及核验返回的磁盘证据。

### 2. 日常任务路由（无明确计划）

凡超出主 Agent 职责边界的日常任务，一律按抽象档位直派 `pi-worker`（不在规则中写死具体模型 ID；由本机 `~/.pi/agent/pi-worker/config.json` 映射，未配置档位自动回退 `default`，详见 `pi-worker` skill）：

| 档位与模式 | 适用场景 | 约束 |
| --- | --- | --- |
| `fast` + `readOnly: true` | 调研探索、测试/构建/lint 验证、外部检索与信息抽取等高噪声、可客观核验的只读工作 | 架构设计、复杂跨模块根因定位和深度审查不降档到 `fast` |
| `heavy` + `readOnly: true` | 独立代码审查、高难度分析等需深度判断的只读工作 | 不修改文件 |
| `default`（读写） | 跨多文件（>3 个文件）、大文件重构、批量迁移、多轮改测闭环的实现 | 不得因已拿到 `file:line` 锚点就由主 Agent 包揽写入 |

### 3. 计划流路由（`writing-plans` 三阶段显式询问）

走 `writing-plans` 或有明确实施计划时，以下三个阶段执行前**均必须显式调用 `ask_question` 由用户选择执行方式**，不得跳过或自行默选：

| 阶段 | 可选方式 | 说明 |
| --- | --- | --- |
| **① 计划写完后 Reviewer**（只读） | `pi-worker heavy` / `swarm carbon` / `swarm claude opus 5.5` | `pi-worker` 用 `tier: "heavy"` + `readOnly: true`；`swarm carbon` 用 `gemini-4-carbon-high`；`swarm claude opus 5.5` 用 `claude-opus-5-5-high`；均仅限只读审查计划 |
| **② 计划实施执行** | `pi-worker default`（串行/并行） / `native`（当前会话串行） / `swarm hydrogen`（串行/并行） | 仅选 `native 当前会话串行` 时由主 Agent 直接实施；选 `pi-worker` 或 `swarm` 时主 Agent 转为答疑拍板、工作区编排、集成与验收 |
| **③ 执行完毕后验收 Reviewer**（只读） | `pi-worker heavy` / `swarm carbon` / `swarm claude opus 5.5` | 全部任务合并并完成集成验证后再次显式询问，三档同计划后 Reviewer，对整分支做独立审查 |

- **写入并行条件**：仅当计划存在无文件重叠的独立任务组时可选并行。`pi-worker default 并行` 由主 Agent 为各任务组分别建独立 `git worktree` 并以各自路径作 `cwd` 并发派发；`swarm hydrogen 并行` 按独立工作区（如 `workspace: "share"`）并发派发；均须逐路验收后依次合并、跑全量测试并清理临时工作区/worktree。

### 4. `pi-worker` 调度与核验规范

- **首次监控绑定**：AGY 会话首次调用 `pi_worker_start` 时，同步顺带调用一次 `pi_worker_monitor`（<10ms 同步返回）绑定本会话 `parentSessionId`；建议传入简短 `title`（省略时从 `prompt` 首行提取）。
- **异步等待与并发锁**：`pi_worker_start` / `pi_worker_reply` 为后台异步任务，完成时自动唤醒，**禁止轮询 `pi_worker_status`**，等待期间继续非重叠工作或先报告状态、不预测结果。`readOnly: true` 禁用 `write`/`edit` 且不占锁，同 `cwd` 可并发 2–4 路；读写任务同 `cwd` 独占写锁，运行期间主 Agent 冻结该工作区写入。
- **接球与实时插话**：收到 `status: "needs_input"` 时，已有明确答案直接 `pi_worker_reply` 秒答续跑，否则转问用户后再续跑；运行中（`running`）需主动纠偏或补充约束用 `pi_worker_steer(taskId, message)` 同步入队（当前 turn 工具执行完、下一次 LLM 请求前注入），非运行态改用 `pi_worker_reply`。
- **磁盘证据核验**：不直接转述 `summary`/`verifiedCommands` 自述；整合回复前核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 及关键结论引用的 `file:line` 源码（详见 `pi-worker` skill）。

## Swarm 模式

- 当用户未明确声明 Swarm 模式使用的模型时，默认使用 `hydrogen`（含添加 worker 或切换模型）；在 Swarm 模式下使用其他模型（如 `carbon`、`claude`）必须先获得用户显式授权。
- 在 Swarm 模式下使用 `carbon` 或 Claude 系列模型（含添加 worker 或切换模型）时，仅限用于**只读审查代码或计划**，禁止将其用于编码实现、命令执行、调研探索或其他任何非审查任务。
