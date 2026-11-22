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