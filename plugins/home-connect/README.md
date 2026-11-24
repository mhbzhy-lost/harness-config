# home-connect-mcp

Agent Plugins 1.0.0 包：把家中 Mac / Windows / WSL 的连接能力收敛成 MCP 工具，替代原来的「连接 CLI + 踩坑手册」组合。

## 包结构（本机插件目录）

```text
~/.agents/plugins/home-connect/    # 真身（本机，不入任何仓库）
├── plugin.json                  # Agent Plugins 清单（name: home-connect）
├── mcp.json                     # stdio server: node ./src/server.ts
├── src/server.ts                # MCP stdio 服务端，通道/引号/重试/截断都在这里
├── scripts/                     # connect.sh 及 6 个通道脚本
├── skills/home-connect/SKILL.md # 精简后的使用策略（31 行）
└── README.md
```

运行时目录 `~/.pi/agent/home-connect/` 只保留**配置与身份**：`config/*.env`、`.env`、`.ssh/`（私钥、known_hosts）。
脚本随插件走，两边通过 `HOME_CONNECT_ROOT` 对接；凭据与主机事实永远不进仓库。

## 工具面

| 工具 | 说明 |
|---|---|
| `home_status` | Tailscale 在线、是否在家（LAN）、目标通道可达性、实际走 LAN 还是中继 |
| `home_exec` | 通道内执行平台原生命令：`windows`=PowerShell，`mac`/`wsl`=bash；真实退出码 |
| `home_copy` | 文件传输：mac 上传走 LAN、下载按 LAN 选路；windows 仅上传（多文件用 `files` 批量模式，单条 sftp 会话）；wsl 双向。同一时刻只允许一个 copy 任务（含批量），并发立即报错 |
| `home_wake` | 显式唤醒 WSL（`home_exec` 已自动重试一次） |

传输层脚本随插件分发（`scripts/connect.sh`），配置与私钥留在运行时目录
`~/.pi/agent/home-connect/`（`config/*.env`、`.env`、`.ssh/`），两边用 `HOME_CONNECT_ROOT` 对接。
旧 skill 目录已迁出 `~/.agents/skills/`（否则会与插件同名技能冲突），并归档到
`~/.agents/backups/home-connect-20261122.tar.gz`。

## 安装（按机器，不入库）

插件是真身目录，直接放本机插件主目录：

```text
~/.agents/plugins/home-connect/          # 真身，不入任何仓库
├── plugin.json  mcp.json  src/  scripts/  skills/  README.md
```

仓库侧只保留一个自有客户端 `src/agent-plugins/`（约 400 行），启动时：

1. 扫描 `~/.agents/plugins/*/plugin.json`（可用 `AGENT_PLUGINS_HOME` 覆盖）
2. 校验清单、收集 `skills/*/SKILL.md` → 经 `resources_discover` 注入
3. 解析根 `mcp.json` → `pi.registerMcpServer()` 内存注册（不写投影文件、不维护信任状态）

因此没有 `<agentDir>/plugins` 桥、没有 `state.json`、没有 `PI_AGENT_DIR` 环境变量；任何启动入口
（TUI、headless、pi-web）行为一致。配置与私钥仍在运行时目录 `~/.pi/agent/home-connect/`
（`config/*.env`、`.env`、`.ssh/`），通过 `HOME_CONNECT_ROOT` 对接。

迁移到另一台机器：

```bash
rsync -a ~/.agents/plugins/home-connect/ other-host:.agents/plugins/home-connect/
rsync -a ~/.pi/agent/home-connect/       other-host:.pi/agent/home-connect/
```

## 验证

```bash
# 直接跑 JSON-RPC，不经过 pi
node /path/to/mcp-drive.mjs ~/.agents/plugins/home-connect/src/server.ts '[]'

# 经 pi 的投影与内置 MCP
PI_AGENT_DIR=$PWD/pi PI_CODING_AGENT_DIR=$PWD/pi node node_modules/@earendil-works/pi-coding-agent/dist/cli.js mcp list --json
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
