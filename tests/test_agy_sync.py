import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AgySyncTest(unittest.TestCase):
    def test_plugin_mcp_configs_match_mcp_json(self) -> None:
        plugins_dir = ROOT / "plugins"
        checked = 0
        for plugin_dir in sorted(p for p in plugins_dir.iterdir() if p.is_dir()):
            mcp_json_path = plugin_dir / "mcp.json"
            if not mcp_json_path.exists():
                continue
            checked += 1
            mcp_config_path = plugin_dir / "mcp_config.json"
            self.assertTrue(
                mcp_config_path.exists(),
                msg=f"{plugin_dir.name} 缺少 AGY 兼容配置 mcp_config.json",
            )

            mcp_servers = json.loads(mcp_json_path.read_text(encoding="utf-8"))[
                "mcpServers"
            ]
            agy_servers = json.loads(mcp_config_path.read_text(encoding="utf-8"))[
                "mcpServers"
            ]

            self.assertEqual(set(agy_servers.keys()), set(mcp_servers.keys()))
            for name, spec in mcp_servers.items():
                agy_spec = agy_servers[name]
                self.assertEqual(agy_spec["command"], spec["command"])
                self.assertEqual(agy_spec.get("cwd"), "${PLUGIN_ROOT}")
                expected_args = [
                    "${PLUGIN_ROOT}/" + arg[2:] if arg.startswith("./") else arg
                    for arg in spec.get("args", [])
                ]
                self.assertEqual(agy_spec.get("args", []), expected_args)

        self.assertGreaterEqual(checked, 3)

    def test_agy_global_rule_has_no_qwen_specific_routing(self) -> None:
        rule_path = ROOT / "agy/rules/harness-config.md"
        self.assertTrue(rule_path.exists())
        self.assertFalse((ROOT / "agy/AGENTS.md").exists())
        text = rule_path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"), msg="rules/*.md 必须包含 YAML frontmatter")
        _, frontmatter, _ = text.split("---", 2)
        self.assertIn("trigger: always_on", frontmatter)
        self.assertIn("## Git Commit 规范", text)
        self.assertIn("test-runner", text)
        for forbidden in ("Explore", "general-purpose", "run_in_background", "/review --effort"):
            self.assertNotIn(forbidden, text)

    def test_agy_test_runner_has_no_file_write_tools(self) -> None:
        agent_path = ROOT / "agy/agents/test-runner.md"
        self.assertTrue(agent_path.exists())
        text = agent_path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        _, frontmatter, body = text.split("---", 2)
        self.assertIn("\nname: test-runner\n", frontmatter)
        self.assertIn("\nsubagent: true\n", frontmatter)
        self.assertNotIn("\nmodel:", frontmatter)

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

        self.assertEqual(set(tools), {"read_file", "run_command", "manage_task"})
        self.assertNotIn("write_file", tools)
        self.assertNotIn("edit_file", tools)
        self.assertIn(
            "Never use shell commands to create, edit, or delete project files",
            body,
        )

    def test_init_agy_dry_run_makes_no_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)

            result = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh"), "--dry-run"],
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
            self.assertFalse(config_dir.exists())

    def test_init_agy_sync_preserves_existing_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            config_dir.mkdir(parents=True)
            skills_json = config_dir / "skills.json"
            existing = {
                "inherits": [{"path": "/shared/skills.json"}],
                "entries": [{"path": "/existing/skills", "exclude": ["demo-.*"]}],
            }
            skills_json.write_text(json.dumps(existing), encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)

            first = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                first.returncode,
                0,
                msg=f"stdout:\n{first.stdout}\nstderr:\n{first.stderr}",
            )

            # 1. 插件链接
            for name in ("deepseek-search", "home-connect", "playwright"):
                link = config_dir / "plugins" / name
                self.assertTrue(link.is_symlink(), msg=f"缺少插件软链: {link}")
                self.assertEqual(link.resolve(), (ROOT / "plugins" / name).resolve())

            # 2. skills.json 保留旧配置并追加仓内 skills/
            merged = json.loads(skills_json.read_text(encoding="utf-8"))
            self.assertEqual(merged["inherits"], existing["inherits"])
            self.assertEqual(
                merged["entries"],
                existing["entries"] + [{"path": str(ROOT / "skills")}],
            )
            self.assertEqual(stat.S_IMODE(skills_json.stat().st_mode), 0o600)
            backups_after_first = list(config_dir.glob("skills.json.bak.*"))
            self.assertEqual(len(backups_after_first), 1)

            # 3. 全局规则软链
            rule_link = config_dir / "rules" / "harness-config.md"
            self.assertTrue(rule_link.is_symlink())
            self.assertEqual(
                rule_link.resolve(), (ROOT / "agy/rules/harness-config.md").resolve()
            )

            # 4. AGY subagent 定义软链
            agent_link = config_dir / "agents" / "test-runner.md"
            self.assertTrue(agent_link.is_symlink())
            self.assertEqual(
                agent_link.resolve(), (ROOT / "agy/agents/test-runner.md").resolve()
            )

            # 5. 二次运行完全幂等
            second = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                second.returncode,
                0,
                msg=f"stdout:\n{second.stdout}\nstderr:\n{second.stderr}",
            )
            merged_again = json.loads(skills_json.read_text(encoding="utf-8"))
            self.assertEqual(merged_again, merged)
            backups_after_second = list(config_dir.glob("skills.json.bak.*"))
            self.assertEqual(len(backups_after_second), 1)

    def test_init_agy_skips_regular_rule_file_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            rule_path = config_dir / "rules" / "harness-config.md"
            rule_path.parent.mkdir(parents=True)
            rule_path.write_text("# user custom rule\n", encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)

            result = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn("已存在且不是软链接", result.stderr)
            self.assertFalse(rule_path.is_symlink())
            self.assertEqual(
                rule_path.read_text(encoding="utf-8"), "# user custom rule\n"
            )


if __name__ == "__main__":
    unittest.main()
