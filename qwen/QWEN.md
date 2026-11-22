# 全局指令

<!-- 由 harness-config 同步（qwen/QWEN.md → ~/.qwen/QWEN.md），对所有项目生效。 -->
<!-- 在此填写跨项目通用的偏好与约定；项目专属内容写各项目的 QWEN.md。保持短而具体。 -->

## Git Commit 规范

- 格式为 `type(scope): 中文祈使句`，`scope` 可选；type 仅允许英文小写 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`style`、`chore`、`build`、`ci`、`revert`。
- subject 必须包含至少一个中文字符，不超过 50 字，不以 `。` 或 `.` 结尾；以祈使句动词开头（如“增加”“修复”“重构”），不用“已修复”“实现了”“修复了”等过去时。
- 禁止以零信息词单独作为 subject：`fix`、`update`、`bugfix`、`wip`、“修改”、“更新”。subject 说明做了什么，body 解释为什么，不重复 diff 已说明的内容。
- 提交信息任何位置禁止 AI 署名或等效辅助标识，包括 `Co-Authored-By: Claude/Copilot/Cursor`、`Generated with Claude`、`AI-assisted`。
- 一次 commit 对应一个逻辑变更，不合并无关改动；修复与对应测试可放同一 commit，重构与修复必须拆开。PR 标题遵循同一规则。