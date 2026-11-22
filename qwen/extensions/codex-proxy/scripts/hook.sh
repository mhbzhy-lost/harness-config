#!/usr/bin/env bash
# Qwen hook 入口：探针实测 hook 命令是 qwen 进程的直接子进程，$PPID 即 qwen PID。
# 失败绝不阻塞会话（manager.py 内部吞异常，这里兜底 exit 0）。
action="${1:-register}"
python3 "$(cd "$(dirname "$0")" && pwd)/manager.py" "$action" "$PPID" >/dev/null 2>&1
exit 0