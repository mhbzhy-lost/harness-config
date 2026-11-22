# harness-config

Qwen Code 个人配置与插件的多机同步仓库。

## 结构

| 路径 | 说明 |
|---|---|
| `init-qwen.sh` | 同步脚本：合并设置 + 注入 HARNESS_CONFIG_ROOT + 链接插件 + 注册 shell 片段 + 链接全局 QWEN.md |
| `init-pi.sh` | 链接插件到 pi 的加载目录（默认 `~/.agents/plugins`） |
| `lib-plugins.sh` | 两个 init 脚本共享的插件链接逻辑 |
| `qwen/settings.json` | 设置模板（仅跨机通用偏好：TUI 精简 + 主题插值） |
| `qwen/shell.zsh` | qwen shell 包装：主题随系统明暗（macOS light→Xcode / dark→Qwen Dark） |
| `qwen/QWEN.md` | 全局指令文件，软链接为 `~/.qwen/QWEN.md`（对所有项目生效） |
| `plugins/` | Agent Plugins v1 插件：deepseek-search / home-connect / playwright |

## 同步范围

- **同步**：模板中定义的设置键；`plugins/*` → `~/.qwen/extensions/<name>` 软链接；`qwen/shell.zsh` 的 source 注册进 `~/.zshrc`；`qwen/QWEN.md` → `~/.qwen/QWEN.md` 软链接（全局指令）。
- **不同步（per-machine）**：`model`、`modelProviders`、`security.auth`、`env` 中的密钥、`providerMetadata`、`$version`、`ui.autoModeAcknowledged` 等机器本地状态。模型/提供商/认证在各机器自行配置。

`init-qwen.sh` 还会向本机设置注入 `env.HARNESS_CONFIG_ROOT`（本仓库绝对路径）——per-machine 值，不入模板。Qwen 将设置 `env` 注入进程环境，插件可据此按相对路径定位仓内资源（如 home-connect 凭据在 `$HARNESS_CONFIG_ROOT/plugins/home-connect`）；无锚点时插件回退自定位。仓库移动后重跑脚本更新。

## 主题随系统明暗

`qwen/shell.zsh` 定义 `qwen()` 包装：启动时读 macOS 外观（`defaults read -g AppleInterfaceStyle`），dark→`Qwen Dark`、light→`Xcode`，把结果写入 `QWEN_THEME` 再调真实 `qwen`；非 macOS（无 `defaults`）回退 `auto`。模板里 `ui.theme="${QWEN_THEME}"` 由 Qwen 设置插值消费该变量。

- `init-qwen.sh` 用标记块 `# >>> harness-config qwen >>>` 把 source 行注册进 `~/.zshrc`（幂等；仓库移动后重跑更新路径；写入前备份）。
- 主题只在**启动时**确定：系统明暗切换后需重启 qwen 才跟随（引擎无实时监听）。
- 未注册包装的机器上 `QWEN_THEME` 未定义，插值保留字面量→主题查找失败→回退默认深色。
- **勿用 `/theme` 对话框选主题**：会把固定值写回 `ui.theme`，覆盖插值；误操作后改回 `"${QWEN_THEME}"`。

## 新机器用法

```bash
git clone <repo-url> harness-config && cd harness-config
./init-qwen.sh
./init-pi.sh      # 若使用 pi：链接插件到 ~/.agents/plugins
# 按需补齐本机内容：
(cd plugins/playwright && npm install)
cp plugins/deepseek-search/.env.example plugins/deepseek-search/.env   # 填写密钥
# home-connect 凭据在 plugins/home-connect/ 内对应位置（已 gitignore）：
#   .env（ROOT_PWD=<sudo密码>）、.ssh/（密钥）、config/*.env（从 *.example 复制填写）
# 模型/提供商/认证在本机自行配置
```

## 设置合并语义

- 深度合并：模板键覆盖本机值，数组整体替换，本机其余已有键保留。
- 写入前自动备份为 `<目标>.bak.<时间戳>`；原子写入；权限 600。
- 内容已一致时不写入（幂等）。

## 插件链接语义

- 已是正确链接 → 跳过；指向别处的链接 → 重指；真实目录/文件 → 警告并跳过（不破坏）。
- pi 侧由 `init-pi.sh` 管理（`PI_PLUGINS_DIR` 可覆盖目标）；指向本仓 `plugins/` 的遗留整目录软链接会自动升级为逐插件链接，指向别处的整目录链接则拒绝处理。
- 凭据（`.env`）与 `node_modules/` 不入库；缺依赖或缺凭据时脚本会给出提示。
- 全局 QWEN.md 链接同语义（`QWEN_GLOBAL_MD` 可覆盖目标）：本机已有真实 `~/.qwen/QWEN.md` 时警告跳过，需手动备份后重跑。

## 常用命令

```bash
./init-qwen.sh --dry-run    # 预览变更
QWEN_SETTINGS_PATH=/tmp/t.json QWEN_EXTENSIONS_DIR=/tmp/ext QWEN_SHELL_RC=/tmp/zshrc QWEN_GLOBAL_MD=/tmp/QWEN.md ./init-qwen.sh   # 测试
```

## 更新

- 设置：把想同步的键手动加进 `qwen/settings.json`（勿加 per-machine 配置），提交推送。
- 插件：直接改 `plugins/` 下内容（本机链接即时生效），提交推送；其他机器 `git pull` 即可，新增插件需重跑 `./init-qwen.sh` 建链接。
- shell 包装：改 `qwen/shell.zsh`（source 即时生效于新终端），提交推送；其他机器 `git pull` 即可。
- 全局指令：改 `qwen/QWEN.md`（软链接即时生效于新会话），提交推送；其他机器 `git pull` 即可。内容保持短而具体，项目专属内容写各项目的 QWEN.md。

## 注意

- 需要 bash + python3；插件运行依赖 node（playwright 还需 `npm install`）。
- 本机设置必须是标准 JSON；脚本不处理手写的 `//` 注释。
- 设置变更重启 Qwen Code 生效；插件变更可用 `/reload-plugins`；shell 包装新开终端生效；全局 QWEN.md 新会话加载（`/memory` 可查看）。
- 主题包装依赖 zsh（注册进 `~/.zshrc`）；bash-only 机器不生效，主题回退默认。
