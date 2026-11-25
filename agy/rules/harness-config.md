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

主模型负责需求澄清、调度、开发、集成和最终回复；独立子代理与长程任务统一委派给 `pi-worker`（调用 `pi_worker_start`）。用户显式指定的原生 subagent（如 `browser`、`research`、`test-runner`、`self`）或流程优先。开发所需的 1–2 步明确文件读取和定向搜索可由主模型直接完成，不机械委派。

| 任务 | 执行者 | 抽象档位（`tier`） | 模式 | 返回证据 |
|---|---|---|---|---|
| 跨目录广泛探索、调用链调查、仓库调研 | `pi-worker` | `fast` | `readOnly: true` | 文件、行号、未确定项 |
| 常规测试、构建、lint、类型检查与报错日志压缩 | `pi-worker` | `fast` | `readOnly: true` | 命令、真实退出码、关键失败栈帧、skip、环境限制 |
| 重噪声外部检索/长文档与大 JSON 抽取、Git 历史考古、基于最终 Diff 生成 PR/文档初稿 | `pi-worker` | `fast` | `readOnly: true` | 结构化结论与来源（URL/ID/Commit/文件行号） |
| 独立代码审查 | `pi-worker` | `heavy` | `readOnly: true` | 位置、失败场景、验证结果 |
| 规格明确的多步编码 / 其他独立任务 | `pi-worker` | `default` | 读写（同 `cwd` 独占锁） | 摘要、`verifiedCommands`、`gitChanges` |

- 路由表只定义抽象档位（`fast` / `default` / `heavy`），不在规则中写死具体模型 ID；抽象档位到实际 `provider`/`model`/`thinking` 的映射由独立本机配置文件 `~/.pi/agent/pi-worker/config.json` 维护（未配置档位自动回退 `default`，详见 `pi-worker` skill）。
- 在 AGY 下 `pi_worker_start` / `pi_worker_reply` 作为后台任务异步运行并在完成时自动唤醒主会话；不要轮询 `pi_worker_status`，等待期间继续非重叠工作或先向用户报告状态，不预测结果。
- 独立只读任务（`readOnly: true`）机械禁用 `write`/`edit` 且不占写锁，可在同一 `cwd` 并行 2–4 路派发；不要重复进行中的搜索或检查。读写任务默认同一 `cwd` 串行独占，运行期间主会话不得同时修改同工作区文件。
- 收到 `status: "needs_input"` 时二级接球：主会话已有明确答案直接 `pi_worker_reply` 秒答续跑，否则转问用户后再续跑。
- 日常验证以 `tier: "fast"` + `readOnly: true` 委派，只负责执行检查与压缩失败证据，不修改实现/测试或下深层根因结论；复杂跨模块失败的根因分析由主模型基于证据判断。
- 仅在“高输入噪声/低隐性上下文依赖/可客观核验”时下放 `fast`；1–2 步可直达的定向读写直接由主模型完成，架构设计、复杂根因定位和深度审查不降档到 `fast`。
- 子代理不直接回复用户。主模型核验关键证据、整合结果并统一回复，不重复执行整轮子代理工作。
