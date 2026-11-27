import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANAGER = ROOT / "qwen/extensions/codex-proxy/scripts/manager.py"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def make_isolated_env(home_dir: Path, bin_dir: Path, port: int) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home_dir)
    env["CODEX_PROXY_API_PORT"] = str(port)
    env["CODEX_UPSTREAM_PROXY"] = "http://127.0.0.1:19999"
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    return env


def run_manager(env: dict[str, str], *args: str, timeout: float = 10.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(MANAGER), *args],
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


class CodexProxyManagerTest(unittest.TestCase):
    def test_status_does_not_create_config_or_state_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            home_dir.mkdir()
            bin_dir.mkdir()
            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            res = run_manager(env, "status")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            data = json.loads(res.stdout)
            self.assertFalse(data["proxy_running"])
            self.assertEqual(data["api_port"], port)
            state_dir = home_dir / ".qwen" / "codex-proxy"
            self.assertFalse((state_dir / "config.yaml").exists())
            self.assertFalse(state_dir.exists())

    def test_ensure_running_exits_early_when_process_crashes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            auth_dir = home_dir / ".qwen" / "codex-proxy" / "auth"
            auth_dir.mkdir(parents=True)
            bin_dir.mkdir()
            (auth_dir / "cred.json").write_text('{"token":"fake"}', encoding="utf-8")

            fake_bin = bin_dir / "cliproxyapi"
            fake_bin.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            fake_bin.chmod(0o755)

            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            t0 = time.monotonic()
            res = run_manager(env, "register", str(os.getpid()), timeout=5.0)
            elapsed = time.monotonic() - t0
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertLess(elapsed, 1.5, msg=f"进程秒退后仍阻塞了 {elapsed:.2f}s")

            state_dir = home_dir / ".qwen" / "codex-proxy"
            self.assertTrue((state_dir / "config.yaml").exists())
            self.assertIn(f"port: {port}", (state_dir / "config.yaml").read_text(encoding="utf-8"))
            self.assertFalse((state_dir / "proxy.pid").exists())
            self.assertFalse((state_dir / "watchdog.pid").exists())

    def test_stop_proxy_verifies_process_identity_escalates_sigkill_and_rotates_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            state_dir = home_dir / ".qwen" / "codex-proxy"
            auth_dir = state_dir / "auth"
            auth_dir.mkdir(parents=True)
            bin_dir.mkdir()
            (auth_dir / "cred.json").write_text('{"token":"fake"}', encoding="utf-8")

            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            # 1. proxy.pid 指向无关进程（sleep）时 stop 不得误杀
            unrelated = subprocess.Popen(["sleep", "30"])
            try:
                (state_dir / "proxy.pid").write_text(str(unrelated.pid), encoding="utf-8")
                stop_res = run_manager(env, "stop")
                self.assertEqual(stop_res.returncode, 0, msg=stop_res.stderr)
                self.assertIsNone(unrelated.poll(), msg="stop_proxy 误杀了无关进程")
                self.assertFalse((state_dir / "proxy.pid").exists())
            finally:
                unrelated.terminate()
                unrelated.wait(timeout=5)

            # 2. 预置 >5MB proxy.log，假 cliproxyapi 忽略 SIGTERM 并监听隔离端口
            log_path = state_dir / "proxy.log"
            log_path.write_bytes(b"X" * (5 * 1024 * 1024 + 128))

            fake_bin = bin_dir / "cliproxyapi"
            fake_bin.write_text(
                "#!/usr/bin/env python3\n"
                "import signal, socket, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "port = None\n"
                "if '-config' in sys.argv:\n"
                "    cfg = open(sys.argv[sys.argv.index('-config') + 1]).read()\n"
                "    for line in cfg.splitlines():\n"
                "        if line.strip().startswith('port:'):\n"
                "            port = int(line.split(':', 1)[1].strip())\n"
                "s = socket.socket()\n"
                "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
                "s.bind(('127.0.0.1', port))\n"
                "s.listen(5)\n"
                "print('stub started', flush=True)\n"
                "while True:\n"
                "    time.sleep(1)\n",
                encoding="utf-8",
            )
            fake_bin.chmod(0o755)

            try:
                reg = run_manager(env, "register", str(os.getpid()), timeout=8.0)
                self.assertEqual(reg.returncode, 0, msg=reg.stderr)

                rotated = state_dir / "proxy.log.1"
                self.assertTrue(rotated.exists(), msg="超过 5MB 的 proxy.log 未轮转为 proxy.log.1")
                self.assertGreater(rotated.stat().st_size, 5 * 1024 * 1024)
                self.assertLess(log_path.stat().st_size, 1024 * 1024)

                status_res = run_manager(env, "status")
                status_data = json.loads(status_res.stdout)
                self.assertTrue(status_data["proxy_running"])
                proxy_pid = status_data["proxy_pid"]
                self.assertIsInstance(proxy_pid, int)

                # stop 必须先尝试 SIGTERM 并对忽略 SIGTERM 的进程升级 SIGKILL
                stop_res = run_manager(env, "stop", timeout=8.0)
                self.assertEqual(stop_res.returncode, 0, msg=stop_res.stderr)

                deadline = time.monotonic() + 2.0
                alive_after = True
                while time.monotonic() < deadline:
                    try:
                        os.kill(proxy_pid, 0)
                        time.sleep(0.05)
                    except ProcessLookupError:
                        alive_after = False
                        break
                self.assertFalse(alive_after, msg="忽略 SIGTERM 的代理进程未被 SIGKILL 清理")
            finally:
                # 兜底清理可能残留的测试子进程
                run_manager(env, "stop", timeout=5.0)


if __name__ == "__main__":
    unittest.main()
