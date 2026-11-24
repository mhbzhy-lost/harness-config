---
name: home-connect
description: Use when the user asks to connect to or operate the home machines — home Mac, home Windows, or its WSL Ubuntu. Triggers include unreachable home machines, remote command failures, sleeping WSL, or files that must be transferred to/from home. 触发词：家中 Mac、家里 Windows、WSL、回家中机器、Tailscale、remote-mac；症状：家里机器连不上、远程命令超时或失败、WSL 休眠、要往家里传文件或从家里取文件。
---

# 家中设备连接（MCP 通道）

家中设备只用本插件的 MCP 工具，**不要自己拼 ssh / scp / tailscale / PowerShell 命令**，也不要读别的连接脚本。工具已内置通道选择、引号处理、连接复用、WSL 唤醒重试与输出截断。

仅覆盖家中三台设备；云服务器等其他主机用各自的 skill（如 aliyun-*-server），不要用本插件。

## 工具

| 工具 | 用途 |
|---|---|
| `home_status` | Tailscale 在线、是否在家（LAN）、指定通道可达性、实际走 LAN 还是中继 |
| `home_exec` | 在通道上执行命令：`windows` 用 PowerShell，`mac` / `wsl` 用 bash；可多行（短时命令首选） |
| `home_exec_bg` | **仅 Antigravity 暴露**：后台异步执行长时远程命令（下载、编译、安装、长脚本等，默认不设本地超时），完成后由宿主自动唤醒；其他环境沿用 `home_exec` |
| `home_copy` | 传文件：mac 上传走 LAN、下载按 LAN 选路；windows 仅上传（多文件用 `files` 批量模式，单条 sftp 会话）；wsl 双向。同一时刻只允许一个 copy 任务（含批量），并发立即报错 |
| `home_copy_bg` | **仅 Antigravity 暴露**：后台异步大文件/批量传输（共享同一单飞传输门禁，不设本地超时）；其他环境沿用 `home_copy` |
| `home_wake` | 显式唤醒 WSL（`home_exec` 已自动重试，通常无需单独调用） |
| `home_reset` | 救援：终止本插件正在执行的远程命令/传输、清理 SSH ControlMaster；不终止远端脱离 SSH 的后台任务 |

WSL ComfyUI 生图是独立的 `comfyui` skill 与 MCP 服务（`comfyui_generate`），不在本 skill 范围。

## 执行顺序

1. 连不上先 `home_status`（可带 `target`），拿到网络层结论与通道可达性。
2. 再 `home_exec` 执行平台原生命令；命令按原样传，不要做 shell 转义包装。
3. 报告时区分「网络可达」与「认证/命令成功」两层结论，以退出码为准。

## 边界

- 大文件不要走中继（按流量计费）；远端能直连下载就在远端发起。
- Windows 远程只支持盘符绝对路径且不含空格；含空格先改名。
- 凭据、私钥、主机地址由服务端从 `home-connect` 的 config/.ssh 读取，不要读取、打印或复制它们。