import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANAGER = ROOT / "qwen/extensions/cliproxyapi/scripts/manager.py"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def make_isolated_env(home_dir: Path, bin_dir: Path, port: int) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home_dir)
    for key in ("CODEX_PROXY_API_PORT", "CODEX_UPSTREAM_PROXY", "CLIPROXYAPI_API_PORT", "CLIPROXYAPI_UPSTREAM_PROXY"):
        env.pop(key, None)
    env["CLIPROXYAPI_API_PORT"] = str(port)
    env["CLIPROXYAPI_UPSTREAM_PROXY"] = "http://127.0.0.1:19999"
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


class CliproxyapiManagerTest(unittest.TestCase):
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
            self.assertEqual(data["lifecycle"], "lazy")
            self.assertNotIn("sessions", data)
            state_dir = home_dir / ".qwen" / "cliproxyapi"
            self.assertFalse((state_dir / "config.yaml").exists())
            self.assertFalse(state_dir.exists())

    def test_ensure_running_exits_early_when_process_crashes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            auth_dir = home_dir / ".qwen" / "cliproxyapi" / "auth"
            auth_dir.mkdir(parents=True)
            bin_dir.mkdir()
            (auth_dir / "cred.json").write_text('{"token":"fake"}', encoding="utf-8")

            fake_bin = bin_dir / "cliproxyapi"
            fake_bin.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            fake_bin.chmod(0o755)

            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            state_dir = home_dir / ".qwen" / "cliproxyapi"
            for action in (("start",), ("register", str(os.getpid()))):
                t0 = time.monotonic()
                res = run_manager(env, *action, timeout=5.0)
                elapsed = time.monotonic() - t0
                self.assertEqual(res.returncode, 0, msg=res.stderr)
                self.assertLess(elapsed, 1.5, msg=f"进程秒退后仍阻塞了 {elapsed:.2f}s")
                self.assertTrue((state_dir / "config.yaml").exists())
                self.assertIn(f"port: {port}", (state_dir / "config.yaml").read_text(encoding="utf-8"))
                self.assertFalse((state_dir / "proxy.pid").exists())
                # 懒加载方案不再有 watchdog 与会话注册表
                self.assertFalse((state_dir / "watchdog.pid").exists())
                self.assertFalse((state_dir / "sessions.json").exists())

    def test_stop_proxy_verifies_process_identity_escalates_sigkill_and_rotates_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            state_dir = home_dir / ".qwen" / "cliproxyapi"
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

            # 预置旧版遗留文件，验证 stop 会顺带清理（watchdog.pid 指向无关进程时不得误杀）
            (state_dir / "sessions.json").write_text("[1, 2]", encoding="utf-8")
            unrelated_wd = subprocess.Popen(["sleep", "30"])
            (state_dir / "watchdog.pid").write_text(str(unrelated_wd.pid), encoding="utf-8")

            try:
                reg = run_manager(env, "start", timeout=8.0)
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

                # 兼容别名 unregister（旧机器未重跑 init-qwen.sh 时的旧 SessionEnd hook）必须是 no-op，不得停服
                unreg = run_manager(env, "unregister", str(os.getpid()), timeout=8.0)
                self.assertEqual(unreg.returncode, 0, msg=unreg.stderr)
                self.assertTrue(json.loads(run_manager(env, "status").stdout)["proxy_running"], msg="unregister 不得停止代理")
                os.kill(proxy_pid, 0)  # 代理进程仍存活

                # 再跑一次 start：已在运行时应直接返回且不重复拉起
                run_manager(env, "start", timeout=8.0)
                self.assertEqual(json.loads(run_manager(env, "status").stdout)["proxy_pid"], proxy_pid)

                # stop 必须先尝试 SIGTERM 并对忽略 SIGTERM 的进程升级 SIGKILL
                stop_res = run_manager(env, "stop", timeout=8.0)
                self.assertEqual(stop_res.returncode, 0, msg=stop_res.stderr)
                self.assertFalse((state_dir / "sessions.json").exists())
                self.assertFalse((state_dir / "watchdog.pid").exists())
                try:
                    os.kill(unrelated_wd.pid, 0)
                except ProcessLookupError:
                    self.fail("stop 误杀了遗留 watchdog.pid 指向的无关进程")

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
                self.assertFalse((state_dir / "proxy.pid").exists())
            finally:
                # 兜底清理可能残留的测试子进程
                run_manager(env, "stop", timeout=5.0)
                unrelated_wd.kill()
                unrelated_wd.wait(timeout=5)


class LegacyEnvAndInitConfigTest(unittest.TestCase):
    def test_legacy_env_vars_fall_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            home_dir.mkdir()
            bin_dir.mkdir()
            port = find_free_port()

            env = make_isolated_env(home_dir, bin_dir, port)
            env.pop("CLIPROXYAPI_API_PORT")
            env.pop("CLIPROXYAPI_UPSTREAM_PROXY")
            env["CODEX_PROXY_API_PORT"] = str(port)
            env["CODEX_UPSTREAM_PROXY"] = "http://127.0.0.1:19998"
            data = json.loads(run_manager(env, "status").stdout)
            self.assertEqual(data["api_port"], port)
            self.assertEqual(data["upstream_proxy"], "http://127.0.0.1:19998")

            # 新变量优先于旧变量
            env["CLIPROXYAPI_API_PORT"] = str(port + 1)
            env["CLIPROXYAPI_UPSTREAM_PROXY"] = "http://127.0.0.1:19999"
            data = json.loads(run_manager(env, "status").stdout)
            self.assertEqual(data["api_port"], port + 1)
            self.assertEqual(data["upstream_proxy"], "http://127.0.0.1:19999")

            # 两者都缺省时回落默认值
            for key in ("CODEX_PROXY_API_PORT", "CODEX_UPSTREAM_PROXY",
                        "CLIPROXYAPI_API_PORT", "CLIPROXYAPI_UPSTREAM_PROXY"):
                env.pop(key, None)
            data = json.loads(run_manager(env, "status").stdout)
            self.assertEqual(data["api_port"], 8317)
            self.assertEqual(data["upstream_proxy"], "http://127.0.0.1:7897")
            self.assertFalse((home_dir / ".qwen").exists(), msg="status 不得创建状态目录")

    def test_init_config_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            home_dir.mkdir()
            bin_dir.mkdir()
            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            res = run_manager(env, "init-config")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            state_dir = home_dir / ".qwen" / "cliproxyapi"
            config = state_dir / "config.yaml"
            self.assertTrue(config.exists())
            self.assertTrue((state_dir / "auth").is_dir())
            text = config.read_text(encoding="utf-8")
            self.assertIn(f"port: {port}", text)
            self.assertIn('proxy-url: "http://127.0.0.1:19999"', text)
            self.assertIn(f'auth-dir: "{state_dir / "auth"}"', text)

            # 用户手改后的配置不被覆盖
            config.write_text(text.replace("port: ", "# port: "), encoding="utf-8")
            res = run_manager(env, "init-config")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertIn("# port: ", config.read_text(encoding="utf-8"))


def run_init_qwen(home_dir: Path, *extra_args: str, timeout: float = 60.0) -> subprocess.CompletedProcess[str]:
    """在隔离 HOME 下运行 init-qwen.sh（所有目标路径均重定向到临时目录），绝不触碰真实 ~/.qwen。"""
    env = os.environ.copy()
    env["HOME"] = str(home_dir)
    qwen_dir = home_dir / ".qwen"
    env["QWEN_SETTINGS_PATH"] = str(qwen_dir / "settings.json")
    env["QWEN_EXTENSIONS_DIR"] = str(qwen_dir / "extensions")
    env["QWEN_SHELL_RC"] = str(home_dir / ".zshrc")
    env["QWEN_GLOBAL_MD"] = str(qwen_dir / "QWEN.md")
    env["QWEN_AGENTS_DIR"] = str(qwen_dir / "agents")
    return subprocess.run(
        ["bash", str(ROOT / "init-qwen.sh"), *extra_args],
        env=env, text=True, capture_output=True, timeout=timeout, check=False,
    )


def named_hook_commands(settings: dict, event: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for group in settings.get("hooks", {}).get(event, []):
        for hook in group.get("hooks", []):
            if isinstance(hook, dict) and isinstance(hook.get("name"), str):
                out[hook["name"]] = hook.get("command", "")
    return out


def legacy_layout(home_dir: Path) -> tuple[Path, Path]:
    """构造改名前的机器状态：旧状态目录 + 指向仓内旧路径的 extension 断链。"""
    qwen_dir = home_dir / ".qwen"
    old_state = qwen_dir / "codex-proxy"
    (old_state / "auth").mkdir(parents=True)
    (old_state / "auth" / "cred.json").write_text('{"token":"fake"}', encoding="utf-8")
    (old_state / "config.yaml").write_text(
        "config-version: 8\n"
        "server:\n"
        '  host: "127.0.0.1"\n'
        "  port: 8317\n"
        "oauth:\n"
        f'  auth-dir: "{old_state / "auth"}"\n'
        'remote-management: {"server-id": "keep-me"}\n',
        encoding="utf-8",
    )
    (old_state / "proxy.log").write_text("old log\n", encoding="utf-8")

    ext_dir = qwen_dir / "extensions"
    ext_dir.mkdir(parents=True)
    (ext_dir / "codex-proxy").symlink_to(ROOT / "qwen" / "extensions" / "codex-proxy")
    assert not (ext_dir / "codex-proxy").exists(), "旧 extension 软链应为断链"
    return old_state, ext_dir


def legacy_settings(hook_script: Path) -> dict:
    return {
        "env": {"KEEP_ME": "1"},
        "hooks": {
            "SessionStart": [
                {"hooks": [{"type": "command", "name": "user-hook", "command": "echo user"}]},
                {"hooks": [{"type": "command", "name": "codex-proxy-start", "command": f'bash "{hook_script}" register'}]},
            ],
            "SessionEnd": [
                {"matcher": "logout|other",
                 "hooks": [{"type": "command", "name": "codex-proxy-end", "command": f'bash "{hook_script}" unregister'}]},
                {"matcher": "logout|prompt_input_exit|bypass_permissions_disabled|other",
                 "hooks": [{"type": "command", "name": "cliproxyapi-end", "command": f'bash "{hook_script}" unregister'}]},
                {"hooks": [{"type": "command", "name": "user-end-hook", "command": "echo user-end"}]},
            ],
        },
    }


class InitQwenMigrationTest(unittest.TestCase):
    def test_migrates_hooks_extension_link_and_state_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home_dir = Path(tmp) / "home"
            home_dir.mkdir()
            old_state, ext_dir = legacy_layout(home_dir)
            settings_path = home_dir / ".qwen" / "settings.json"
            settings_path.write_text(
                json.dumps(legacy_settings(ROOT / "qwen" / "extensions" / "codex-proxy" / "scripts" / "hook.sh")),
                encoding="utf-8",
            )

            # 旧 proxy.pid 指向无关进程：迁移时的温和停止不得误杀
            unrelated = subprocess.Popen(["sleep", "30"])
            try:
                (old_state / "proxy.pid").write_text(str(unrelated.pid), encoding="utf-8")
                res = run_init_qwen(home_dir)
                self.assertEqual(res.returncode, 0, msg=res.stderr)
                self.assertIsNone(unrelated.poll(), msg="迁移误杀了无关进程")
            finally:
                unrelated.terminate()
                unrelated.wait(timeout=5)

            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            start = named_hook_commands(settings, "SessionStart")
            end = named_hook_commands(settings, "SessionEnd")
            self.assertNotIn("codex-proxy-start", start)
            self.assertNotIn("codex-proxy-end", end)
            self.assertIn("cliproxyapi-start", start)
            self.assertIn("cliproxyapi/scripts/hook.sh", start["cliproxyapi-start"])
            self.assertTrue(start["cliproxyapi-start"].endswith(" start"), msg=start["cliproxyapi-start"])
            # 懒加载方案退出不回收：旧的 SessionEnd cliproxyapi-end 必须被按名清理，用户自己的 hook 保留
            self.assertNotIn("cliproxyapi-end", end)
            self.assertEqual(end, {"user-end-hook": "echo user-end"})
            self.assertEqual(settings["env"]["KEEP_ME"], "1")
            self.assertEqual(named_hook_commands(settings, "SessionStart")["user-hook"], "echo user")

            # 旧断链被清理，新链指向仓内 cliproxyapi
            self.assertFalse((ext_dir / "codex-proxy").is_symlink(), msg="旧 extension 软链未清理")
            new_link = ext_dir / "cliproxyapi"
            self.assertTrue(new_link.is_symlink())
            self.assertEqual(os.readlink(new_link), str(ROOT / "qwen" / "extensions" / "cliproxyapi"))

            # 状态目录迁移 + auth-dir 改写 + 其他配置保留
            new_state = home_dir / ".qwen" / "cliproxyapi"
            self.assertFalse(old_state.exists())
            self.assertTrue((new_state / "auth" / "cred.json").exists())
            self.assertTrue((new_state / "proxy.log").exists())
            config = (new_state / "config.yaml").read_text(encoding="utf-8")
            self.assertNotIn(str(old_state), config)
            self.assertIn(f'auth-dir: "{new_state / "auth"}"', config)
            self.assertIn('"server-id": "keep-me"', config)
            self.assertIn("port: 8317", config)

            # 幂等：再次运行无变化
            snapshot = sorted(str(p.relative_to(home_dir)) for p in home_dir.rglob("*"))
            second = run_init_qwen(home_dir)
            self.assertEqual(second.returncode, 0, msg=second.stderr)
            self.assertEqual(sorted(str(p.relative_to(home_dir)) for p in home_dir.rglob("*")), snapshot)
            self.assertFalse(second.stdout.count("状态目录已迁移"))

    def test_dry_run_makes_no_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            home_dir.mkdir()
            old_state, _ = legacy_layout(home_dir)
            settings_path = home_dir / ".qwen" / "settings.json"
            settings_path.write_text(
                json.dumps(legacy_settings(ROOT / "qwen" / "extensions" / "codex-proxy" / "scripts" / "hook.sh")),
                encoding="utf-8",
            )

            def snapshot() -> dict[str, tuple[str, bytes]]:
                return {
                    str(p.relative_to(tmp_path)): (
                        "link:" + os.readlink(p) if p.is_symlink()
                        else "dir" if p.is_dir() else p.read_bytes())
                    for p in tmp_path.rglob("*")
                }

            before = snapshot()
            res = run_init_qwen(home_dir, "--dry-run")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertEqual(snapshot(), before, msg="--dry-run 产生了磁盘变更")
            self.assertTrue(old_state.exists())
            self.assertFalse((home_dir / ".qwen" / "cliproxyapi").exists())
            self.assertTrue((home_dir / ".qwen" / "extensions" / "codex-proxy").is_symlink())
            self.assertIn("[dry-run]", res.stdout)
            self.assertIn("cliproxyapi", res.stdout)
            self.assertNotIn("状态目录已迁移", res.stdout)

    def test_keeps_real_directory_or_foreign_link_named_codex_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home_dir = Path(tmp) / "home"
            home_dir.mkdir()
            qwen_dir = home_dir / ".qwen"
            ext_dir = qwen_dir / "extensions"
            ext_dir.mkdir(parents=True)
            real_dir = ext_dir / "codex-proxy"
            real_dir.mkdir()
            (real_dir / "keep.txt").write_text("keep", encoding="utf-8")
            foreign = qwen_dir / "foreign-target"
            foreign.mkdir()
            state_base = qwen_dir
            (state_base / "codex-proxy").symlink_to(foreign)

            res = run_init_qwen(home_dir)
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertTrue((real_dir / "keep.txt").exists())
            self.assertTrue((state_base / "codex-proxy").is_symlink(), msg="指向他处的同名链接/目录不得被当成状态目录迁移")
            self.assertFalse((state_base / "cliproxyapi").exists())


if __name__ == "__main__":
    unittest.main()
