#!/usr/bin/env python3
"""cliproxyapi 生命周期管理：CLIProxyAPI 多渠道 OAuth 代理的懒加载启动与手动停止。

Qwen Code（SessionStart hook）与 Pi（pi/extensions/cliproxyapi）共用同一份状态目录与端口：
任何一端发现代理未运行即按需拉起，退出时**不**自动回收（避免一方退出杀掉另一方正在使用的代理），
需要停止时手动执行 `manager.py stop`。

多进程安全：fcntl.flock 串行化启动；proxy.pid 记录带启动指纹的进程身份，stop 只杀指纹匹配的进程。
未安装 cliproxyapi 或未完成任何渠道登录时静默 no-op，绝不阻塞任何会话。

状态目录为 ~/.qwen/cliproxyapi（由旧名 codex-proxy 迁移而来，迁移见 init-qwen.sh）。

子命令: start | stop | status | init-config
        register（= start 的向后兼容别名）| unregister（静默 no-op，兼容旧机器未重跑 init-qwen.sh 时的旧 hook）
"""
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

STATE = os.path.expanduser("~/.qwen/cliproxyapi")
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


def gen_config():
    os.makedirs(AUTH_DIR, exist_ok=True)
    if os.path.exists(CONFIG):
        return
    _atomic_write_text(
        CONFIG,
        "config-version: 8\n"
        "server:\n"
        '  host: "127.0.0.1"\n'
        f"  port: {API_PORT}\n"
        "requests:\n"
        f'  proxy-url: "{UPSTREAM_PROXY}"\n'
        "oauth:\n"
        f'  auth-dir: "{AUTH_DIR}"\n',
    )


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
        sys.exit("用法: manager.py start|stop|status|init-config")
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
        else:
            sys.exit(f"未知子命令: {cmd}")
    except Exception as e:
        # 生命周期钩子绝不阻塞 Qwen/Pi：失败只报 stderr
        print(f"cliproxyapi: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()