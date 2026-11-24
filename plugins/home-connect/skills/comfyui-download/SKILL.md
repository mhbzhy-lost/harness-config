---
name: comfyui-download
description: Use when the user asks to download models, LoRAs, upscalers or VAEs from Civitai (or other URLs) into the home WSL ComfyUI model directories. 触发词：civitai、下载模型、下 LoRA、下载超分/VAE、模型资源、civitai token；症状：要给 ComfyUI 补模型、找不到某个模型/LoRA 需要下载。
---

# Civitai 模型下载（经 home-connect wsl 通用操作）

**没有专用 MCP 工具**：资源类型繁多，不用 MCP schema 限制死。直接用 `home_exec`（target=wsl；在 Antigravity 下若暴露 `home_exec_bg`，大文件下载优先用 `home_exec_bg` 后台异步执行）执行 curl 等命令完成下载；本 skill 只约定 token、目标目录与流程。生图/查询用 `comfyui` skill。

## Token

- 位置：WSL 侧 `~/.config/civitai/token`——**纯 token 文本**（无 `KEY=` 前缀），目录 700、文件 600。
- 用法：远程命令里 `TOKEN=$(cat ~/.config/civitai/token)` 后 `curl -H "Authorization: Bearer $TOKEN" ...`；**不要回显、打印 token，也不要拼进 `?token=` URL（会进日志）**。
- 缺失时（新机器）向用户索取，经 `home_exec` 写入：`mkdir -p ~/.config/civitai && chmod 700 ~/.config/civitai`，写文件后 `chmod 600`；写入命令本身不要带 echo/cat 回显。

## 目标目录（共享模型根）

模型经 `extra_model_paths.yaml` 挂在共享根 `~/anima-lab/models/`，**lab 与 prod 两个 ComfyUI 实例都可见**；下载到这里一次生效两边：

| Civitai 类型 | 子目录 |
|---|---|
| Checkpoint / Diffusion model | `Stable-diffusion` |
| LORA | `Lora` |
| Upscaler | `ESRGAN` |
| VAE | `VAE` |
| TextEncoder | `text_encoder` |

（prod 实例另有 `~/anima-prod/models/*` 私有根；仅当用户明确要 prod 私有时才放那里。）

## 流程

1. 定位资源：已知 model-version id 直接用；否则搜索
   `curl -s -H "Authorization: Bearer $CIVITAI_TOKEN" "https://civitai.com/api/v1/models?query=<名字>&limit=5"`，
   再 `GET /api/v1/model-versions/<id>` 拿 `files[]`（name / downloadUrl / sizeKB / hashes.SHA256）与 `type`。
2. 选文件：优先 `.safetensors`；精度按用户要求（fp16/fp8）。目标路径 = 共享根/类型子目录/`files[].name`。
3. 下载（**在 WSL 侧直连外网**，不经过 home-connect 中继，大文件无流量计费顾虑）：
   `curl -L -H "Authorization: Bearer $CIVITAI_TOKEN" -o <目标路径> <downloadUrl>`；
   先 `mkdir -p` 子目录；断点续传加 `-C -`。
4. 校验：本地 `stat` 大小与 API `sizeKB` 对比；可选 `sha256sum` 对比 `hashes.SHA256`。
5. 生效验证：`comfyui_list` 看新资源是否出现（object_info 会重扫目录）；未出现再考虑重启实例（`~/.config/comfy-start.sh`）。
6. 可选 sidecar：用户目录惯例保存 `<name>.civitai.info` / `.json` / `.preview.png`（API 响应与 images 字段），便于追溯。

## 边界

- 不在本地 Mac 下载再上传（双程浪费）；一切在 WSL 侧完成。
- 同名文件已存在时先问用户覆盖与否，不要静默覆盖。
- 非 Civitai 直链（如 HuggingFace）同样流程：`home_exec` wsl curl 到对应子目录；HF  gated 资源需用户提供的 token 同理存放。
- 下载完成后提醒：新模型若要用于 `comfyui_generate`，需先在工具实现中补 model→workflow 绑定（`bound=false` 会被拒绝）。
