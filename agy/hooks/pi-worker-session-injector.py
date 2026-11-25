#!/usr/bin/env python3
"""AGY PreToolUse hook: 为 pi_worker_start 与 pi_worker_monitor 自动补全父会话上下文。

同时兼容 Eager 直接工具调用（如 mcp_pi-worker_pi-worker_pi_worker_start）与
Lazy 间接调用（call_mcp_tool + ServerName/ToolName/Arguments）：
- 缺省 parentSessionId 时自动写入 payload.conversationId；
- pi_worker_monitor 缺省 cwd 时自动写入 payload.cwd（回退 workspacePaths[0]），
  使监控面板默认支持“当前会话 / 当前项目 / 全部”作用域切换；
- 显式传入的 parentSessionId 或 cwd 原样保留；任何异常 fail-open 放行。
"""

import json
import sys


def _non_empty_str(value) -> str | None:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return None


def _extract_workspace_cwd(payload: dict) -> str | None:
    cwd = _non_empty_str(payload.get("cwd"))
    if cwd:
        return cwd
    workspaces = payload.get("workspacePaths")
    if isinstance(workspaces, list):
        for item in workspaces:
            ws = _non_empty_str(item)
            if ws:
                return ws
    return None


def inject_pi_worker_session(payload: dict) -> dict:
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {"decision": "allow"}
    tool_name = tool_call.get("name")
    args = tool_call.get("args")
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return {"decision": "allow"}

    conv_id = _non_empty_str(payload.get("conversationId"))
    ws_cwd = _extract_workspace_cwd(payload)
    if not conv_id and not ws_cwd:
        return {"decision": "allow"}

    # 1. Lazy 路径：call_mcp_tool
    if tool_name == "call_mcp_tool":
        server_name = args.get("ServerName")
        target_tool = args.get("ToolName")
        if not isinstance(server_name, str) or "pi-worker" not in server_name:
            return {"decision": "allow"}
        if target_tool not in ("pi_worker_start", "pi_worker_monitor"):
            return {"decision": "allow"}
        raw_inner = args.get("Arguments")
        inner = dict(raw_inner) if isinstance(raw_inner, dict) else {}
        changed = False
        if conv_id and not _non_empty_str(inner.get("parentSessionId")):
            inner["parentSessionId"] = conv_id
            changed = True
        if target_tool == "pi_worker_monitor" and ws_cwd and not _non_empty_str(inner.get("cwd")):
            inner["cwd"] = ws_cwd
            changed = True
        if changed:
            return {"decision": "allow", "overwrite": {"Arguments": inner}}
        return {"decision": "allow"}

    # 2. Eager 路径：直接工具调用（前缀可能为 mcp_pi-worker_pi-worker_ 或无前缀）
    if tool_name.endswith("pi_worker_start"):
        if conv_id and not _non_empty_str(args.get("parentSessionId")):
            return {"decision": "allow", "overwrite": {"parentSessionId": conv_id}}
        return {"decision": "allow"}

    if tool_name.endswith("pi_worker_monitor"):
        overwrite: dict[str, str] = {}
        if conv_id and not _non_empty_str(args.get("parentSessionId")):
            overwrite["parentSessionId"] = conv_id
        if ws_cwd and not _non_empty_str(args.get("cwd")):
            overwrite["cwd"] = ws_cwd
        if overwrite:
            return {"decision": "allow", "overwrite": overwrite}
        return {"decision": "allow"}

    return {"decision": "allow"}


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        result = (
            inject_pi_worker_session(payload)
            if isinstance(payload, dict)
            else {"decision": "allow"}
        )
    except Exception:
        result = {"decision": "allow"}
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
