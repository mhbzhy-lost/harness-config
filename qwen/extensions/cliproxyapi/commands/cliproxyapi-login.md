---
description: CLIProxyAPI 多渠道 OAuth 登录（Codex、Claude、Antigravity、Copilot 等）与本地代理接入引导
---

引导用户完成 CLIProxyAPI 的渠道登录与本地代理接入验证。所有命令经 shell 工具运行；涉及用户设置写入时用 python3 做 JSON 往返，保留已有内容。

状态目录为 `~/.qwen/cliproxyapi/`（旧机器上的 `~/.qwen/codex-proxy/` 由 `init-qwen.sh` 自动迁移）。

1. 依赖检查：`command -v cliproxyapi`。缺失则提示用户 `brew install cliproxyapi`，不要自行安装，停止。
2. 上游代理可达性：`nc -z 127.0.0.1 7897`。登录与上游请求流量走该代理（端口可用环境变量 CLIPROXYAPI_UPSTREAM_PROXY 覆盖，旧名 CODEX_UPSTREAM_PROXY 仍兼容，默认 http://127.0.0.1:7897）。不可达则告知用户先启动代理客户端，停止。
3. 生成配置（首次必做，避免新机器找不到 config.yaml）：
   `python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py init-config`
   幂等：已存在 `~/.qwen/cliproxyapi/config.yaml` 时不覆盖。生成的 config 仅绑 127.0.0.1:8317，`requests.proxy-url` 指向上游代理，`oauth.auth-dir` 在 `~/.qwen/cliproxyapi/auth`。
   已内置 Antigravity 防风控基线：`routing`（关闭重试 + 保存冷却状态）、`oauth.providers.antigravity`（`tos-pause-window: "6h"` + 身份清洗：Pi 自述、`CLIProxyAPI`/`codex-proxy` 网关名、Qwen Code 署名与 `<docs>` 段替换）以及 `oauth.model-alias.antigravity`（`fork: true` 暴露 `gemini-4-carbon` / `gemini-4-neon` / `gemini-4-hydrogen` 无后缀别名，保留原后缀模型）。
   旧机器已有旧版 `config.yaml` 时不要删除重建：改用 `manager.py sync-config`（可先加 `--dry-run` 预览）或直接重跑 `init-qwen.sh` / `init-pi.sh`，只增量补齐缺失段、不覆盖手改的 `port`/`proxy-url`/`auth-dir`/别名/注释，并自动备份为 `config.yaml.bak-<时间戳>`。
4. 登录（打开浏览器，用户完成对应渠道授权；命令会阻塞到授权完成，超时设 ≥300s）。按用户要用的渠道执行对应参数，可多渠道分别登录：
   - Codex（ChatGPT OAuth）：`cliproxyapi -config ~/.qwen/cliproxyapi/config.yaml -codex-login -login-proxy http://127.0.0.1:7897`
   - Claude：把 `-codex-login` 换成 `-claude-login`
   - Antigravity：`-antigravity-login`；Copilot：`-copilot-login`
   - 其他渠道与完整登录参数以 `cliproxyapi --help` 为准，不要凭记忆猜测参数名。
5. 启动并验证：
   `python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py start`
   `curl -s http://127.0.0.1:8317/v1/models`
   列出返回的模型 ID。失败则查 `~/.qwen/cliproxyapi/proxy.log` 尾部并报告。
6. 接入 Qwen（per-machine 模型配置，不入同步模板）：用 python3 向 ~/.qwen/settings.json 追加：
   - `env.CLIPROXYAPI_API_KEY = "local"`（proxy 默认无客户端鉴权，仅本机绑定；Qwen 的 envKey 需有值）
   - `modelProviders.openai` 数组追加入口（保留已有条目）：
     `{"id": "<第5步列出的模型ID>", "name": "[Codex] <模型名>", "baseUrl": "http://127.0.0.1:8317/v1", "envKey": "CLIPROXYAPI_API_KEY"}`
   其他渠道模型同理按需逐个追加，名称前缀用对应渠道名。写入前备份 settings.json。
   注意不同协议的 `baseUrl` 后缀规则相反（OpenAI 系 `/v1`、Anthropic 与 Qwen `gemini` 不带后缀、Pi `google-generative-ai` 必须 `/v1beta`），配错会 404；Pi 侧 Antigravity Gemini 还须 `compat.supportsStrictMode: false`。各运行时 × 协议的精确写法参考 `cliproxyapi-manage-models` 技能，不要凭记忆拼。
7. 告知用户：重启 Qwen Code 后 /model 可选这些模型；proxy 为懒加载启动（Qwen Code 与 Pi 共用，会话退出不自动回收，手动 `manager.py stop` 停止；/cliproxyapi-status 查看状态）；各渠道凭据仅供个人自用，禁止共享/转售该端点。
