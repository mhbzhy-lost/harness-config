import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemoteTerminalSyncTest(unittest.TestCase):
    def test_init_remote_dry_run_makes_no_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            shell_rc = Path(tmp) / ".zshrc"
            state_dir = Path(tmp) / "remote-state"
            env = os.environ.copy()
            env["REMOTE_SHELL_RC"] = str(shell_rc)
            env["HARNESS_REMOTE_DIR"] = str(state_dir)

            res = subprocess.run(
                ["bash", str(ROOT / "init-remote.sh"), "--dry-run"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=f"stdout:\n{res.stdout}\nstderr:\n{res.stderr}")
            self.assertFalse(shell_rc.exists())
            self.assertFalse(state_dir.exists())

    def test_init_remote_registers_shell_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            shell_rc = Path(tmp) / ".zshrc"
            shell_rc.write_text("# user zshrc\n", encoding="utf-8")
            state_dir = Path(tmp) / "remote-state"
            env = os.environ.copy()
            env["REMOTE_SHELL_RC"] = str(shell_rc)
            env["HARNESS_REMOTE_DIR"] = str(state_dir)

            first = subprocess.run(
                ["bash", str(ROOT / "init-remote.sh"), "--skip-install"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, msg=f"stdout:\n{first.stdout}\nstderr:\n{first.stderr}")
            rc_text = shell_rc.read_text(encoding="utf-8")
            self.assertIn("# >>> harness-config remote-terminal >>>", rc_text)
            self.assertIn(str(ROOT / "remote-terminal/shell.zsh"), rc_text)
            self.assertIn("# user zshrc", rc_text)
            self.assertEqual(len(list(Path(tmp).glob(".zshrc.bak.*"))), 1)

            second = subprocess.run(
                ["bash", str(ROOT / "init-remote.sh"), "--skip-install"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, msg=f"stdout:\n{second.stdout}\nstderr:\n{second.stderr}")
            self.assertEqual(shell_rc.read_text(encoding="utf-8"), rc_text)
            self.assertEqual(len(list(Path(tmp).glob(".zshrc.bak.*"))), 1)

    def test_shell_wrapper_validates_name_and_runs_inside_tmux(self) -> None:
        shell_file = ROOT / "remote-terminal/shell.zsh"
        # 验证非法会话名被拒绝
        bad = subprocess.run(
            ["zsh", "-c", f'source "{shell_file}"; rt -n "bad:name" echo hi'],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("会话名只允许", bad.stderr)

        # 验证已在 TMUX 内时直接透传任意命令不嵌套 tmux
        env = os.environ.copy()
        env["TMUX"] = "/tmp/tmux-test,123,0"
        inside = subprocess.run(
            ["zsh", "-c", f'source "{shell_file}"; rt echo "HELLO_ANY_CMD"'],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(inside.returncode, 0, msg=f"stderr:\n{inside.stderr}")
        self.assertIn("HELLO_ANY_CMD", inside.stdout)

        # 验证 --help 与会话名生成格式
        gen = subprocess.run(
            ["zsh", "-c", f'source "{shell_file}"; _rt_session_name qwen'],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(gen.returncode, 0, msg=f"stderr:\n{gen.stderr}")
        name = gen.stdout.strip()
        self.assertRegex(name, r"^qwen-[A-Za-z0-9_-]+-[0-9a-f]{4}-\d+$")

    def test_remote_ui_is_generic_not_pi_only(self) -> None:
        html = (ROOT / "remote-terminal/src/web/public/index.html").read_text(encoding="utf-8")
        self.assertIn("<title>远程终端 · tmux</title>", html)
        self.assertIn("<h1>终端会话</h1>", html)
        self.assertNotIn("<h1>pi 会话</h1>", html)

    def test_shell_ensure_fast_path_skips_node_when_web_exposure_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_root = tmp_path / "rt-root"
            fake_root.mkdir()
            (fake_root / "node_modules").mkdir()
            shell_copy = fake_root / "shell.zsh"
            shell_copy.write_text((ROOT / "remote-terminal/shell.zsh").read_text(encoding="utf-8"), encoding="utf-8")

            log_file = tmp_path / "node_calls.log"
            fake_node = tmp_path / "fake-node"
            fake_node.write_text(f"#!/bin/sh\necho \"$@\" >> \"{log_file}\"\n", encoding="utf-8")
            fake_node.chmod(0o755)

            state_dir = tmp_path / "state"
            state_dir.mkdir()
            cfg = state_dir / "config.json"
            cfg.write_text('{"webExposure": "off"}\n', encoding="utf-8")

            env = os.environ.copy()
            env["HARNESS_REMOTE_NODE"] = str(fake_node)
            env["HARNESS_REMOTE_DIR"] = str(state_dir)
            env["HARNESS_REMOTE_CONFIG"] = str(cfg)

            # 1) webExposure=off 且无存活 pid，且开启干扰性 zsh 选项（验证 emulate -L zsh）时，应跳过 Node
            res_off = subprocess.run(
                ["zsh", "-c", f'setopt ksh_arrays sh_word_split; source "{shell_copy}"; _rt_ensure_server'],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res_off.returncode, 0, msg=f"stderr:\n{res_off.stderr}")
            self.assertFalse(log_file.exists(), msg=f"webExposure=off 不应调用 node，实际调用: {log_file.read_text() if log_file.exists() else ''}")

            # 2) webExposure=lan 且无 web.pid 时，应调用 Node ensure
            cfg.write_text('{"webExposure": "lan"}\n', encoding="utf-8")
            res_lan_missing = subprocess.run(
                ["zsh", "-c", f'source "{shell_copy}"; _rt_ensure_server'],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res_lan_missing.returncode, 0, msg=f"stderr:\n{res_lan_missing.stderr}")
            self.assertTrue(log_file.exists() and "ensure" in log_file.read_text(encoding="utf-8"))

            # 3) webExposure=lan 且 web.pid 存活、同 shell 已 ensured 时，应跳过二次调用 Node
            log_file.unlink()
            live_proc = subprocess.Popen(["sleep", "30"])
            try:
                (state_dir / "web.pid").write_text(f"{live_proc.pid}\n", encoding="utf-8")
                res_lan_cached = subprocess.run(
                    ["zsh", "-c", f'source "{shell_copy}"; _HARNESS_REMOTE_ENSURED=1; _rt_ensure_server'],
                    cwd=ROOT,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(res_lan_cached.returncode, 0, msg=f"stderr:\n{res_lan_cached.stderr}")
                self.assertFalse(log_file.exists(), msg="webExposure=lan 存活且已 ensured 时不应重复拉起 node")

                # 4) webExposure=public 且缺 agent.pid 时，即使 _HARNESS_REMOTE_ENSURED=1 也应拉起 Node
                cfg.write_text('{"webExposure": "public"}\n', encoding="utf-8")
                res_pub_missing_agent = subprocess.run(
                    ["zsh", "-c", f'source "{shell_copy}"; _HARNESS_REMOTE_ENSURED=1; _rt_ensure_server'],
                    cwd=ROOT,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(res_pub_missing_agent.returncode, 0, msg=f"stderr:\n{res_pub_missing_agent.stderr}")
                self.assertTrue(log_file.exists() and "ensure" in log_file.read_text(encoding="utf-8"))

                # 5) webExposure=public 且 web.pid 与 agent.pid 均存活且已 ensured 时，应跳过 Node
                log_file.unlink()
                (state_dir / "agent.pid").write_text(f"{live_proc.pid}\n", encoding="utf-8")
                res_pub_cached = subprocess.run(
                    ["zsh", "-c", f'source "{shell_copy}"; _HARNESS_REMOTE_ENSURED=1; _rt_ensure_server'],
                    cwd=ROOT,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(res_pub_cached.returncode, 0, msg=f"stderr:\n{res_pub_cached.stderr}")
                self.assertFalse(log_file.exists(), msg="webExposure=public 双进程存活且已 ensured 时不应重复拉起 node")
            finally:
                live_proc.terminate()
                live_proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
