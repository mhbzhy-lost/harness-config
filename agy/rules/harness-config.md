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

主模型负责需求澄清、调度、开发、集成和最终回复；独立非开发任务按下表委派。用户显式指定的 subagent 或流程优先。开发所需的明确文件读取和定向搜索可由主模型直接完成，不机械委派。

| 任务 | 执行者 | 返回证据 |
|---|---|---|
| 跨目录广泛探索、调用链调查、仓库调研 | `research` | 文件、行号、未确定项 |
| 测试、构建、lint、类型检查及失败诊断 | `test-runner` | 命令、真实退出码、skip、环境限制 |
| 独立代码审查 | `research` 或 `self`（只读审查） | 位置、失败场景、验证结果 |
| 其他独立非开发任务 | `self` | 有界结果与证据 |

- 子代理后台异步运行、经消息通知返回；不要轮询状态，等待期间继续非重叠工作或先向用户报告状态，不预测结果。
- 独立只读任务可并行 2–4 路派发；不要重复子代理正在做的搜索或检查。写入默认由主模型串行完成，只有用户明确要求并行开发时才使用隔离工作区（`Workspace: "share"` 或 `"branch"`）。
- 日常测试委派 `test-runner`，不让验证者修改实现或测试。
- 子代理不直接回复用户。主模型核验关键证据、整合结果并统一回复，不重复执行整轮子代理工作。
