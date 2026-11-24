import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_agent(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} has no YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) != 3:
        raise AssertionError(f"{path} has malformed frontmatter")
    return parts[1], parts[2]


class QwenRoutingConfigTest(unittest.TestCase):
    def test_explore_uses_abstract_fast_grade(self) -> None:
        settings = json.loads((ROOT / "qwen/settings.json").read_text(encoding="utf-8"))
        self.assertEqual(settings["agents"]["builtin"]["exploreModel"], "fast")
        self.assertNotIn("fastModel", settings)
        self.assertNotIn("modelGrades", settings["agents"])

    def test_python_bytecode_is_ignored(self) -> None:
        ignore_rules = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("__pycache__/", ignore_rules)

    def test_review_agent_keeps_native_review_model_override(self) -> None:
        frontmatter, _ = read_agent(ROOT / "qwen/agents/review-agent.md")
        self.assertIn("\nmodel: qwen4-max-preview\n", frontmatter)

    def test_qwen_global_routing_covers_fast_tier_principles(self) -> None:
        text = (ROOT / "qwen/QWEN.md").read_text(encoding="utf-8")
        self.assertIn("test-runner", text)
        self.assertIn("`fast`", text)
        self.assertIn("Git 历史考古", text)
        self.assertIn("基于最终 Diff 生成 PR/文档初稿", text)
        self.assertIn("架构设计、复杂根因定位和深度审查不降档到 `fast`", text)
        for forbidden in ("invoke_subagent", "flash_lite"):
            self.assertNotIn(forbidden, text)

    def test_test_runner_has_no_file_write_tools(self) -> None:
        frontmatter, body = read_agent(ROOT / "qwen/agents/test-runner.md")
        self.assertIn("\nname: test-runner\n", frontmatter)
        self.assertIn("Use PROACTIVELY", frontmatter)
        self.assertIn("\nmodel: fast\n", frontmatter)

        tools = []
        in_tools = False
        for line in frontmatter.splitlines():
            if line == "tools:":
                in_tools = True
                continue
            if in_tools and line.startswith("  - "):
                tools.append(line[4:].strip())
            elif in_tools and line and not line.startswith(" "):
                in_tools = False

        self.assertEqual(
            set(tools),
            {"read_file", "grep_search", "glob", "run_shell_command"},
        )
        self.assertNotIn("write_file", tools)
        self.assertNotIn("edit", tools)
        self.assertIn(
            "Never use shell commands to create, edit, or delete project files",
            body,
        )
        self.assertIn("parent agent owns root-cause analysis", body)

    def test_init_preserves_machine_models_and_links_test_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            settings_path = tmp_path / "settings.json"
            machine_settings = {
                "model": {"name": "machine-main", "reasoningEffort": "low"},
                "fastModel": "deepseek-v4.1-flash-1017",
                "agents": {
                    "modelGrades": {"high": "machine-heavy"},
                    "defaultBackground": False,
                },
                "env": {"KEEP_MACHINE_VALUE": "1"},
            }
            settings_path.write_text(
                json.dumps(machine_settings), encoding="utf-8"
            )

            env = os.environ.copy()
            env.update(
                {
                    "QWEN_SETTINGS_PATH": str(settings_path),
                    "QWEN_EXTENSIONS_DIR": str(tmp_path / "extensions"),
                    "QWEN_SHELL_RC": str(tmp_path / ".zshrc"),
                    "QWEN_GLOBAL_MD": str(tmp_path / "QWEN.md"),
                    "QWEN_AGENTS_DIR": str(tmp_path / "agents"),
                }
            )
            result = subprocess.run(
                ["bash", str(ROOT / "init-qwen.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                result.returncode,
                0,
                msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )

            merged = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(merged["model"], machine_settings["model"])
            self.assertEqual(merged["fastModel"], machine_settings["fastModel"])
            self.assertEqual(
                merged["agents"]["modelGrades"],
                machine_settings["agents"]["modelGrades"],
            )
            self.assertFalse(merged["agents"]["defaultBackground"])
            self.assertEqual(merged["agents"]["builtin"]["exploreModel"], "fast")
            self.assertEqual(merged["env"]["KEEP_MACHINE_VALUE"], "1")
            self.assertEqual(merged["env"]["HARNESS_CONFIG_ROOT"], str(ROOT))

            agent_link = tmp_path / "agents/test-runner.md"
            self.assertTrue(agent_link.is_symlink())
            self.assertEqual(
                agent_link.resolve(),
                (ROOT / "qwen/agents/test-runner.md").resolve(),
            )


if __name__ == "__main__":
    unittest.main()
