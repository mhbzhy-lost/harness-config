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
        self.assertIn("有明确计划", text)
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

        def run_hook(payload: dict, extra_env: dict | None = None) -> dict:
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith("ANTIGRAVITY_")
            }
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

            # 5. hooks.json 保留已有 hook 并注入内置子代理档位兜底 hook
            merged_hooks = json.loads(hooks_json.read_text(encoding="utf-8"))
            self.assertEqual(merged_hooks["my-custom-hook"], existing_hooks["my-custom-hook"])
            router_hook = merged_hooks["harness-config-subagent-model-router"]
            self.assertEqual(router_hook["PreToolUse"][0]["matcher"], "invoke_subagent")
            self.assertIn(
                str(ROOT / "agy/hooks/subagent-model-router.py"),
                router_hook["PreToolUse"][0]["hooks"][0]["command"],
            )
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


if __name__ == "__main__":
    unittest.main()
