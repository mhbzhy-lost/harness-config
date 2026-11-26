# harness-config

Qwen Code 个人配置与插件的多机同步仓库。

## 结构

| 路径 | 说明 |
|---|---|
| `init-qwen.sh` | 同步脚本：合并设置 + 注入 HARNESS_CONFIG_ROOT + 链接插件 + 注册 shell 片段 + 链接全局 QWEN.md + 链接 agent 定义 |
| `init-pi.sh` | 同步到 Pi：合并 `pi/settings.json` 并按序注入 `pi/extensions/*` 与 `skills/` 到 `~/.pi/agent/settings.json` + 链接 `pi/keybindings.json` + 链接 `pi/GLOBAL.md` 到 `~/.pi/agent/AGENTS.md` + 复制 `pi/bin/apply_patch` 到 `~/.pi/agent/bin/` + 链接跨运行时插件到 `~/.agents/plugins` + 注册 `pi/shell.zsh` 到 `~/.zshrc` + 自动软链本机 Pi 包文档到 `.agents/skills/pi-docs/` |
| `pi/settings.json` | Pi 跨机通用设置模板（`hideThinkingBlock`、`cacheWarming`、`defaultTools` 与锁版社区包 `npm:@arhen/pi-core-ask@1.1.0` / `git:github.com/mhbzhy-lost/pi-dcp@v1.0.0`），深度合并进 `~/.pi/agent/settings.json`（保留本机模型、本地 packages 与非受管扩展） |
| `pi/GLOBAL.md` | Pi 全局指令（Commit 规范、Pi bin 工具与 `bash_async` 约定），软链接为 `~/.pi/agent/AGENTS.md`（仓内不命名为 `AGENTS.md` 避免目录扫描误加载） |
| `pi/keybindings.json` | Pi 快捷键配置（`alt+p` / `shift+alt+p` 切换模型），软链接为 `~/.pi/agent/keybindings.json` |
| `pi/bin/` | Pi 辅助工具 `apply_patch`（由 `init-pi.sh` 复制到 `~/.pi/agent/bin/apply_patch`，与 Pi 原生管理的 `fd` / `rg` 一同自动进入 Pi bash 子进程 `PATH`） |
| `pi/extensions/` | Pi 专属扩展（每个扩展 `<name>/<name>.ts`）：`agent-plugins`（Agent Plugins 1.0.0 加载 `~/.agents/plugins/`）、`ask-user-question`、`dcp`、`compact-tools`、`bash-cwd`、`bash-async`、`endpoint-fallback`、`network-recovery`、`openai-proxy`、`security-gates`、`session-owner`、`tool-timing`、`tui-lite` |
| `pi/shell.zsh` + `pi/launcher.zsh` | Pi shell 包装与 `session-owner` 启动预检器（`pi/scripts/pi-session-owner.ts`），防止多窗口 `pi -c` 写坏同一会话 |
| `init-agy.sh` | 同步到 Antigravity（AGY）：合并 `agy/settings.json` + 链接插件到 `~/.gemini/config/plugins` + 注册 `skills/` 到 `skills.json` + 链接 `agy/rules/*.md` 到全局 rules + 链接 `agy/agents/*.md` 到全局 agents + 注入 `agy/hooks/` 到 `hooks.json` |
| `init-remote.sh` | 初始化通用远程终端 `remote-terminal/`（按需安装 `node-pty`/`xterm`/`ws`、检查 `tmux`、注册 `rt`/`rtctl` 包装进 `~/.zshrc`） |
| `remote-terminal/` | 通用 tmux Web 终端与公网中继客户端（兼容 ECS `pi-relay-server` v2 协议，支持承载 `pi`/`qwen`/`agy`/普通 shell 等任意会话；状态保存在 `~/.harness-remote/`） |
| `lib-plugins.sh` | 三个 init 脚本共享的插件链接逻辑 |
| `agy/settings.json` | AGY CLI 设置模板（跨机通用 UI 偏好：全屏 `altScreenMode: always`），深度合并进 `~/.gemini/antigravity-cli/settings.json` |
| `agy/rules/` | AGY 全局规则（带 `trigger: always_on`），逐文件软链接进 `~/.gemini/config/rules/`（对所有项目生效） |
| `agy/agents/` | AGY 自定义 subagent 定义（`test-runner` 只读验证与失败日志压缩，frontmatter 声明 `model: flash`），逐文件软链接进 `~/.gemini/config/agents/` |
| `agy/hooks/` | AGY 生命周期 hook（`subagent-model-router.py`：内置 `research` 缺省/`inherit` 时机械兜底 `flash`），按名幂等注入 `~/.gemini/config/hooks.json` |
| `qwen/settings.json` | 设置模板（跨机通用偏好：TUI 精简 + 主题插值 + Explore 抽象 `fast` 档位） |
| `qwen/shell.zsh` | qwen shell 包装：主题随系统明暗（macOS light→Xcode / dark→Qwen Dark） |
| `qwen/QWEN.md` | 全局指令与子代理路由表，软链接为 `~/.qwen/QWEN.md`（对所有项目生效） |
| `qwen/agents/` | subagent 定义（test-runner 只读验证与失败日志压缩，frontmatter 声明 `model: fast`；review-agent 重模型覆盖；antigravity 外部执行器委托 `agy acp`），逐文件软链接进 `~/.qwen/agents/` |
| `qwen/extensions/` | 原生 Qwen extension（codex-proxy：/codex-login、/codex-status + 生命周期脚本），软链接进 `~/.qwen/extensions/` |
| `skills/` | 跨项目独立 skill（superpowers 改写版：`writing-skills` / `writing-plans`），分别注入 Qwen `skills.directories`、AGY `skills.json` 与 Pi `skills` 加载 |
| `.agents/skills/` | 仅在本仓加载的项目级 skill：`pi-manage-provider`（安全管理 `~/.pi/agent/models.json` 与 `/dev/tty` 凭据录入）、`pi-docs`（Pi 官方文档索引，本机 `docs`/`examples`/`schemas`/`README.md` 软链由 `init-pi.sh` 自动生成且 gitignore） |
| `plugins/` | Agent Plugins v1 插件：deepseek-search / home-connect / pi-worker / playwright |

## 同步范围

- **同步**：模板中定义的设置键；`plugins/*` → `~/.qwen/extensions/<name>` 软链接；`qwen/shell.zsh` 的 source 注册进 `~/.zshrc`；`qwen/QWEN.md` → `~/.qwen/QWEN.md` 软链接（全局指令）；`skills/` 经注入的 `skills.directories` 加载（user 级 skill）；`qwen/agents/*.md` → `~/.qwen/agents/<name>.md` 逐文件软链接（subagent 定义）；`qwen/extensions/*` → `~/.qwen/extensions/<name>` 软链接 + codex-proxy 生命周期 hooks 注入 settings。
- **不同步（per-machine）**：`model`、`fastModel`、`agents.modelGrades`、`modelProviders`、`security.auth`、`env` 中的密钥、`providerMetadata`、`$version`、`ui.autoModeAcknowledged` 等机器本地状态。具体模型、轻量档位映射、提供商和认证在各机器自行配置；模板只写 `fast` / `inherit` 等抽象角色档位。

`init-qwen.sh` 还会向本机设置注入 `env.HARNESS_CONFIG_ROOT`（本仓库绝对路径）——per-machine 值，不入模板。Qwen 将设置 `env` 注入进程环境，插件可据此按相对路径定位仓内资源（如 home-connect 凭据在 `$HARNESS_CONFIG_ROOT/plugins/home-connect`）；无锚点时插件回退自定位。仓库移动后重跑脚本更新。

同理，脚本确保 `skills.directories` 含 `<仓库根>/skills`（保留用户已有的其他目录条目）。不用软链、不入模板：设置插值先于 settings env 注入，`${HARNESS_CONFIG_ROOT}` 写法首次加载解析不了，故注入字面绝对路径。skill 以 user 级加载、不受文件夹信任门控，**重启 Qwen Code 生效**。仓库移动后重跑会追加新路径，旧路径条目需手动删除。

## 子代理路由与模型档位

- `qwen/QWEN.md` 是跨项目软路由：主模型负责调度、开发、集成和最终回复；广泛探索用 Explore，常规测试/构建/lint 与日志压缩用 test-runner，重噪声外部检索/长文档与大 JSON 抽取、Git 历史考古、基于最终 Diff 生成 PR/文档初稿用 general-purpose（优先轻量档位），未分类非开发任务用 general-purpose（继承主模型），完整审查用 `/review` medium/high。
- Explore（模板 `agents.builtin.exploreModel`）与 test-runner（frontmatter `model: fast`）均使用抽象档位 `fast`。各机器在本机 settings 配置 `fastModel`，模板不保存该档位对应的具体模型 ID；未配置 `fastModel` 时自动回退继承主模型。general-purpose 默认继承当前主模型，高噪声可核验任务按需传轻量档位（`fast` / `small`）。
- 原生 `/review` 暂不支持把 `high` 档静态绑定到 review-agent，因此 `review-agent.md` 保留 `qwen4-max-preview` 作为唯一具体模型例外；其他机器须自行提供该模型。第一版不要求新增 `agents.modelGrades.high`。
- test-runner 不开放 `write_file` / `edit`，shell 仅用于运行检查，禁止用于修改项目文件。后者是提示词约束，不是只读沙箱；测试和构建产生的正常产物允许存在。
- 路由和模型设置均需新会话加载。配置验收命令：`python3 -m unittest discover -s tests -p 'test_*.py'`；真实路由是否命中仍须观察新会话中的实际 Agent 调用。

## 主题随系统明暗

`qwen/shell.zsh` 定义 `qwen()` 包装：启动时读 macOS 外观（`defaults read -g AppleInterfaceStyle`），dark→`Qwen Dark`、light→`Xcode`，把结果写入 `QWEN_THEME` 再调真实 `qwen`；非 macOS（无 `defaults`）回退 `auto`。模板里 `ui.theme="${QWEN_THEME}"` 由 Qwen 设置插值消费该变量。

- `init-qwen.sh` 用标记块 `# >>> harness-config qwen >>>` 把 source 行注册进 `~/.zshrc`（幂等；仓库移动后重跑更新路径；写入前备份）。
- 主题只在**启动时**确定：系统明暗切换后需重启 qwen 才跟随（引擎无实时监听）。
- 未注册包装的机器上 `QWEN_THEME` 未定义，插值保留字面量→主题查找失败→回退默认深色。
- **勿用 `/theme` 对话框选主题**：会把固定值写回 `ui.theme`，覆盖插值；误操作后改回 `"${QWEN_THEME}"`。

## Codex 订阅桥接（codex-proxy）

CLIProxyAPI（`brew install cliproxyapi`）把 ChatGPT 订阅配额暴露为本地 OpenAI 端点（仅绑 `127.0.0.1:8317`），生命周期由 Qwen hooks 自动管理，无需单独守护。

- **架构**：`qwen/extensions/codex-proxy/` 提供 `/codex-login`、`/codex-status` 命令与 `scripts/manager.py`。标准 extension 不加载 hooks（实测），故 SessionStart/SessionEnd hooks 由 `init-qwen.sh` 注入用户 settings（按 name 幂等管理自有条目，保留其他 hooks；命令路径为 per-machine 绝对路径）。
- **多进程安全**：hook 命令是 qwen 进程直接子进程（`$PPID` 即 qwen PID，实测）。PID 注册表 + `fcntl.flock`；SessionStart 注册，SessionEnd（非 clear 原因）注销；watchdog 每 5s 清理死亡 PID，最后一个会话消失即停 proxy。`kill -9` 崩溃由 watchdog 兜底（已测）。
- **上游代理**：OpenAI 流量必须走代理——config `requests.proxy-url` 默认 `http://127.0.0.1:7897`（`CODEX_UPSTREAM_PROXY` 可覆盖），登录用 `-login-proxy` 同值。只作用于 cliproxyapi 进程，Qwen 自身流量不受影响。
- **一次性接入**：`brew install cliproxyapi` → 确保 7897 代理客户端在跑 → `/codex-login`（浏览器 ChatGPT OAuth，命令引导后续模型条目写入）。模型条目属 per-machine 配置，不入模板。
- **状态目录** `~/.qwen/codex-proxy/`：config.yaml、auth/（OAuth 凭据，per-machine 秘密，不在仓内）、proxy.log、注册表。未安装/未登录时 hooks 静默 no-op，不阻塞任何会话。
- **风险**：个人自用属 OpenAI 当前默许的灰区；共享/转售触发风控（详见调研记忆）。

## 新机器用法

```bash
git clone <repo-url> harness-config && cd harness-config
./init-qwen.sh
./init-pi.sh      # 若使用 pi：链接插件到 ~/.agents/plugins
./init-agy.sh     # 若使用 agy：链接插件 + 注册 skills.json + 链接 AGY 全局规则
# 可选：playwright 依赖按需安装（首次 browser_start 返回 sdk-missing 时再执行也可以）
bash plugins/playwright/scripts/setup.sh
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
- 凭据（`.env`）与 `node_modules/` 不入库；缺凭据时脚本会给出提示。自带 `scripts/setup.sh` 的插件按懒加载处理，init 阶段不提示安装，由对应 skill 在首次使用时报 `sdk-missing` 并引导执行 setup。
- 全局 QWEN.md 链接同语义（`QWEN_GLOBAL_MD` 可覆盖目标）：本机已有真实 `~/.qwen/QWEN.md` 时警告跳过，需手动备份后重跑。
- agent 定义同语义逐文件链接（`QWEN_AGENTS_DIR` 可覆盖目录）：只管理仓内有的文件，本机自建的其他 agent 不受影响。注意 `qwen/agents/review-agent.md` 的 `model` 钉死了具体模型 ID，会随仓同步——其他机器需有该模型，否则自行调整。`qwen/agents/antigravity.md` 是外部执行器（`executor: acp → agy acp`），需要本机安装 Antigravity CLI 并完成 `agy` 登录后才能派发，缺 CLI 时报 `spawn agy ENOENT`、不会回退到 Qwen 模型。

## 常用命令

```bash
./init-qwen.sh --dry-run    # 预览 Qwen 变更
./init-pi.sh --dry-run      # 预览 Pi 变更
./init-agy.sh --dry-run     # 预览 AGY 变更
python3 -m unittest discover -s tests -p 'test_*.py'   # 路由与 init 回归测试
node --test tests/test_pi_extensions.mjs               # Pi 扩展与 session-owner 回归测试
QWEN_SETTINGS_PATH=/tmp/t.json QWEN_EXTENSIONS_DIR=/tmp/ext QWEN_SHELL_RC=/tmp/zshrc QWEN_GLOBAL_MD=/tmp/QWEN.md QWEN_AGENTS_DIR=/tmp/agents ./init-qwen.sh   # 临时目录同步测试
PI_AGENT_DIR=/tmp/pi-agent PI_PLUGINS_DIR=/tmp/pi-plugins PI_SHELL_RC=/tmp/pi-zshrc ./init-pi.sh   # Pi 临时目录同步测试
AGY_SETTINGS_PATH=/tmp/agy-settings.json AGY_CONFIG_DIR=/tmp/agy-config ./init-agy.sh   # AGY 临时目录同步测试
```

## 更新

- 设置：把想同步的键手动加进 `qwen/settings.json`（勿加 per-machine 配置），提交推送。
- 插件：直接改 `plugins/` 下内容（本机链接即时生效），提交推送；其他机器 `git pull` 即可，新增插件需重跑 `./init-qwen.sh` 建链接。
- shell 包装：改 `qwen/shell.zsh`（source 即时生效于新终端），提交推送；其他机器 `git pull` 即可。
- 全局指令：改 `qwen/QWEN.md`（软链接即时生效于新会话），提交推送；其他机器 `git pull` 即可。内容保持短而具体，项目专属内容写各项目的 QWEN.md。
- skill：改 `skills/<name>/`（重启 Qwen Code 生效），提交推送；其他机器 `git pull` 即可。新增 skill 无需重跑 init（目录已被扫描）。
- agent 定义：改 `qwen/agents/<name>.md`（软链接即时生效于新会话），提交推送；新增 agent 文件需重跑 `./init-qwen.sh` 建链接。review-agent 提示词升级后需对照内置重同步。

## 注意

- 需要 bash + python3；插件运行依赖 node（playwright 依赖按需安装：`plugins/playwright/scripts/setup.sh`）。
- 本机设置必须是标准 JSON；脚本不处理手写的 `//` 注释。
- 设置变更重启 Qwen Code 生效；插件变更可用 `/reload-plugins`；shell 包装新开终端生效；全局 QWEN.md 新会话加载（`/memory` 可查看）。
- 主题包装依赖 zsh（注册进 `~/.zshrc`）；bash-only 机器不生效，主题回退默认。
