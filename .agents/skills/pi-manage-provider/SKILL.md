---
name: pi-manage-provider
description: Use when adding, deleting, updating, or diagnosing missing, invalid, or rejected non-sensitive Pi provider and model definitions in ~/.pi/agent/models.json. Do not inspect, retrieve, rotate, request, read, record, or repeat credentials.
---

# 管理 Pi Provider 与 Model

管理本机 Pi 的自定义模型与提供商定义。默认配置根目录是 `~/.pi/agent/`；显式设置 `PI_CODING_AGENT_DIR` 或传入 `--agent-dir <dir>` 时，以该目录为准（Pi 1.7.0 起本体同时支持 `--agent-dir <dir>` 与 `PI_CODING_AGENT_DIR`，前者优先，且 Pi 启动时会把 `--agent-dir` 写入 `PI_CODING_AGENT_DIR` 供扩展与子进程读取；1.6.x 仅识别 `PI_CODING_AGENT_DIR`；`PI_AGENT_DIR` 只是本管理脚本的兼容别名，不要依赖它传给 Pi）。

只管理 `models.json` 中不敏感的 provider/model 定义，不检查凭据，不调用真实 provider。`models.json` 与 `auth.json` 均为本机配置，不提交、不跨机器同步；`settings.json` 中的 `enabledModels` 同样是本机选择，不因新增定义自动改写。

## 操作

使用本 skill 目录下的 `manage-providers.py`（从任意工作目录调用时使用脚本的真实绝对路径）：

```bash
SCRIPT="<本 skill 目录>/manage-providers.py"

# 查看定义，不读取 auth.json，也不判断认证是否可用
python3 "$SCRIPT" list

# 添加非敏感 provider 定义；不会设置凭据
python3 "$SCRIPT" add-provider deepseek-example \
  --api openai-completions \
  --base-url https://provider.example/v1 \
  --compat supportsDeveloperRole=false \
  --compat maxTokensField=max_tokens

# --id 是实际发送给 API 的模型 ID，--name 只是显示名称
python3 "$SCRIPT" add-model deepseek-example \
  --id example-model \
  --name "Example Model" \
  --context 128000 \
  --max-tokens 8192

# 删除前确认对象；provider 删除还会删除 auth.json 中同名凭据条目，须先取得这一副作用的授权
python3 "$SCRIPT" remove-model deepseek-example example-model --confirm example-model
python3 "$SCRIPT" remove-provider deepseek-example --confirm deepseek-example
```

- `add-provider` 支持 `--auth-header` 和可重复的 `--header "non-sensitive-key:value"`。`--auth-header` 只设置请求行为，不读取或写入 key。
- `--compat key=value` 可重复使用：JSON 布尔、数字、对象和数组保留类型，普通未加引号的字符串仍按字符串保存。`true/false/yes/no` 表示布尔，`1/0` 表示数字。例如 `--compat vllmPriority=1` 和 `--compat 'chatTemplateKwargs={"enable_thinking":true}'`。字段必须符合实际 API 的配置 schema，不凭“兼容 OpenAI”猜测开关。
- `add-model` 还支持 `--reasoning`、`--input text,image`。`context` 和 `max-tokens` 必须是正整数，`input` 仅使用 `text`、`image`。
- 脚本只处理标准 JSON；不要用它自动重写带注释的配置。已有 provider/model 不自动覆盖，复杂修改按 Pi 当前公开 schema 做明确、最小的字段编辑，不通过“先删再加”隐式清除认证。

## 当前字段与旧用法

常见 `--api` 值：

| 值 | 协议 |
|---|---|
| `openai-completions` | OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses |
| `anthropic-messages` | Anthropic Messages |
| `google-generative-ai` | Google Generative AI |

这不是完整白名单；其他 API 必须由当前 Pi 或已安装扩展实际支持。`openai` 本身不是这里的通用 API 类型。

- `actualModelId` 和 `--actual-model-id` 已不适用于当前 Pi 配置。使用真实 `--id` 和显示 `--name`；不要创建一个 alias ID 再指望 `actualModelId` 转发。
- provider 级 `metadataUserId` / `--metadata-user-id` 不在当前支持字段中，不再生成或作为生效配置展示。
- 遇到已有本机定义中的旧字段时，不自动改写；先核对实际模型身份，再按用户授权修改。
- 高级模型字段包括 `thinkingLevelMap`、`inputLimits`、`promptCache`、`samplingParams`、`samplingParamsByThinkingLevel`；已有模型的局部调整可用 `modelOverrides`。脚本未为这些字段另造 CLI，按 Pi 官方模型配置说明操作。
- 打开 Pi 的 `/model` 会重新加载定义。能加载不等于认证可用；缺少凭据或认证被拒时，不读取 `auth.json`、不打印环境变量，也不尝试调用 provider 验证。

## 凭据边界

Base URL、metadata 与自定义 header 都必须是非敏感内容。脚本拒绝 `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key`、`API-Key`，也拒绝 Bearer/Basic、secret/token/key 前缀或明显长 token 形式的 header 值。不要把认证值放进模型 prompt、命令参数、环境变量、stdin、命令模板或对话。

凭据设置和轮换不属于自动管理定义的授权。只有用户明确要求设置凭据时，才可启动下面的安全交互入口，由人类在 `/dev/tty` 无回显输入；代理不能请求、读取、记录或复述输入值：

```bash
python3 "$SCRIPT" set-key <provider>
```

没有交互终端时停止，不能回退到命令行、环境变量或 stdin 传 key。Pi 自身的 `/login` 也是人类可用的认证入口。

## 存储与检查

- `models.json` 使用锁及原子替换，避免脚本自身并发更新丢失；不把该锁描述为所有编辑器或 Pi 进程共享的锁。
- `auth.json` 写入使用同目录临时文件、fsync、原子替换和 `0600` 权限。
- 删除 provider 时若后续定义更新失败，脚本恢复原凭据内容并报告失败。
- 维护脚本时运行 `python3 -m unittest tests/test_pi_manage_provider.py`；只在隔离临时目录使用假数据，不能以校验为由读取本机真实凭据或请求真实服务。
