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

        self.assertGreaterEqual(checked, 4)

    def test_agy_mcp_configs_declare_async_background_settings(self) -> None:
        pi_agy = json.loads(
            (ROOT / "plugins/pi-worker/mcp_config.json").read_text(encoding="utf-8")
        )["mcpServers"]["pi-worker"]
        self.assertEqual(pi_agy.get("timeoutSeconds"), -1)
        self.assertEqual(pi_agy.get("env", {}).get("PI_WORKER_AGY"), "1")
        self.assertEqual(
            pi_agy.get("tools", {}).get("pi_worker_start", {}).get("background"),
            "always",
        )
        self.assertEqual(
            pi_agy.get("tools", {}).get("pi_worker_reply", {}).get("background"),
            "always",
        )

        hc_agy = json.loads(
            (ROOT / "plugins/home-connect/mcp_config.json").read_text(encoding="utf-8")
        )["mcpServers"]
        self.assertEqual(hc_agy["home"].get("timeoutSeconds"), -1)
        self.assertEqual(hc_agy["home"].get("env", {}).get("HOME_CONNECT_AGY_ASYNC"), "1")
        self.assertEqual(
            hc_agy["home"].get("tools", {}).get("home_exec_bg", {}).get("background"),
            "always",
        )
        self.assertEqual(
            hc_agy["home"].get("tools", {}).get("home_copy_bg", {}).get("background"),
            "always",
        )
        self.assertEqual(hc_agy["comfyui"].get("timeoutSeconds"), -1)
        self.assertEqual(
            hc_agy["comfyui"].get("tools", {}).get("comfyui_generate", {}).get("background"),
            "always",
        )

        # 标准跨运行时 mcp.json 必须保持纯净，不含 AGY 专属后台字段或 env 开关
        for rel in ("plugins/pi-worker/mcp.json", "plugins/home-connect/mcp.json"):
            servers = json.loads((ROOT / rel).read_text(encoding="utf-8"))["mcpServers"]
            for srv in servers.values():
                self.assertNotIn("timeoutSeconds", srv, msg=f"{rel} 不应含 AGY timeoutSeconds")
                self.assertNotIn("tools", srv, msg=f"{rel} 不应含 AGY tools 后台配置")
                env_map = srv.get("env") or {}
                self.assertNotIn("PI_WORKER_AGY", env_map)
                self.assertNotIn("HOME_CONNECT_AGY_ASYNC", env_map)

        # 使用 mcp_config.json AGY 扩展能力的插件必须提供 .antigravity-plugin/plugin.json 覆盖根 Agent Plugins 清单
        for plugin_name in ("pi-worker", "home-connect"):
            agy_manifest_path = ROOT / "plugins" / plugin_name / ".antigravity-plugin" / "plugin.json"
            self.assertTrue(agy_manifest_path.exists(), msg=f"缺少 {agy_manifest_path}")
            agy_manifest = json.loads(agy_manifest_path.read_text(encoding="utf-8"))
            root_manifest = json.loads(
                (ROOT / "plugins" / plugin_name / "plugin.json").read_text(encoding="utf-8")
            )
            self.assertEqual(agy_manifest.get("name"), root_manifest.get("name"))
            self.assertNotIn("agent-plugins.org", str(agy_manifest.get("$schema", "")))

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
        self.assertIn("`flash`", text)
        self.assertIn("`pro`", text)
        self.assertIn("Git 历史考古", text)
        self.assertIn("基于最终 Diff 生成 PR/文档初稿", text)
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
        self.assertIn("\nmodel: flash\n", frontmatter)

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
        self.assertIn("parent agent owns root-cause analysis", body)

    def test_subagent_model_router_hook_behavior(self) -> None:
        hook_path = ROOT / "agy/hooks/subagent-model-router.py"
        self.assertTrue(hook_path.exists())

        def run_hook(stdin_text: str) -> dict:
            res = subprocess.run(
                ["python3", str(hook_path)],
                input=stdin_text,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            return json.loads(res.stdout)

        # 1. 内置 research 缺省 Model → 机械兜底 flash
        self.assertEqual(
            run_hook(
                json.dumps(
                    {"toolCall": {"name": "invoke_subagent", "args": {"TypeName": "research"}}}
                )
            ),
            {"decision": "allow", "overwrite": {"Model": "flash"}},
        )
        # 2. 内置 research 传 inherit → 同样兜底 flash
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "toolCall": {
                            "name": "invoke_subagent",
                            "args": {"TypeName": "research", "Model": "inherit"},
                        }
                    }
                )
            ),
            {"decision": "allow", "overwrite": {"Model": "flash"}},
        )
        # 3. 显式指定 pro / flash_lite → 原样放行不覆盖
        for explicit in ("pro", "flash_lite", "flash"):
            self.assertEqual(
                run_hook(
                    json.dumps(
                        {
                            "toolCall": {
                                "name": "invoke_subagent",
                                "args": {"TypeName": "research", "Model": explicit},
                            }
                        }
                    )
                ),
                {"decision": "allow"},
            )
        # 4. 其他 subagent（self / test-runner）→ 原样放行
        self.assertEqual(
            run_hook(
                json.dumps(
                    {"toolCall": {"name": "invoke_subagent", "args": {"TypeName": "self"}}}
                )
            ),
            {"decision": "allow"},
        )
        # 5. 非法输入 → fail-open 放行
        self.assertEqual(run_hook("not-json"), {"decision": "allow"})

    def test_agy_settings_enables_alt_screen(self) -> None:
        settings_path = ROOT / "agy/settings.json"
        self.assertTrue(settings_path.exists())
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(settings.get("altScreenMode"), "always")

    def test_init_agy_dry_run_makes_no_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)

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
            self.assertFalse(settings_path.exists())

    def test_init_agy_sync_preserves_existing_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            config_dir.mkdir(parents=True)
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            settings_path.parent.mkdir(parents=True)
            existing_settings = {
                "altScreenMode": "default",
                "machineOnly": {"keep": True},
            }
            settings_path.write_text(json.dumps(existing_settings), encoding="utf-8")

            skills_json = config_dir / "skills.json"
            existing = {
                "inherits": [{"path": "/shared/skills.json"}],
                "entries": [{"path": "/existing/skills", "exclude": ["demo-.*"]}],
            }
            skills_json.write_text(json.dumps(existing), encoding="utf-8")

            hooks_json = config_dir / "hooks.json"
            existing_hooks = {"my-custom-hook": {"PostToolUse": []}}
            hooks_json.write_text(json.dumps(existing_hooks), encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)

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

            # 0. AGY settings.json 深度合并并保留本机键
            merged_settings = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(merged_settings["altScreenMode"], "always")
            self.assertEqual(merged_settings["machineOnly"], {"keep": True})
            self.assertEqual(stat.S_IMODE(settings_path.stat().st_mode), 0o600)
            settings_backups_first = list(settings_path.parent.glob("settings.json.bak.*"))
            self.assertEqual(len(settings_backups_first), 1)

            # 1. 插件链接
            for name in ("deepseek-search", "home-connect", "pi-worker", "playwright"):
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

            # 5. hooks.json 保留已有 hook 并注入内置子代理档位兜底 hook
            merged_hooks = json.loads(hooks_json.read_text(encoding="utf-8"))
            self.assertEqual(merged_hooks["my-custom-hook"], existing_hooks["my-custom-hook"])
            router_hook = merged_hooks["harness-config-subagent-model-router"]
            self.assertEqual(router_hook["PreToolUse"][0]["matcher"], "invoke_subagent")
            self.assertIn(
                str(ROOT / "agy/hooks/subagent-model-router.py"),
                router_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
            self.assertEqual(stat.S_IMODE(hooks_json.stat().st_mode), 0o600)
            self.assertEqual(len(list(config_dir.glob("hooks.json.bak.*"))), 1)

            # 6. 二次运行完全幂等
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
            self.assertEqual(
                json.loads(settings_path.read_text(encoding="utf-8")), merged_settings
            )
            self.assertEqual(
                len(list(settings_path.parent.glob("settings.json.bak.*"))), 1
            )
            merged_again = json.loads(skills_json.read_text(encoding="utf-8"))
            self.assertEqual(merged_again, merged)
            backups_after_second = list(config_dir.glob("skills.json.bak.*"))
            self.assertEqual(len(backups_after_second), 1)
            self.assertEqual(
                json.loads(hooks_json.read_text(encoding="utf-8")), merged_hooks
            )
            self.assertEqual(len(list(config_dir.glob("hooks.json.bak.*"))), 1)

    def test_init_agy_skips_regular_rule_file_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            rule_path = config_dir / "rules" / "harness-config.md"
            rule_path.parent.mkdir(parents=True)
            rule_path.write_text("# user custom rule\n", encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)

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
