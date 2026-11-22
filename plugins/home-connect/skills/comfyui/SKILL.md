---
name: comfyui
description: Use when the user asks to generate images with ComfyUI on the home WSL machine — txt2img, anime illustration generation, or checking generation results/available models. 触发词：ComfyUI、生图、画一张、txt2img、出图、WSL 生图、可用模型/LoRA；症状：要生成/修改 anime 图、要看生图结果、ComfyUI 队列或输出问题。
---

# WSL ComfyUI 生图（comfyui MCP 服务）

生图只用本服务的工具；连接层与 home-connect 共享（LAN 直连/中继自动选路、WSL 自动唤醒），**不要自己拼 ssh/curl 到 WSL**。连接异常先用 home 服务的 `home_status` 诊断。从 Civitai 下载模型资源用 `comfyui-download` skill。

## 工具

| 工具 | 用途 |
|---|---|
| `comfyui_generate` | 生图并取回本地；返回 `localPath` 可直接 read_file 查看 |
| `comfyui_list` | 查询可用模型（附绑定状态 `bound`）、LoRA、放大模型；选名字前先查，不要猜 |

## 控制面（仅这些）

| 参数 | 说明 |
|---|---|
| `prompt` / `negativePrompt` | 正/负向提示词，自动补丁条件节点 |
| `model` | 模型名；默认 `oneObsessionAnima_v40.safetensors`；`bound=false` 的模型会被拒绝 |
| `width` / `height` | 基础分辨率 |
| `upscale` | 超分**净倍率**：1=仅基础分辨率（bypass 超分链），2=最终 2 倍；默认取模型绑定值 |
| `lora` | LoRA 名；`none`=零强度 bypass；省略=用 workflow 自带 LoRA |
| `timeoutSec` | 运维超时，默认 600 |

**模型 → workflow 绑定内置于工具实现，agent 不感知也不传 workflow**：不同模型自动用各自绑定的图（含采样细节 steps/cfg/sampler/scheduler/denoise）。seed 由工具内部随机。其余一切细节由 workflow json 控制。

当前绑定：`oneObsessionAnima_v40` → 仓内 `workflows/anima-interaction-single.json`（抄自 yugang `src/tools/draw/workflow-interaction-single.json`，单角色 + LoRA + 4x 超分链，默认 2 倍；原图 remap-tag LoRA 节点已适配为 LoraLoader）；`Moody-Krea2-Mix-v7-fp8` → 仓内 `workflows/krea2-moody-v7.json`（Krea2 管线：无超分链、无 LoRA、负向为零化条件——传 `negativePrompt`/`lora`/`upscale>1` 会报错）。

## 边界

- 中继按流量计费：大图/多图优先在家庭 LAN 内生成。
- 超时返回带 `promptId`：任务可能仍在队列/运行中，稍后查 `/history` 而非盲目重试。
- 图校验失败返回 `node_errors`（含可用模型清单）；据此改参数，不要猜名字。
- ComfyUI 未运行时自动经 `~/.config/comfy-start.sh` 启动。
- 示例：`{"prompt": "masterpiece, best quality, 1girl, solo, countryside, sunset", "upscale": 2}`。
