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


if __name__ == "__main__":
    unittest.main()
