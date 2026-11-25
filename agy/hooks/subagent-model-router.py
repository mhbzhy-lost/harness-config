#!/usr/bin/env python3
"""AGY PreToolUse hook: 为内置 subagent（research / review-agent）兜底模型档位。

自定义 subagent 通过 agy/agents/*.md 的 frontmatter `model:` 静态绑定；
内置 subagent 无静态配置文件，由本 hook 在 invoke_subagent 执行前兜底：
- TypeName == "research" 且未传 Model 或 Model == "inherit" → overwrite Model 为 "flash"
- TypeName == "review-agent" 且未传 Model 或 Model == "inherit" → overwrite Model 为 "pro"
- 显式指定了其他档位（如 "pro" / "flash_lite" / "flash"）或其他 TypeName → 原样放行
- 任何输入解析异常均 fail-open 返回 {"decision": "allow"}，不阻塞会话
"""

import json
import sys

BUILTIN_DEFAULT_MODELS = {
    "research": "flash",
    "review-agent": "pro",
}


def route_subagent_model(payload: dict) -> dict:
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {"decision": "allow"}
    args = tool_call.get("args")
    if not isinstance(args, dict):
        return {"decision": "allow"}

    type_name = args.get("TypeName")
    if not isinstance(type_name, str):
        return {"decision": "allow"}

    default_model = BUILTIN_DEFAULT_MODELS.get(type_name)
    if not default_model:
        return {"decision": "allow"}

    current_model = args.get("Model")
    if current_model is None or current_model == "" or current_model == "inherit":
        return {"decision": "allow", "overwrite": {"Model": default_model}}

    return {"decision": "allow"}


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        result = (
            route_subagent_model(payload)
            if isinstance(payload, dict)
            else {"decision": "allow"}
        )
    except Exception:
        result = {"decision": "allow"}
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
