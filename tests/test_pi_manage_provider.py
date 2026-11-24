import importlib.util
import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / ".agents/skills/pi-manage-provider/manage-providers.py"


def run_cli(agent_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    env.pop("PI_AGENT_DIR", None)
    return subprocess.run(
        ["python3", str(SCRIPT), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def load_module():
    spec = importlib.util.spec_from_file_location("pi_manage_provider", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PiManageProviderTest(unittest.TestCase):
    def test_default_agent_dir_is_standard_pi_agent(self) -> None:
        mod = load_module()
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(mod.get_agent_dir(), Path.home() / ".pi" / "agent")
        with mock.patch.dict(os.environ, {"PI_AGENT_DIR": "/tmp/custom-agent"}, clear=True):
            self.assertEqual(mod.get_agent_dir(), Path("/tmp/custom-agent"))
        with mock.patch.dict(
            os.environ,
            {"PI_CODING_AGENT_DIR": "/tmp/coding-dir", "PI_AGENT_DIR": "/tmp/custom-agent"},
            clear=True,
        ):
            self.assertEqual(mod.get_agent_dir(), Path("/tmp/coding-dir"))

    def test_credentials_never_accept_cli_key_and_never_echo_rejected_args(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            help_res = run_cli(agent_dir, "--help")
            self.assertEqual(help_res.returncode, 0)
            self.assertNotRegex(help_res.stdout, r"--key|set-key <provider> <key>")
            self.assertNotRegex(run_cli(agent_dir, "add-provider", "--help").stdout, r"metadata-user-id")
            self.assertNotRegex(run_cli(agent_dir, "add-model", "--help").stdout, r"actual-model-id")

            rejected = run_cli(
                agent_dir,
                "add-provider",
                "demo",
                "--api",
                "openai-completions",
                "--base-url",
                "https://example.invalid",
                "--key",
                "fake-test-key",
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertNotIn("fake-test-key", rejected.stdout + rejected.stderr)

    def test_auth_writes_are_private_and_atomic(self) -> None:
        mod = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent_dir)}):
                mod.save_auth_json({"demo": {"type": "api_key", "key": "fake-test-key"}})
            auth = agent_dir / "auth.json"
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
            self.assertIn("fake-test-key", auth.read_text(encoding="utf-8"))
            self.assertEqual(list(agent_dir.glob(".auth.json.*.tmp")), [])

            source = SCRIPT.read_text(encoding="utf-8")
            self.assertIn("os.fsync", source)
            self.assertIn("os.replace", source)
            self.assertIn("_models_lock", source)

    def test_ordinary_headers_reject_credential_like_values_and_preserve_compat_types(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            rejected_values = [
                "Bearer fake-header-token",
                "Basic ZmFrZS11c2VyOmZha2UtcGFzcw==",
                "sk-fake-header-secret",
                "token_fake_header_secret",
                "aB3dE5fG7hJ9kLmNpQrStUvWxYz0123456789ABCD",
            ]
            for value in rejected_values:
                res = run_cli(
                    agent_dir,
                    "add-provider",
                    "bad-value",
                    "--api",
                    "openai-completions",
                    "--base-url",
                    "https://example.invalid",
                    "--header",
                    f"X-Feature-Flag: {value}",
                )
                self.assertNotEqual(res.returncode, 0)
                self.assertIn("sensitive header value must not be stored in models.json", res.stderr)
                self.assertNotIn(value, res.stdout + res.stderr)

            ok = run_cli(
                agent_dir,
                "add-provider",
                "safe-value",
                "--api",
                "openai-completions",
                "--base-url",
                "https://example.invalid",
                "--header",
                "X-Feature-Flag: enabled",
                "--compat",
                "supportsDeveloperRole=false",
                "--compat",
                "vllmPriority=1",
                "--compat",
                'chatTemplateKwargs={"enable_thinking":true}',
            )
            self.assertEqual(ok.returncode, 0, msg=ok.stderr)
            provider = json.loads((agent_dir / "models.json").read_text(encoding="utf-8"))["providers"]["safe-value"]
            self.assertEqual(provider["headers"], {"X-Feature-Flag": "enabled"})
            self.assertEqual(
                provider["compat"],
                {
                    "supportsDeveloperRole": False,
                    "vllmPriority": 1,
                    "chatTemplateKwargs": {"enable_thinking": True},
                },
            )

            listed = run_cli(agent_dir, "list")
            self.assertEqual(listed.returncode, 0)
            self.assertIn("header: X-Feature-Flag: [redacted]", listed.stdout)
            self.assertNotIn("enabled", listed.stdout)

    def test_sensitive_headers_and_unconfirmed_provider_removals_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            self.assertEqual(
                run_cli(
                    agent_dir,
                    "add-provider",
                    "demo",
                    "--api",
                    "openai-completions",
                    "--base-url",
                    "https://example.invalid",
                ).returncode,
                0,
            )
            for name in ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "X-API-Key", "API-Key"]:
                value = "fake-sensitive-header-value"
                res = run_cli(
                    agent_dir,
                    "add-provider",
                    "blocked",
                    "--api",
                    "openai-completions",
                    "--base-url",
                    "https://example.invalid",
                    "--header",
                    f"{name}: {value}",
                )
                self.assertNotEqual(res.returncode, 0)
                self.assertEqual(res.stderr, "Error: sensitive header must not be stored in models.json\n")
                self.assertNotRegex(res.stdout + res.stderr, re.compile(f"{re.escape(name)}|{re.escape(value)}"))

            models_text = (agent_dir / "models.json").read_text(encoding="utf-8")
            self.assertNotRegex(models_text, r"Authorization|fake-sensitive-header-value")

            unconfirmed = run_cli(agent_dir, "remove-provider", "demo")
            self.assertNotEqual(unconfirmed.returncode, 0)
            self.assertIn("demo", (agent_dir / "models.json").read_text(encoding="utf-8"))

            confirmed = run_cli(agent_dir, "remove-provider", "demo", "--confirm", "demo")
            self.assertEqual(confirmed.returncode, 0, msg=confirmed.stderr)

    def test_remove_model_requires_exact_confirmation_and_add_model_validates_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            self.assertEqual(
                run_cli(
                    agent_dir,
                    "add-provider",
                    "demo",
                    "--api",
                    "openai-completions",
                    "--base-url",
                    "https://example.invalid",
                ).returncode,
                0,
            )
            bad_ctx = run_cli(
                agent_dir, "add-model", "demo", "--id", "bad", "--context", "0", "--max-tokens", "100"
            )
            self.assertNotEqual(bad_ctx.returncode, 0)
            bad_input = run_cli(
                agent_dir,
                "add-model",
                "demo",
                "--id",
                "bad",
                "--context",
                "100",
                "--max-tokens",
                "50",
                "--input",
                "text,audio",
            )
            self.assertNotEqual(bad_input.returncode, 0)

            self.assertEqual(
                run_cli(
                    agent_dir,
                    "add-model",
                    "demo",
                    "--id",
                    "model-to-remove",
                    "--context",
                    "1",
                    "--max-tokens",
                    "1",
                    "--input",
                    "text,image",
                    "--reasoning",
                ).returncode,
                0,
            )
            models_path = agent_dir / "models.json"
            before = models_path.read_text(encoding="utf-8")

            missing = run_cli(agent_dir, "remove-model", "demo", "model-to-remove")
            self.assertNotEqual(missing.returncode, 0)
            self.assertEqual(models_path.read_text(encoding="utf-8"), before)

            mismatched = run_cli(agent_dir, "remove-model", "demo", "model-to-remove", "--confirm", "other")
            self.assertNotEqual(mismatched.returncode, 0)
            self.assertEqual(models_path.read_text(encoding="utf-8"), before)

            removed = run_cli(
                agent_dir, "remove-model", "demo", "model-to-remove", "--confirm", "model-to-remove"
            )
            self.assertEqual(removed.returncode, 0, msg=removed.stderr)
            self.assertNotIn("model-to-remove", models_path.read_text(encoding="utf-8"))

    def test_remove_provider_rolls_back_auth_on_models_failure(self) -> None:
        mod = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent_dir)}):
                mod.save_models_json({"providers": {"demo": {"baseUrl": "https://example.invalid", "api": "openai-completions", "models": []}}})
                mod.save_auth_json({"demo": {"type": "api_key", "key": "fake-key"}})
                args = SimpleNamespace(name="demo", confirm="demo")
                with mock.patch.object(mod, "_update_models", side_effect=OSError("disk full")):
                    with self.assertRaises(RuntimeError):
                        mod.cmd_remove_provider(args)
                auth = json.loads((agent_dir / "auth.json").read_text(encoding="utf-8"))
                self.assertEqual(auth, {"demo": {"type": "api_key", "key": "fake-key"}})
                self.assertEqual(stat.S_IMODE((agent_dir / "auth.json").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
