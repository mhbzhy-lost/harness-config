# Playwright runtime 维护与验收

## 目录边界

实现、依赖与二级文档都留在插件目录 `plugins/playwright/`：MCP 入口 `src/server.ts`，runtime 在 `src/runtime/`（per-instance daemon + unix socket + 安全命令集）。server 直接调用本目录的 runtime；`src/runtime/cli.ts` 是与之等价的 CLI 入口，仅供诊断与验收，不要恢复外部 skill。

## 本地验证

```bash
cd plugins/playwright
bash scripts/setup.sh                       # 幂等安装依赖：按 package-lock 锁版，--ignore-scripts 且不下载浏览器
node src/runtime/cli.ts instances           # 不需要 Chrome 的 runtime 冒烟，应返回 {"ok":true,"result":[]}
node src/runtime/cli.ts --instance doc-smoke start \
  && node src/runtime/cli.ts --instance doc-smoke command '{"op":"navigate","url":"about:blank"}' \
  && node src/runtime/cli.ts --instance doc-smoke stop   # 真实 Chrome 冒烟（headless 系统 Chrome）
cd ../.. && node --test tests/test_*.mjs    # 仓库级回归：含 Pi agent-plugins 对本插件的清单校验与 server 注册断言
```

仓库级回归测试不启动 Chrome；真实 Chrome 冒烟需要系统 Google Chrome 在场，缺失或被跳过按 blocked/失败处理，不算通过。

## 依赖与变更审计

- 只使用 `package-lock.json` 锁定的依赖；不使用 npm `_npx` 缓存或第三方 Playwright MCP 包。
- `playwright` 与 `playwright-core` 必须是同一稳定版本；安装时使用 `--ignore-scripts` 和 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（`scripts/setup.sh` 已内置），除非用户另行批准资源安装。
- 静态审计范围是本插件的源码、文档、package/lock；不得把仓库其他 feature 的问题当作本插件失败。
- 真实验收只使用新的临时 profile 和无认证本机页面；不读已有认证 profile，不做真实 SSO。
- 变更后检查 `git diff --check`，并确认没有凭据、浏览器 profile 或验收产物进入 Git。
