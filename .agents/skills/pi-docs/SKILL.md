---
name: pi-docs
description: Use when reading official Pi documentation or examples to edit Pi extensions, settings, keybindings, themes, skills, TUI components, custom providers, models, packages, MCP, or SDK integrations inside this repository.
---

# Pi 官方文档与示例索引

本 skill 面向在 `harness-config` 中维护 `pi/`（扩展、设置、快捷键、全局指令、provider 配置）的场景，让 Qwen Code、AGY 等外部工具也能按需读取本机已安装的 `@earendil-works/pi-coding-agent` 官方文档、示例与 schema。

本目录下的 `docs/`、`examples/`、`schemas/` 与 `README.md` 为本机软链（已纳入 `.gitignore`，不入库），由 `./init-pi.sh` 按本机实际安装路径自动生成。

## 使用规则

1. **按需读取**：仅读取与当前任务直接相关的文档和示例，不要一次性读完所有文件。
2. **先读后改**：在修改 Pi 扩展、配置或机制前，完整阅读对应文档与交叉引用，不凭记忆猜测 API 或字段。
3. **路径解析**：以下相对路径均相对于**本 skill 所在目录**（`.agents/skills/pi-docs/`），而不是仓库根目录。
4. **若软链缺失**：如果本目录下没有 `docs/`，说明本机尚未安装 `@earendil-works/pi-coding-agent` 或尚未运行 `./init-pi.sh`。提示用户安装后执行 `./init-pi.sh`（或指定 `PI_PACKAGE_DIR=<包根目录> ./init-pi.sh`），不要猜测或伪造 Pi 内部 API。

## 主题索引

| 主题 | 文档与示例路径（相对本 skill 目录） |
|---|---|
| 概览与入口 | `README.md`、`docs/index.md`、`docs/how-pi-works.md`、`docs/quickstart.md` |
| 扩展开发（Hooks / Tools / UI） | `docs/extensions.md`、`examples/extensions/` |
| TUI 组件、主题与终端 | `docs/tui.md`、`docs/themes.md`、`docs/terminal-setup.md`、`docs/tmux.md` |
| 设置、配置与环境变量 | `docs/settings.md`、`docs/configuration.md`、`docs/environment-variables.md`、`schemas/` |
| 快捷键与斜杠命令 | `docs/keybindings.md`、`docs/slash-commands.md`、`docs/shell-aliases.md` |
| 模型、Provider 与自定义 Provider | `docs/models.md`、`docs/models-configuration.md`、`docs/providers.md`、`docs/custom-provider.md`、`docs/virtual-models.md` |
| Skills 与 Prompt 模板 | `docs/skills.md`、`docs/prompt-templates.md` |
| Pi 包管理与分发 | `docs/packages.md` |
| MCP 与 Codemode | `docs/mcp.md`、`docs/codemode.md` |
| 会话、压缩与消息结构 | `docs/sessions.md`、`docs/session-format.md`、`docs/compaction.md`、`docs/message-types.md` |
| CLI / JSON / RPC / SDK | `docs/cli.md`、`docs/json.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/sdk.md` |
| 安全模型 | `docs/security.md` |
