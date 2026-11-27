# 项目维护规则

## 目录与指令归属

- Qwen Code 专属配置放在 `qwen/`，包括设置模板、shell 包装、agent 定义和原生扩展；AGY 专属配置放在 `agy/`（设置模板 `agy/settings.json`、shell 包装 `agy/shell.zsh`、全局规则 `agy/rules/`、subagent 定义 `agy/agents/` 与生命周期 hook `agy/hooks/`；设置模板同样只放跨机通用偏好，不写入本机状态或凭据，自定义 subagent 通过 frontmatter 绑定抽象档位，受管 hooks 通过 `hooks.json` 按名幂等注入）；Pi 专属配置放在 `pi/`（设置模板 `pi/settings.json`、快捷键 `pi/keybindings.json`、shell 包装 `pi/shell.zsh` + `pi/launcher.zsh`、子进程工具 `pi/bin/`、预检脚本 `pi/scripts/` 与扩展 `pi/extensions/`）。跨运行时的插件、跨项目独立技能和通用远程终端分别放在根目录的 `plugins/`、`skills/` 和 `remote-terminal/`（由 `init-remote.sh` 独立初始化，运行时状态与凭据保存在本机 `~/.harness-remote/`，不入库）；仅在本仓维护配置时使用的项目级技能放在 `.agents/skills/`（如 `pi-manage-provider`、`pi-docs`；其中 `pi-docs` 指向本机 Pi 包的文档软链由 `init-pi.sh` 按本机路径自动创建并纳入 `.gitignore`，不入库）。
- Pi 扩展遵循严格命名约定：每个扩展位于 `pi/extensions/<name>/`，入口文件必须与扩展名一致，命名为 `pi/extensions/<name>/<name>.ts`；扩展的私有辅助模块放在同一扩展目录内，不在 `pi/extensions/` 下放置无同名入口的独立目录。`pi/settings.json` 同样只放跨机通用偏好与锁版的社区 `npm:` / `git:` 包，不写入本机模型、认证、本地路径 packages、代理或运行时状态；`init-pi.sh` 合并模板（对 `packages` 与 `defaultTools` 增量合并、同包名/同仓库按模板版本原地更新）并按序注入仓内扩展与 `skills/` 绝对路径，保留本机已有非受管扩展、本地 packages、skills 与配置。
- 本仓规则写在根目录 `AGENTS.md`；跨项目的个人偏好按运行时分别维护在 `qwen/QWEN.md`（由 `init-qwen.sh` 软链接到 `~/.qwen/QWEN.md`）、`agy/rules/harness-config.md`（由 `init-agy.sh` 逐文件软链接到 `~/.gemini/config/rules/`）和 `pi/GLOBAL.md`（由 `init-pi.sh` 软链接到 `~/.pi/agent/AGENTS.md`）；AGY 与 Pi 侧仓内源文件均不命名为 `AGENTS.md` 以免被目录扫描误加载，不用复制文件或通过 `context.includeDirectories` 扩大加载范围。
- 支撑跨机器偏好的 shell 逻辑应留在仓内（例如 `qwen/shell.zsh`）；用户的 shell 配置只由初始化脚本幂等注册加载入口，不内联实现。

## Qwen Code 设置的同步范围

- `qwen/settings.json` 只放跨机器通用的偏好。具体模型选择、`fastModel`、`agents.modelGrades`、模型提供商（包括自定义 provider）、认证方式、API Key 等凭据，以及 `providerMetadata` 等本机状态，均由各机器在本机配置，不写入同步模板，也不由 `init-qwen.sh` 分发。模板可以配置 `fast` / `inherit` 等抽象角色档位，但不写这些档位对应的具体模型 ID。同步时须保留本机已有配置。
- 仓内资源统一以 `HARNESS_CONFIG_ROOT` 为锚点按相对路径定位，不新增各插件专用的仓库根变量。该绝对路径由 `init-qwen.sh` 注入本机设置，不写入模板。`skills.directories` 同样由脚本注入仓内 `skills/` 的绝对路径，并保留已有目录条目。
- 仓内同步的 agent 定义若引用具体模型 ID，应注明目标机器需要自行配置对应模型和提供商，不要为满足该依赖扩大设置同步范围。当前仅 `review-agent` 为原生 `/review` 保留 `qwen4-max-preview` 例外，其他 agent 不复制这一做法。覆盖内置 agent 时，除有意调整的字段外，应保留上游工具和提示词；升级 Qwen Code 后对照内置定义检查。

## 插件与初始化

- `init-qwen.sh`、`init-pi.sh` 和 `init-agy.sh` 分别管理各自运行时的插件链接，复用 `lib-plugins.sh`。pi 默认从 `~/.agents/plugins` 加载，AGY 默认从 `~/.gemini/config/plugins` 加载；不要为旧目录新增临时反向软链接。
- 仓内插件遵循 Agent Plugins 1.0.0（`plugin.json` + `mcp.json` + `skills/`），同时在插件根目录提供兼容 AGY 原生模式的 `mcp_config.json`（使用 `${PLUGIN_ROOT}`，与 `mcp.json` 保持核心 server 启动定义同步）。需要使用 AGY 专属能力（如 `timeoutSeconds`、`tools.*.background`、`env` 开关、MCP App 侧面板）的插件在 `<plugin>/.antigravity-plugin/plugin.json` 提供 AGY 原生清单（覆盖根 Agent Plugins `$schema` 以确保 AGY 走 `mcp_config.json` 加载，同时保持根 `plugin.json`/`mcp.json` 对 Qwen/Pi 完全纯净）。
- 初始化须幂等。受管链接已正确时跳过，目标错误时重指，遇到同名真实文件或目录则警告并跳过；不要覆盖用户已有文件或改动未受管条目。
- 插件凭据放在仓内对应插件约定的位置，并纳入 `.gitignore`；只提交不含真实凭据的示例，不把凭据放到 `~/.pi` 再做兼容链接。这与模型通道凭据留在本机 Qwen Code 配置是两回事。
- ComfyUI 与 home-connect 保持同一个插件，共用连接层，但各自提供独立的 skill 和 MCP server 入口；不要把两组工具合并进同一个 `server.ts`。
- 更新从 superpowers 改编的 skills 时，核对最新上游发布版，不以本机旧缓存为准。保留版本来源和许可证说明，移除对未随仓库分发的上游 skills 的依赖，保证改编版可以独立使用。
- `codex-proxy` 保持为本机 Qwen 扩展：会话 hooks 由 `init-qwen.sh` 按名称幂等管理，不影响其他 hooks。代理只监听回环地址；多个 Qwen 会话可共用，最后一个会话退出后才停止。未安装或未登录不应阻塞 Qwen 会话。

## Git 命令

- 本仓 Git 操作优先使用 `git1` 命令；确认 `git1` 不可用后再回退到 `git`。

## Git 提交身份

- 本仓用 `git config --local` 固定提交身份为 `gh` 当前登录账号；账号未公开邮箱时使用 GitHub 的 `noreply` 地址，不使用全局私人邮箱。新克隆或切换 GitHub 账号后，在提交前核对本仓的 `user.name` 和 `user.email`。
