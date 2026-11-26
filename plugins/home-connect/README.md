# home-connect-mcp

Agent Plugins 1.0.0 包：把家中 Mac / Windows / WSL 的连接能力收敛成 MCP 工具，替代原来的「连接 CLI + 踩坑手册」组合。

## 包结构（仓内真身）

插件真身在仓内 `plugins/home-connect/`，由 `init-qwen.sh` / `init-pi.sh` / `init-agy.sh` 软链到各运行时的插件目录（Qwen `~/.qwen/extensions/`、Pi `~/.agents/plugins/`、AGY `~/.gemini/config/plugins/`）；凭据放在插件目录内已 gitignore 的位置，不入库：

```text
plugins/home-connect/
├── plugin.json                  # Agent Plugins 清单（name: home-connect）
├── mcp.json                     # Qwen / Pi 用：两个 stdio server（home → src/server.ts，comfyui → src/server-comfyui.ts）
├── mcp_config.json              # AGY 原生模式用：${PLUGIN_ROOT} 定位同一对 server，并开启 HOME_CONNECT_AGY_ASYNC
├── src/server.ts                # home MCP stdio 服务端，通道/引号/重试/截断都在这里
├── src/server-comfyui.ts        # comfyui MCP stdio 服务端（独立入口）
├── src/server-http.ts           # 宿主模式 Streamable HTTP 入口（见下文）
├── scripts/                     # connect.sh 入口 + 8 个通道脚本 + deploy-host.sh / host-cert.sh
├── skills/                      # home-connect / comfyui / comfyui-download 三个 skill
└── README.md
```

凭据与主机事实（`.env`、`.ssh/`、`config/*.env`、`.remote-files/`；宿主模式另有 `host.json`、`tls/`）均放在仓内插件目录的 gitignore 位置，`config/` 只保留 `*.example` 模板。连接层 `src/connection.ts` 以 `RUNTIME_ROOT`（`$HARNESS_CONFIG_ROOT/plugins/home-connect`，无锚点时回退插件自定位）作为配置/身份根，并以 `HOME_CONNECT_ROOT` 传给脚本；脚本缺该变量时同样回退到自身目录的上一级。

## 工具面

`mcp.json` 定义两个独立 stdio server，工具面分别如下：

| server | 工具 | 说明 |
|---|---|---|
| `home`（`src/server.ts`） | `home_status` | Tailscale 在线、是否在家（LAN）、目标通道可达性、实际走 LAN 还是中继 |
| | `home_exec` | 通道内执行平台原生命令：`windows`=PowerShell，`mac`/`wsl`=bash；真实退出码 |
| | `home_copy` | 文件传输：mac 上传走 LAN、下载按 LAN 选路；windows 仅上传（多文件用 `files` 批量模式，单条 sftp 会话）；wsl 双向。同一时刻只允许一个 copy 任务（含批量），并发立即报错 |
| | `home_wake` | 显式唤醒 WSL（`home_exec` 已自动重试一次） |
| | `home_reset` | 救援工具：终止 home-connect 正在执行的远程命令/传输，清理本机 SSH ControlMaster 复用状态（卡死或 `Session open refused by peer` 时调用） |
| | `home_exec_bg` / `home_copy_bg` | 仅 `HOME_CONNECT_AGY_ASYNC=1` 时暴露（AGY 经 `mcp_config.json` 启用，并标记 `background: always`）：长时命令/大文件传输交由 Antigravity 宿主作为后台任务执行、完成后唤醒主会话 |
| `comfyui`（`src/server-comfyui.ts`） | `comfyui_generate` / `comfyui_list` | 文生图与结果/模型列表；与 home server 独立入口、共用连接层 |

## Pi 侧加载方式

仓库侧的 Agent Plugins 客户端 `pi/extensions/agent-plugins/`（由 `init-pi.sh` 注入 `~/.pi/agent/settings.json`）启动时：

1. 扫描 `~/.agents/plugins/*/plugin.json`（可用 `AGENT_PLUGINS_HOME` 覆盖）
2. 校验清单、收集 `skills/*/SKILL.md` → 经 `resources_discover` 注入
3. 解析根 `mcp.json` → `pi.registerMcpServer()` 内存注册（不写投影文件、不维护信任状态）

因此没有 `<agentDir>/plugins` 桥、没有 `state.json`；任何启动入口（TUI、headless、pi-web）行为一致。

迁移到另一台机器：`git clone` 本仓后重跑对应 init 脚本即可，凭据按 `.gitignore` 约定的位置手工放置，不随仓库同步。

## 验证

```bash
cd plugins/home-connect
# 直接向 stdio server 发 JSON-RPC（不经任何运行时），取 tools/list 的回包
rpc() { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | "$@" | tail -1; }
rpc node src/server.ts                                  # home_status home_exec home_copy home_wake home_reset
rpc env HOME_CONNECT_AGY_ASYNC=1 node src/server.ts     # AGY 异步模式额外暴露 home_exec_bg / home_copy_bg
rpc node src/server-comfyui.ts                          # comfyui_generate comfyui_list

# 异步工具面回归测试
node --test tests/test_home_connect_async.mjs

# 经运行时加载：Pi 会话内输入 /mcp，应看到来源为 agent-plugins 扩展的 home 与 comfyui。
# 注意 `pi mcp list --json`（PI_CODING_AGENT_DIR 可指定配置根目录）不加载扩展、只读 <配置根>/mcp.json，
# 看不到由扩展注册的 server，不能用它判定本插件是否生效。
```

## 宿主模式：给手机端 agent 的远程 HTTP 入口

手机端 agent 没有 bash 环境，也不该持有 ssh 凭据，所以需要一个跑在家中 mac 上的 remote MCP server。
它不另写一份工具：`src/server-http.ts` 直接 import stdio 版的同一份 `HOME_TOOLS` / `COMFYUI_TOOLS` 与
连接层，只是把传输换成 Streamable HTTP。home 与 comfyui 仍是两个独立 server，挂在同一监听的两条路径上。

| 路径 | 内容 |
|---|---|
| `/home` | `home_status` / `home_exec` / `home_copy` / `home_wake` / `home_reset` |
| `/comfyui` | `comfyui_generate` / `comfyui_list`；图片随结果内联为 image 内容块（远端读不到 localPath） |
| `/ca.crt` | 公开（不需要 token）下发中继路的 CA 证书，手机浏览器打开即下载 |

`HOME_CONNECT_HOST=mac` 时的连接方式（与 stdio 版的差别只在「这台机器在哪」）：

- `mac` 目标就是本机，直接执行，不经 ssh
- `windows` 只走 LAN，用 `HOME_CONNECT_WIN_KEY` 指向 mac 上已有的密钥（不新增凭据，也没有中继备路）
- `wsl` 没有密钥，经 Windows 的 `wsl.exe`（`scripts/wsl-via-win.sh`）；Windows OpenSSH 默认 shell 是 cmd.exe，
  **单引号不成组**，交互走 stdin、文件走 base64
- ComfyUI 从本机直连 `COMFYUI_URL`（默认 mac 上到 WSL 的回环隧道 `127.0.0.1:18190`，只接受回环地址）

### 两条接入路径

| 路径 | 地址 | 加密 |
|---|---|---|
| 局域网 | `http://<mac 局域网 IP>:8787` | 无（与旧 server 相同，仅家庭网络内可达） |
| 中继 | `https://<中继公网 IP>:18787` | TLS 在 mac 上终结，frp 只转发密文（`transport.useEncryption`），与 stdio 版 SSH 同级 |

中继路的证书由 `scripts/host-cert.sh` 自建 CA 签发（**必须用 RSA**：macOS 自带 LibreSSL 生成的 EC 公钥带显式曲线参数，
现代客户端一律拒绝）。手机端需安装 `tls/ca.crt`（`GET /ca.crt` 可取）。
CA 指纹在服务启动日志里，装的时候核对。`home_status` 与 `GET /` 都会返回两条地址和本次请求走的那条。
服务端替客户端选不了路：手机上要配两个 server，或在家庭网络内外切换地址。

### 部署与回滚（在开发机上跑，不在家庭局域网也可）

```bash
plugins/home-connect/scripts/deploy-host.sh                # 上传 → 临时端口冒烟（含 windows/wsl）→ 切换 launchd
plugins/home-connect/scripts/deploy-host.sh --no-restart   # 只上传并冒烟
```

远端只有这一份代码：由本脚本从仓库同步，不在 mac 上另改。包经 `connect.sh mac sh` 的 stdin 传送，
只含代码与公开主机信息（`lan.env` / `windows.env` / `known_hosts`），不含私钥。
远端目录是 `~/home-connect-host`，脚本开头有硬闸：目录必须在家目录之下，`mkdir` / `cd` 任一失败即停。
首次部署会在远端 `npm install` MCP SDK 并生成随机 token（只写进 `host.json`，不打印）。

- 冒烟不过不切换；切换后起不来自动回滚到上一次的 plist（`~/Library/LaunchAgents/com.home-mac-mcp.plist.prev`）
- 手工回滚：`launchctl bootout gui/$(id -u)/com.home-mac-mcp && launchctl bootstrap gui/$(id -u) <那个 .prev>`
- 首次签证书：在 mac 上 `bash scripts/host-cert.sh tls <中继公网IP> <局域网IP>`，再部署一次
- frp 代理 `home-mac-mcp`（`localPort 8788 → remotePort 18787`）写在 mac 的 `~/.frp/frpc.toml`，
  云安全组需放行 18787 入方向；改完重启 `com.home.frpc`
