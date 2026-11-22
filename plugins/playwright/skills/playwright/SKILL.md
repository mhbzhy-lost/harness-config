---
name: playwright
description: Use when needing real browser UI interaction, web automation, E2E steps, screenshots, or logged-in site access via local Chrome. 需要浏览器操作、网页交互、E2E、截图、登录态复用时使用；触发词：浏览器、打开网页、playwright、chrome、截图、登录。
---

# 受限 Playwright 浏览器操作

本地系统 Chrome（channel=chrome），per-instance daemon，多实例并行、profile 凭据共享、手动认证模式。

## 工具与顺序

`browser_start` → `browser_command`（navigate / snapshot / click / fill / wait / screenshot / tabs / inspect）→ `browser_stop`。

- `browser_start(instance, profile?, headed?, auth?)`：启动实例。`profile` 复用 `~/.playwright-sdk/profiles` 持久登录态（跨实例凭据共享）；`auth: true` 进手动认证模式（限制页面操作，供用户人工登录沉淀登录态）。
- `browser_command(instance, command)`：安全命令对象，如 `{op:'navigate',url:'https://example.com'}`、`{op:'snapshot'}`、`{op:'click',locator:...}`。
- `browser_instances()`：列出全部实例；遗留实例排查后 `browser_stop`。

## 规则

1. 每个任务使用自己拥有的实例名；默认 headless，headed/auth 仅在用户明确要求时使用。
2. 只接受安全命令集：**不支持任意 evaluate、run-file、凭据读取、密码输入**；不输出 cookie/token/授权材料。
3. 等待页面状态用 `op=wait`，不做同步阻塞等待。
4. 实例闲置 30 分钟自动回收（`PI_PLAYWRIGHT_IDLE_TIMEOUT` 秒数可调）。

## 深入文档

详细操作、认证流程、诊断与维护见插件内 docs/：`guide.md`（总览）、`operations.md`（命令集）、`authentication.md`（登录态）、`diagnostics.md`（排障）、`maintenance.md`（维护）。
