---
description: 一次性 Codex（ChatGPT OAuth）登录与本地代理接入验证
---

执行 Codex 订阅登录与验证。所有命令经 shell 工具运行；涉及用户设置写入时用 python3 做 JSON 往返，保留已有内容。

1. 依赖检查：`command -v cliproxyapi`。缺失则提示用户 `brew install cliproxyapi`，不要自行安装，停止。
2. 上游代理可达性：`nc -z 127.0.0.1 7897`。OpenAI 流量必须走该代理（端口可用环境变量 CODEX_UPSTREAM_PROXY 覆盖，默认 http://127.0.0.1:7897）。不可达则告知用户先启动代理客户端，停止。
3. 登录（打开浏览器，用户完成 ChatGPT 授权；命令会阻塞到授权完成，超时设 ≥300s）：
   `cliproxyapi -config ~/.qwen/codex-proxy/config.yaml -codex-login -login-proxy http://127.0.0.1:7897`
   config.yaml 由 manager 自动生成（server 仅绑 127.0.0.1:8317，requests.proxy-url 指向上游代理，oauth.auth-dir 在 ~/.qwen/codex-proxy/auth）。
4. 启动并验证：
   `python3 ~/.qwen/extensions/codex-proxy/scripts/manager.py start`
   `curl -s http://127.0.0.1:8317/v1/models`
   列出返回的模型 ID。失败则查 `~/.qwen/codex-proxy/proxy.log` 尾部并报告。
5. 接入 Qwen（per-machine 模型配置，不入同步模板）：用 python3 向 ~/.qwen/settings.json 追加：
   - `env.CODEX_PROXY_API_KEY = "local"`（proxy 默认无客户端鉴权，仅本机绑定；Qwen 的 envKey 需有值）
   - `modelProviders.openai` 数组追加入口（保留已有条目）：
     `{"id": "<第4步列出的模型ID>", "name": "[Codex] <模型名>", "baseUrl": "http://127.0.0.1:8317/v1", "envKey": "CODEX_PROXY_API_KEY"}`
   多个模型按需逐个追加。写入前备份 settings.json。
6. 告知用户：重启 Qwen Code 后 /model 可选 Codex 模型；proxy 进程随会话自动起停（/codex-status 查看）；个人自用符合 OpenAI 当前态度，禁止共享/转售该端点。