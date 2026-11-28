#!/usr/bin/env bash
# Qwen hook 入口：代理为懒加载（Qwen Code 与 Pi 共用），默认动作 start = 确保运行；退出不自动回收。
# 失败绝不阻塞会话（manager.py 内部吞异常，这里兜底 exit 0）。
action="${1:-start}"
python3 "$(cd "$(dirname "$0")" && pwd)/manager.py" "$action" >/dev/null 2>&1
exit 0