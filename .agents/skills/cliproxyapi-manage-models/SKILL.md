---
name: cliproxyapi-manage-models
description: Use when adding, updating, or troubleshooting Qwen Code (~/.qwen/settings.json) or Pi (~/.pi/agent/models.json) model definitions routed through CLIProxyAPI (127.0.0.1:8317 or custom CLIProxyAPI endpoints), including baseUrl /v1 or /v1beta 404 mismatches, protocol routing, or local dummy API key setup.
---

# 为 CLIProxyAPI 编写 Qwen Code 与 Pi 模型定义

## Overview

CLIProxyAPI 只暴露本地或自定义 HTTP 协议端点，不会自动向 Qwen Code 或 Pi 注册模型；两个运行时均需在本机配置文件中静态声明模型定义，且**不同运行时 × 不同协议的 `baseUrl` 后缀规则相反**（尤其 Anthropic 与 Gemini 极易配错导致 404）。

**红线（硬约束）**：
- 模型定义与占位/真实凭据均为 **per-machine 配置**：写入 `~/.qwen/settings.json` 与 `~/.pi/agent/models.json`，**严禁**写入仓库模板 `qwen/settings.json`、`pi/settings.json` 或提交入库。
- **严禁**读取或输出 `~/.qwen/cliproxyapi/auth/*.json`、`~/.pi/agent/auth.json` 或任何真实 API Key / OAuth token。
- 不自动改写 `~/.pi/agent/settings.json` 中的 `enabledModels`，除非用户明确要求。

## Quick Reference：协议与 `baseUrl` 对照表

假设 CLIProxyAPI 监听 `<HOST>`（本机默认 `http://127.0.0.1:8317`）：

| 上游/目标协议 | Qwen Code (`modelProviders.<key>`) | Qwen Code `baseUrl` | Pi (`api`) | Pi `baseUrl` | 关键原因 |
|---|---|---|---|---|---|
| OpenAI Chat Completions | `openai` | `<HOST>/v1` | `openai-completions` | `<HOST>/v1` | 两者 OpenAI SDK 均追加 `/chat/completions` |
| OpenAI Responses（推荐 Codex） | `openai` + `"wireApi": "responses"`（或 `openai-responses`） | `<HOST>/v1` | `openai-responses` | `<HOST>/v1` | Qwen 会剥离末尾 `/v1` 再拼 `/v1/responses`；Pi 追加 `/responses` |
| Anthropic Messages（推荐 Claude） | `anthropic` | `<HOST>`（**不带 `/v1`**） | `anthropic-messages` | `<HOST>`（**不带 `/v1`**） | 两者均直接调 `@anthropic-ai/sdk` `post("/v1/messages")`，带 `/v1` 会拼成 `/v1/v1/messages` 404 |
| Gemini（推荐 Gemini / Antigravity Gemini） | `gemini` | `<HOST>`（**不带 `/v1beta`**） | `google-generative-ai` | `<HOST>/v1beta`（**必须带 `/v1beta`**） | Qwen 保留 `@google/genai` 默认 `apiVersion="v1beta"`；Pi 在设 `baseUrl` 时显式清空 `apiVersion=""` |

> **切勿盲信 Qwen 内置 `model-providers.md` 示例中的 `anthropic` `baseUrl: ".../v1"`**：实测 Qwen Code `AnthropicContentGenerator` 直接将 `baseUrl` 传入 `@anthropic-ai/sdk`，不剥离 `/v1`。

## Step 1：先确认真实模型 ID（不要猜测）

未拿到确切模型 ID 前，先从运行中的 CLIProxyAPI 查询 `/v1/models`：

```bash
# 查看本机 cliproxyapi 状态（Qwen 与 Pi 共用，懒加载）；未运行时可手动 start
python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py status
python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py start

# 列出当前已登录凭据暴露的全部真实模型 ID（仅含 id/owned_by，不含凭据）
curl -s http://127.0.0.1:8317/v1/models
```

若 CLIProxyAPI 配置了 `access.api-keys`，调用 `/v1/models` 需由用户本机环境带鉴权头查询，或直接让用户提供模型 ID。

## Step 2：Qwen Code（`~/.qwen/settings.json`）

### 规则与字段
- **占位 key**：本机回环未配 `access.api-keys` 时，在 `env` 中设 `"CLIPROXYAPI_API_KEY": "local"`，模型条目用 `"envKey": "CLIPROXYAPI_API_KEY"`。若配了真实 `access.api-keys`，让用户自行配置环境变量或 `settings.json`，代理不要请求或回显真实密钥。
- **内置协议分组 vs 自定义分组**：
  - 直接放在 `modelProviders.openai` / `modelProviders.anthropic` / `modelProviders.gemini` 时，无需 `providerProtocol`。
  - 若使用自定义 provider 名（如 `cliproxyapi-claude`、`cliproxyapi-gemini`），**必须**同步在顶层 `providerProtocol` 映射到内置协议（仅允许 `"openai"` / `"anthropic"` / `"gemini"` 等内置 `AuthType`）。
- **`wireApi`**：`"wireApi": "responses"` **仅**适用于 `openai` / `openai-responses` 协议；严禁写到 `anthropic` 或 `gemini` 条目下。
- **上下文窗口与能力字段**：Qwen Code 使用 `generationConfig.contextWindowSize`（**不是** `contextWindow`）、`generationConfig.samplingParams`、`capabilities.vision`。
- **写入方式**：先备份 `~/.qwen/settings.json`，用 `python3` 做 JSON 往返合并并原子替换（权限 `0600`），保留已有 provider、hooks 与其他配置；不得使用带 `//` 注释的非标准 JSON。

### 参考配置片段（Qwen Code）

```json
{
  "env": {
    "CLIPROXYAPI_API_KEY": "local"
  },
  "providerProtocol": {
    "cliproxyapi-claude": "anthropic",
    "cliproxyapi-gemini": "gemini"
  },
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-5.3-codex",
        "name": "[Codex] GPT-5.3 Codex",
        "baseUrl": "http://127.0.0.1:8317/v1",
        "envKey": "CLIPROXYAPI_API_KEY",
        "wireApi": "responses",
        "generationConfig": {
          "contextWindowSize": 272000
        }
      }
    ],
    "cliproxyapi-claude": [
      {
        "id": "claude-sonnet-4-6",
        "name": "[Claude] Claude Sonnet 4.6",
        "baseUrl": "http://127.0.0.1:8317",
        "envKey": "CLIPROXYAPI_API_KEY",
        "generationConfig": {
          "contextWindowSize": 200000,
          "samplingParams": { "max_tokens": 16384 }
        }
      }
    ],
    "cliproxyapi-gemini": [
      {
        "id": "gemini-2.5-pro",
        "name": "[Gemini] Gemini 2.5 Pro",
        "baseUrl": "http://127.0.0.1:8317",
        "envKey": "CLIPROXYAPI_API_KEY",
        "capabilities": { "vision": true },
        "generationConfig": {
          "contextWindowSize": 1000000,
          "samplingParams": { "max_tokens": 65536 }
        }
      }
    ]
  }
}
```

修改后需**重启 Qwen Code**，再通过 `/model` 切换。

## Step 3：Pi（`~/.pi/agent/models.json`）

**REQUIRED BACKGROUND**：涉及 Pi `models.json` 的凭据边界、字段规范或安全 `/dev/tty` 录入真实密钥时，遵循 `pi-manage-provider` 技能约定。

### 规则与字段
- **凭据与占位 key（两种情况区分）**：
  - **本机无 `access.api-keys` 的回环代理**（`127.0.0.1:8317`）：Pi 要求 provider 有可解析的认证才会在 `/model` 显示模型；此时可在 provider 上直接写非敏感占位 `"apiKey": "local"`（`pi-manage-provider` 的 `manage-providers.py` 有意不提供 `--api-key` 参数，因此该占位字段需直接对 `models.json` 做最小 JSON 写入）。
  - **已启用 `access.api-keys` 的代理**（含远程代理）：**严禁**把真实密钥写入 `models.json` 或命令行；改用 `"apiKey": "$CLIPROXYAPI_API_KEY"`（要求启动 Pi 的 shell 已导出该变量），或运行 `pi-manage-provider` 的 `set-key <provider>` 由人类在 `/dev/tty` 录入 `~/.pi/agent/auth.json`。
- **分组策略**：推荐按协议拆分为独立 provider（如 `cliproxyapi-codex`、`cliproxyapi-claude`、`cliproxyapi-gemini`），每个 provider 固定自己的 `api` 与 `baseUrl`，避免同组下混用不同 `baseUrl` 规则；也支持单 provider 内在各 model 上单独覆盖 `api` 和 `baseUrl`。
- **模型字段**：`id`（必填，发给 API 的真实 ID）、`name`、`reasoning`（布尔）、`input`（`["text"]` 或 `["text", "image"]`）、`contextWindow`、`maxTokens`、`cost`（订阅 OAuth 代理填全 `0` 即可，四项 `input`/`output`/`cacheRead`/`cacheWrite` 须齐全）。
  - **不要**添加非 schema 字段（如 `"type": "chat"`、`actualModelId`、`metadataUserId`）。
  - **不要**凭“这是代理”猜测开启 `compat` 开关；仅在实测请求报错确认差异后再按 Pi `models-configuration.md` 精确添加。
- **生效方式**：Pi 中打开 `/model` 即热重载 `~/.pi/agent/models.json`，无需重启。

### 参考配置片段（Pi）

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "cliproxyapi-codex": {
      "name": "CLIProxyAPI Codex",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "api": "openai-responses",
      "apiKey": "local",
      "models": [
        {
          "id": "gpt-5.3-codex",
          "name": "[Codex] GPT-5.3 Codex",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "cliproxyapi-claude": {
      "name": "CLIProxyAPI Claude",
      "baseUrl": "http://127.0.0.1:8317",
      "api": "anthropic-messages",
      "apiKey": "local",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "name": "[Claude] Claude Sonnet 4.6",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "cliproxyapi-gemini": {
      "name": "CLIProxyAPI Gemini",
      "baseUrl": "http://127.0.0.1:8317/v1beta",
      "api": "google-generative-ai",
      "apiKey": "local",
      "models": [
        {
          "id": "gemini-2.5-pro",
          "name": "[Gemini] Gemini 2.5 Pro",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 65536,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

### Pi 代理生命周期提醒
`cliproxyapi` 为 **Qwen Code 与 Pi 双端统一懒加载、退出不自动回收**：
- Qwen Code：`SessionStart` hook（由 `init-qwen.sh` 注入）调用 `manager.py start` 按需拉起。
- Pi：仓内扩展 `pi/extensions/cliproxyapi`（由 `init-pi.sh` 注入）在加载与每次 `before_agent_start` 时自动懒加载——有凭据且端口未监听才调用同一个 `manager.py start`；并发合并、异常吞掉，不注册退出回收。
- 两端共用 `~/.qwen/cliproxyapi` 与 `127.0.0.1:8317`；任一端退出都**不会**杀掉代理，需停止时手动 `python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py stop`（会同时影响正在使用它的 Pi/Qwen 会话）。
- 仅在未使用本仓 Pi 扩展（如远端部署、独立机器）时才需自行启动代理（`manager.py start` 或独立常驻服务），否则会连接拒绝。

## Common Mistakes

| 误区 / 现象 | 根因 | 修复 |
|---|---|---|
| Qwen 或 Pi 走 Anthropic 协议报 `404` | `baseUrl` 末尾多写了 `/v1`，拼出 `/v1/v1/messages` | 去掉 `/v1`，改为 `http://127.0.0.1:8317` |
| Pi 走 `google-generative-ai` 报 `404` | Pi 设 `baseUrl` 时清空 `apiVersion`，未写 `/v1beta` | Pi 用 `http://127.0.0.1:8317/v1beta`；Qwen `gemini` 仍用 `http://127.0.0.1:8317` |
| Qwen 自定义 provider 名加载后被静默跳过 | 未在 `providerProtocol` 映射到内置 `AuthType` | 补齐 `providerProtocol["<id>"] = "anthropic" \| "gemini" \| "openai"` |
| Qwen 中模型上下文字段不生效 | 照搬 Pi 的 `contextWindow` 顶层字段 | Qwen 须写在 `generationConfig.contextWindowSize` |
| Pi `/model` 里看不到刚加的 provider | 无 `apiKey` 且 `auth.json` 无条目，Pi 隐藏未认证模型 | 本地无鉴权回环设 `"apiKey": "local"`；有鉴权用 `"$ENV"` 或 `pi-manage-provider` `set-key` |
| Pi 中调用报 `ECONNREFUSED 127.0.0.1:8317` | 未安装 `cliproxyapi` / `~/.qwen/cliproxyapi/auth` 无任何 `.json` 凭据（懒加载静默跳过），或未使用本仓 `pi/extensions/cliproxyapi` 扩展 | `manager.py status` 查 `credentials_present`，缺则走 `/cliproxyapi-login`；否则手动 `manager.py start` |
