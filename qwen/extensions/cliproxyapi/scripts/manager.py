#!/usr/bin/env python3
"""cliproxyapi 生命周期管理：CLIProxyAPI 多渠道 OAuth 代理的懒加载启动与手动停止。

Qwen Code（SessionStart hook）与 Pi（pi/extensions/cliproxyapi）共用同一份状态目录与端口：
任何一端发现代理未运行即按需拉起，退出时**不**自动回收（避免一方退出杀掉另一方正在使用的代理），
需要停止时手动执行 `manager.py stop`。

多进程安全：fcntl.flock 串行化启动；proxy.pid 记录带启动指纹的进程身份，stop 只杀指纹匹配的进程。
未安装 cliproxyapi 或未完成任何渠道登录时静默 no-op，绝不阻塞任何会话。

状态目录为 ~/.qwen/cliproxyapi（由旧名 codex-proxy 迁移而来，迁移见 init-qwen.sh；
可用环境变量 CLIPROXYAPI_STATE_DIR 覆盖，与 Pi 扩展 pi/extensions/cliproxyapi 一致）。

子命令: start | stop | status | init-config | sync-config [--dry-run]
        register（= start 的向后兼容别名）| unregister（静默 no-op，兼容旧机器未重跑 init-qwen.sh 时的旧 hook）

init-config 仅在 config.yaml 不存在时生成跨机安全基线（Antigravity 别名、身份清洗与冷却/重试保护）；
sync-config 对已有旧 config.yaml 做**非破坏性增量补齐**（只补缺失的 routing: / oauth.model-alias.antigravity: / oauth.providers.antigravity: 段，
绝不覆盖用户手改的 server/port/server-id/proxy-url/auth-dir/已有别名/注释），由 init-qwen.sh / init-pi.sh 调用。
"""
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime

STATE = os.path.expanduser(os.environ.get("CLIPROXYAPI_STATE_DIR") or "~/.qwen/cliproxyapi")
REGISTRY = os.path.join(STATE, "sessions.json")  # 旧版会话注册表，仅在 stop 时清理遗留
LOCK = os.path.join(STATE, "lock")
PROXY_PID = os.path.join(STATE, "proxy.pid")
WATCHDOG_PID = os.path.join(STATE, "watchdog.pid")
LOG = os.path.join(STATE, "proxy.log")
LOG_MAX_BYTES = 5 * 1024 * 1024
CONFIG = os.path.join(STATE, "config.yaml")
AUTH_DIR = os.path.join(STATE, "auth")
# 环境变量优先读 CLIPROXYAPI_*，回退兼容旧名 CODEX_*
API_PORT = int(os.environ.get("CLIPROXYAPI_API_PORT") or os.environ.get("CODEX_PROXY_API_PORT") or "8317")
UPSTREAM_PROXY = (os.environ.get("CLIPROXYAPI_UPSTREAM_PROXY")
                  or os.environ.get("CODEX_UPSTREAM_PROXY")
                  or "http://127.0.0.1:7897")


def find_bin():
    return shutil.which("cliproxyapi") or "/opt/homebrew/bin/cliproxyapi"


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _ps_field(pid, field, utc=False):
    if not pid or pid <= 0:
        return None
    env = os.environ.copy()
    env["LC_ALL"] = "C"
    if utc:
        env["TZ"] = "UTC"
    try:
        res = subprocess.run(
            ["ps", "-p", str(pid), "-o", f"{field}="],
            env=env,
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    out = res.stdout.strip()
    return out or None


def get_process_signature(pid):
    raw = _ps_field(pid, "lstart", utc=True)
    return " ".join(raw.split()) if raw else None


def is_zombie(pid):
    stat = _ps_field(pid, "stat")
    return bool(stat and "Z" in stat.split()[0])


def _atomic_write_text(path, content):
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=f".{os.path.basename(path)}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_pidfile_entry(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError:
        return None, None
    if not raw:
        return None, None
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            pid = int(data["pid"])
            sig = data.get("signature")
            return pid, (sig if isinstance(sig, str) and sig.strip() else None)
        except (ValueError, KeyError, TypeError):
            return None, None
    lines = raw.splitlines()
    try:
        pid = int(lines[0].strip())
    except ValueError:
        return None, None
    sig = lines[1].strip() if len(lines) > 1 and lines[1].strip() else None
    return pid, sig


def read_pidfile(path):
    return read_pidfile_entry(path)[0]


def write_pidfile(path, pid):
    payload = json.dumps({"pid": pid, "signature": get_process_signature(pid)})
    _atomic_write_text(path, payload)


def verify_process_identity(pid, expected_sig, expected_hint):
    if not pid or not alive(pid) or is_zombie(pid):
        return False
    if expected_sig:
        current_sig = get_process_signature(pid)
        return bool(current_sig and current_sig == expected_sig)
    args = _ps_field(pid, "args") or ""
    return expected_hint in args


def terminate_verified_process(pid, expected_sig, expected_hint, grace_seconds=1.5):
    if not verify_process_identity(pid, expected_sig, expected_hint):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if not alive(pid) or is_zombie(pid):
            return
        time.sleep(0.05)
    if verify_process_identity(pid, expected_sig, expected_hint):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            return
        kill_deadline = time.monotonic() + 1.0
        while time.monotonic() < kill_deadline:
            if not alive(pid) or is_zombie(pid):
                return
            time.sleep(0.05)


def proxy_running():
    pid, sig = read_pidfile_entry(PROXY_PID)
    return pid if verify_process_identity(pid, sig, "cliproxyapi") else None


def has_credentials():
    try:
        # 凭据是 OAuth JSON 文件；kv.db 等运行态文件不算
        return any(n.endswith(".json") and os.path.isfile(os.path.join(AUTH_DIR, n))
                   for n in os.listdir(AUTH_DIR))
    except OSError:
        return False


# 跨机安全基线（纯字符串拼接，本机无 PyYAML）：
# - routing.retry 关闭重试、cooldown 持久化冷却状态；
# - oauth.providers.antigravity 的 tos-pause-window 与敏感词/正则替换，用于 Antigravity 防风控身份清洗
#   （Pi 系统提示自述、CLIProxyAPI/codex-proxy 网关名、Qwen Code 署名与 <docs> 段）。
ROUTING_BASELINE = (
    "routing:\n"
    "  retry:\n"
    "    request-retry: 0\n"
    "    max-retry-interval: 0\n"
    "  cooldown:\n"
    "    save-cooldown-status: true\n"
)
MODEL_ALIAS_ANTIGRAVITY_BLOCK = (
    "  model-alias:\n"
    "    antigravity:\n"
    '      - name: "gemini-4-carbon-high"\n'
    '        alias: "gemini-4-carbon"\n'
    "        fork: true\n"
    '      - name: "gemini-4-neon-xhigh"\n'
    '        alias: "gemini-4-neon"\n'
    "        fork: true\n"
    '      - name: "gemini-4-hydrogen-xhigh"\n'
    '        alias: "gemini-4-hydrogen"\n'
    "        fork: true\n"
)
ANTIGRAVITY_PROVIDER_BLOCK = (
    "    antigravity:\n"
    '      tos-pause-window: "6h"\n'
    "      sensitive-words-replace:\n"
    '        "You are a coding assistant running inside pi, a coding agent harness.": '
    '"You are a helpful coding assistant."\n'
    '        "cliproxyapi": "local-gateway"\n'
    '        "CLIProxyAPI": "local-gateway"\n'
    '        "codex-proxy": "local-gateway"\n'
    "      sensitive-patterns-replace:\n"
    "        - pattern: 'You are Qwen Code,[^\\n.]*developed by Alibaba Group[^\\n.]*\\.'\n"
    '          replacement: "You are a helpful coding assistant."\n'
    "        - pattern: 'You are Qwen Code,[^\\n.]*\\.'\n"
    '          replacement: "You are a helpful coding assistant."\n'
    "        - pattern: '(?s)<docs>.*?</docs>\\n?'\n"
    '          replacement: ""\n'
)


def gen_config():
    """首次生成 config.yaml（幂等：已存在则原样返回，绝不覆盖）。"""
    os.makedirs(AUTH_DIR, exist_ok=True)
    if os.path.exists(CONFIG):
        return
    _atomic_write_text(
        CONFIG,
        "config-version: 8\n"
        "server:\n"
        '  host: "127.0.0.1"\n'
        f"  port: {API_PORT}\n"
        + ROUTING_BASELINE
        + "requests:\n"
        f'  proxy-url: "{UPSTREAM_PROXY}"\n'
        "oauth:\n"
        f'  auth-dir: "{AUTH_DIR}"\n'
        + MODEL_ALIAS_ANTIGRAVITY_BLOCK
        + "  providers:\n"
        + ANTIGRAVITY_PROVIDER_BLOCK,
    )
    os.chmod(CONFIG, 0o600)

_TOP_KEY = re.compile(r"^([A-Za-z0-9_-]+):")
_ANTIGRAVITY = re.compile(r"^\s*antigravity\s*:")


def _read_config_lines():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return f.read().split("\n")
    except OSError:
        return None


def _top_level_ranges(lines):
    """返回 [(key, start, end)]：每个顶层键的行号区间 [start, end)，end 为下一个顶层键行或文件末尾。"""
    ranges = []
    starts = []
    for i, line in enumerate(lines):
        m = _TOP_KEY.match(line)
        if m:
            starts.append((m.group(1), i))
    for idx, (key, start) in enumerate(starts):
        end = starts[idx + 1][1] if idx + 1 < len(starts) else len(lines)
        ranges.append((key, start, end))
    return ranges


def _trim_trailing_empty(lines, start, end):
    """块内最后一个非空行之后（不含文件末尾的空行）的位置，用于在块末尾插入内容。"""
    pos = end
    while pos > start and not lines[pos - 1].strip():
        pos -= 1
    return pos


def _sub_block_end(lines, start, end):
    """子块结束行：下一条缩进 <= 2 空格的非空行（start 为子块首行下标）。"""
    pos = start
    while pos < end:
        line = lines[pos]
        if line.strip() and not line.startswith("   "):
            break
        pos += 1
    return pos


def _plan_oauth_child(lines, oauth_start, oauth_end, sub_key, child_block, tail_additions, plan_inserts):
    """独立判断 oauth.<sub_key>.antigravity 是否缺失，缺失则补齐（不改写任何既有行）。

    - oauth 块内无 `  <sub_key>:`：把 `  <sub_key>:\n` + child_block 记入 tail_additions（追加到 oauth 块末尾）；
    - 有 `  <sub_key>:` 但其子块内无 `    antigravity:`：在子块末尾插入 child_block；
    - 已有 antigravity:：不动（尊重用户自定义）。
    """
    oauth_lines = lines[oauth_start:oauth_end]
    sub_idx = next((i for i, l in enumerate(oauth_lines) if re.match(rf"^  {re.escape(sub_key)}:\s*(#.*)?$", l)), None)
    if sub_idx is None:
        tail_additions.append(["  " + sub_key + ":"] + child_block)
        return
    child_start = oauth_start + sub_idx + 1
    child_end = _sub_block_end(lines, child_start, oauth_end)
    if any(_ANTIGRAVITY.match(l) for l in lines[child_start:child_end]):
        return
    plan_inserts.append((_trim_trailing_empty(lines, child_start, child_end), child_block))


def _plan_sync(lines):
    """计算增量补齐计划，返回 [(插入位置, 待插入行列表)]；空列表表示无需变更。

    以行为单位做轻量结构识别（仅依赖“顶层键顶格、oauth 子键 2 空格缩进”这两条缩进约定），
    不解析也不改写任何既有行，因此用户的手改内容与注释全部原样保留。
    routing / oauth.model-alias.antigravity / oauth.providers.antigravity 三项独立判断，各自缺失才补。
    只认对应子块内的 antigravity:（其它位置的同名键不算）。
    """
    plan = []
    eof_blocks = []  # 需要追加到文件末尾的段（合并为一次插入，共享一个空行分隔）
    ranges = _top_level_ranges(lines)
    keys = [k for k, _, _ in ranges]

    # 1. 顶层 routing: 段缺失 → 补齐（插在 server: 段之后；无 server: 则插在首个其他顶层键之前或文件末尾）
    if "routing" not in keys:
        block = ROUTING_BASELINE.rstrip("\n").split("\n")
        insert_at = None
        for key, start, _ in ranges:
            if key in ("config-version", "server"):
                continue
            insert_at = start
            break
        if insert_at is None:
            eof_blocks.append(block)
        else:
            plan.append((insert_at, block))

    # 2./3. oauth.model-alias.antigravity 与 oauth.providers.antigravity 独立补齐
    oauth_range = next(((s, e) for k, s, e in ranges if k == "oauth"), None)
    if oauth_range is None:
        eof_blocks.append(
            (["oauth:"] + MODEL_ALIAS_ANTIGRAVITY_BLOCK.rstrip("\n").split("\n")
             + ["  providers:"] + ANTIGRAVITY_PROVIDER_BLOCK.rstrip("\n").split("\n"))
        )
    else:
        oauth_start, oauth_end = oauth_range
        tail_additions = []  # 追加到 oauth 块末尾的子块（按 model-alias → providers 顺序）
        plan_inserts = []  # 本轮对 oauth 的插入计划（位置都在 oauth 块内）
        _plan_oauth_child(lines, oauth_start, oauth_end, "model-alias",
                          MODEL_ALIAS_ANTIGRAVITY_BLOCK.rstrip("\n").split("\n")[1:], tail_additions, plan_inserts)
        _plan_oauth_child(lines, oauth_start, oauth_end, "providers",
                          ANTIGRAVITY_PROVIDER_BLOCK.rstrip("\n").split("\n"), tail_additions, plan_inserts)
        plan.extend(plan_inserts)
        if tail_additions:
            block = [line for chunk in tail_additions for line in chunk]
            plan.append((_trim_trailing_empty(lines, oauth_start + 1, oauth_end), block))

    if eof_blocks:
        block = [line for chunk in eof_blocks for line in chunk]
        if lines and lines[-1].strip():
            block = [""] + block  # 原文件末行无换行时先补一个行结束
        plan.append((len(lines), block))
    return plan


def sync_config(dry_run=False):
    """对已有 config.yaml 非破坏性增量补齐跨机安全基线；返回是否需要变更。

    - config.yaml 不存在：静默 no-op（不建目录、不建文件；首建请用 init-config）。
    - 只补缺失的顶层 routing: 段与 oauth.model-alias.antigravity: / oauth.providers.antigravity: 段，绝不改写既有行。
    - 无缺失项：严格 no-op（不写文件、不备份），连续执行幂等。
    - 有变更：先备份 config.yaml.bak-<YYYYMMDDHHMMSS>（0600），再原子写回（0600）；dry_run 仅预览。
    """
    lines = _read_config_lines()
    if lines is None:
        return False
    plan = _plan_sync(lines)
    if not plan:
        return False
    summary = []
    for pos, block in plan:
        # 以插入段内缩进为 0/2 空格的键名概括该段（如 "routing:"、"model-alias:+providers:"）
        keys = [l.strip() for l in block if re.match(r"^(?:  )?\S.*:\s*$", l)]
        key = "+".join(dict.fromkeys(keys)) or "段"
        summary.append(f"{key}（第 {pos + 1} 行前插入 {len(block)} 行）")
    desc = "；".join(summary)
    if dry_run:
        print(f"[dry-run] cliproxyapi: {CONFIG} 将补齐: {desc}")
        return True
    # 自下而上应用插入，保证前面的位置不失效；同一位置的多个插入按计划倒序应用，
    # 使“子块末尾插入”（先计划）最终落在“oauth 块末尾追加”（后计划）之前，保持嵌套正确
    for _, (pos, block) in sorted(enumerate(plan), key=lambda t: (t[1][0], t[0]), reverse=True):
        lines[pos:pos] = block
    content = "\n".join(lines)
    if not content.endswith("\n"):
        content += "\n"
    backup = f"{CONFIG}.bak-{datetime.now():%Y%m%d%H%M%S}"
    with open(CONFIG, "rb") as src, open(backup, "wb") as dst:
        dst.write(src.read())
    os.chmod(backup, 0o600)
    _atomic_write_text(CONFIG, content)
    os.chmod(CONFIG, 0o600)
    print(f"cliproxyapi: {CONFIG} 已增量补齐: {desc}；备份: {backup}")
    return True


def rotate_log_if_needed():
    try:
        if os.path.getsize(LOG) > LOG_MAX_BYTES:
            os.replace(LOG, LOG + ".1")
    except OSError:
        pass


def port_ready():
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", API_PORT)) == 0


def stop_proxy():
    """手动停止代理：仅终止 proxy.pid 中指纹匹配的进程，SIGTERM 无效则升级 SIGKILL。

    顺带清理旧版“随会话起停”方案遗留的 watchdog.pid 与 sessions.json（若存在）。
    """
    entries = []
    for path, hint in ((PROXY_PID, "cliproxyapi"), (WATCHDOG_PID, "manager.py")):
        pid, sig = read_pidfile_entry(path)
        if pid:
            entries.append((pid, sig, hint))
        try:
            os.unlink(path)
        except OSError:
            pass
    try:
        os.unlink(REGISTRY)
    except OSError:
        pass
    for pid, sig, hint in entries:
        terminate_verified_process(pid, sig, hint)


def ensure_running():
    """懒加载：已在运行或端口已被监听则直接返回；否则拉起 cliproxyapi 并等待端口就绪。

    必须在 locked() 内调用（外层持 flock），避免 Qwen 与 Pi 并发重复启动。
    找不到二进制或未登录任何渠道时静默 no-op；进程秒退则立即清理 proxy.pid 返回，不空等。
    """
    if proxy_running() or port_ready():
        return
    bin_path = find_bin()
    if not os.path.isfile(bin_path) or not has_credentials():
        return
    gen_config()
    rotate_log_if_needed()
    with open(LOG, "a", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [bin_path, "-config", CONFIG],
            stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    write_pidfile(PROXY_PID, proc.pid)
    for _ in range(50):
        if port_ready():
            return
        if proc.poll() is not None:
            proc.wait()
            try:
                os.unlink(PROXY_PID)
            except OSError:
                pass
            return
        time.sleep(0.2)


def locked(fn):
    os.makedirs(STATE, exist_ok=True)
    with open(LOCK, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def status():
    pid = proxy_running()
    print(json.dumps({
        "proxy_running": bool(pid),
        "proxy_pid": pid,
        "api_port": API_PORT,
        "upstream_proxy": UPSTREAM_PROXY,
        "credentials_present": has_credentials(),
        "binary": find_bin(),
        "lifecycle": "lazy",
    }, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: manager.py start|stop|status|init-config|sync-config [--dry-run]")
    cmd = sys.argv[1]
    try:
        if cmd in ("start", "register"):
            # register 是旧 hook 的子命令，语义已退化为“确保运行”
            locked(ensure_running)
        elif cmd == "unregister":
            # 旧 SessionEnd hook 入口：退出不再回收代理，静默 no-op
            pass
        elif cmd == "stop":
            locked(stop_proxy)
        elif cmd == "status":
            status()
        elif cmd == "init-config":
            # 首次登录前幂等生成 config.yaml 与 auth/ 目录（供 /cliproxyapi-login 调用）
            locked(gen_config)
        elif cmd == "sync-config":
            # 旧机器增量补齐 config.yaml 缺失段（不建目录/文件；不加锁以免在无状态目录时产生 lock 文件）
            args = sys.argv[2:]
            if any(a not in ("--dry-run",) for a in args):
                sys.exit(f"未知参数: {' '.join(args)}")
            sync_config(dry_run="--dry-run" in args)
        else:
            sys.exit(f"未知子命令: {cmd}")
    except Exception as e:
        # 生命周期钩子绝不阻塞 Qwen/Pi：失败只报 stderr
        print(f"cliproxyapi: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()