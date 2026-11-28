---
description: 查看 cliproxyapi 代理生命周期状态与可用模型
---

运行并报告：

1. `python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py status` —— proxy 是否运行、PID、凭据是否存在、上游代理地址（`lifecycle: "lazy"`：Qwen Code 与 Pi 共用，懒加载启动，退出不自动回收）。
2. 若 proxy 运行：`curl -s http://127.0.0.1:8317/v1/models` 列出可用模型。
3. 异常排查线索：
   - credentials_present=false → 跑 /cliproxyapi-login 完成渠道登录。
   - proxy 未运行但有凭据 → 下个 Qwen 会话或 Pi 启动时会自动拉起；仍起不来查 `tail -30 ~/.qwen/cliproxyapi/proxy.log`。
   - 上游超时 → 确认 127.0.0.1:7897 代理客户端在跑（`nc -z 127.0.0.1 7897`）。
   - 手动停止：`python3 ~/.qwen/extensions/cliproxyapi/scripts/manager.py stop`（下次任一端启动会话时自动拉起；注意这会同时影响正在使用该代理的 Pi/Qwen 会话）。
