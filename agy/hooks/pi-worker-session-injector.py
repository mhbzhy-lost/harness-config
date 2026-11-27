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
import stat
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

_TITLE_MAX_CHARS = 48
_CONVERSATION_TIMEOUT_SECONDS = 0.35
_TITLE_CACHE_OK_TTL_SECONDS = 300.0
_TITLE_CACHE_FAIL_TTL_SECONDS = 30.0
_TITLE_CACHE_MAX_ENTRIES = 128


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


def _title_cache_path() -> Path:
    configured = _non_empty_str(os.environ.get("AGY_TITLE_CACHE_PATH"))
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".cache" / "harness-config" / "agy-pi-worker-title-cache.json"


def _ensure_private_dir(directory: Path) -> bool:
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        st = os.lstat(directory)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            return False
        if st.st_uid != os.getuid():
            return False
        if directory != Path(tempfile.gettempdir()).resolve() and directory != Path(tempfile.gettempdir()):
            if stat.S_IMODE(st.st_mode) != 0o700:
                os.chmod(directory, 0o700)
        return True
    except OSError:
        return False


def _load_title_cache(cache_path: Path, now: float) -> dict[str, dict]:
    try:
        if cache_path.parent.is_symlink():
            return {}
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(cache_path, flags)
    except OSError:
        return {}
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            os.close(fd)
            return {}
        with os.fdopen(fd, "r", encoding="utf-8") as f:
            fd = -1
            raw = json.load(f)
    except Exception:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        return {}
    if not isinstance(raw, dict):
        return {}
    entries = raw.get("entries")
    if not isinstance(entries, dict):
        return {}
    valid: dict[str, dict] = {}
    for key, entry in entries.items():
        if not isinstance(key, str) or not isinstance(entry, dict):
            continue
        expires_at = entry.get("expiresAt")
        if isinstance(expires_at, (int, float)) and expires_at > now:
            valid[key] = entry
    return valid


def _save_title_cache(cache_path: Path, entries: dict[str, dict], now: float) -> None:
    try:
        if not _ensure_private_dir(cache_path.parent):
            return
        pruned = [
            (k, v)
            for k, v in entries.items()
            if isinstance(v, dict) and isinstance(v.get("expiresAt"), (int, float)) and v["expiresAt"] > now
        ]
        if len(pruned) > _TITLE_CACHE_MAX_ENTRIES:
            pruned.sort(
                key=lambda item: item[1].get("updatedAt", 0) if isinstance(item[1].get("updatedAt"), (int, float)) else 0,
                reverse=True,
            )
            pruned = pruned[:_TITLE_CACHE_MAX_ENTRIES]
        payload = json.dumps({"entries": dict(pruned)}, ensure_ascii=False)
        tmp_path = cache_path.parent / f".{cache_path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(tmp_path, flags, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                fd = -1
                f.write(payload)
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, cache_path)
        except Exception:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception:
        pass


def _fetch_conversation_title(conv_id: str) -> str | None:
    """经本机 Antigravity LS 读取会话标题；带私有本地 TTL 缓存，任何失败静默返回 None（fail-open）。"""
    address = _non_empty_str(os.environ.get("ANTIGRAVITY_LS_ADDRESS"))
    csrf_token = _non_empty_str(os.environ.get("ANTIGRAVITY_CSRF_TOKEN"))
    if not address or not csrf_token or not conv_id:
        return None
    cache_path = _title_cache_path()
    cache_key = f"{address}\0{conv_id}"
    now = time.time()
    entries = _load_title_cache(cache_path, now)
    cached = entries.get(cache_key)
    if isinstance(cached, dict):
        cached_title = cached.get("title")
        if cached_title is None:
            return None
        if isinstance(cached_title, str):
            return _sanitize_title(cached_title)

    title: str | None = None
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
        if isinstance(data, dict):
            annotations = data.get("annotations")
            raw_title = None
            if isinstance(annotations, dict):
                raw_title = _non_empty_str(annotations.get("title"))
            if not raw_title:
                state = data.get("state")
                if isinstance(state, dict):
                    raw_title = _non_empty_str(state.get("summary"))
            title = _sanitize_title(raw_title)
    except Exception:
        title = None

    ttl = _TITLE_CACHE_OK_TTL_SECONDS if title else _TITLE_CACHE_FAIL_TTL_SECONDS
    entries[cache_key] = {
        "title": title,
        "expiresAt": now + ttl,
        "updatedAt": now,
    }
    _save_title_cache(cache_path, entries, now)
    return title


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
