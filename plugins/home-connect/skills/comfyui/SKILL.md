---
name: comfyui
description: Use when the user asks to generate images with ComfyUI on the home WSL machine — txt2img, anime illustration generation, workflow runs, or checking generation results. 触发词：ComfyUI、生图、画一张、txt2img、出图、WSL 生图、跑个 workflow；症状：要生成/修改 anime 图、要看生图结果、ComfyUI 队列或输出问题。
---

# WSL ComfyUI 生图（comfyui MCP 服务）

生图只用本服务的 `comfyui_generate` 工具；连接层与 home-connect 共享（LAN 直连/中继自动选路、WSL 自动唤醒），**不要自己拼 ssh/curl 到 WSL**。连接异常先用 home 服务的 `home_status` 诊断。

## 工具

| 工具 | 用途 |
|---|---|
| `comfyui_generate` | 提交图到 WSL ComfyUI、轮询完成、把输出取回本地；返回 `localPath` 可直接 read_file 查看 |

## 默认行为

- 默认图：WSL 侧 `~/anima-lab/graph-single1.json`（单角色 txt2img + hires fix + 3D pose 控制 + LoRA）。
- `workflowPath` 或内联 `workflow`（**API 格式**，UI 图需先“导出 API”）可换任意图。
- `prompt` / `negativePrompt` 自动补丁正/负向条件节点（沿采样器链接回溯 CLIPTextEncode）。
- `seed` 默认每个采样器独立随机；指定可复现。`steps` / `cfg` / `sampler` / `scheduler` / `denoise` / `width` / `height` / `checkpoint` / `lora` 按需覆盖；pose `scene_json` 不动。
- `filenamePrefix` 默认 `home-connect/<时间戳>`，不污染既有 output 系列。
- ComfyUI 未运行时经 `~/.config/comfy-start.sh` 自动启动（`autostart=false` 关闭）；整体超时 `timeoutSec` 默认 600。
- 输出默认取回 `<运行时根>/.remote-files/comfyui/`；`fetch=false` 仅返回远端路径。

## 边界

- 中继按流量计费：大图/多图优先在家庭 LAN 内生成。
- 超时返回带 `promptId`：任务可能仍在 ComfyUI 队列/运行中，稍后查 `/history` 而非盲目重试。
- 图校验失败会返回 `node_errors`（含可用模型清单）；据此改 `checkpoint`/`lora` 等参数，不要猜模型名。
- 示例：`{"prompt": "masterpiece, best quality, 1girl, solo, countryside, sunset", "steps": 30}`。
