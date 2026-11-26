#!/usr/bin/env python3
"""AGY PreToolUse hook: 守卫 swarm 工具的模型选择，默认锁定 Hydrogen 目录。

- 仅拦截 swarm 工具的 action == "add" / "model"，其余工具或 action 原样放行
- model 缺失 / 空白 / 裸别名 "hydrogen" → overwrite 为默认 Hydrogen 目录 ID
  （默认 gemini-4-hydrogen-high，可用环境变量 AGY_SWARM_DEFAULT_MODEL 覆盖）
- model 命中合法 Hydrogen 目录 ID 或显示名 → 原样放行，保留调用方选定档位
- 其他任何模型值 → force_ask，要求用户显式授权；Claude 系列额外提醒仅限只读审查
- 任何输入解析异常均 fail-open 返回 {"decision": "allow"}，不阻塞会话
"""

import json
import os
import re
import sys

DEFAULT_SWARM_MODEL = "gemini-4-hydrogen-high"

HYDROGEN_ID_RE = re.compile(
    r"^gemini-[0-9]+(?:\.[0-9]+)?-hydrogen(?:-[a-z0-9]+)?$", re.IGNORECASE
)
HYDROGEN_DISPLAY_RE = re.compile(
    r"^gemini\s+[0-9]+(?:\.[0-9]+)?\s+hydrogen(?:\s*\([^)]+\))?$", re.IGNORECASE
)


def resolve_default_model() -> str:
    override = os.environ.get("AGY_SWARM_DEFAULT_MODEL", "")
    return override.strip() or DEFAULT_SWARM_MODEL


def guard_swarm_model(payload: dict) -> dict:
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {"decision": "allow"}
    args = tool_call.get("args")
    if not isinstance(args, dict):
        return {"decision": "allow"}

    name = tool_call.get("name")
    if isinstance(name, str) and name and name != "swarm":
        return {"decision": "allow"}

    action = args.get("action")
    if action not in ("add", "model"):
        return {"decision": "allow"}

    model = args.get("model")
    if model is None or (isinstance(model, str) and model.strip().lower() in ("", "hydrogen")):
        return {"decision": "allow", "overwrite": {"model": resolve_default_model()}}

    if isinstance(model, str) and (
        HYDROGEN_ID_RE.match(model.strip()) or HYDROGEN_DISPLAY_RE.match(model.strip())
    ):
        return {"decision": "allow"}

    worker_name = args.get("name")
    has_name = isinstance(worker_name, str) and worker_name.strip()
    if action == "add":
        target = f"worker '{worker_name}'" if has_name else "新 worker"
    else:
        target = f"worker '{worker_name}'" if has_name else "当前会话自身"

    reason = (
        f"swarm action '{action}' 请求为 {target} 使用非 Hydrogen 模型 "
        f"'{model}'；Swarm 默认使用 Hydrogen 模型（{resolve_default_model()}），"
        "切换到其他模型需用户显式授权。"
    )
    if isinstance(model, str) and "claude" in model.lower():
        reason += "（注意：Claude 系列模型仅限只读审查代码或计划）"
    return {"decision": "force_ask", "reason": reason}


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        result = (
            guard_swarm_model(payload)
            if isinstance(payload, dict)
            else {"decision": "allow"}
        )
    except Exception:
        result = {"decision": "allow"}
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()