---
name: home-connect
description: Use when the user asks to connect to or operate the home machines — home Mac, home Windows, or its WSL Ubuntu, or to generate images with ComfyUI on WSL. Triggers include unreachable home machines, remote command failures, sleeping WSL, or files that must be transferred to/from home. 触发词：家中 Mac、家里 Windows、WSL、回家中机器、Tailscale、remote-mac、ComfyUI 生图；症状：家里机器连不上、远程命令超时或失败、WSL 休眠、要往家里传文件或从家里取文件。
---

# 家中设备连接（MCP 通道）

家中设备只用本插件的 MCP 工具，**不要自己拼 ssh / scp / tailscale / PowerShell 命令**，也不要读别的连接脚本。工具已内置通道选择、引号处理、连接复用、WSL 唤醒重试与输出截断。

仅覆盖家中三台设备；云服务器等其他主机用各自的 skill（如 aliyun-*-server），不要用本插件。

## 工具

| 工具 | 用途 |
|---|---|
| `home_status` | Tailscale 在线、是否在家（LAN）、指定通道可达性、实际走 LAN 还是中继 |
| `home_exec` | 在通道上执行命令：`windows` 用 PowerShell，`mac` / `wsl` 用 bash；可多行 |
| `home_copy` | 传文件：mac 上传走 LAN、下载按 LAN 选路；windows 仅上传（多文件用 `files` 批量模式，单条 sftp 会话）；wsl 双向。同一时刻只允许一个 copy 任务（含批量），并发立即报错 |
| `home_wake` | 显式唤醒 WSL（`home_exec` 已自动重试，通常无需单独调用） |
| `home_comfyui` | 驱动 WSL 上的 ComfyUI 生图并取回本地（复用 wsl 通道），见下节 |

## ComfyUI 生图（home_comfyui）

- 默认加载 WSL 侧 `~/anima-lab/graph-single1.json`（单角色 txt2img + hires fix，含 pose 控制与 LoRA）；`workflowPath` 或内联 `workflow`（API 格式）可换任意图。
- 常用参数：`prompt` / `negativePrompt`（自动补丁正/负向条件节点）、`seed`（默认随机，指定可复现）、`steps` / `cfg` / `sampler` / `scheduler` / `denoise`、`width` / `height`（不改 pose scene_json）、`checkpoint` / `lora`、`filenamePrefix`（默认 `home-connect/<时间戳>`，不污染既有系列）。
- ComfyUI 未运行时经 `~/.config/comfy-start.sh` 自动启动（`autostart=false` 关闭）；整体超时 `timeoutSec` 默认 600。
- 输出默认经连接层取回 `<运行时根>/.remote-files/comfyui/`，返回含 `localPath`，可直接用 read_file 查看；`fetch=false` 仅返回远端路径。
- 中继按流量计费：大图/多图优先在家庭 LAN 内生成；超时返回会带 `promptId`，可稍后查 `/history` 而非盲目重试。
- 示例：`{"prompt": "masterpiece, best quality, 1girl, solo, countryside, sunset", "steps": 30}`。

## 执行顺序

1. 连不上先 `home_status`（可带 `target`），拿到网络层结论与通道可达性。
2. 再 `home_exec` 执行平台原生命令；命令按原样传，不要做 shell 转义包装。
3. 报告时区分「网络可达」与「认证/命令成功」两层结论，以退出码为准。

## 边界

- 大文件不要走中继（按流量计费）；远端能直连下载就在远端发起。
- Windows 远程只支持盘符绝对路径且不含空格；含空格先改名。
- 凭据、私钥、主机地址由服务端从 `home-connect` 的 config/.ssh 读取，不要读取、打印或复制它们。