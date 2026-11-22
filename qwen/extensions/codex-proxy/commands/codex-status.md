---
description: 查看 codex-proxy 生命周期状态与可用模型
---

运行并报告：

1. `python3 ~/.qwen/extensions/codex-proxy/scripts/manager.py status` —— proxy 是否运行、PID、注册的会话 PID、凭据是否存在、上游代理地址。
2. 若 proxy 运行：`curl -s http://127.0.0.1:8317/v1/models` 列出可用模型。
3. 异常排查线索：
   - credentials_present=false → 跑 /codex-login。
   - proxy 未运行但有会话注册 → 查 `tail -30 ~/.qwen/codex-proxy/proxy.log`。
   - 上游超时 → 确认 127.0.0.1:7897 代理客户端在跑（`nc -z 127.0.0.1 7897`）。
   - 手动停止：`python3 ~/.qwen/extensions/codex-proxy/scripts/manager.py stop`（下个会话启动会自动拉起）。