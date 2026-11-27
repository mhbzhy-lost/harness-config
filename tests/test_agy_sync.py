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
            pi_agy.get("tools", {}).get("pi_worker_start", {}).get("eager"),
            True,
        )
        self.assertEqual(
            pi_agy.get("tools", {}).get("pi_worker_reply", {}).get("background"),
            "always",
        )
        self.assertEqual(
            pi_agy.get("tools", {}).get("pi_worker_reply", {}).get("eager"),
            True,
        )
        self.assertEqual(
            pi_agy.get("tools", {}).get("pi_worker_monitor", {}).get("eager"),
            True,
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
        self.assertIn("pi-worker", text)
        self.assertIn("pi_worker_start", text)
        self.assertIn("mcp_pi-worker_pi-worker_pi_worker_start", text)
        self.assertIn("主 Agent 职责边界", text)
        self.assertIn("小范围定向读写与集成收口", text)
        self.assertIn("无明确计划", text)
        self.assertIn("有明确实施计划", text)
        self.assertIn("ask_question", text)
        self.assertIn("pi-worker heavy", text)
        self.assertIn("native subagent pro", text)
        self.assertIn("swarm claude opus 5.5", text)
        self.assertIn("swarm hydrogen", text)
        self.assertIn("验收 Reviewer", text)
        self.assertIn("git worktree", text)
        self.assertIn("writing-plans", text)
        self.assertIn("首轮强制委派", text)
        self.assertIn("executedCommands", text)
        self.assertIn("eventsPath", text)
        self.assertIn("`fast`", text)
        self.assertIn("`default`", text)
        self.assertIn("`heavy`", text)
        self.assertIn("`readOnly: true`", text)
        self.assertIn("~/.pi/agent/pi-worker/config.json", text)
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
        self.assertNotIn("Use PROACTIVELY", frontmatter)

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

    def test_swarm_model_guard_hook_behavior(self) -> None:
        hook_path = ROOT / "agy/hooks/swarm-model-guard.py"
        self.assertTrue(hook_path.exists())

        def run_hook(stdin_text: str, extra_env: dict | None = None) -> dict:
            # 清理 AGY_SWARM_DEFAULT_MODEL，保证断言不受宿主机环境影响
            env = {
                k: v
                for k, v in os.environ.items()
                if k != "AGY_SWARM_DEFAULT_MODEL"
            }
            if extra_env:
                env.update(extra_env)
            res = subprocess.run(
                ["python3", str(hook_path)],
                input=stdin_text,
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            return json.loads(res.stdout)

        def swarm_call(args: dict) -> str:
            return json.dumps({"toolCall": {"name": "swarm", "args": args}})

        default_overwrite = {
            "decision": "allow",
            "overwrite": {"model": "gemini-4-hydrogen-high"},
        }

        # 1. add 缺省 / 空串 / 空白串 / 裸别名 hydrogen → 兜底默认 Hydrogen ID
        for args in (
            {"action": "add", "prompt": "explore"},
            {"action": "add", "model": None},
            {"action": "add", "model": ""},
            {"action": "add", "model": "   "},
            {"action": "add", "model": "hydrogen"},
            {"action": "add", "model": "Hydrogen"},
        ):
            self.assertEqual(run_hook(swarm_call(args)), default_overwrite, msg=args)
        # 2. model 缺省 / 裸别名 hydrogen → 同样兜底
        for args in (
            {"action": "model"},
            {"action": "model", "model": "hydrogen"},
        ):
            self.assertEqual(run_hook(swarm_call(args)), default_overwrite, msg=args)
        # 3. 环境变量覆写默认模型生效（空白值回退内置默认）
        self.assertEqual(
            run_hook(
                swarm_call({"action": "add"}),
                {"AGY_SWARM_DEFAULT_MODEL": "gemini-5-hydrogen-xhigh"},
            ),
            {"decision": "allow", "overwrite": {"model": "gemini-5-hydrogen-xhigh"}},
        )
        self.assertEqual(
            run_hook(
                swarm_call({"action": "add"}),
                {"AGY_SWARM_DEFAULT_MODEL": "   "},
            ),
            default_overwrite,
        )
        # 4. 合法 Hydrogen 目录 ID 与显示名 → 原样放行不覆盖
        for model in (
            "gemini-4-hydrogen-low",
            "gemini-4-hydrogen-medium",
            "gemini-4-hydrogen-high",
            "gemini-4-hydrogen-xhigh",
            "Gemini 4 Hydrogen (High)",
        ):
            for action in ("add", "model"):
                self.assertEqual(
                    run_hook(swarm_call({"action": action, "model": model})),
                    {"decision": "allow"},
                    msg=(action, model),
                )
        # 5. 非 Hydrogen 模型 → force_ask，reason 含模型名与目标
        for model in (
            "gemini-4-neon-high",
            "claude-opus-5-5-high",
            "pro",
            "flash",
            "gpt-oss-120b-medium",
        ):
            cases = (
                ({"action": "add", "name": "scout", "model": model}, "worker 'scout'"),
                ({"action": "add", "model": model}, "新 worker"),
                ({"action": "model", "name": "scout", "model": model}, "worker 'scout'"),
                ({"action": "model", "model": model}, "当前会话自身"),
            )
            for args, target in cases:
                out = run_hook(swarm_call(args))
                self.assertEqual(out["decision"], "force_ask", msg=args)
                self.assertIn(model, out["reason"], msg=args)
                self.assertIn(target, out["reason"], msg=args)
                if "claude" in model.lower():
                    self.assertIn(
                        "Claude 系列模型仅限只读审查代码或计划", out["reason"], msg=args
                    )
                else:
                    self.assertNotIn("只读审查", out["reason"], msg=args)
        # 6. 其他 action → 直接放行
        for action in ("status", "models", "kill", "title"):
            self.assertEqual(
                run_hook(swarm_call({"action": action, "model": "pro"})),
                {"decision": "allow"},
                msg=action,
            )
        # 7. 非 swarm 工具名 → 直接放行
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "toolCall": {
                            "name": "invoke_subagent",
                            "args": {"action": "add", "model": "pro"},
                        }
                    }
                )
            ),
            {"decision": "allow"},
        )
        # 8. 非法 JSON → fail-open 放行
        self.assertEqual(run_hook("not-json"), {"decision": "allow"})

    def test_git_commit_guard_hook_behavior(self) -> None:
        hook_path = ROOT / "agy/hooks/git-commit-guard.py"
        self.assertTrue(hook_path.exists())
        self.assertTrue(os.access(hook_path, os.X_OK), msg="hook 必须可执行")

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

        def cmd_call(command_line: str, name: str = "run_command") -> str:
            return json.dumps(
                {"toolCall": {"name": name, "args": {"CommandLine": command_line}}}
            )

        def assert_allow(command_line: str) -> None:
            self.assertEqual(
                run_hook(cmd_call(command_line)),
                {"decision": "allow"},
                msg=command_line,
            )

        def assert_deny(command_line: str, reason_part: str | None = None) -> None:
            out = run_hook(cmd_call(command_line))
            self.assertEqual(out.get("decision"), "deny", msg=command_line)
            self.assertTrue(out.get("reason"), msg=command_line)
            if reason_part:
                self.assertIn(reason_part, out["reason"], msg=command_line)

        # 1. 合规提交：无 scope / 带 scope / 多 -m / 组合短参数 / 附着值 / = 形式
        for command in (
            'git commit -m "feat: 增加登录功能"',
            "git commit -m 'fix(auth): 修复登录超时'",
            "git commit -m 'feat: 增加功能' -m '补充背景说明'",
            'git commit -am "fix: 修复崩溃"',
            'git commit -asm "fix: 修复崩溃"',
            "git commit -m'feat: 增加功能'",
            "git commit --message='feat: 增加功能'",
            "git commit --message 'feat: 增加功能'",
        ):
            assert_allow(command)
        # 2. git1 / 绝对路径 / git 全局选项（含带值与 = 形式）
        for command in (
            'git1 commit -m "feat: 增加功能"',
            '/usr/bin/git commit -m "feat: 增加功能"',
            '/opt/homebrew/bin/git1 commit -m "feat: 增加功能"',
            'git -C /repo -c user.name=x --no-pager commit -m "feat: 增加功能"',
            'git --git-dir=/x --work-tree /y --namespace ns commit -m "feat: 增加功能"',
            'git -p --bare --config-env=K=V --super-prefix=/p commit -m "feat: 增加功能"',
        ):
            assert_allow(command)
        # 3. --help / -h / --amend --no-edit（不带 -m）放行
        assert_allow("git commit --help")
        assert_allow("git commit -h")
        assert_allow("git commit --amend --no-edit")
        # 4. 非 commit 子命令 / 非 git 命令 → 原样放行
        for command in (
            "git status",
            "git push origin main",
            "git log --oneline",
            "ls -la",
            'echo "git commit -m bad"',
        ):
            assert_allow(command)
        # 5. 单引号内的字面反引号与 $() 允许
        assert_allow("git commit -m 'fix: 修复 `date` 与 $(pwd) 字面量说明'")
        # 6. 命令前缀剥离：VAR=val / env / sudo / command / nohup / time
        assert_allow('VAR=1 env FOO=bar sudo -u me git commit -m "feat: 增加功能"')
        assert_allow('command git commit -m "feat: 增加功能"')
        assert_allow('nohup time git commit -m "feat: 增加功能"')
        # 7. 复合命令 / 子 shell / 换行 / sh -c 嵌套（含组合短参数）合规放行
        for command in (
            "git add -u && git commit -m 'feat: 增加功能'",
            "echo hi; git commit -m 'feat: 增加功能' | tee log",
            "git commit -m 'feat: 增加功能' && git push",
            "(git commit -m 'feat: 增加功能')",
            "git status\ngit commit -m 'feat: 增加功能'",
            'bash -lc "git commit -m \'feat: 增加功能\'"',
            "sh -c 'git commit -m \"feat: 增加功能\"'",
            'zsh -c "git commit -m \'feat: 增加功能\'"',
        ):
            assert_allow(command)
        # 8. 非 run_command 工具 / 缺名兜底 / 非法输入 fail-open
        self.assertEqual(
            run_hook(cmd_call("git commit", name="read_file")),
            {"decision": "allow"},
        )
        self.assertEqual(
            run_hook(json.dumps({"toolCall": {"args": {"CommandLine": "git commit"}}})).get(
                "decision"
            ),
            "deny",
        )
        for raw in ("not-json", "", "[1,2]", '{"toolCall": "oops"}'):
            self.assertEqual(run_hook(raw), {"decision": "allow"}, msg=raw)
        self.assertEqual(run_hook(cmd_call("")), {"decision": "allow"})
        self.assertEqual(
            run_hook(json.dumps({"toolCall": {"name": "run_command", "args": {}}})),
            {"decision": "allow"},
        )
        # 9. 首行格式与 type 白名单
        assert_deny('git commit -m "增加功能"', "格式")
        assert_deny('git commit -m "feature: 增加功能"', "type")
        assert_deny('git commit -m "Fix: 增加功能"', "type")
        assert_deny('git commit -m "fix( ): 增加功能"', "scope")
        # 10. 中文 / 长度 / 句号 / 过去时 / 零信息词
        assert_deny('git commit -m "fix: repair login"', "中文")
        assert_deny('git commit -m "fix: ' + "修" * 51 + '"', "50")
        assert_allow('git commit -m "fix: ' + "修" * 50 + '"')
        assert_deny('git commit -m "fix: 修复登录。"', "句号")
        assert_deny('git commit -m "fix: 修复登录."', "句号")
        assert_deny('git commit -m "fix: 已修复登录"', "过去时")
        assert_deny('git commit -m "fix: 修复了登录"', "过去时")
        assert_deny('git commit -m "refactor: 已重构连接层"', "过去时")
        # 「已+非动词集」不构成过去时，不误杀
        assert_allow('git commit -m "feat: 已读回执支持列表展示"')
        assert_deny('git commit -m "chore: update"', "零信息")
        assert_deny('git commit -m "chore: WIP"', "零信息")
        assert_deny('git commit -m "chore: 修改"', "零信息")
        assert_deny('git commit -m "chore: 更新"', "零信息")
        # 11. AI 署名（subject 或 body）
        assert_deny(
            'git commit -m "feat: 增加功能" -m "Co-Authored-By: Claude <x@y>"',
            "AI 署名",
        )
        assert_deny(
            'git commit -m "feat: 增加功能" -m "Co-Authored-By: Cursor <x@y>"',
            "AI 署名",
        )
        assert_deny('git commit -m "feat: 增加功能" -m "Generated with Claude Code"', "Generated")
        assert_deny('git commit -m "feat: 增加功能" -m "Generated by Copilot"', "Generated")
        assert_deny('git commit -m "feat: 增加功能" -m "AI-assisted"', "AI-assisted")
        assert_deny(
            'git commit -m "feat: 增加功能" -m "🤖 generated with some tool"',
            "Generated",
        )
        assert_deny('git commit -m "feat: 增加功能" -m "generated by AI"', "Generated")
        # 不含 AI 标识的正常 generated 说明不误杀
        assert_allow('git commit -m "feat: 增加功能" -m "generated by protoc"')
        assert_allow('git commit -m "feat: 增加功能" -m "generated with scripts/gen.py"')
        # 人工署名不拦截
        assert_allow('git commit -m "feat: 增加功能" -m "Co-Authored-By: Zhang San <z@x>"')
        # 12. 缺省 -m / --amend 缺 --no-edit / -F 系列
        assert_deny("git commit", "-m")
        assert_deny("git commit -a", "-m")
        assert_deny("git commit --amend", "-m")
        assert_deny("git commit -F msg.txt", "-m")
        assert_deny("git commit --file msg.txt", "-m")
        assert_deny("git commit --file=msg.txt", "-m")
        assert_deny("git commit -aF msg.txt", "-m")
        assert_deny("git commit -m 'feat: 增加功能' -F msg.txt", "-m")
        # 13. 嵌套 / 复合命令中的违规提交同样拦截
        assert_deny('sh -c "git commit -m \'fix: repair\'"', "中文")
        assert_deny("bash -lc 'git commit -m \"fix: repair\"'", "中文")
        assert_deny('git add . && git commit -m "fix: repair"', "中文")
        assert_deny('git status; git commit', "-m")
        assert_deny('(git commit -m "fix: repair")', "中文")
        assert_deny('sudo git commit -m "fix: repair"', "中文")
        assert_deny('git -C /repo commit -F msg.txt', "-m")
        # 14. 命令替换 / $'...' 绕过 → 拒绝
        assert_deny('git commit -m "$(cat msg.txt)"', "命令替换")
        assert_deny("git commit -m `cat msg.txt`", "命令替换")
        assert_deny("git commit -m $'feat: 增加功能'", "$'")
        assert_deny("git commit --message=$(cat msg.txt)", "命令替换")
        # 非 git 相关的 shell -c 命令替换 / $'...' 不误杀
        assert_allow('bash -c "echo $(pwd)"')
        assert_allow('sh -c "ls $(date)"')
        assert_allow('bash -c "echo `date`"')
        assert_allow("bash -c $'echo hi'")
        # git 相关的 shell -c 载荷仍拦截命令替换 / $'...' 绕过
        assert_deny('bash -c "git commit -m \\"$(cat msg.txt)\\""', "命令替换")
        assert_deny("sh -c \"git commit -m $'feat: 增加功能'\"", "$'")
        # 15. 多 -m 时首条 -m 首行作为 subject；body 超长不拦截
        assert_deny('git commit -m "fix: repair" -m "feat: 增加功能"', "中文")
        assert_allow('git commit -m "feat: 增加功能" -m "' + "长" * 200 + '"')

    def test_pi_worker_session_injector_hook_behavior(self) -> None:
        hook_path = ROOT / "agy/hooks/pi-worker-session-injector.py"
        self.assertTrue(hook_path.exists())

        def run_hook(stdin_text: str, extra_env: dict | None = None) -> dict:
            # 清理 ANTIGRAVITY_* 环境变量，保证断言不受本机运行态影响
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith("ANTIGRAVITY_")
            }
            if extra_env:
                env.update(extra_env)
            res = subprocess.run(
                ["python3", str(hook_path)],
                input=stdin_text,
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            return json.loads(res.stdout)

        # 1. Eager pi_worker_start 缺省 parentSessionId → 自动补全 conversationId
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "conversationId": "conv-123",
                        "cwd": "/repo/app",
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                            "args": {"cwd": "/repo/app", "prompt": "explore"},
                        },
                    }
                )
            ),
            {"decision": "allow", "overwrite": {"parentSessionId": "conv-123"}},
        )
        # 2. Eager pi_worker_monitor 缺省 parentSessionId & cwd → 同时补全
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "conversationId": "conv-123",
                        "workspacePaths": ["/repo/app"],
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_monitor",
                            "args": {},
                        },
                    }
                )
            ),
            {
                "decision": "allow",
                "overwrite": {"parentSessionId": "conv-123", "cwd": "/repo/app"},
            },
        )
        # 3. 显式传入 parentSessionId 时不覆盖
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "conversationId": "conv-123",
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                            "args": {"cwd": "/repo/app", "prompt": "x", "parentSessionId": "custom"},
                        },
                    }
                )
            ),
            {"decision": "allow"},
        )
        # 4. Lazy call_mcp_tool 路径自动补全 Arguments.parentSessionId
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "conversationId": "conv-456",
                        "cwd": "/repo/b",
                        "toolCall": {
                            "name": "call_mcp_tool",
                            "args": {
                                "ServerName": "pi-worker_pi-worker",
                                "ToolName": "pi_worker_start",
                                "Arguments": {"cwd": "/repo/b", "prompt": "check"},
                            },
                        },
                    }
                )
            ),
            {
                "decision": "allow",
                "overwrite": {
                    "Arguments": {
                        "cwd": "/repo/b",
                        "prompt": "check",
                        "parentSessionId": "conv-456",
                    }
                },
            },
        )
        # 5. 非 pi-worker 工具与非法输入 → fail-open 放行
        self.assertEqual(
            run_hook(
                json.dumps(
                    {
                        "conversationId": "conv-456",
                        "toolCall": {"name": "read_file", "args": {"Path": "/a"}},
                    }
                )
            ),
            {"decision": "allow"},
        )
        self.assertEqual(run_hook("bad-json"), {"decision": "allow"})

    def test_pi_worker_session_injector_title_injection(self) -> None:
        """parentSessionTitle 自动注入：ConversationService 命中、失败降级 lastUserInput、显式保留、Eager/Lazy 双路径。"""
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        hook_path = ROOT / "agy/hooks/pi-worker-session-injector.py"
        hits: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                hits.append(
                    {
                        "path": self.path,
                        "csrf": self.headers.get("x-antigravity-csrf-token"),
                        "connect": self.headers.get("Connect-Protocol-Version"),
                        "conversationId": body.get("conversationId"),
                    }
                )
                conv_id = body.get("conversationId")
                if conv_id == "conv-summary":
                    payload = {"state": {"summary": "摘要\n标题"}}
                elif conv_id == "conv-long":
                    payload = {"annotations": {"title": "字" * 60}}
                elif conv_id == "conv-bad":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"not-json")
                    return
                else:
                    payload = {"annotations": {"title": "  会话\n标题  "}}
                data = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        ls_env = {
            "ANTIGRAVITY_LS_ADDRESS": f"127.0.0.1:{server.server_address[1]}",
            "ANTIGRAVITY_CSRF_TOKEN": "test-csrf-token",
        }

        with tempfile.TemporaryDirectory() as cache_tmp:
            cache_path = str(Path(cache_tmp) / "title-cache.json")

            def run_hook(payload: dict, extra_env: dict | None = None) -> dict:
                env = {
                    k: v
                    for k, v in os.environ.items()
                    if not k.startswith("ANTIGRAVITY_")
                }
                env["AGY_TITLE_CACHE_PATH"] = cache_path
                if extra_env:
                    env.update(extra_env)
                res = subprocess.run(
                    ["python3", str(hook_path)],
                    input=json.dumps(payload),
                    text=True,
                    capture_output=True,
                    check=False,
                    env=env,
                )
                self.assertEqual(res.returncode, 0, msg=res.stderr)
                return json.loads(res.stdout)

            try:
                # 1. Eager start：ConversationService 命中 → 清洗单行后注入
                self.assertEqual(
                    run_hook(
                        {
                            "conversationId": "conv-t1",
                            "cwd": "/repo/app",
                            "toolCall": {
                                "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                                "args": {"cwd": "/repo/app", "prompt": "explore"},
                            },
                        },
                        ls_env,
                    ),
                    {
                        "decision": "allow",
                        "overwrite": {
                            "parentSessionId": "conv-t1",
                            "parentSessionTitle": "会话 标题",
                        },
                    },
                )
                self.assertEqual(hits[-1]["path"], "/product.v1.ConversationService/GetConversation")
                self.assertEqual(hits[-1]["csrf"], "test-csrf-token")
                self.assertEqual(hits[-1]["connect"], "1")
                self.assertEqual(hits[-1]["conversationId"], "conv-t1")

                # 2. Eager monitor：同时补全 parentSessionId/cwd/parentSessionTitle
                self.assertEqual(
                    run_hook(
                        {
                            "conversationId": "conv-t1",
                            "workspacePaths": ["/repo/app"],
                            "toolCall": {
                                "name": "mcp_pi-worker_pi-worker_pi_worker_monitor",
                                "args": {},
                            },
                        },
                        ls_env,
                    ),
                    {
                        "decision": "allow",
                        "overwrite": {
                            "parentSessionId": "conv-t1",
                            "cwd": "/repo/app",
                            "parentSessionTitle": "会话 标题",
                        },
                    },
                )

                # 3. annotations 缺失时回退 state.summary；超长标题截断到 48 字 + 省略号
                eager_start = {
                    "cwd": "/repo/app",
                    "toolCall": {
                        "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                        "args": {"cwd": "/repo/app", "prompt": "x"},
                    },
                }
                out = run_hook({**eager_start, "conversationId": "conv-summary"}, ls_env)
                self.assertEqual(out["overwrite"]["parentSessionTitle"], "摘要 标题")
                out = run_hook({**eager_start, "conversationId": "conv-long"}, ls_env)
                self.assertEqual(out["overwrite"]["parentSessionTitle"], "字" * 48 + "…")

                # 4. LS 不可达/返回非法 JSON/未配置环境变量 → 降级 lastUserInput 首条非空行
                fallback_input = "\n\n  首行  内容 \n第二行"
                for env, conv in (
                    ({"ANTIGRAVITY_LS_ADDRESS": "127.0.0.1:9", "ANTIGRAVITY_CSRF_TOKEN": "test-csrf-token"}, "conv-t1"),
                    (ls_env, "conv-bad"),
                    (None, "conv-t1"),
                ):
                    out = run_hook(
                        {
                            "conversationId": conv,
                            "cwd": "/repo/app",
                            "lastUserInput": fallback_input,
                            "toolCall": {
                                "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                                "args": {"cwd": "/repo/app", "prompt": "x"},
                            },
                        },
                        env,
                    )
                    self.assertEqual(
                        out,
                        {
                            "decision": "allow",
                            "overwrite": {
                                "parentSessionId": conv,
                                "parentSessionTitle": "首行 内容",
                            },
                        },
                    )
                # lastUserInput 为 dict.text 结构时同样支持
                out = run_hook(
                    {
                        "conversationId": "conv-t1",
                        "cwd": "/repo/app",
                        "lastUserInput": {"text": "结构化输入首行"},
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                            "args": {"cwd": "/repo/app", "prompt": "x"},
                        },
                    },
                )
                self.assertEqual(out["overwrite"]["parentSessionTitle"], "结构化输入首行")

                # 5. 显式传入 parentSessionTitle 时原样保留（不覆盖、不请求 LS）
                hits_before = len(hits)
                self.assertEqual(
                    run_hook(
                        {
                            "conversationId": "conv-t1",
                            "cwd": "/repo/app",
                            "lastUserInput": "不应被使用",
                            "toolCall": {
                                "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                                "args": {
                                    "cwd": "/repo/app",
                                    "prompt": "x",
                                    "parentSessionId": "custom",
                                    "parentSessionTitle": "自定义标题",
                                },
                            },
                        },
                        ls_env,
                    ),
                    {"decision": "allow"},
                )
                self.assertEqual(len(hits), hits_before)

                # 6. Lazy call_mcp_tool 路径：Arguments 内注入 parentSessionTitle（monitor 同时补 cwd）
                self.assertEqual(
                    run_hook(
                        {
                            "conversationId": "conv-t1",
                            "cwd": "/repo/b",
                            "toolCall": {
                                "name": "call_mcp_tool",
                                "args": {
                                    "ServerName": "pi-worker_pi-worker",
                                    "ToolName": "pi_worker_monitor",
                                    "Arguments": {},
                                },
                            },
                        },
                        ls_env,
                    ),
                    {
                        "decision": "allow",
                        "overwrite": {
                            "Arguments": {
                                "parentSessionId": "conv-t1",
                                "cwd": "/repo/b",
                                "parentSessionTitle": "会话 标题",
                            }
                        },
                    },
                )
                # Lazy 路径显式标题同样保留
                self.assertEqual(
                    run_hook(
                        {
                            "conversationId": "conv-t1",
                            "cwd": "/repo/b",
                            "toolCall": {
                                "name": "call_mcp_tool",
                                "args": {
                                    "ServerName": "pi-worker_pi-worker",
                                    "ToolName": "pi_worker_start",
                                    "Arguments": {
                                        "cwd": "/repo/b",
                                        "prompt": "x",
                                        "parentSessionId": "custom",
                                        "parentSessionTitle": "自定义",
                                    },
                                },
                            },
                        },
                        ls_env,
                    ),
                    {"decision": "allow"},
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_agy_settings_enables_alt_screen(self) -> None:
        settings_path = ROOT / "agy/settings.json"
        self.assertTrue(settings_path.exists())
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(settings.get("altScreenMode"), "always")

    def test_agy_shell_snippet_has_valid_zsh_syntax(self) -> None:
        snippet = ROOT / "agy/shell.zsh"
        self.assertTrue(snippet.exists())
        res = subprocess.run(
            ["zsh", "-n", str(snippet)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        text = snippet.read_text(encoding="utf-8")
        for fn in ("_agy_launch_with_proxy()", "agyui()", "agyide()"):
            self.assertIn(fn, text)

    def test_init_agy_dry_run_makes_no_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            shell_rc = Path(tmp) / ".zshrc"
            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

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
            self.assertFalse(shell_rc.exists())

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

            shell_rc = Path(tmp) / ".zshrc"
            shell_rc.write_text("# user zshrc\nexport FOO=bar\n", encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

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

            # 5. hooks.json 保留已有 hook 并注入受管 hooks，不再注入已退役的路由 hook
            merged_hooks = json.loads(hooks_json.read_text(encoding="utf-8"))
            self.assertEqual(merged_hooks["my-custom-hook"], existing_hooks["my-custom-hook"])
            self.assertNotIn("harness-config-subagent-model-router", merged_hooks)
            pi_worker_hook = merged_hooks["harness-config-pi-worker-session-injector"]
            self.assertIn(
                "pi_worker_(start|monitor)",
                pi_worker_hook["PreToolUse"][0]["matcher"],
            )
            self.assertIn(
                str(ROOT / "agy/hooks/pi-worker-session-injector.py"),
                pi_worker_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
            swarm_hook = merged_hooks["harness-config-swarm-model-guard"]
            self.assertEqual(swarm_hook["PreToolUse"][0]["matcher"], "swarm")
            self.assertIn(
                str(ROOT / "agy/hooks/swarm-model-guard.py"),
                swarm_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
            commit_hook = merged_hooks["harness-config-git-commit-guard"]
            self.assertEqual(commit_hook["PreToolUse"][0]["matcher"], "run_command")
            self.assertIn(
                str(ROOT / "agy/hooks/git-commit-guard.py"),
                commit_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
            self.assertEqual(
                commit_hook["PreToolUse"][0]["hooks"][0].get("timeout"), 5
            )
            self.assertEqual(stat.S_IMODE(hooks_json.stat().st_mode), 0o600)
            self.assertEqual(len(list(config_dir.glob("hooks.json.bak.*"))), 1)

            # 5.5 shell 注册保留原 ~/.zshrc 内容并注入标记块
            rc_after_first = shell_rc.read_text(encoding="utf-8")
            self.assertIn("export FOO=bar", rc_after_first)
            self.assertIn("# >>> harness-config agy >>>", rc_after_first)
            self.assertIn(f"source '{ROOT / 'agy/shell.zsh'}'", rc_after_first)
            self.assertIn("# <<< harness-config agy <<<", rc_after_first)
            self.assertEqual(len(list(shell_rc.parent.glob(".zshrc.bak.*"))), 1)

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
            self.assertEqual(shell_rc.read_text(encoding="utf-8"), rc_after_first)
            self.assertEqual(len(list(shell_rc.parent.glob(".zshrc.bak.*"))), 1)

    def test_init_agy_removes_retired_managed_hooks_idempotently(self) -> None:
        """已退役受管 hook 的幂等清理：--dry-run 只报告不写入，正式同步移除旧 key 且不触碰其他条目。"""
        retired_key = "harness-config-subagent-model-router"
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            config_dir.mkdir(parents=True)
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            shell_rc = Path(tmp) / ".zshrc"

            hooks_json = config_dir / "hooks.json"
            existing_hooks = {
                retired_key: {
                    "PreToolUse": [
                        {
                            "matcher": "invoke_subagent",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": 'python3 "/old/path/subagent-model-router.py"',
                                    "timeout": 5,
                                }
                            ],
                        }
                    ]
                },
                "my-custom-hook": {"PostToolUse": []},
                "harness-config-pi-worker-session-injector": {
                    "PreToolUse": [
                        {
                            "matcher": "old",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": 'python3 "/old/path/pi-worker-session-injector.py"',
                                    "timeout": 5,
                                }
                            ],
                        }
                    ]
                },
            }
            hooks_text = json.dumps(existing_hooks, ensure_ascii=False, indent=2)
            hooks_json.write_text(hooks_text, encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

            def run_init(*args: str) -> subprocess.CompletedProcess:
                result = subprocess.run(
                    ["bash", str(ROOT / "init-agy.sh"), *args],
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
                return result

            # 1. --dry-run 正确识别并报告将移除的退役 key，不写入任何文件
            dry = run_init("--dry-run")
            self.assertIn(
                f"[dry-run] 将移除已退役受管 hook {retired_key}", dry.stdout
            )
            self.assertEqual(hooks_json.read_text(encoding="utf-8"), hooks_text)
            self.assertEqual(list(config_dir.glob("hooks.json.bak.*")), [])

            # 2. 正式同步：退役 key 被移除，用户自定义 hook 原样保留，其他受管 hook 正常更新
            first = run_init()
            self.assertIn(f"已移除退役受管 hook: {retired_key}", first.stdout)
            merged_hooks = json.loads(hooks_json.read_text(encoding="utf-8"))
            self.assertNotIn(retired_key, merged_hooks)
            self.assertEqual(
                merged_hooks["my-custom-hook"], existing_hooks["my-custom-hook"]
            )
            pi_worker_hook = merged_hooks["harness-config-pi-worker-session-injector"]
            self.assertIn(
                str(ROOT / "agy/hooks/pi-worker-session-injector.py"),
                pi_worker_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
            for name in (
                "harness-config-swarm-model-guard",
                "harness-config-git-commit-guard",
            ):
                self.assertIn(name, merged_hooks)
            self.assertEqual(len(list(config_dir.glob("hooks.json.bak.*"))), 1)

            # 3. 二次运行完全幂等：内容不变、不新增备份
            second = run_init()
            self.assertIn("hooks.json 已包含全部受管 hooks，无需写入", second.stdout)
            self.assertEqual(
                json.loads(hooks_json.read_text(encoding="utf-8")), merged_hooks
            )
            self.assertEqual(len(list(config_dir.glob("hooks.json.bak.*"))), 1)

            # 4. 清理后再跑 --dry-run 不再报告移除
            dry_again = run_init("--dry-run")
            self.assertNotIn("将移除已退役受管 hook", dry_again.stdout)

    def test_init_agy_skips_regular_rule_file_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "agy-config"
            settings_path = Path(tmp) / "antigravity-cli" / "settings.json"
            shell_rc = Path(tmp) / ".zshrc"
            rule_path = config_dir / "rules" / "harness-config.md"
            rule_path.parent.mkdir(parents=True)
            rule_path.write_text("# user custom rule\n", encoding="utf-8")

            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

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

    def test_git_commit_guard_shell_fast_path_skips_python_and_catches_obfuscated_git(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "agy-config"
            settings_path = tmp_path / "antigravity-cli" / "settings.json"
            shell_rc = tmp_path / ".zshrc"
            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

            init_res = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(init_res.returncode, 0, msg=init_res.stderr)

            hooks = json.loads((config_dir / "hooks.json").read_text(encoding="utf-8"))
            cmd = hooks["harness-config-git-commit-guard"]["PreToolUse"][0]["hooks"][0]["command"]
            self.assertIn("sh -c", cmd)

            # 1. 普通非 git 命令（不含 git / \ / '）走快放行，零 Python 启动
            fake_bin = tmp_path / "fake-bin"
            fake_bin.mkdir()
            fake_py = fake_bin / "python3"
            fake_py.write_text("#!/bin/sh\necho PYTHON_INVOKED >&2\nexit 99\n", encoding="utf-8")
            fake_py.chmod(0o755)
            fast_env = os.environ.copy()
            fast_env["PATH"] = f"{fake_bin}:{fast_env.get('PATH', '')}"

            fast_payload = json.dumps(
                {"toolCall": {"name": "run_command", "args": {"CommandLine": "ls -la"}}}
            )
            fast_res = subprocess.run(
                ["sh", "-c", cmd],
                input=fast_payload,
                env=fast_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(fast_res.returncode, 0, msg=fast_res.stderr)
            self.assertEqual(json.loads(fast_res.stdout), {"decision": "allow"})

            # 2. 混淆绕过（g''it / gi\t）不得走快放行，必须进入 Python guard 并被拦截
            for bad_cmd in ("g''it commit -m bad", "gi\\t commit -m bad"):
                bad_payload = json.dumps(
                    {"toolCall": {"name": "run_command", "args": {"CommandLine": bad_cmd}}}
                )
                bad_res = subprocess.run(
                    ["sh", "-c", cmd],
                    input=bad_payload,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(bad_res.returncode, 0, msg=bad_res.stderr)
                out = json.loads(bad_res.stdout)
                self.assertEqual(out.get("decision"), "deny", msg=(bad_cmd, out))

    def test_pi_worker_injector_fast_path_and_title_cache(self) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "agy-config"
            settings_path = tmp_path / "antigravity-cli" / "settings.json"
            shell_rc = tmp_path / ".zshrc"
            env = os.environ.copy()
            env["AGY_CONFIG_DIR"] = str(config_dir)
            env["AGY_SETTINGS_PATH"] = str(settings_path)
            env["AGY_SHELL_RC"] = str(shell_rc)

            init_res = subprocess.run(
                ["bash", str(ROOT / "init-agy.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(init_res.returncode, 0, msg=init_res.stderr)

            hooks = json.loads((config_dir / "hooks.json").read_text(encoding="utf-8"))
            cmd = hooks["harness-config-pi-worker-session-injector"]["PreToolUse"][0]["hooks"][0]["command"]
            self.assertIn("sh -c", cmd)

            # 1. 非 pi_worker_start / pi_worker_monitor 的 call_mcp_tool 零 Python 启动直接放行
            fake_bin = tmp_path / "fake-bin"
            fake_bin.mkdir()
            fake_py = fake_bin / "python3"
            fake_py.write_text("#!/bin/sh\necho PYTHON_INVOKED >&2\nexit 99\n", encoding="utf-8")
            fake_py.chmod(0o755)
            fast_env = os.environ.copy()
            fast_env["PATH"] = f"{fake_bin}:{fast_env.get('PATH', '')}"

            unrelated_payload = json.dumps(
                {
                    "toolCall": {
                        "name": "call_mcp_tool",
                        "args": {"ServerName": "home", "ToolName": "home_exec", "Arguments": {}},
                    }
                }
            )
            fast_res = subprocess.run(
                ["sh", "-c", cmd],
                input=unrelated_payload,
                env=fast_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(fast_res.returncode, 0, msg=fast_res.stderr)
            self.assertEqual(json.loads(fast_res.stdout), {"decision": "allow"})

            # 2. 标题缓存：同一 (address, conversationId) 第二次不再请求 LS；私有目录 0700、文件 0600
            hits: list[str] = []

            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):  # noqa: N802
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    conv_id = body.get("conversationId", "")
                    hits.append(conv_id)
                    if conv_id == "conv-fail":
                        self.send_response(500)
                        self.end_headers()
                        return
                    data = json.dumps({"annotations": {"title": "缓存标题"}}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

                def log_message(self, *args):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cache_dir = tmp_path / "cache-dir"
            cache_path = cache_dir / "title-cache.json"
            hook_env = {k: v for k, v in os.environ.items() if not k.startswith("ANTIGRAVITY_")}
            hook_env["ANTIGRAVITY_LS_ADDRESS"] = f"127.0.0.1:{server.server_address[1]}"
            hook_env["ANTIGRAVITY_CSRF_TOKEN"] = "csrf-test"
            hook_env["AGY_TITLE_CACHE_PATH"] = str(cache_path)

            try:
                payload = json.dumps(
                    {
                        "conversationId": "conv-cache-ok",
                        "cwd": "/repo/app",
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                            "args": {"cwd": "/repo/app", "prompt": "x"},
                        },
                    }
                )
                first = subprocess.run(["sh", "-c", cmd], input=payload, env=hook_env, text=True, capture_output=True, check=False)
                self.assertEqual(first.returncode, 0, msg=first.stderr)
                self.assertEqual(json.loads(first.stdout)["overwrite"]["parentSessionTitle"], "缓存标题")
                self.assertEqual(hits, ["conv-cache-ok"])
                self.assertEqual(stat.S_IMODE(cache_dir.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(cache_path.stat().st_mode), 0o600)

                second = subprocess.run(["sh", "-c", cmd], input=payload, env=hook_env, text=True, capture_output=True, check=False)
                self.assertEqual(second.returncode, 0, msg=second.stderr)
                self.assertEqual(json.loads(second.stdout)["overwrite"]["parentSessionTitle"], "缓存标题")
                self.assertEqual(hits, ["conv-cache-ok"], msg="命中缓存不应再次请求 LS")

                # 失败负缓存 30s：同一失败会话第二次不再请求 LS，降级 lastUserInput
                fail_payload = json.dumps(
                    {
                        "conversationId": "conv-fail",
                        "cwd": "/repo/app",
                        "lastUserInput": "降级标题",
                        "toolCall": {
                            "name": "mcp_pi-worker_pi-worker_pi_worker_start",
                            "args": {"cwd": "/repo/app", "prompt": "x"},
                        },
                    }
                )
                subprocess.run(["sh", "-c", cmd], input=fail_payload, env=hook_env, text=True, capture_output=True, check=False)
                fail2 = subprocess.run(["sh", "-c", cmd], input=fail_payload, env=hook_env, text=True, capture_output=True, check=False)
                self.assertEqual(json.loads(fail2.stdout)["overwrite"]["parentSessionTitle"], "降级标题")
                self.assertEqual(hits, ["conv-cache-ok", "conv-fail"], msg="失败负缓存窗口内不应重复请求 LS")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
