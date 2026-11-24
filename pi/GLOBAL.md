# 全局指令

<!-- 由 harness-config 同步（pi/GLOBAL.md → ~/.pi/agent/AGENTS.md），对所有项目生效。 -->
<!-- 在此填写跨项目通用的偏好与约定；项目专属内容写各项目的 AGENTS.md。保持短而具体。 -->

## Git Commit 规范

- 格式为 `type(scope): 中文祈使句`，`scope` 可选；type 仅允许英文小写 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`style`、`chore`、`build`、`ci`、`revert`。
- subject 必须包含至少一个中文字符，不超过 50 字，不以 `。` 或 `.` 结尾；以祈使句动词开头（如“增加”“修复”“重构”），不用“已修复”“实现了”“修复了”等过去时。
- 禁止以零信息词单独作为 subject：`fix`、`update`、`bugfix`、`wip`、“修改”、“更新”。subject 说明做了什么，body 解释为什么，不重复 diff 已说明的内容。
- 提交信息任何位置禁止 AI 署名或等效辅助标识，包括 `Co-Authored-By: Claude/Copilot/Cursor`、`Generated with Claude`、`AI-assisted`。
- 一次 commit 对应一个逻辑变更，不合并无关改动；修复与对应测试可放同一 commit，重构与修复必须拆开。PR 标题遵循同一规则。
- `security-gates` 扩展会对 type 白名单、中文字符、句号结尾、过去时、零信息 subject、AI 署名以及宽泛暂存（`git add -A/.`、`git commit -a`）做机械校验；机械检查不能代替人工核对，也不授予提交权限。

## Pi Shell 工具与异步命令

- Pi bash 子进程的 `PATH` 默认前置 `~/.pi/agent/bin/`（含 Pi 自管的 `fd` / `rg` 与本仓同步的 `apply_patch`）：使用 `fd` 查找文件，使用 `rg` 搜索文本；需要一次表达多文件增删改时，可使用 `apply_patch` 通过 stdin 提交完整的 `*** Begin Patch ... *** End Patch` 结构化补丁。
- **禁止执行 `sleep` 命令**（同步 `bash` 中的 `sleep` 会被 `security-gates` 机械拦截）。凡是等待、延迟、轮询或等待长命令完成，必须使用 `bash_async`，不得用同步 `bash` 通过 `sleep` 阻塞等待。
- 测试套件、构建、类型检查或网络请求等长耗时任务使用 `bash_async`，收到启动回执后继续其他无冲突工作或结束当前回合，等待完成回执自动唤醒，不要轮询或阻塞干等。

## 通用约定

- 文档、代码注释与说明正文默认使用中文（专业术语与代码标识符除外）。
- 未经用户明确要求，不改动无关代码，不主动扩写无关测试或压力场景；验证范围紧扣当前变更。
