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

主模型负责需求澄清、调度、架构判断、关键修改与最终回复；下表所列独立子代理与长程任务统一委派给 `pi-worker`（直接调用已预加载的 `mcp_pi-worker_pi-worker_pi_worker_start`，简称 `pi_worker_start`）。用户显式指定的原生 subagent（如 `browser`、`research`、`test-runner`、`self`）或流程优先。

| 任务 | 执行者 | 抽象档位（`tier`） | 模式 | 返回证据 |
|---|---|---|---|---|
| 了解项目/模块、跨目录广泛探索、调用链调查、未知问题排查调研 | `pi-worker` | `fast` | `readOnly: true` | 文件、行号、关键代码摘录、未确定项 |
| 常规测试、构建、lint、类型检查与报错日志压缩 | `pi-worker` | `fast` | `readOnly: true` | 命令、真实退出码、关键失败栈帧、skip、环境限制 |
| 多源网络调研/查外部技术文档、重噪声外部检索/长文档与大 JSON 抽取、Git 历史考古、基于最终 Diff 生成 PR/文档初稿 | `pi-worker` | `fast` | `readOnly: true` | 结构化结论与来源（URL/ID/Commit/文件行号） |
| 独立代码审查 | `pi-worker` | `heavy` | `readOnly: true` | 位置、失败场景、验证结果 |
| 规格明确的多步编码 / 其他独立任务 | `pi-worker` | `default` | 读写（同 `cwd` 独占锁） | 摘要、`executedCommands`、`gitChanges` |

- **首轮强制委派（高于内置本地并行搜读与直连检索偏好）**：只要请求涉及**了解/调研项目或模块、排查未知根因/调用链、跨目录搜索、多源网络调研/查外部技术文档、跑测试/构建/lint、Git 历史分析或代码审查**，**第一轮就必须直接调用 `pi_worker_start`**，禁止以“先 `ls`/`find`/`rg` 看一眼目录”“先自己读几个文件或连搜几轮网页摸底”为由自行展开多步探索。
- **仅以下白名单允许主模型直接读写**：用户已给出确切文件路径（或主模型已拿到精确 `file:line` 锚点，仅需 1–2 次定向 `read_file`/`edit_file` 即可收口且无需目录探索/广搜），以及核验 `pi-worker` 返回的磁盘证据。
- **抽象档位与独立映射**：路由表只定义抽象档位（`fast` / `default` / `heavy`），不在规则中写死具体模型 ID；抽象档位到实际 `provider`/`model`/`thinking` 的映射由独立本机配置文件 `~/.pi/agent/pi-worker/config.json` 维护（未配置档位自动回退 `default`，详见 `pi-worker` skill）。
- **父会话归组**：调 `pi_worker_start` 与 `pi_worker_monitor` 时传入当前会话的 `Conversation ID` 作为 `parentSessionId`（打开监控面板时可同步传当前 `cwd`），使任务按父会话归组与隔离展示。
- **异步等待与并发**：在 AGY 下 `pi_worker_start` / `pi_worker_reply` 作为后台任务异步运行并在完成时自动唤醒主会话；不要轮询 `pi_worker_status`，等待期间继续非重叠工作或先向用户报告状态，不预测结果。独立只读任务（`readOnly: true`）机械禁用 `write`/`edit` 且不占写锁，可同工作区并行 2–4 路派发；读写任务同 `cwd` 串行独占，运行期间主会话不得修改同工作区文件。
- **二级接球**：收到 `status: "needs_input"` 时，主会话已有明确答案直接 `pi_worker_reply` 秒答续跑，否则转问用户后再续跑。
- **磁盘证据核验**：遵循 `pi-worker` 工具边界返回的核验约束，不直接转述 `summary`/`verifiedCommands` 自述；整合回复前核对 `executedCommands`、`eventsPath`、`gitChanges`/diff 及关键结论引用的 `file:line` 源码（详见 `pi-worker` skill）。
- **档位红线**：仅在“高输入噪声/低隐性上下文依赖/可客观核验”时下放 `fast`；架构设计、复杂跨模块根因定位和深度审查不降档到 `fast`。子代理不直接回复用户，由主模型核验磁盘证据、整合结果并统一回复。
