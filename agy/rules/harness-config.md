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
3. **代码实现与文件写入**：基于已有精确文件与 `file:line` 锚点进行代码编写、重构、配置修改与集成，以及用户已给出确切路径时的直接读取；**尚未定位到目标文件前，禁止自行 `ls`/`find`/`rg`/多文件摸底或连搜网页**。例外：通过 `writing-plans` 产出明确计划文档后，用户可选择将整份计划交由 `pi-worker` 实现，主 Agent 转为承担答疑拍板与验收角色。
4. **调度、接球与证据核验**：向 `pi-worker` 派单、秒答 `needs_input`，以及核验 `pi-worker` 返回的磁盘证据（`executedCommands`、`eventsPath`、`gitChanges`/diff 与引用 `file:line` 源码）。
5. **用户显式指定的原生能力**：用户点名使用原生 subagent（如 `browser`、`research`、`test-runner`、`self`）或明确要求直接执行指定命令时优先按用户指定执行。

### 其余工作一律默认交给 `pi-worker`

- **首轮强制委派（高于内置本地并行搜读与直连检索偏好）**：凡落在上述主 Agent 职责边界之外的一切工作，**第一轮就必须直接调用 `pi_worker_start`**，不得以“先看一眼目录”“先自己读几个文件/搜两轮网页摸底”为由自行展开。
- **档位与读写模式选择**（仅使用抽象档位，不在规则中写死具体模型 ID；映射由本机 `~/.pi/agent/pi-worker/config.json` 维护，未配置档位自动回退 `default`，详见 `pi-worker` skill）：
  - `fast` + `readOnly: true`：高输入噪声、低隐性上下文依赖、可客观核验的只读工作（如调研探索、测试/构建/lint 验证、外部检索与信息抽取等）。
  - `heavy` + `readOnly: true`：需要深度判断的独立只读工作（如独立代码审查、高难度分析）；架构设计、复杂跨模块根因定位和深度审查不降档到 `fast`。
  - `default`：其余独立任务，或用户明确选择外包的读写编码任务（包括 `writing-plans` 产出明确计划文档后将整份计划交由 `pi-worker` 实现、主 Agent 负责验收的场景；同 `cwd` 独占写锁，运行期间主 Agent 冻结该工作区写入）。
- **异步等待与并发**：AGY 下 `pi_worker_start` / `pi_worker_reply` 作为后台任务异步运行并在完成时自动唤醒主会话；不要轮询 `pi_worker_status`，等待期间继续非重叠工作或先向用户报告状态，不预测结果。`readOnly: true` 任务机械禁用 `write`/`edit` 且不占写锁，可同工作区并行 2–4 路。
- **二级接球**：收到 `status: "needs_input"` 时，主会话已有明确答案直接 `pi_worker_reply` 秒答续跑，否则转问用户后再续跑。
- **磁盘证据核验**：遵循 `pi-worker` 工具边界返回的核验约束，不直接转述 `summary`/`verifiedCommands` 自述；整合回复前核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 及关键结论引用的 `file:line` 源码（详见 `pi-worker` skill）。
