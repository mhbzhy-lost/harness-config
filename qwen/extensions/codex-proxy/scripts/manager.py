#!/usr/bin/env python3
"""codex-proxy 生命周期管理：CLIProxyAPI 随 Qwen Code 会话起停。

多进程安全：PID 注册表 + fcntl.flock；watchdog 每 5s 清理死亡 PID，
最后一个会话消失即停 proxy。崩溃（kill -9）由 watchdog 兜底。
未安装 cliproxyapi 或未完成 codex 登录时静默 no-op，绝不阻塞 Qwen 启动。

子命令: register <pid> | unregister <pid> | watchdog | start | stop | status
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

STATE = os.path.expanduser("~/.qwen/codex-proxy")
REGISTRY = os.path.join(STATE, "sessions.json")
LOCK = os.path.join(STATE, "lock")
PROXY_PID = os.path.join(STATE, "proxy.pid")
WATCHDOG_PID = os.path.join(STATE, "watchdog.pid")
LOG = os.path.join(STATE, "proxy.log")
LOG_MAX_BYTES = 5 * 1024 * 1024
CONFIG = os.path.join(STATE, "config.yaml")
AUTH_DIR = os.path.join(STATE, "auth")
API_PORT = int(os.environ.get("CODEX_PROXY_API_PORT", "8317"))
UPSTREAM_PROXY = os.environ.get("CODEX_UPSTREAM_PROXY", "http://127.0.0.1:7897")
WATCHDOG_INTERVAL = 5


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


def read_pids():
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            return [int(p) for p in json.load(f)]
    except (OSError, ValueError):
        return []


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


def write_pids(pids):
    _atomic_write_text(REGISTRY, json.dumps(sorted(set(pids))))


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
    entries = []
    for path, hint in ((WATCHDOG_PID, "manager.py"), (PROXY_PID, "cliproxyapi")):
        pid, sig = read_pidfile_entry(path)
        entries.append((pid, sig, hint))
        try:
            os.unlink(path)
        except OSError:
            pass
    for pid, sig, hint in entries:
        terminate_verified_process(pid, sig, hint)


def ensure_running():
    if proxy_running():
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
            wd = subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "watchdog"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
            write_pidfile(WATCHDOG_PID, wd.pid)
            return
        if proc.poll() is not None:
            proc.wait()
            try:
                os.unlink(PROXY_PID)
            except OSError:
                pass
            return
        time.sleep(0.2)
    wd = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "watchdog"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    write_pidfile(WATCHDOG_PID, wd.pid)


def locked(fn):
    os.makedirs(STATE, exist_ok=True)
    with open(LOCK, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def register(pid):
    def op():
        pids = [p for p in read_pids() if alive(p)]
        if alive(pid) and pid not in pids:
            pids.append(pid)
        write_pids(pids)
        ensure_running()
    locked(op)


def unregister(pid):
    def op():
        pids = [p for p in read_pids() if alive(p) and p != pid]
        write_pids(pids)
        if not pids:
            stop_proxy()
    locked(op)


def watchdog():
    while True:
        time.sleep(WATCHDOG_INTERVAL)
        def op():
            pids = [p for p in read_pids() if alive(p)]
            write_pids(pids)
            if not pids:
                # 先清 pidfile 再杀 proxy；watchdog 自然退出，不杀自己
                proxy_pid, proxy_sig = read_pidfile_entry(PROXY_PID)
                for path in (PROXY_PID, WATCHDOG_PID):
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                terminate_verified_process(proxy_pid, proxy_sig, "cliproxyapi")
                return True
            return False
        if locked(op):
            return


def status():
    pid = proxy_running()
    print(json.dumps({
        "proxy_running": bool(pid),
        "proxy_pid": pid,
        "api_port": API_PORT,
        "upstream_proxy": UPSTREAM_PROXY,
        "sessions": read_pids(),
        "credentials_present": has_credentials(),
        "binary": find_bin(),
    }, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: manager.py register|unregister|watchdog|start|stop|status [pid]")
    cmd = sys.argv[1]
    try:
        if cmd in ("register", "unregister"):
            pid = int(sys.argv[2]) if len(sys.argv) > 2 else os.getppid()
            (register if cmd == "register" else unregister)(pid)
        elif cmd == "watchdog":
            watchdog()
        elif cmd == "start":
            locked(ensure_running)
        elif cmd == "stop":
            locked(stop_proxy)
        elif cmd == "status":
            status()
        else:
            sys.exit(f"未知子命令: {cmd}")
    except Exception as e:
        # 生命周期钩子绝不阻塞 Qwen：失败只报 stderr
        print(f"codex-proxy: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()