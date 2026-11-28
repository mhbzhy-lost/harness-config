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

# 期望的跨机安全基线段（独立于实现手写，防止实现与测试同源漂移）
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
    '        "You are a coding assistant running inside pi, a coding agent harness.": "You are a helpful coding assistant."\n'
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

    def test_init_config_writes_cross_machine_baseline_with_0600(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            home_dir = tmp_path / "home"
            bin_dir = tmp_path / "bin"
            home_dir.mkdir()
            bin_dir.mkdir()
            port = find_free_port()
            env = make_isolated_env(home_dir, bin_dir, port)

            self.assertEqual(run_manager(env, "init-config").returncode, 0)
            config = home_dir / ".qwen" / "cliproxyapi" / "config.yaml"
            text = config.read_text(encoding="utf-8")
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertIn("config-version: 8\n", text)
            self.assertIn('  host: "127.0.0.1"\n', text)
            self.assertIn(f"  port: {port}\n", text)
            # 冷却/重试保护
            self.assertIn("routing:\n  retry:\n    request-retry: 0\n    max-retry-interval: 0\n  cooldown:\n    save-cooldown-status: true\n", text)
            self.assertIn(f'  proxy-url: "http://127.0.0.1:19999"\n', text)
            self.assertIn(f'  auth-dir: "{home_dir / ".qwen" / "cliproxyapi" / "auth"}"\n', text)
            # Antigravity 身份清洗（Pi 自述 + 网关名 + Qwen 署名 + <docs> 段）
            self.assertIn(f'  auth-dir: "{home_dir / ".qwen" / "cliproxyapi" / "auth"}"\n' + MODEL_ALIAS_ANTIGRAVITY_BLOCK + "  providers:\n    antigravity:\n      tos-pause-window: \"6h\"\n", text, "model-alias 位于 auth-dir 与 providers 之间")
            self.assertIn('        "You are a coding assistant running inside pi, a coding agent harness.": "You are a helpful coding assistant."\n', text)
            for word in ("cliproxyapi", "CLIProxyAPI", "codex-proxy"):
                self.assertIn(f'        "{word}": "local-gateway"\n', text)
            self.assertIn("        - pattern: 'You are Qwen Code,[^\\n.]*developed by Alibaba Group[^\\n.]*\\.'\n          replacement: \"You are a helpful coding assistant.\"\n", text)
            self.assertIn("        - pattern: 'You are Qwen Code,[^\\n.]*\\.'\n          replacement: \"You are a helpful coding assistant.\"\n", text)
            self.assertIn("        - pattern: '(?s)<docs>.*?</docs>\\n?'\n          replacement: \"\"\n", text)
            self.assertTrue(text.endswith("\n"))

            # 生成结果对 sync-config 而言已是完整基线：不得再改写或产生备份
            before = config.read_bytes()
            res = run_manager(env, "sync-config")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertEqual(res.stdout.strip(), "")
            self.assertEqual(config.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in config.parent.iterdir()), ["auth", "config.yaml", "lock"])

    def test_state_dir_env_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            state_dir = tmp_path / "custom-state"
            env = make_isolated_env(tmp_path / "home", bin_dir, find_free_port())
            env["CLIPROXYAPI_STATE_DIR"] = str(state_dir)

            self.assertEqual(run_manager(env, "init-config").returncode, 0)
            self.assertTrue((state_dir / "config.yaml").exists())
            self.assertTrue((state_dir / "auth").is_dir())
            self.assertFalse((tmp_path / "home" / ".qwen").exists(), msg="CLIPROXYAPI_STATE_DIR 覆盖后不得再使用 ~/.qwen/cliproxyapi")
            self.assertIn(f'auth-dir: "{state_dir / "auth"}"', (state_dir / "config.yaml").read_text(encoding="utf-8"))

            # 空字符串视为未设置，回落默认
            env["CLIPROXYAPI_STATE_DIR"] = ""
            data = json.loads(run_manager(env, "status").stdout)
            self.assertEqual(data["api_port"], int(env["CLIPROXYAPI_API_PORT"]))


def legacy_config(auth_dir: Path) -> str:
    """改造前的旧版 config.yaml：无 routing、无 providers.antigravity，带用户手改项与注释。"""
    return (
        "config-version: 8\n"
        "server:\n"
        '  host: "127.0.0.1"  # 本机绑定\n'
        "  port: 8317\n"
        "  server-id: keep-me-1234\n"
        "requests:\n"
        '  proxy-url: "http://127.0.0.1:7899"\n'
        "oauth:\n"
        f'  auth-dir: "{auth_dir}"\n'
        "  model-alias:\n"
        "    antigravity:\n"
        '      - name: "gemini-4-carbon-high"\n'
        '        alias: "gemini-4-carbon"\n'
    )


class SyncConfigTest(unittest.TestCase):
    """sync-config：对已有旧 config.yaml 做非破坏性增量补齐（全部隔离在临时目录，不触碰 ~/.qwen）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.config = self.state / "config.yaml"
        self.port = find_free_port()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.env = make_isolated_env(self.root / "home", self.bin_dir, self.port)
        self.env["CLIPROXYAPI_STATE_DIR"] = str(self.state)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def sync(self, *args: str) -> subprocess.CompletedProcess[str]:
        res = run_manager(self.env, "sync-config", *args)
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(res.stderr.strip(), "")
        return res

    def backups(self) -> list[str]:
        return sorted(p.name for p in self.state.glob("config.yaml.bak-*"))

    def test_sync_config_upgrades_legacy_config_preserving_user_changes(self) -> None:
        self.config.write_text(legacy_config(self.state / "auth"), encoding="utf-8")
        self.config.chmod(0o644)
        original = self.config.read_text(encoding="utf-8")

        res = self.sync()
        self.assertIn("已增量补齐", res.stdout)
        self.assertIn("routing", res.stdout)
        self.assertIn("providers:", res.stdout)
        text = self.config.read_text(encoding="utf-8")
        # 新增段
        self.assertIn("routing:\n  retry:\n    request-retry: 0\n    max-retry-interval: 0\n  cooldown:\n    save-cooldown-status: true\nrequests:\n", text, "routing 段应插在 server 之后、requests 之前")
        self.assertIn("  providers:\n    antigravity:\n      tos-pause-window: \"6h\"\n      sensitive-words-replace:\n", text)
        self.assertIn('        "cliproxyapi": "local-gateway"\n', text)
        self.assertIn("        - pattern: '(?s)<docs>.*?</docs>\\n?'\n          replacement: \"\"\n", text)
        # 旧内容逐行保留（含注释、server-id、手改端口与代理、auth-dir、model-alias）
        for line in original.splitlines():
            self.assertIn(line, text.splitlines(), msg=f"用户原有行丢失: {line!r}")
        self.assertLess(text.index("routing:"), text.index("requests:"))
        # providers 段追加在 oauth 块末尾（model-alias 之后）
        self.assertLess(text.index("alias: \"gemini-4-carbon\""), text.index("  providers:"))
        # 备份为原文（0600），config.yaml 收紧为 0600
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        self.assertRegex(backups[0], r"^config\.yaml\.bak-\d{14}$")
        self.assertEqual((self.state / backups[0]).read_text(encoding="utf-8"), original)
        self.assertEqual((self.state / backups[0]).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)

        # 二次执行：严格幂等，无变更、无新备份
        snapshot = self.config.read_bytes()
        second = self.sync()
        self.assertEqual(second.stdout.strip(), "")
        self.assertEqual(self.config.read_bytes(), snapshot)
        self.assertEqual(self.backups(), backups)

    def test_sync_config_inserts_providers_when_oauth_lacks_it_and_no_oauth_at_all(self) -> None:
        # oauth 存在但无 providers:
        self.config.write_text('config-version: 8\nserver:\n  port: 1\noauth:\n  auth-dir: "/x/auth"\n', encoding="utf-8")
        self.sync()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn('  auth-dir: "/x/auth"\n' + MODEL_ALIAS_ANTIGRAVITY_BLOCK + "  providers:\n    antigravity:\n      tos-pause-window: \"6h\"\n", text, "oauth 存在但无 model-alias/providers：依次追加")
        # 连顶层 oauth: 都没有（且末尾无换行）
        self.config.write_text("config-version: 8\nserver:\n  port: 2", encoding="utf-8")
        res = self.sync()
        self.assertEqual(res.stdout.count("将补齐") + res.stdout.count("已增量补齐"), 1)
        text = self.config.read_text(encoding="utf-8")
        self.assertIn("  port: 2\n\nrouting:\n  retry:\n", text, "只有 config-version/server 时 routing 追加到末尾，并先补行结束")
        self.assertLess(text.index("routing:"), text.index("oauth:"))
        self.assertTrue(text.endswith("\noauth:\n  model-alias:\n    antigravity:\n" + MODEL_ALIAS_ANTIGRAVITY_BLOCK.split("\n", 2)[2].rstrip("\n") + "\n  providers:\n" + ANTIGRAVITY_PROVIDER_BLOCK.rstrip("\n") + "\n"), "无 oauth: 时依次追加 model-alias 与 providers")
        self.assertIn('          replacement: ""\n', text)

    def test_sync_config_never_overwrites_existing_routing_or_antigravity(self) -> None:
        # 用户自有 routing:（即便内容不同）与 providers.antigravity:（即便内容不同）均原样保留
        original = (
            "routing:\n"
            "  retry:\n"
            "    request-retry: 3\n"
            "oauth:\n"
            '  auth-dir: "/x/auth"\n'
            "  providers:\n"
            "    antigravity:\n"
            "      tos-pause-window: \"1h\"\n"
            "  model-alias:\n"
            "    antigravity:\n"
            "      - name: \"a\"\n"
        )
        self.config.write_text(original, encoding="utf-8")
        res = self.sync()
        self.assertEqual(res.stdout.strip(), "")
        self.assertEqual(self.config.read_text(encoding="utf-8"), original)
        self.assertEqual(self.backups(), [])
        # dry-run 同样报告无变更
        self.assertEqual(self.sync("--dry-run").stdout.strip(), "")

        # providers: 下已有其它渠道但无 antigravity：只在 providers 子块末尾追加，不碰 model-alias.antigravity
        partial = (
            "oauth:\n"
            "  model-alias:\n"
            "    antigravity:\n"
            "      - name: \"a\"\n"
            "  providers:\n"
            "    codex:\n"
            "      k: 1\n"
        )
        self.config.write_text(partial, encoding="utf-8")
        self.sync()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn("    codex:\n      k: 1\n    antigravity:\n      tos-pause-window: \"6h\"\n", text)
        self.assertLess(text.index("model-alias:"), text.index("  providers:"), "不得打乱既有键顺序")

        # 只有 model-alias.antigravity 而无 providers:：同名键不算 providers.antigravity，仍须在 oauth 块末尾补 providers:
        alias_only = "oauth:\n  auth-dir: \"/x/auth\"\n  model-alias:\n    antigravity:\n      - name: \"a\"\n        alias: \"b\"\n"
        self.config.write_text(alias_only, encoding="utf-8")
        self.sync()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn(alias_only, text, "oauth 块原有行原样保留在 providers: 之前")
        self.assertIn('        alias: "b"\n  providers:\n    antigravity:\n      tos-pause-window: "6h"\n', text)
        self.assertEqual(text.count("  providers:"), 1)
        # 顶层无 oauth: 但有其它同名键，同样补齐 oauth.providers.antigravity
        self.config.write_text("config-version: 8\nmodel-alias:\n  antigravity:\n    k: 1\n", encoding="utf-8")
        self.sync()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn("routing:\n  retry:\n    request-retry: 0\n", text)
        self.assertIn("    k: 1\n\noauth:\n" + MODEL_ALIAS_ANTIGRAVITY_BLOCK + "  providers:\n    antigravity:\n", text)
        self.assertEqual(self.sync().stdout.strip(), "")

    def test_sync_config_fills_model_alias_antigravity_independently(self) -> None:
        alias_tail = MODEL_ALIAS_ANTIGRAVITY_BLOCK.split("\n", 2)[2].rstrip("\n") + "\n"
        # 1. 已有 routing 与 providers.antigravity，但无 model-alias：仅单独补齐 oauth 块末尾的 model-alias
        base = "routing:\n  retry: {}\noauth:\n  auth-dir: \"/x/auth\"\n  providers:\n    antigravity:\n      x: 1\n"
        self.config.write_text(base, encoding="utf-8")
        res = self.sync()
        self.assertIn("model-alias:", res.stdout)
        text = self.config.read_text(encoding="utf-8")
        self.assertTrue(text.startswith(base), "既有行原样保留，model-alias 追加在 oauth 块末尾")
        self.assertTrue(text.endswith("      x: 1\n" + MODEL_ALIAS_ANTIGRAVITY_BLOCK), text)
        self.assertEqual(len(self.backups()), 1)
        second = self.sync()
        self.assertEqual(second.stdout.strip(), "")
        self.assertEqual(len(self.backups()), 1, "二次执行严格 no-op，不产生多余备份")

        # 2. 已有 model-alias（其它 provider 别名）但无 antigravity：在 model-alias 子块末尾插入
        self.config.write_text('oauth:\n  model-alias:\n    gemini:\n      - name: "g"\n        alias: "x"\n  providers:\n    antigravity:\n      x: 1\n', encoding="utf-8")
        self.sync()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn('        alias: "x"\n    antigravity:\n      - name: "gemini-4-carbon-high"\n        alias: "gemini-4-carbon"\n        fork: true\n', text)
        self.assertIn('        alias: "gemini-4-hydrogen"\n        fork: true\n  providers:\n    antigravity:\n      x: 1\n', text, "model-alias 子块之后仍是 providers，嵌套不乱")
        self.assertEqual(text.count("  model-alias:"), 1)
        self.assertEqual(self.sync().stdout.strip(), "")

        # 3. 用户自定义 model-alias.antigravity：不覆盖
        custom = "oauth:\n  model-alias:\n    antigravity:\n      - name: \"mine\"\n        alias: \"my-alias\"\n"
        self.config.write_text(custom, encoding="utf-8")
        res = self.sync()
        self.assertNotIn("model-alias", res.stdout, "已有自定义 model-alias.antigravity 不覆盖")
        self.assertIn(custom, self.config.read_text(encoding="utf-8"))
        self.assertNotIn("gemini-4-carbon", self.config.read_text(encoding="utf-8"))

        # 4. 只有 model-alias.antigravity、无 providers.antigravity / routing：后两项单独补齐
        only_alias = "oauth:\n" + MODEL_ALIAS_ANTIGRAVITY_BLOCK
        self.config.write_text(only_alias, encoding="utf-8")
        res = self.sync()
        self.assertIn("routing:", res.stdout)
        self.assertIn("providers:", res.stdout)
        self.assertNotIn("model-alias", res.stdout)
        text = self.config.read_text(encoding="utf-8")
        self.assertTrue(text.endswith('        fork: true\n  providers:\n' + ANTIGRAVITY_PROVIDER_BLOCK), text)
        self.assertEqual(text.count("    antigravity:"), 2, "model-alias 与 providers 各一个 antigravity")
        self.assertEqual(self.sync().stdout.strip(), "")

    def test_sync_config_dry_run_makes_no_changes(self) -> None:
        self.config.write_text(legacy_config(self.state / "auth"), encoding="utf-8")
        before = self.config.read_bytes()
        mode = self.config.stat().st_mode
        res = self.sync("--dry-run")
        self.assertIn("[dry-run]", res.stdout)
        self.assertEqual(self.config.read_bytes(), before, "--dry-run 不得改写 config.yaml")
        self.assertEqual(self.config.stat().st_mode, mode)
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ["config.yaml"], "--dry-run 不得产生备份或其他文件")

    def test_sync_config_noop_when_config_missing(self) -> None:
        res = self.sync()
        self.assertEqual(res.stdout.strip(), "")
        self.assertEqual(list(self.state.iterdir()), [], "config.yaml 不存在时不得创建 lock/目录/文件")
        self.assertFalse((self.state / "config.yaml").exists())
        # 状态目录本身也不存在：同样静默 no-op
        missing = self.root / "missing-state"
        self.env["CLIPROXYAPI_STATE_DIR"] = str(missing)
        self.assertEqual(self.sync().stdout.strip(), "")
        self.assertFalse(missing.exists())
        # --dry-run 组合同样 no-op
        self.assertEqual(self.sync("--dry-run").stdout.strip(), "")

    def test_sync_config_rejects_unknown_args(self) -> None:
        res = run_manager(self.env, "sync-config", "--force")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("未知参数", res.stderr + res.stdout)


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
            self.assertIn('auth-dir: "' + str(new_state / "auth") + '"', config)
            self.assertIn('"server-id": "keep-me"', config)
            self.assertIn("port: 8317", config)
            # 1c. 迁移后的旧 config.yaml 被增量补齐跨机安全基线，且用户手改项原样保留
            self.assertIn("routing:\n  retry:\n    request-retry: 0\n    max-retry-interval: 0\n  cooldown:\n    save-cooldown-status: true\n", config)
            self.assertIn("  providers:\n    antigravity:\n      tos-pause-window: \"6h\"\n", config)
            self.assertIn('        "cliproxyapi": "local-gateway"', config)
            self.assertEqual(config.count('auth-dir: "' + str(new_state / "auth") + '"'), 1)
            backups = sorted(p.name for p in new_state.glob("config.yaml.bak-*"))
            self.assertEqual(len(backups), 1, f"首次升级应恰好产生一个备份: {backups}")
            self.assertEqual((new_state / backups[0]).stat().st_mode & 0o777, 0o600)
            self.assertEqual((new_state / "config.yaml").stat().st_mode & 0o777, 0o600)
            self.assertIn("已增量补齐", res.stdout)

            # 幂等：再次运行无变化（含不再产生新的 config.yaml 备份）
            snapshot = sorted(str(p.relative_to(home_dir)) for p in home_dir.rglob("*"))
            second = run_init_qwen(home_dir)
            self.assertEqual(second.returncode, 0, msg=second.stderr)
            self.assertEqual(sorted(str(p.relative_to(home_dir)) for p in home_dir.rglob("*")), snapshot)
            self.assertFalse(second.stdout.count("状态目录已迁移"))
            self.assertNotIn("已增量补齐", second.stdout)

    def test_upgrades_existing_state_config_without_migration(self) -> None:
        """新机器已是 cliproxyapi 目录但 config.yaml 为旧版：init-qwen.sh 仅增量补齐，不动状态目录。"""
        with tempfile.TemporaryDirectory() as tmp:
            home_dir = Path(tmp) / "home"
            home_dir.mkdir()
            settings_path = home_dir / ".qwen" / "settings.json"
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text(json.dumps({"env": {"KEEP_ME": "1"}}), encoding="utf-8")
            state_dir = home_dir / ".qwen" / "cliproxyapi"
            state_dir.mkdir()
            config = state_dir / "config.yaml"
            config.write_text(legacy_config(state_dir / "auth"), encoding="utf-8")
            (state_dir / "proxy.log").write_text("log\n", encoding="utf-8")

            res = run_init_qwen(home_dir)
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            text = config.read_text(encoding="utf-8")
            self.assertIn("  server-id: keep-me-1234\n", text)
            self.assertIn('  proxy-url: "http://127.0.0.1:7899"\n', text)
            self.assertIn('  host: "127.0.0.1"  # 本机绑定\n', text)
            self.assertIn("routing:\n  retry:\n    request-retry: 0\n", text)
            self.assertIn("    antigravity:\n      tos-pause-window: \"6h\"\n", text)
            self.assertTrue((state_dir / "proxy.log").exists())
            self.assertEqual(len(list(state_dir.glob("config.yaml.bak-*"))), 1)
            self.assertEqual(json.loads(settings_path.read_text(encoding="utf-8"))["env"]["KEEP_ME"], "1")

            # 重跑：幂等，不再产生第二个备份
            again = run_init_qwen(home_dir)
            self.assertEqual(again.returncode, 0, msg=again.stderr)
            self.assertEqual(len(list(state_dir.glob("config.yaml.bak-*"))), 1)
            self.assertNotIn("已增量补齐", again.stdout)

    def test_dry_run_previews_sync_without_touching_legacy_state_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home_dir = Path(tmp) / "home"
            home_dir.mkdir()
            state_dir = home_dir / ".qwen" / "cliproxyapi"
            state_dir.mkdir(parents=True)
            config = state_dir / "config.yaml"
            config.write_text(legacy_config(state_dir / "auth"), encoding="utf-8")
            before = config.read_bytes()

            res = run_init_qwen(home_dir, "--dry-run")
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertIn("[dry-run]", res.stdout)
            self.assertIn("将补齐", res.stdout, "旧 config.yaml 应预览补齐计划")
            self.assertEqual(config.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in state_dir.iterdir()), ["config.yaml"])
            self.assertFalse((home_dir / ".qwen" / "settings.json").exists())

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
