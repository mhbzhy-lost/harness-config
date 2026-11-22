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
import time

STATE = os.path.expanduser("~/.qwen/codex-proxy")
REGISTRY = os.path.join(STATE, "sessions.json")
LOCK = os.path.join(STATE, "lock")
PROXY_PID = os.path.join(STATE, "proxy.pid")
WATCHDOG_PID = os.path.join(STATE, "watchdog.pid")
LOG = os.path.join(STATE, "proxy.log")
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


def read_pids():
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            return [int(p) for p in json.load(f)]
    except (OSError, ValueError):
        return []


def write_pids(pids):
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sorted(set(pids)), f)
    os.replace(tmp, REGISTRY)


def read_pidfile(path):
    try:
        with open(path, encoding="utf-8") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def proxy_running():
    pid = read_pidfile(PROXY_PID)
    return pid if pid and alive(pid) else None


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
    with open(CONFIG, "w", encoding="utf-8") as f:
        f.write(
            "config-version: 8\n"
            "server:\n"
            '  host: "127.0.0.1"\n'
            f"  port: {API_PORT}\n"
            "requests:\n"
            f'  proxy-url: "{UPSTREAM_PROXY}"\n'
            "oauth:\n"
            f'  auth-dir: "{AUTH_DIR}"\n'
        )


def port_ready():
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", API_PORT)) == 0


def stop_proxy():
    for path in (PROXY_PID, WATCHDOG_PID):
        pid = read_pidfile(path)
        if pid and alive(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        try:
            os.unlink(path)
        except OSError:
            pass


def ensure_running():
    if proxy_running():
        return
    bin_path = find_bin()
    if not os.path.isfile(bin_path) or not has_credentials():
        return
    gen_config()
    with open(LOG, "a", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [bin_path, "-config", CONFIG],
            stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    with open(PROXY_PID, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    wd = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "watchdog"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    with open(WATCHDOG_PID, "w", encoding="utf-8") as f:
        f.write(str(wd.pid))
    for _ in range(20):
        if port_ready():
            return
        time.sleep(0.5)


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
                proxy_pid = read_pidfile(PROXY_PID)
                for path in (PROXY_PID, WATCHDOG_PID):
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                if proxy_pid and alive(proxy_pid):
                    try:
                        os.kill(proxy_pid, signal.SIGTERM)
                    except OSError:
                        pass
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
        gen_config()
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