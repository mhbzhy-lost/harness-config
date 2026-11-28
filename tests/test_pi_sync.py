import json
import os
import pty
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PiSyncTest(unittest.TestCase):
    def test_every_pi_extension_entry_matches_directory_name(self) -> None:
        ext_root = ROOT / "pi/extensions"
        self.assertTrue(ext_root.is_dir())
        dirs = sorted(p for p in ext_root.iterdir() if p.is_dir())
        self.assertGreaterEqual(len(dirs), 14)
        for ext_dir in dirs:
            entry = ext_dir / f"{ext_dir.name}.ts"
            self.assertTrue(
                entry.is_file(),
                msg=f"扩展 {ext_dir.name} 缺少与扩展名一致的入口文件: {entry}",
            )

    def test_pi_bin_tools_exist_and_are_executable(self) -> None:
        path = ROOT / "pi/bin/apply_patch"
        self.assertTrue(path.is_file(), msg=f"缺少 bin 工具: {path}")
        self.assertTrue(os.access(path, os.X_OK), msg=f"bin 工具缺少执行权限: {path}")
        for removed in ("fd", "rg"):
            self.assertFalse((ROOT / "pi/bin" / removed).exists(), msg=f"仓内不再维护 {removed}，由 Pi 原生管理")

    def test_pi_settings_template_has_no_machine_specific_fields(self) -> None:
        settings_path = ROOT / "pi/settings.json"
        self.assertTrue(settings_path.is_file())
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(data.get("hideThinkingBlock"), True)
        self.assertEqual(data.get("cacheWarming"), "streaming")
        self.assertIsInstance(data.get("defaultTools"), list)
        pkgs = data.get("packages")
        self.assertIsInstance(pkgs, list)
        self.assertIn("npm:@arhen/pi-core-ask@1.1.0", pkgs)
        self.assertIn("git:github.com/mhbzhy-lost/pi-dcp@v1.0.1", pkgs)
        for pkg in pkgs:
            self.assertIsInstance(pkg, str)
            self.assertTrue(
                pkg.startswith(("npm:", "git:")),
                msg=f"模板 packages 只应包含跨机 npm:/git: 声明: {pkg}",
            )
        self.assertNotIn("pi-subagents", settings_path.read_text(encoding="utf-8"), msg="pi-subagents 只能经 launcher 注入交互式会话，不得写入全局模板（pi-worker 会加载）")
        for forbidden in (
            "model",
            "defaultProvider",
            "defaultModel",
            "enabledModels",
            "extensions",
            "skills",
            "deviceId",
            "lastChangelogVersion",
            "theme",
        ):
            self.assertNotIn(forbidden, data, msg=f"模板不应包含本机字段或绝对路径: {forbidden}")

    def test_pi_global_md_naming_and_content(self) -> None:
        global_md = ROOT / "pi/GLOBAL.md"
        self.assertTrue(global_md.is_file())
        self.assertFalse((ROOT / "pi/AGENTS.md").exists(), msg="仓内不得命名为 pi/AGENTS.md，以免被目录扫描误加载")
        text = global_md.read_text(encoding="utf-8")
        self.assertIn("## Git Commit 规范", text)
        self.assertIn("禁止执行 `sleep` 命令", text)
        self.assertIn("bash_async", text)
        self.assertIn("apply_patch", text)
        for forbidden in ("subagent", "子代理", "modelGrades", "fastModel"):
            self.assertNotIn(forbidden, text)

    def test_init_pi_dry_run_makes_no_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / "pi-agent"
            plugins_dir = Path(tmp) / "plugins"
            shell_rc = Path(tmp) / ".zshrc"
            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(agent_dir)
            env["PI_PLUGINS_DIR"] = str(plugins_dir)
            env["PI_SHELL_RC"] = str(shell_rc)
            env["PI_DOCS_SKILL_DIR"] = str(Path(tmp) / "pi-docs")
            env["PI_PACKAGE_DIR"] = str(Path(tmp) / "missing-pkg")

            res = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh"), "--dry-run"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=f"stdout:\n{res.stdout}\nstderr:\n{res.stderr}")
            self.assertFalse(agent_dir.exists())
            self.assertFalse(plugins_dir.exists())
            self.assertFalse(shell_rc.exists())

    def test_init_pi_retires_openai_proxy_and_injects_cliproxyapi(self) -> None:
        """openai-proxy 已退役：重跑 init-pi.sh 须从本机 settings 剔除其遗留路径（含旧仓库路径），并注入 cliproxyapi 懒加载扩展。"""
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / "pi-agent"
            agent_dir.mkdir(parents=True)
            plugins_dir = Path(tmp) / "plugins"
            shell_rc = Path(tmp) / ".zshrc"
            shell_rc.write_text("# existing zshrc\n", encoding="utf-8")
            settings_path = agent_dir / "settings.json"
            settings_path.write_text(json.dumps({
                "extensions": [
                    "/custom/keep-me/index.mjs",
                    "/old/harness-config/pi/extensions/openai-proxy/openai-proxy.ts",
                    "/custom/plugins/openai-proxy/openai-proxy.ts",
                    "/custom/keep-openai-proxy-helper.ts",
                ],
            }), encoding="utf-8")
            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(agent_dir)
            env["PI_PLUGINS_DIR"] = str(plugins_dir)
            env["PI_SHELL_RC"] = str(shell_rc)
            env["PI_DOCS_SKILL_DIR"] = str(Path(tmp) / "pi-docs")
            env["PI_PACKAGE_DIR"] = str(Path(tmp) / "missing-pkg")

            res = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=f"stdout:\n{res.stdout}\nstderr:\n{res.stderr}")

            exts = json.loads(settings_path.read_text(encoding="utf-8"))["extensions"]
            self.assertFalse(
                [e for e in exts if e.endswith("/pi/extensions/openai-proxy/openai-proxy.ts")],
                msg="退役的 openai-proxy 扩展路径未被清理",
            )
            self.assertIn("/custom/plugins/openai-proxy/openai-proxy.ts", exts, msg="仅剔除 /pi/extensions/<retired>/<retired>.ts 后缀，用户自建同名扩展不得被误删")
            self.assertIn("/custom/keep-me/index.mjs", exts)
            self.assertIn("/custom/keep-openai-proxy-helper.ts", exts, msg="仅剔除与 <retired>/<retired>.ts 后缀完全匹配的条目")
            cliproxyapi = str(ROOT / "pi/extensions/cliproxyapi/cliproxyapi.ts")
            self.assertIn(cliproxyapi, exts)
            self.assertLess(exts.index(str(ROOT / "pi/extensions/agent-plugins/agent-plugins.ts")), exts.index(cliproxyapi))
            self.assertLess(exts.index(cliproxyapi), exts.index(str(ROOT / "pi/extensions/ask-user-question/ask-user-question.ts")))
            self.assertFalse((ROOT / "pi/extensions/openai-proxy").exists(), msg="openai-proxy 目录应已从仓内移除")
            self.assertFalse((ROOT / "pi/openai-proxy.example.json").exists())

    def test_init_pi_sync_preserves_existing_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / "pi-agent"
            agent_dir.mkdir(parents=True)
            plugins_dir = Path(tmp) / "plugins"
            shell_rc = Path(tmp) / ".zshrc"
            shell_rc.write_text("# existing zshrc\n", encoding="utf-8")

            settings_path = agent_dir / "settings.json"
            existing_settings = {
                "packages": [
                    "../../.r2c/integrations/pi-adapter",
                    "git:github.com/mhbzhy-lost/pi-dcp-migrate@v0.1.3",
                ],
                "extensions": [
                    "/custom/loongsuite-pilot/index.mjs",
                    "/old/harness-config/pi/extensions/tui-lite/tui-lite.ts",
                ],
                "skills": ["/custom/local-skills"],
                "defaultTools": ["+custom_tool"],
                "defaultProvider": "openai",
                "defaultModel": "gpt-5",
                "hideThinkingBlock": False,
            }
            settings_path.write_text(json.dumps(existing_settings), encoding="utf-8")

            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(agent_dir)
            env["PI_PLUGINS_DIR"] = str(plugins_dir)
            env["PI_SHELL_RC"] = str(shell_rc)
            env["PI_DOCS_SKILL_DIR"] = str(Path(tmp) / "pi-docs")
            env["PI_PACKAGE_DIR"] = str(Path(tmp) / "missing-pkg")

            first = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, msg=f"stdout:\n{first.stdout}\nstderr:\n{first.stderr}")

            # 1. settings.json 深度合并，保留本机配置与非受管扩展，替换旧受管路径，保持渲染器顺序
            merged = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(merged["hideThinkingBlock"], True)
            self.assertEqual(merged["cacheWarming"], "streaming")
            self.assertEqual(
                merged["packages"],
                [
                    "../../.r2c/integrations/pi-adapter",
                    "git:github.com/mhbzhy-lost/pi-dcp@v1.0.1",
                    "npm:@arhen/pi-core-ask@1.1.0",
                ],
            )
            self.assertEqual(merged["defaultProvider"], "openai")
            self.assertEqual(merged["defaultModel"], "gpt-5")
            self.assertIn("+custom_tool", merged["defaultTools"])
            self.assertIn("+codemode", merged["defaultTools"])

            exts = merged["extensions"]
            self.assertIn("/custom/loongsuite-pilot/index.mjs", exts)
            self.assertNotIn("/old/harness-config/pi/extensions/tui-lite/tui-lite.ts", exts)
            ask_idx = exts.index(str(ROOT / "pi/extensions/ask-user-question/ask-user-question.ts"))
            dcp_idx = exts.index(str(ROOT / "pi/extensions/dcp/dcp.ts"))
            subagents_idx = exts.index(str(ROOT / "pi/extensions/subagents/subagents.ts"))
            compact_idx = exts.index(str(ROOT / "pi/extensions/compact-tools/compact-tools.ts"))
            self.assertLess(ask_idx, compact_idx)
            self.assertLess(dcp_idx, compact_idx)
            self.assertLess(dcp_idx, subagents_idx)
            self.assertLess(subagents_idx, compact_idx)
            self.assertIn(str(ROOT / "pi/extensions/agent-plugins/agent-plugins.ts"), exts)
            self.assertEqual(len(exts), 1 + 14)
            self.assertIn("/custom/local-skills", merged["skills"])
            self.assertIn(str(ROOT / "skills"), merged["skills"])
            self.assertEqual(stat.S_IMODE(settings_path.stat().st_mode), 0o600)
            self.assertEqual(len(list(agent_dir.glob("settings.json.bak.*"))), 1)

            # 2. keybindings.json 与全局 AGENTS.md 软链
            kb_link = agent_dir / "keybindings.json"
            self.assertTrue(kb_link.is_symlink())
            self.assertEqual(kb_link.resolve(), (ROOT / "pi/keybindings.json").resolve())

            global_md_link = agent_dir / "AGENTS.md"
            self.assertTrue(global_md_link.is_symlink())
            self.assertEqual(global_md_link.resolve(), (ROOT / "pi/GLOBAL.md").resolve())

            # 2.5 apply_patch 复制到 $PI_AGENT_DIR/bin/apply_patch 且可执行
            copied_bin = agent_dir / "bin/apply_patch"
            self.assertTrue(copied_bin.is_file())
            self.assertFalse(copied_bin.is_symlink())
            self.assertTrue(os.access(copied_bin, os.X_OK))
            self.assertEqual(copied_bin.read_bytes(), (ROOT / "pi/bin/apply_patch").read_bytes())

            # 3. 插件软链
            for name in ("deepseek-search", "home-connect", "pi-worker", "playwright"):
                link = plugins_dir / name
                self.assertTrue(link.is_symlink(), msg=f"缺少插件软链: {link}")
                self.assertEqual(link.resolve(), (ROOT / "plugins" / name).resolve())

            # 4. shell.zsh 注册进 ~/.zshrc
            rc_text = shell_rc.read_text(encoding="utf-8")
            self.assertIn("# >>> harness-config pi >>>", rc_text)
            self.assertIn(str(ROOT / "pi/shell.zsh"), rc_text)
            self.assertIn("# existing zshrc", rc_text)

            # 5. 二次运行完全幂等
            second = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, msg=f"stdout:\n{second.stdout}\nstderr:\n{second.stderr}")
            self.assertEqual(json.loads(settings_path.read_text(encoding="utf-8")), merged)
            self.assertEqual(len(list(agent_dir.glob("settings.json.bak.*"))), 1)
            self.assertEqual(shell_rc.read_text(encoding="utf-8"), rc_text)
            self.assertIn("apply_patch：已是最新，无需复制", second.stdout)

    def test_init_pi_skips_regular_keybindings_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / "pi-agent"
            agent_dir.mkdir(parents=True)
            kb_path = agent_dir / "keybindings.json"
            kb_path.write_text('{"custom": "ctrl+x"}\n', encoding="utf-8")

            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(agent_dir)
            env["PI_PLUGINS_DIR"] = str(Path(tmp) / "plugins")
            env["PI_SHELL_RC"] = str(Path(tmp) / ".zshrc")
            env["PI_DOCS_SKILL_DIR"] = str(Path(tmp) / "pi-docs")
            env["PI_PACKAGE_DIR"] = str(Path(tmp) / "missing-pkg")

            res = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0)
            self.assertIn("已存在且不是软链接", res.stderr)
            self.assertFalse(kb_path.is_symlink())
            self.assertEqual(kb_path.read_text(encoding="utf-8"), '{"custom": "ctrl+x"}\n')

    def test_launcher_bypasses_version_and_blocks_duplicate_session_continue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            fake_pi = tmp_path / "fake-pi"
            fake_pi.write_text("#!/bin/sh\necho \"FAKE_PI:$*\"\n", encoding="utf-8")
            fake_pi.chmod(0o755)

            registry = tmp_path / "registry"
            env = os.environ.copy()
            env["PI_REAL_BIN"] = str(fake_pi)
            env["PI_SESSION_OWNER_REGISTRY"] = str(registry)

            # 1. --version 走 bypass，直接透传，不建 owner 记录
            ver = subprocess.run(
                ["zsh", str(ROOT / "pi/launcher.zsh"), "--version"],
                cwd=tmp_path,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(ver.returncode, 0, msg=f"stderr:\n{ver.stderr}")
            self.assertIn("FAKE_PI:--version", ver.stdout)
            self.assertFalse(registry.exists())

    def test_interactive_packages_manifest_is_pinned_and_isolated_from_settings(self) -> None:
        manifest = ROOT / "pi/interactive-packages.json"
        self.assertTrue(manifest.is_file(), msg=f"缺少 {manifest}")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertIsInstance(data, dict)
        pkgs = data.get("packages")
        self.assertIsInstance(pkgs, list)
        self.assertIn("npm:pi-subagents@0.90.0", pkgs)
        self.assertEqual(set(data), {"packages"}, msg="清单只应包含 packages 字段")
        exact = re.compile(r"^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$")
        commit = re.compile(r"^[0-9a-f]{7,40}$")
        for pkg in pkgs:
            self.assertIsInstance(pkg, str)
            self.assertTrue(pkg.startswith(("npm:", "git:")), msg=f"仅支持 npm:/git: 条目: {pkg}")
            name, sep, version = pkg.rpartition("@")
            self.assertTrue(sep and name and version, msg=f"条目必须锁定精确版本/tag/commit: {pkg}")
            self.assertFalse(version.startswith(("^", "~", ">", "<", "=", "*", "x", " ")), msg=f"禁止 semver 范围: {pkg}")
            self.assertNotIn(version, ("latest", "next", "main", "master", "dev"), msg=f"禁止浮动 tag/分支: {pkg}")
            self.assertNotIn(" ", version)
            if pkg.startswith("npm:"):
                self.assertRegex(version, exact, msg=f"npm 条目必须锁定精确版本: {pkg}")
            else:
                self.assertTrue(exact.match(version) or commit.match(version), msg=f"git 条目必须锁定 tag 或 commit: {pkg}")
        self.assertNotIn("pi-subagents", (ROOT / "pi/settings.json").read_text(encoding="utf-8"))

    def _run_launcher_with_argv_capture(self, launcher: Path, argv: list[str]) -> tuple[int, str, dict]:
        """在 pty 下启动 launcher（假 pi 记录 argv），返回 (退出码, stderr, 假 pi 记录)。"""
        tmp_path = launcher.parent
        fake_pi = tmp_path / "fake-pi"
        fake_pi.write_text(
            "#!/usr/bin/env node\n"
            "const { writeFileSync } = require('node:fs');\n"
            "writeFileSync(process.env.FAKE_PI_OUT, JSON.stringify({ argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS || '' }));\n",
            encoding="utf-8",
        )
        fake_pi.chmod(0o755)
        out_file = tmp_path / "fake-pi-output.json"
        env = os.environ.copy()
        for leaked in ("NODE_OPTIONS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_FANOUT_CHILD", "PI_SESSION_OWNER_ID", "PI_SESSION_OWNER_REGISTRY", "PI_SESSION_FILE"):
            env.pop(leaked, None)
        env["PI_REAL_BIN"] = str(fake_pi)
        env["PI_SESSION_OWNER_REGISTRY"] = str(tmp_path / "registry")
        env["PI_HEAP_DIAGNOSTIC_DIR"] = str(tmp_path / "heap")
        env["FAKE_PI_OUT"] = str(out_file)
        master_fd, slave_fd = pty.openpty()
        try:
            res = subprocess.run(
                ["zsh", str(launcher), *argv],
                cwd=tmp_path,
                env=env,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        finally:
            os.close(slave_fd)
            os.close(master_fd)
        info = json.loads(out_file.read_text(encoding="utf-8")) if out_file.is_file() else {}
        return res.returncode, res.stderr, info

    def test_launcher_injects_interactive_packages_only_in_interactive_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            session_owner_arg = str(tmp_path / "extensions/session-owner/session-owner.ts")
            # 假 pi 所在目录即 pi_root：把 launcher 放在临时目录，scripts/ 软链到仓内
            launcher = tmp_path / "launcher.zsh"
            launcher.write_text((ROOT / "pi/launcher.zsh").read_text(encoding="utf-8"), encoding="utf-8")
            (tmp_path / "scripts").symlink_to(ROOT / "pi/scripts")
            (tmp_path / "extensions").symlink_to(ROOT / "pi/extensions")
            (tmp_path / "interactive-packages.json").write_text((ROOT / "pi/interactive-packages.json").read_text(encoding="utf-8"), encoding="utf-8")

            # 1. 交互模式（无参数，pty）：session-owner 与锁版包一同以 -e 传入，且置于用户参数之前
            code, stderr, info = self._run_launcher_with_argv_capture(launcher, [])
            self.assertEqual(code, 0, msg=f"stderr:\n{stderr}")
            argv = info.get("argv") or []
            self.assertIn(session_owner_arg, argv, msg=f"stderr:\n{stderr}\nargv: {argv}")
            self.assertEqual(argv.count("-e"), 2, msg=f"应恰好注入两个 -e: {argv}")
            self.assertEqual(argv[0], "-e")
            self.assertEqual(argv[2], "-e")
            self.assertEqual(argv[3], "npm:pi-subagents@0.90.0")
            self.assertEqual(argv[-2:], ["-e", "npm:pi-subagents@0.90.0"])
            self.assertEqual(info.get("nodeOptions"), "")

            shutil.rmtree(tmp_path / "registry")
            # 2. 非交互 bypass（--version）：不加载 pi-subagents，参数原样透传
            code, stderr, info = self._run_launcher_with_argv_capture(launcher, ["--version"])
            self.assertEqual(code, 0, msg=f"stderr:\n{stderr}")
            argv = info.get("argv") or []
            self.assertEqual(argv, ["--version"])
            self.assertFalse((tmp_path / "registry").exists())

            # 3. 含空格的包名经 NUL 分隔读入后仍是单个参数
            (tmp_path / "interactive-packages.json").write_text(
                json.dumps({"packages": ["npm:a b@1.0.0", "npm:c@2.0.0"]}), encoding="utf-8"
            )
            code, stderr, info = self._run_launcher_with_argv_capture(launcher, [])
            self.assertEqual(code, 0, msg=f"stderr:\n{stderr}")
            argv = info.get("argv") or []
            self.assertEqual(argv[-4:], ["-e", "npm:a b@1.0.0", "-e", "npm:c@2.0.0"])

            # 4. 清单缺失时静默跳过，只注入 session-owner
            (tmp_path / "interactive-packages.json").unlink()
            code, stderr, info = self._run_launcher_with_argv_capture(launcher, [])
            self.assertEqual(code, 0, msg=f"stderr:\n{stderr}")
            self.assertEqual(info.get("argv"), ["-e", session_owner_arg])

            # 5. 清单非法 JSON / packages 非字符串数组：中文报错且非零退出，不拉起 pi
            for bad in ("{bad", '{"packages": "npm:x@1.0.0"}', '{"packages": [1]}', '{"packages": [""]} ', '{"other": []}'):
                (tmp_path / "interactive-packages.json").write_text(bad, encoding="utf-8")
                out_file = tmp_path / "fake-pi-output.json"
                out_file.unlink(missing_ok=True)
                code, stderr, info = self._run_launcher_with_argv_capture(launcher, [])
                self.assertNotEqual(code, 0, msg=f"清单 {bad!r} 应失败")
                self.assertIn("错误:", stderr)
                self.assertIn("interactive-packages.json", stderr)
                self.assertNotIn("parameter not set", stderr)
                self.assertFalse(out_file.exists(), msg=f"清单 {bad!r} 非法时不得拉起 pi")

            # 6. bypass 模式忽略非法清单（非交互不读取清单）
            (tmp_path / "interactive-packages.json").write_text("{bad", encoding="utf-8")
            code, stderr, info = self._run_launcher_with_argv_capture(launcher, ["--version"])
            self.assertEqual(code, 0, msg=f"stderr:\n{stderr}")
            self.assertEqual(info.get("argv"), ["--version"])

    def test_launcher_node_script_receives_heap_flags_with_spaces_without_leaking_node_options(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            diag_dir = tmp_path / "diag with spaces" / "heap"
            out_file = tmp_path / "fake-pi-output.json"
            fake_pi = tmp_path / "fake-pi"
            fake_pi.write_text(
                "#!/usr/bin/env node\n"
                "const { spawnSync } = require('node:child_process');\n"
                "const { writeFileSync } = require('node:fs');\n"
                "const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.NODE_OPTIONS || \"\")'], { encoding: 'utf8' });\n"
                "writeFileSync(process.env.FAKE_PI_OUT, JSON.stringify({\n"
                "  execArgv: process.execArgv,\n"
                "  argv: process.argv.slice(2),\n"
                "  childNodeOptions: child.stdout,\n"
                "  ownNodeOptions: process.env.NODE_OPTIONS || '',\n"
                "}));\n",
                encoding="utf-8",
            )
            fake_pi.chmod(0o755)

            registry = tmp_path / "registry"
            env = os.environ.copy()
            env.pop("NODE_OPTIONS", None)
            env["PI_REAL_BIN"] = str(fake_pi)
            env["PI_SESSION_OWNER_REGISTRY"] = str(registry)
            env["PI_HEAP_DIAGNOSTIC_DIR"] = str(diag_dir)
            env["FAKE_PI_OUT"] = str(out_file)

            master_fd, slave_fd = pty.openpty()
            try:
                res = subprocess.run(
                    ["zsh", str(ROOT / "pi/launcher.zsh")],
                    cwd=tmp_path,
                    env=env,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
            finally:
                os.close(slave_fd)
                os.close(master_fd)

            self.assertEqual(res.returncode, 0, msg=f"stderr:\n{res.stderr}")
            self.assertTrue(out_file.is_file(), msg=f"fake-pi 未输出文件; stderr:\n{res.stderr}")
            info = json.loads(out_file.read_text(encoding="utf-8"))
            self.assertIn("--max-old-space-size=8192", info["execArgv"])
            self.assertIn("--heapsnapshot-near-heap-limit=2", info["execArgv"])
            self.assertIn(f"--diagnostic-dir={diag_dir}", info["execArgv"])
            self.assertEqual(info["ownNodeOptions"], "")
            self.assertEqual(info["childNodeOptions"], "")

    def test_launcher_node_script_bypass_version_succeeds_under_no_unset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            fake_pi = tmp_path / "fake-pi"
            fake_pi.write_text(
                "#!/usr/bin/env node\n"
                "console.log('FAKE_NODE_PI:' + process.argv.slice(2).join(' '));\n",
                encoding="utf-8",
            )
            fake_pi.chmod(0o755)

            registry = tmp_path / "registry"
            env = os.environ.copy()
            env.pop("NODE_OPTIONS", None)
            env["PI_REAL_BIN"] = str(fake_pi)
            env["PI_SESSION_OWNER_REGISTRY"] = str(registry)

            res = subprocess.run(
                ["zsh", str(ROOT / "pi/launcher.zsh"), "--version"],
                cwd=tmp_path,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=f"stderr:\n{res.stderr}")
            self.assertNotIn("parameter not set", res.stderr)
            self.assertIn("FAKE_NODE_PI:--version", res.stdout)
            self.assertFalse(registry.exists())

    def test_pi_docs_skill_exists_and_init_links_local_package_docs(self) -> None:
        skill_md = ROOT / ".agents/skills/pi-docs/SKILL.md"
        self.assertTrue(skill_md.is_file())
        text = skill_md.read_text(encoding="utf-8")
        self.assertIn("name: pi-docs", text)
        self.assertIn("docs/extensions.md", text)
        self.assertIn("docs/models-configuration.md", text)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            fake_pkg = tmp_path / "pkg"
            (fake_pkg / "docs").mkdir(parents=True)
            (fake_pkg / "examples").mkdir()
            (fake_pkg / "schemas").mkdir()
            (fake_pkg / "README.md").write_text("# Pi\n", encoding="utf-8")
            (fake_pkg / "package.json").write_text(
                json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "1.6.0"}),
                encoding="utf-8",
            )

            docs_target = tmp_path / "pi-docs"
            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(tmp_path / "agent")
            env["PI_PLUGINS_DIR"] = str(tmp_path / "plugins")
            env["PI_SHELL_RC"] = str(tmp_path / ".zshrc")
            env["PI_PACKAGE_DIR"] = str(fake_pkg)
            env["PI_DOCS_SKILL_DIR"] = str(docs_target)

            # 1. --dry-run 不落盘
            dry = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh"), "--dry-run"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(dry.returncode, 0, msg=dry.stderr)
            self.assertFalse(docs_target.exists())

            # 2. 真实运行创建 4 个软链
            first = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, msg=first.stderr)
            for asset in ("docs", "examples", "schemas", "README.md"):
                link = docs_target / asset
                self.assertTrue(link.is_symlink(), msg=f"缺少软链: {link}")
                self.assertEqual(link.resolve(), (fake_pkg / asset).resolve())

            # 3. 二次运行幂等
            second = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, msg=second.stderr)
            self.assertIn("Pi 文档 docs：链接已正确", second.stdout)

            # 4. 已有真实文件/目录不覆盖，仅告警跳过
            (docs_target / "README.md").unlink()
            (docs_target / "README.md").write_text("local custom\n", encoding="utf-8")
            third = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(third.returncode, 0, msg=third.stderr)
            self.assertIn("已存在且不是软链接", third.stderr)
            self.assertEqual((docs_target / "README.md").read_text(encoding="utf-8"), "local custom\n")

    def test_init_pi_handles_missing_pi_package_gracefully(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            docs_target = tmp_path / "pi-docs"
            env = os.environ.copy()
            env["PI_AGENT_DIR"] = str(tmp_path / "agent")
            env["PI_PLUGINS_DIR"] = str(tmp_path / "plugins")
            env["PI_SHELL_RC"] = str(tmp_path / ".zshrc")
            env["PI_PACKAGE_DIR"] = str(tmp_path / "does-not-exist")
            env["PI_DOCS_SKILL_DIR"] = str(docs_target)

            res = subprocess.run(
                ["bash", str(ROOT / "init-pi.sh")],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, msg=res.stderr)
            self.assertIn("未找到本机 @earendil-works/pi-coding-agent 包", res.stdout)
            self.assertFalse(docs_target.exists())


if __name__ == "__main__":
    unittest.main()
