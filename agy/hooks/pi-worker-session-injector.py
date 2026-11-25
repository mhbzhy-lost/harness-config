#!/usr/bin/env python3
"""AGY PreToolUse hook: 为 pi_worker_start 与 pi_worker_monitor 自动补全父会话上下文。

同时兼容 Eager 直接工具调用（如 mcp_pi-worker_pi-worker_pi_worker_start）与
Lazy 间接调用（call_mcp_tool + ServerName/ToolName/Arguments）：
- 缺省 parentSessionId 时自动写入 payload.conversationId；
- pi_worker_monitor 缺省 cwd 时自动写入 payload.cwd（回退 workspacePaths[0]）；
- 缺省 parentSessionTitle 时自动注入会话可读标题：优先经 ConversationService
  GetConversation 读取 annotations.title / state.summary（350ms 超时），
  失败或未配置环境变量时降级取 payload.lastUserInput 首条非空行；
- 显式传入的 parentSessionId / parentSessionTitle / cwd 原样保留；
  任何异常 fail-open 放行，绝不阻塞工具调用。
"""

import json
import os
import sys
import urllib.request

_TITLE_MAX_CHARS = 48
_CONVERSATION_TIMEOUT_SECONDS = 0.35


def _non_empty_str(value) -> str | None:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return None


def _sanitize_title(text) -> str | None:
    """合并换行/连续空白为单行并截断到 ~48 字。"""
    if not isinstance(text, str):
        return None
    cleaned = " ".join(text.split())
    if not cleaned:
        return None
    if len(cleaned) > _TITLE_MAX_CHARS:
        return cleaned[:_TITLE_MAX_CHARS] + "…"
    return cleaned


def _fetch_conversation_title(conv_id: str) -> str | None:
    """经本机 Antigravity LS 读取会话标题；任何失败静默返回 None（fail-open）。"""
    address = _non_empty_str(os.environ.get("ANTIGRAVITY_LS_ADDRESS"))
    csrf_token = _non_empty_str(os.environ.get("ANTIGRAVITY_CSRF_TOKEN"))
    if not address or not csrf_token or not conv_id:
        return None
    try:
        request = urllib.request.Request(
            f"http://{address}/product.v1.ConversationService/GetConversation",
            data=json.dumps({"conversationId": conv_id}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-antigravity-csrf-token": csrf_token,
            },
            method="POST",
        )
        with urllib.request.urlopen(
            request, timeout=_CONVERSATION_TIMEOUT_SECONDS
        ) as response:
            data = json.loads(response.read().decode("utf-8"))
        if not isinstance(data, dict):
            return None
        annotations = data.get("annotations")
        title = None
        if isinstance(annotations, dict):
            title = _non_empty_str(annotations.get("title"))
        if not title:
            state = data.get("state")
            if isinstance(state, dict):
                title = _non_empty_str(state.get("summary"))
        return _sanitize_title(title)
    except Exception:
        return None


def _fallback_title_from_payload(payload: dict) -> str | None:
    """降级：取 lastUserInput 首条非空行，合并空白并截断。"""
    raw = payload.get("lastUserInput")
    if isinstance(raw, dict):
        raw = raw.get("text")
    if not isinstance(raw, str):
        return None
    for line in raw.splitlines():
        if line.strip():
            return _sanitize_title(line)
    return None


def _resolve_session_title(payload: dict, conv_id: str | None) -> str | None:
    try:
        if conv_id:
            title = _fetch_conversation_title(conv_id)
            if title:
                return title
        return _fallback_title_from_payload(payload)
    except Exception:
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

    def session_title_for(existing_args: dict) -> str | None:
        if _non_empty_str(existing_args.get("parentSessionTitle")):
            return None  # 调用方显式传入则原样保留
        return _resolve_session_title(payload, conv_id)

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
        title = session_title_for(inner)
        if title:
            inner["parentSessionTitle"] = title
            changed = True
        if changed:
            return {"decision": "allow", "overwrite": {"Arguments": inner}}
        return {"decision": "allow"}

    # 2. Eager 路径：直接工具调用（前缀可能为 mcp_pi-worker_pi-worker_ 或无前缀）
    if tool_name.endswith("pi_worker_start"):
        overwrite: dict[str, str] = {}
        if conv_id and not _non_empty_str(args.get("parentSessionId")):
            overwrite["parentSessionId"] = conv_id
        title = session_title_for(args)
        if title:
            overwrite["parentSessionTitle"] = title
        if overwrite:
            return {"decision": "allow", "overwrite": overwrite}
        return {"decision": "allow"}

    if tool_name.endswith("pi_worker_monitor"):
        overwrite = {}
        if conv_id and not _non_empty_str(args.get("parentSessionId")):
            overwrite["parentSessionId"] = conv_id
        if ws_cwd and not _non_empty_str(args.get("cwd")):
            overwrite["cwd"] = ws_cwd
        title = session_title_for(args)
        if title:
            overwrite["parentSessionTitle"] = title
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
