# remote-terminal：通用 tmux 远程终端与公网中继

把本机**任意 tmux 会话**（`pi`、`qwen`、`agy`、`claude`、普通 shell、开发服务器或任意 TUI）通过手机浏览器安全操控。

- **局域网模式（`lan`）**：本机 `web-server`（Node + `node-pty` + `xterm.js`）attach tmux，手机浏览器直连。
- **公网模式（`public`）**：兼容现有 ECS `pi-relay-server`（v0.1.2 / 协议 v2），本机出站 WSS 常连接 → ECS 透明中继 → 手机浏览器；家里零入站端口、6 位配对码本机审批、多 Mac 聚合会话列表、同网段自动局域网直连。
- **零侵入本仓状态**：所有本机配置、CA、可信设备列表与运行日志统一落在 `~/.harness-remote/`（`HARNESS_REMOTE_DIR` 可覆盖），绝不污染 Git 工作区。

## 初始化

```bash
./init-remote.sh           # 安装 remote-terminal 依赖、检查 tmux、注册 shell 包装到 ~/.zshrc
source ~/.zshrc
```

## 日常使用

```bash
# 启动任意可远程接入的会话
rt                         # 交互式 shell 会话
rt pi                      # Pi 会话（自动保留 session-owner）
rt qwen                    # Qwen 会话（自动保留系统明暗主题）
rt agy                     # AGY 会话
rt -n dev npm run dev      # 自定义会话名启动任意命令

# 远程访问与设备管理（rtctl）
rtctl status               # 查看 exposure、web-server/agent 状态、设备数与访问 URL
rtctl ls                   # 列出当前所有可接入的 tmux 会话
rtctl ensure               # 按 ~/.harness-remote/config.json 启停服务
rtctl stop                 # 停止本机 web-server 与 relay-agent
rtctl join                 # 交互式接入 ECS 公网中继（写入 config.json + fetch-ca + ensure + status）
rtctl fetch-ca             # 下载并按指纹校验中继根 CA
rtctl devices              # 查看待批准与可信设备
rtctl approve <配对码> [--name 名称]
rtctl deny <配对码>
rtctl revoke <设备id>      # 即时切断该设备存量连接
```

## 本机配置（`~/.harness-remote/config.json`）

可从 [config.example.json](file:///Users/leshi.zhy/harness-config/remote-terminal/config.example.json) 复制：

| `webExposure` | 行为 |
|---|---|
| 缺失 / `"off"` | 默认关闭；`ensure` 停止本机 `web-server` 与 `relay-agent` |
| `"lan"` | 仅局域网访问（`0.0.0.0:7681`，可选 `HARNESS_REMOTE_TOKEN`） |
| `"public"` | 公网 ECS 中继 + 同网段局域网直连（自动生成内部 `web-token` 与回环豁免） |

## 从旧 `pi-config` 迁移（保留已批准手机免重配）

```bash
mkdir -p ~/.harness-remote && chmod 700 ~/.harness-remote
cp ~/pi-config/var/pi-relay/{devices.json,root-ca.crt,web-token} ~/.harness-remote/ 2>/dev/null || true
# 把 ~/pi-config/pi/settings.local.json 中的 webExposure 与 webRelay 写入 ~/.harness-remote/config.json
rtctl ensure && rtctl status
```
