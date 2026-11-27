# 全仓性能与稳定性（P0–P2）修复实施计划

> **For agentic workers:** Implement this plan task-by-task in order (or per disjoint parallel group in isolated git worktrees when Parallel mode is chosen). Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass (when running serially).

**Goal:** 修复全仓审查报告中全部 24 项 P0–P2 性能与稳定性问题（含 `home-connect` HTTP 鉴权多字节长度异常加固），并为此前缺少自动化测试的插件补齐回归测试。

**Architecture:** 8 个模块（`remote-terminal`、`deepseek-search`、`session-owner`+`launcher.zsh`、其余 Pi 扩展、`home-connect`、`pi-worker`、`playwright`、Python/AGY hooks）源码与测试文件完全正交，彼此无共享修改文件，既支持单分支串行实施，也支持按独立 `git worktree` 并行实施后顺序集成。锁恢复策略按语言分层：Node/TS 模块保持零原生依赖（临时文件 + `link` 原子发布 + `<lock>.reclaim` 回收互斥消除 ABA 竞态 + `LC_ALL=C TZ=UTC ps -o lstart=` 进程身份校验 + 退避），Python 模块采用标准库 `fcntl.flock`。

**Tech Stack:** Node.js（原生 TypeScript type-stripping + `node --test` / `node <script>`）、Python 3（`unittest`、`fcntl`、`shlex`）、POSIX `sh`/`bash`/`zsh`、esbuild（`plugins/pi-worker/ui-src/build.mjs`）。

**Spec:** `/Users/mhbzhy/.gemini/antigravity/brain/77de0b6b-fa7c-41ac-895a-9173a696ed12/perf-stability-audit.md`（用户已拍板：`session-owner` 坚持纯 Node 方案，缩临界区 + 退避 + 批量 `readSync` + 对已死 PID 陈旧 `.guard` 安全自愈；修复范围覆盖全部 P0 + P1 + P2）。

## Global Constraints

- **零新增外部依赖**：不引入原生 C++ addon（如 `fs-ext`）或新 npm/pip 依赖；Python 仅用标准库，Node 仅用内建模块与已有依赖。对本机未装 `node_modules` 的模块（`remote-terminal`、`home-connect`），抽离零第三方依赖、无顶层副作用的纯模块供 `node --test` 直接单测。
- **统一的 Node 陈旧锁安全回收协议（无 ABA 竞态）**：Task 1、Task 3、Task 6、Task 7 全部遵循同一模式：
  1. 正常持锁：先写含 `{ pid, token, ... }` 的私有临时文件，再 `link(tmp, lockPath)` 原子发布（`finally` 删除 `tmp`），杜绝 0 字节窗口；
  2. 陈旧锁回收：绝不直接 `unlink(lockPath)` 或直接 `rename(lockPath, ...)`（防止 ABA 搬走他人新活锁）；先以 `O_EXCL`+`link` 原子抢占 `<lockPath>.reclaim` 回收互斥锁，持锁期间重新 `lstat`+读取 `lockPath`，核验 `ino` 与 `token` 未变且持锁 PID 确实已死（对损坏/无 token 锁额外要求 `mtime > 2s` 宽限），确认后再 `unlink(lockPath)`，最后释放 `<lockPath>.reclaim`（`.reclaim` 自身仅在 PID 已死且 `mtime > 5s` 时回收）。
- **统一进程启动指纹**：进程身份校验统一使用 `LC_ALL=C TZ=UTC ps -p <pid> -o lstart=` 规范化串（**严禁包含 `comm`**，避免 Pi 改写 `process.title` 导致 Linux `comm` 变化误杀活进程；且仅在回收陈旧锁或跨进程 `cancel` 时调用，不放入 `status`/`list` 热路径）。
- **既有契约不破坏**：
  - `manage-providers.py` 必须保留 `_models_lock` 函数名（`tests/test_pi_manage_provider.py` 源码断言）。
  - `init-agy.sh` 生成的 `hooks.json` 必须保留 `pi_worker_(start|monitor)` 子串、`swarm`、`run_command` 三个 `matcher`、对应脚本绝对路径、`timeout: 5`、`0600` 权限及幂等性（`tests/test_agy_sync.py` 断言）。
  - `plugins/home-connect` 所有 `HOST_MODE`（`HOME_CONNECT_HOST==="mac"`）分支语义保持不变。
  - `plugins/playwright` 保持 `.sdk-lease/owner.json`、`instances/<name>/{owner.json,ready.json}`、`stopRuntime` 强确认与 `<100` 字节 `.sock` 契约不变。
  - 凡修改 `plugins/pi-worker/ui-src/*` 必须重新运行 `node plugins/pi-worker/ui-src/build.mjs` 同步更新 `plugins/pi-worker/ui/monitor.html`。
- **Worktree 并行前置依赖准备**：并行模式在新建 `git worktree` 中执行 Task 6 / Task 7 前，须从主检出软链已安装的 gitignored `node_modules`（如 `plugins/pi-worker/ui-src/node_modules`、`plugins/playwright/node_modules`，若主检出存在则 `ln -s`，否则跳过或按需 `npm ci`），确保 `build.mjs` 与测试正常运行。
- **测试运行器**：本机无 `pytest`，Python 测试统一用 `python3 -m unittest`；Node 测试分别沿用各文件原有运行方式（`node --test` 或 `node <path>`）。
- **Git 提交规范**：优先使用 `git1`（不可用时回退 `git`）；commit 格式必须为 `type(scope): 中文祈使句`（≤50 字、无末尾句号、无 AI 署名），以祈使动词开头；禁止直接提交到 `main`（实施须在独立特性分支或 worktree 进行）。
- **平台兼容**：所有 shell 与进程身份检查须兼容 macOS（BSD）与 Linux（GNU）。

## Review Focus

1. **陈旧锁回收 ABA 竞态与 0 字节窗口**：两进程同时检测到死锁并回收时，绝不能通过 `unlink` 或直接 `rename` 搬走第三者刚发布的新活锁，也不能在建锁写入前因 0 字节窗口误删活锁——归属 **Task 1**（`remote-terminal`）、**Task 3**（`session-owner`）、**Task 6**（`pi-worker`）、**Task 7**（`playwright`）。
2. **PID 复用与 `process.title` 误判**：旧进程退出 PID 被复用时不误杀无关进程组，同时 Pi 改写 `process.title` 后指纹仍保持稳定不会把活进程误判为死进程——归属 **Task 6**（`pi-worker`）、**Task 8**（`codex-proxy`）。
3. **跨分片、半开连接与流式背压**：HTTP 请求头跨多帧到达、UTF-8 多字节字符跨 chunk 切分、响应头返回后连接静默断开或无限慢速灌流、TLS 握手挂死，均不得崩溃、乱码或永久挂起——归属 **Task 1**（`remote-terminal`）、**Task 2**（`deepseek-search`）、**Task 5**（`home-connect`）。
4. **路径空格、绕过引号、点文件与畸形入参**：`$HOME`/诊断目录含空格、bypass 分支在 `no_unset` 下启动、`g''it commit`/`gi\t commit` 绕过尝试、`stateRoot` 混入 `.DS_Store`/损坏目录、HTTP 收到非法 URL 或等长多字节 `Authorization` 头、工具收到非字符串 `path` 入参（fail-closed）——归属 **Task 1**、**Task 3**、**Task 4**、**Task 5**、**Task 7**、**Task 8**。
5. **非正常终止、孙进程管道继承与测试环境隔离**：工具未达终态的定时器清理、MCP 会话 LRU 驱逐关闭、孙进程继承 stdio 时先杀进程组再释锁、`codex-proxy` 与 AGY title 缓存测试严禁触碰用户真实 `HOME`/`TMPDIR`/端口 8317——归属 **Task 4**、**Task 5**、**Task 6**、**Task 8**。

## Parallel Partition Map

8 个 Task 修改的源码与测试文件**完全互不重叠**，可作为单波次并行组（或任意拆分为 2–4 个 worktree 组）安全并发执行：
- **Group A**：Task 1（`remote-terminal`）
- **Group B**：Task 2（`deepseek-search`）+ Task 7（`playwright`）
- **Group C**：Task 3（`session-owner` + `launcher.zsh`）+ Task 4（其余 Pi 扩展）
- **Group D**：Task 5（`home-connect`）
- **Group E**：Task 6（`pi-worker`，worktree 需软链 `plugins/pi-worker/ui-src/node_modules`）
- **Group F**：Task 8（`manage-providers` + `codex-proxy` + `agy/hooks`）

---

### Task 1: 加固 `remote-terminal` Web/Relay 稳定性与 Shell 快路径

**Depends on:** `none`

**Files:**
- Create: `remote-terminal/src/web/url.ts`（零第三方依赖：导出 `parseRequestUrl`）
- Create: `remote-terminal/src/relay/header-rewrite.ts`（零第三方依赖：导出 `forceConnectionClose`、`HeaderRewriteState`/`createHeaderRewriter`、`EarlyBuffer`）
- Modify: `remote-terminal/src/web/server.ts:194-332`
- Modify: `remote-terminal/src/relay/ensure.ts:140-205`
- Modify: `remote-terminal/src/relay/devices.ts:30-105`
- Modify: `remote-terminal/src/relay/agent.ts:75-150, 220-266, 320-390`
- Modify: `remote-terminal/shell.zsh:15-35`
- Test: `tests/test_remote_terminal.mjs`
- Test: `tests/test_remote_terminal.py`

**Interfaces:**
- Consumes: `remote-terminal/src/protocol.ts` 中已有常量 `BACKPRESSURE_HIGH_BYTES`、`BACKPRESSURE_CHECK_MS`、`MAX_WS_MESSAGE_BYTES`。
- Produces:
  - `remote-terminal/src/web/url.ts` 导出 `parseRequestUrl(rawUrl: string | undefined): URL | null`；
  - `remote-terminal/src/relay/header-rewrite.ts` 导出 `MAX_HEADER_BUFFER_BYTES = 65536`、`MAX_EARLY_BUFFER_BYTES = 1024 * 1024`、`createHeaderRewriter(maxBytes?: number)`、`createEarlyBuffer(maxBytes?: number)`；
  - 保持 `createWebServer`、`withEnsureLock`、`addPending`/`approveByCode`/`denyByCode`/`revokeById`/`readActivePending` 及 `shell.zsh` 的 `_rt_ensure_server` 外部契约不变。

- [ ] **Step 1: 编写失败测试覆盖全部缺陷（零第三方依赖可在本机直接运行）**
  - 在 `tests/test_remote_terminal.mjs` 新增测试：
    1. `web url parser: rejects malformed HTTP/upgrade URLs cleanly without throwing`：导入 `remote-terminal/src/web/url.ts` 测试 `http://[invalid`、合法 `/ws?session=a&token=b`、空串，并用原生 `node:http` 验证畸形请求进入 handler 时返回 `400` 而不崩溃；另源码检查 `server.ts` 已绑定 `maxPayload: MAX_WS_MESSAGE_BYTES`、`ws.bufferedAmount > BACKPRESSURE_HIGH_BYTES` 背压及 `closeAllConnections` + `ws.terminate`。
    2. `relay locks & atomicWriteJson: atomic link publish + reclaim mutex handles dead lock and concurrent writes safely`：在临时目录预置已死 PID 的 `devices.lock`，并发调用 `addPending`/`approveByCode` 10 次无误删锁或临时文件冲突，验证 `devices.json` 完整无丢失。
    3. `relay header-rewrite: split HTTP headers across multiple chunks still rewrite Connection: close and cap early buffer`：导入 `remote-terminal/src/relay/header-rewrite.ts`，将 `GET / HTTP/1.1\r\nConnection: keep-alive` 与 `\r\n\r\n` 拆成 2 个 chunk 喂给 `createHeaderRewriter()`，断言合并改写后包含 `Connection: close` 且不含 `keep-alive`；验证超 `MAX_HEADER_BUFFER_BYTES` 与 `createEarlyBuffer` 超上限时返回 overflow/拒绝。
  - 在 `tests/test_remote_terminal.py` 新增测试：
    4. `test_shell_ensure_fast_path_skips_node_when_web_exposure_off`：在临时目录**构造伪造的 `node_modules` 目录与 `config.json`（`webExposure: "off"`）**（确保不因 `shell.zsh:27` 缺 `node_modules` 短路假绿）并放假 `node` 记账脚本，source `remote-terminal/shell.zsh` 调用 `_rt_ensure_server`，断言假 `node` 未被调用；再切 `webExposure: "lan"` 且无 `web.pid` 时断言假 `node` 被调用。

- [ ] **Step 2: 运行测试确认全部新增用例失败**
  - Run: `node --test tests/test_remote_terminal.mjs && python3 -m unittest tests.test_remote_terminal -v`
  - Expected: 新增用例 FAIL，原有 8 个用例 PASS。

- [ ] **Step 3: 最小化实现修复**
  1. 新建 `remote-terminal/src/web/url.ts` 实现 `parseRequestUrl`；更新 `remote-terminal/src/web/server.ts`：
     - `createServer` 回调与 `server.on("upgrade", ...)` 均用 `try/catch` 包裹并通过 `parseRequestUrl` 解析（非法 URL 返回 `400` 并 `res.end()` / `socket.destroy()`）。
     - `new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES })`。
     - `att.onData` 检查 `ws.bufferedAmount > BACKPRESSURE_HIGH_BYTES` 时调用 `att.pause()`，并以 `BACKPRESSURE_CHECK_MS` 定时检查排空后 `att.resume()`（在 `ws.on("close")` 与 `att.onExit` 清理定时器）。
     - `close()` 中调用 `server.closeAllConnections?.()`，对 `wss.clients` 发 `ws.close()` 并在 500ms 宽限后对仍未关闭的 WS 调用 `ws.terminate()`。
  2. `remote-terminal/src/relay/ensure.ts` & `remote-terminal/src/relay/devices.ts`：
     - `atomicWriteJson` 临时文件名改用 `${file}.tmp-${process.pid}-${randomUUID()}`。
     - `withEnsureLock` 与 `withDeviceLock` 按 Global Constraints 统一改用“临时文件写入 `{ pid, token }` + `link(tmp, lockFile)` 原子发布 + `<lockFile>.reclaim` 回收互斥（重读校验 `ino`+`token`+死 PID 后 `unlink`）”。
  3. 新建 `remote-terminal/src/relay/header-rewrite.ts` 并接入 `remote-terminal/src/relay/agent.ts`：
     - `createHeaderRewriter` 在未见 `\r\n\r\n` 前累积头部字节（上限 `65536` 字节），跨多条 WS 消息拼接完整头部后再执行 `forceConnectionClose` 并关闭改写；`createEarlyBuffer` 限制总字节上限 `1MB`，超限立即关闭数据通道。
     - L356-358 与 L379-386 处 `writeStatus(...).then(...)` 改为 `.catch(() => {}).finally(() => process.exit(...))`，并在 `shutdown` 中清理 watcher 与活跃数据通道。
  4. `remote-terminal/shell.zsh`：
     - `_rt_ensure_server` 开头加 `emulate -L zsh`（防止交互 shell 选项干扰模式匹配）；零 fork 读取 `$HOME/.harness-remote/config.json`：
       - 若 `webExposure` 为 `"off"` 且无存活 `web.pid`/`agent.pid` 则直接 return；
       - 若 `webExposure` 为 `"lan"` 且 `web.pid` 存活、或 `"public"` 且 `web.pid` 与 `agent.pid` 均存活，且当前 shell `_HARNESS_REMOTE_ENSURED=1` 时跳过拉起 Node。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node --test tests/test_remote_terminal.mjs && python3 -m unittest tests.test_remote_terminal -v`
  - Expected: 全部用例 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add remote-terminal/src/web/url.ts remote-terminal/src/relay/header-rewrite.ts remote-terminal/src/web/server.ts remote-terminal/src/relay/ensure.ts remote-terminal/src/relay/devices.ts remote-terminal/src/relay/agent.ts remote-terminal/shell.zsh tests/test_remote_terminal.mjs tests/test_remote_terminal.py && git commit -m "fix(remote-terminal): 加固服务异常处理、锁原子性与背压控制"`

---

### Task 2: 修复 `deepseek-search` 代理隧道泄漏、超时作用域与连接复用

**Depends on:** `none`

**Files:**
- Modify: `plugins/deepseek-search/src/providers.ts:95-232`
- Create: `tests/test_deepseek_search.mjs`

**Interfaces:**
- Consumes: `plugins/deepseek-search/src/providers.ts` 现有 `ProviderFailure`、`REQUEST_TIMEOUT_MS`、`MAX_RESPONSE_BYTES`。
- Produces: 保持 `requestSearch(action, input)` 与 `ProviderFailure` 签名不变；导出 `postJson(provider, url, payload, headers, options?: { timeoutMs?: number; ca?: string | Buffer; proxyPort?: number })` 与 `getProxyTunnelAgent(proxyPort: number, options?: { ca?: string | Buffer; timeoutMs?: number })` 供本地 HTTPS 回归测试注入自签证书与短超时。

- [ ] **Step 1: 创建失败测试 `tests/test_deepseek_search.mjs`（本地自签 HTTPS，不访问公网）**
  - 测试辅助：用本机 `openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"` 在临时目录生成自签证书与私钥（或在无 openssl 时跳过并报错提示），启动本地 `node:https` 与假 HTTP `CONNECT` 代理服务器，覆盖 4 个用例：
    1. `direct fetch: timeout covers slow response body streaming`：本地 HTTPS 服务立即返回 `200` 响应头但永不结束 body，使用 `timeoutMs: 150` + 测试 `ca`（若 `fetch` 受限可验证经自定义 dispatcher 或 `NODE_EXTRA_CA_CERTS` 子进程）调用 `postJson` 读取响应，断言 600ms 内以 `ProviderFailure` 超时失败。
    2. `proxy tunnel: stalled TLS handshake after CONNECT 200 times out and destroys socket`：假代理回复 `HTTP/1.1 200 Connection Established\r\n\r\n` 后不再发送任何 TLS 数据，用 `timeoutMs: 150` 调用代理分支，断言 600ms 内超时 reject 且代理侧 socket 收到 `close` 事件不泄漏。
    3. `proxy tunnel: premature response close rejects promptly instead of hanging`：代理后端 HTTPS 服务返回 `200` + `Content-Length: 1000` 后仅发 5 字节即 `socket.destroy()`，断言 500ms 内立即 reject `ProviderFailure`。
    4. `proxy tunnel: getProxyTunnelAgent reuses agent per port with idle timeout`：相同端口两次获取返回同一实例，不同端口返回不同实例，测试结束调用 `agent.destroy()`。

- [ ] **Step 2: 运行测试确认失败**
  - Run: `node --test tests/test_deepseek_search.mjs`
  - Expected: FAIL（导出缺失 / 慢响应体超时失效 / TLS 握手挂死 / premature close 挂起）。

- [ ] **Step 3: 最小化实现 `plugins/deepseek-search/src/providers.ts`**
  - 用模块级 `Map<string, ProxyTunnelAgent>` 按端口（测试传入自定义 `ca`/`timeoutMs` 时不污染默认缓存池）复用 `getProxyTunnelAgent`，配置 `keepAlive: true`、`maxSockets: 8`、空闲 socket `timeout: 30_000`（防止复用已被对端关闭的连接触发 `ECONNRESET`）。
  - 在 `ProxyTunnelAgent.createConnection` 中：
    - 使用传入或默认的 `timeoutMs`（不再硬编码 30s），同时覆盖 `CONNECT` 阶段与 `tlsConnect` 握手阶段；
    - TLS 握手超时与 `tls.once("error")` 路径均显式 `tls.destroy()` 与 `socket.destroy()`，用 `settled` 守卫防止双回调；支持可选 `ca` 透传给 `tlsConnect`。
  - 在 `postJson` 中：
    - 改为内部带 `MAX_RESPONSE_BYTES` 上限读取并返回完整 `{ status, headers, body: Uint8Array }`（`requestProvider` 直接读 `response.body`，不再在 `finally { clearTimeout(timer); }` 之后再读流），确保 `clearTimeout(timer)` 仅在响应体完整读取或中止后才执行；直连非 2xx 分支同样及时 cancel/释放 body。
    - 代理分支将 `controller.signal` 绑定到 `httpsRequest`（`abort` 时销毁请求并 reject 超时）；在 `response` 上监听 `"aborted"` 与 `"close"`（若 `!response.complete && !ended` 立即 reject `响应流中断`）。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node --test tests/test_deepseek_search.mjs`
  - Expected: 4 pass / 0 fail，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add plugins/deepseek-search/src/providers.ts tests/test_deepseek_search.mjs && git commit -m "fix(deepseek-search): 修复代理隧道泄漏与全链路超时保护"`

---

### Task 3: 优化 `session-owner` 纯 Node 锁/读盘性能并收窄 `launcher.zsh` 的 `NODE_OPTIONS`

**Depends on:** `none`

**Files:**
- Modify: `pi/extensions/session-owner/registry.ts:170-265, 455-485`
- Modify: `pi/extensions/session-owner/contract.ts:227-238`
- Modify: `pi/launcher.zsh:15-35, 75-124`
- Create: `tests/test_pi_session_owner.mjs`
- Modify: `tests/test_pi_sync.py`

**Interfaces:**
- Consumes: `pi/extensions/session-owner/contract.ts`、`pi/extensions/session-owner/registry.ts`、`pi/scripts/pi-session-owner.ts`。
- Produces: 保持 `prepareLaunch`、`listLiveRecords`、`updateOwnRecord`、`readSessionHeaderBytes` 导出签名完全兼容；`createRegistryStore` 可选接受 `{ sleepMs?: (ms: number) => void; onGuardAttempt?: () => void }` 注入钩子供确定性单测退避行为。

- [ ] **Step 1: 编写失败测试**
  - 创建 `tests/test_pi_session_owner.mjs`：
    1. `prepareLaunch resolves reservation outside .guard lock`：传入延迟 120ms 的 `resolveReservation`，在其执行期间并发调用 `listLiveRecords(store)`，断言 `listLiveRecords` 在 <50ms 内成功返回。
    2. `acquireGuard reclaims dead-PID stale .guard across 3 concurrent child processes without breaking live lock`：预置含已死 PID（`99999999`）的 `.guard`，并行派生 **3 个独立子进程** 同时执行 `prepareLaunch`，断言全部成功完成且 `.guard` 最终被清理；另测试 `.guard` 为存活 PID 时不误删并按退避返回 `registry-busy`。
    3. `acquireGuard uses backoff instead of hot fsync spin`：持有效 `.guard` 时通过 `onGuardAttempt` 计数钩子调用 `prepareLaunch`（`guardTimeoutMs: 60`），断言重试次数 ≤ 10 次（远低于无退避热自旋）。
    4. `readSessionHeaderBytes reads first line in bounded bulk readSync loop`：创建 4KB 首行 + 多行正文的 JSONL 文件，验证返回 Buffer 精确等于首行含 `\n`，超过 `MAX_SESSION_HEADER_BYTES` 截断。
  - 在 `tests/test_pi_sync.py` 新增 2 个 `launcher.zsh` 测试：
    5. `test_launcher_node_script_receives_heap_flags_with_spaces_without_leaking_node_options`：用真实 `#!/usr/bin/env node` 假脚本（打印 `process.execArgv` 与其子进程 `NODE_OPTIONS`）配合含空格 `PI_HEAP_DIAGNOSTIC_DIR`，验证 Pi 自身通过 `execArgv` 收到 `--max-old-space-size` / `--heapsnapshot-near-heap-limit=2` / `--diagnostic-dir=<含空格路径>`，且下游子进程 `NODE_OPTIONS` 未被注入这些参数。
    6. `test_launcher_node_script_bypass_version_succeeds_under_no_unset`：用 `#!/usr/bin/env node` 假脚本执行 `launcher.zsh --version`（走 `:80` bypass 分支），断言退出码 0 且不报 `no_unset` / `parameter not set`。

- [ ] **Step 2: 运行测试确认新增用例失败**
  - Run: `node --test tests/test_pi_session_owner.mjs && python3 -m unittest tests.test_pi_sync -v`
  - Expected: 新增用例 FAIL，原有 `test_pi_sync` PASS。

- [ ] **Step 3: 最小化实现修复**
  1. `pi/extensions/session-owner/contract.ts:227-237`：
     - `readSessionHeaderBytes` 改为批量循环 `readSync(fd, buffer, total, buffer.length - total, total)`（兼容 POSIX 短读），每轮在新增区间检查 `indexOf(10)`，遇到 `\n`、EOF 或满 `MAX_SESSION_HEADER_BYTES` 即返回，将最多 16,384 次系统调用降至 1–2 次。
  2. `pi/extensions/session-owner/registry.ts`：
     - `prepareLaunch` 先在锁外执行 `const reservation = input.resolveReservation ? await input.resolveReservation() : input.reservation;`，再进入同步 `withGuard` 执行 `recordsLocked` + `conflict` + `publishLocked`。
     - `acquireGuard` 实现：
       - 若 `publishExclusivePrivate` 报 `EEXIST`，读取 `observed = privateJson(...)`：
         - 若 `observed?.protocol === GUARD_PROTOCOL && isDead(observed.pid)`：走 Global Constraints 的 **`.guard.reclaim` 回收互斥协议**（原子抢占 `.guard.reclaim` → 重读 `.guard` 确认 `ino` 与 `token` 未变且 `isDead(pid)` → `unlinkSync(.guard)` → 释放 `.guard.reclaim`），彻底消除 ABA 误删新锁。
         - 若持锁者存活：用退避休眠（默认 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)`，`5ms → 10ms → 20ms` 指数退避 + 抖动，截断至剩余 deadline；支持注入 `sleepMs` 钩子）后重试，彻底消除热自旋 `fsyncSync`。
  3. `pi/launcher.zsh:15-35, 75-124`：
     - 移除 `export NODE_OPTIONS=...` 全局导出。
     - 显式初始化 `local node_heap_mb="" heap_diagnostic_dir=""`（在 `no_unset` 下安全）；在 `_exec_pi` 中仅当 `[[ -n "${node_heap_mb:-}" && -n "${heap_diagnostic_dir:-}" ]]` 时才组装 `heap_flags=("--max-old-space-size=${node_heap_mb}" "--heapsnapshot-near-heap-limit=2" "--diagnostic-dir=${heap_diagnostic_dir}")`（bypass 分支与 `mkdir` 失败路径零报错）。
     - 在 `_exec_pi` 的 `*.js` 分支使用既有 `$node_bin` 执行 `exec "$node_bin" "${heap_flags[@]}" "$real_pi" "$@"`；若目标非 `*.js`，用 `IFS= read -r first_line < "$real_pi" || true`（防 `err_return` 中断）探测 `#!*node*` shebang，命中时同样通过 `"$node_bin" "${heap_flags[@]}" "$real_pi" "$@"` 执行；否则 `exec "$real_pi" "$@"`。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node --test tests/test_pi_session_owner.mjs && python3 -m unittest tests.test_pi_sync -v`
  - Expected: 全部用例 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add pi/extensions/session-owner/registry.ts pi/extensions/session-owner/contract.ts pi/launcher.zsh tests/test_pi_session_owner.mjs tests/test_pi_sync.py && git commit -m "fix(pi): 优化 session-owner 纯 Node 锁自愈与启动环境参数"`

---

### Task 4: 修复其余 Pi 扩展的内存泄漏、安全边界与热路径性能

**Depends on:** `none`

**Files:**
- Modify: `pi/extensions/compact-tools/status.ts:1-63`
- Modify: `pi/extensions/compact-tools/compact-tools.ts:1-20`
- Modify: `pi/extensions/security-gates/shell-policy.ts:95-120, 245-270, 315-330`
- Modify: `pi/extensions/endpoint-fallback/index.ts:75-90`
- Modify: `pi/extensions/openai-proxy/index.ts:95-155`
- Modify: `pi/extensions/bash-cwd/extension.ts:1-45`
- Test: `tests/test_pi_extensions.mjs`

**Interfaces:**
- Consumes: 各扩展既有内部模块接口（不引入 `pi-coding-agent` 值导入到可单测模块）。
- Produces:
  - `compact-tools/status.ts` 导出 `clearAllStatusAnimations(): void`，`syncStatusAnimation` 支持可选 `{ now?: () => number; maxLifetimeMs?: number }` 供确定性时钟测试；
  - `bash-cwd/extension.ts` 导出 `createCachedBashOptions(getBashOptions, options?: { ttlMs?: number; maxEntries?: number })` 并接管执行期查询缓存。

- [ ] **Step 1: 在 `tests/test_pi_extensions.mjs` 编写失败测试**
  1. `compact-tools: orphaned loading timer stops on maxLifetime expiry and clearAllStatusAnimations`：注入可变时钟 `now` 与短 `maxLifetimeMs: 250`，启动 loading 动画不进入终态，推进时钟超过上限断言停止重绘；再测试 `clearAllStatusAnimations()` 立即清理所有活跃定时器且挂接 `session_shutdown`。
  2. `security-gates: nested sh -c exceeding depth limit is blocked and non-string sensitive path fails closed`：用程序化引号嵌套构造 10 层 `sh -c` 包裹无害命令 `echo ok`，断言被保守拦截；向 `checkSensitivePath` 传入 `{ path: 123 }` / `{ path: null }` 断言返回 `SENSITIVE_PATH_UNCERTAIN`（fail-closed）且不抛 `TypeError`。
  3. `endpoint-fallback: defaultProbe cancels response body after checking status`：mock `fetch` 返回带 spy `body.cancel()` 的响应，断言探活后 `body.cancel()` 被调用一次（保留原有 `prepareForRequest` 首轮同步探活与“零后台轮询”契约不变）。
  4. `openai-proxy: re-applying proxy config updates delegate target and closes previous ProxyAgent`：先后以两个不同代理 URL 初始化，断言旧 `ProxyAgent.close()` 被调用且后续请求路由到新代理。
  5. `bash-cwd: createCachedBashOptions caches lookup per (cwd, projectTrusted)`：经 `extension.ts` 连续两次同参数调用仅触发一次底层 `getBashOptions`。

- [ ] **Step 2: 运行测试确认新增用例失败**
  - Run: `node --test tests/test_pi_extensions.mjs`
  - Expected: 新增用例 FAIL，原有 11 个用例 PASS。

- [ ] **Step 3: 最小化实现修复**
  1. `pi/extensions/compact-tools/status.ts` & `compact-tools.ts`：
     - 维护活跃 timer 集合，回调内用 `new WeakRef(context)` 解包并在引用丢失或超过默认最长寿命 `DEFAULT_MAX_SPINNER_LIFETIME_MS = 30 * 60 * 1000`（30 分钟，兼顾长耗时工具同时防止永久泄漏）时自动 `clearInterval`；导出 `clearAllStatusAnimations()` 并在 `compact-tools.ts` 订阅 `session_shutdown` 与 `session_before_switch` 时调用。
  2. `pi/extensions/security-gates/shell-policy.ts`：
     - 为 `containsSleepCommand` 与 `checkShellWrapper` 增加 `depth = 0` 与 `MAX_WRAPPER_DEPTH = 8`，超深时保守判定为命中拦截。
     - `checkSensitivePath` 对待检路径字段校验：若存在非空且非字符串值，直接 fail-closed 返回 `SENSITIVE_PATH_UNCERTAIN`，不抛 `TypeError` 也不误放行。
  3. `pi/extensions/endpoint-fallback/index.ts`：
     - `defaultProbe` 读取 `res.status` 后始终 `await res.body?.cancel().catch(() => {})` 释放连接（不动 `prepareForRequest` 同步故障切换语义）。
  4. `pi/extensions/openai-proxy/index.ts`：
     - 在 `target` 上挂可变委托状态槽（记录当前 `fetchImpl` 与旧 `ProxyAgent` 关闭句柄），再次配置时替换委托实现并异步关闭旧 `ProxyAgent`（吞掉关闭错误），实现热更新且无 `ProxyAgent` 泄漏。
  5. `pi/extensions/bash-cwd/extension.ts`：
     - 实现 `createCachedBashOptions(getBashOptions, { ttlMs = 5000, maxEntries = 32 })`，在 `extension.ts` 内对 `getDefaultBashOptions` 做短 TTL 缓存（不改 `bash-cwd.ts` 对 `pi-coding-agent` 的导入结构）。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node --test tests/test_pi_extensions.mjs`
  - Expected: 全部用例 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add pi/extensions/compact-tools/status.ts pi/extensions/compact-tools/compact-tools.ts pi/extensions/security-gates/shell-policy.ts pi/extensions/endpoint-fallback/index.ts pi/extensions/openai-proxy/index.ts pi/extensions/bash-cwd/extension.ts tests/test_pi_extensions.mjs && git commit -m "fix(pi): 修复扩展定时器泄漏、递归深度边界与热路径缓存"`

---

### Task 5: 加固 `home-connect` 进程终止/流缓冲、HTTP 安全边界与 LAN 探测性能

**Depends on:** `none`

**Files:**
- Create: `plugins/home-connect/src/http-guards.ts`（零第三方依赖、无顶层副作用：导出 `isAuthorizedHeader`、`readBoundedJsonBody`、`LruSessionStore`）
- Modify: `plugins/home-connect/src/connection.ts:35-190, 215-245`
- Modify: `plugins/home-connect/src/server-http.ts:50-240`
- Modify: `plugins/home-connect/src/tools-comfyui.ts:255-305`
- Modify: `plugins/home-connect/scripts/connect.sh:30-46`
- Modify: `plugins/home-connect/scripts/mac.sh:75-98, 185-210`
- Test: `tests/test_home_connect_async.mjs`
- Create: `tests/test_home_connect_http.mjs`

**Interfaces:**
- Consumes: `plugins/home-connect/src/connection.ts`、`server-http.ts`、`tools-comfyui.ts`。
- Produces:
  - `plugins/home-connect/src/http-guards.ts` 导出 `isAuthorizedHeader(given: string | undefined, expectedApiKey: string): boolean`、`readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown>`（超限抛 `PayloadTooLargeError`）、`LruSessionStore<T extends { close?: () => Promise<void> | void }>`；
  - `connection.ts` 导出 `invalidateLanCache()`，并允许 `run`/`settle` 接受可选 `maxCaptureBytes`；
  - 保持所有 MCP 工具名、参数及 `HOST_MODE` 分支语义不变。

- [ ] **Step 1: 编写失败测试**
  - 在 `tests/test_home_connect_async.mjs` 新增测试：
    1. `settle escalates SIGTERM to SIGKILL for signal-ignoring child and clears inner timer on normal exit`：启动忽略 `SIGTERM` 的子进程（`trap '' TERM; sleep 30`）配合 `timeoutSec: 1`，断言 6s 内被 `SIGKILL` 终止返回 `timedOut: true`；另起正常秒退子进程验证无残留内层定时器。
    2. `settle decodes split multi-byte UTF-8 cleanly and caps runaway stdout`：子进程把 3 字节中文 UTF-8 拆分在不同 chunk 输出，断言无 `U+FFFD` 乱码；超限输出触发运行期截断而不无界增长。
    3. `mac.sh status cleans previous temp files instead of leaking`：在隔离 `TMPDIR` 下准备假 `ssh` 桩（不 `source mac.sh`），运行 `bash plugins/home-connect/scripts/mac.sh status`，断言退出后 `TMPDIR` 中残留 0 个 `home-mac-err.*` 文件。
  - 创建 `tests/test_home_connect_http.mjs`（仅导入零依赖的 `plugins/home-connect/src/http-guards.ts`，不触发 MCP SDK 导入或 `host.json` 顶层读取）：
    4. `isAuthorizedHeader handles multi-byte UTF-8 of same JS string length without throwing RangeError`：传入与 `Bearer <ascii-key>` 字符数相等但含中文字符的 header，断言返回 `false` 而不抛错。
    5. `readBoundedJsonBody rejects chunked body exceeding maxBytes with 413 error and parses valid body`：用原生 `node:http` 发送无 `Content-Length` 的 chunked 请求（分别测合法 JSON 与超限载荷），断言合法时返回解析对象供 `transport.handleRequest(req, res, parsedBody)` 使用，超限时抛 `PayloadTooLargeError`（对应 413）。
    6. `LruSessionStore refreshes access order on get and closes evicted session`：容量为 2，依次插入 A、B，访问 A 刷新 LRU 后插入 C，断言被淘汰的是 B 且 `B.close()` 被调用。

- [ ] **Step 2: 运行测试确认失败**
  - Run: `node tests/test_home_connect_async.mjs && node --test tests/test_home_connect_http.mjs`
  - Expected: 新增用例 FAIL，原有 `test_home_connect_async.mjs` 用例 PASS。

- [ ] **Step 3: 最小化实现修复**
  1. `plugins/home-connect/src/connection.ts`：
     - `stopChild(child, signal: NodeJS.Signals = "SIGTERM")`：超时回调先发 `SIGTERM`，保存 `forceKillTimer = setTimeout(() => stopChild(child, "SIGKILL"), 2_000)`，在 `close` 与 `error` 回调里同时 `clearTimeout(killTimer)` 和 `clearTimeout(forceKillTimer)`。
     - 使用 `new StringDecoder("utf8")` 解码 `stdout`/`stderr`（在 `close` 时 `.end()` flush 尾字节），并加运行期字节上限：默认 `4 * 1024 * 1024`（4MB，保障 ComfyUI 大 `/object_info` JSON 完整不被误截断，同时阻断无限 OOM；`comfyCurl` 可按需传入更大上限或复用 8MB）。
     - `lanAvailable()` 增加 8s TTL 缓存**并缓存进行中的 in-flight Promise**（防止 `comfyuiList` 的 `Promise.all` 同时发出 4 次探测），在 `resetHomeConnect()` 清空；调用 `connect.sh` 时透传 `HOME_CONNECT_LAN_STATE=available|unavailable`。
  2. `plugins/home-connect/scripts/connect.sh`：
     - `wsl` 分支检查 `${HOME_CONNECT_LAN_STATE:-}`：为 `available` 时跳过重复 `"$LAN" require`，为 `unavailable` 时直接报错返回，未设置时保留原 `"$LAN" require` 逻辑。
  3. `plugins/home-connect/scripts/mac.sh`：
     - `new_errtmp()` 在生成新 `mktemp` 前先 `[ -n "${errtmp:-}" ] && rm -f "$errtmp"`。
  4. `plugins/home-connect/src/tools-comfyui.ts`：
     - `comfyuiList()` 对 4 个 `/object_info/*` 节点用 `Promise.all` 并发拉取（依赖上面的 in-flight LAN 缓存，仅探测一次 LAN；保留 `HOST_MODE` 路径与单节点容错）。
  5. 新建 `plugins/home-connect/src/http-guards.ts` 并接入 `plugins/home-connect/src/server-http.ts`：
     - `authorized()` 改为调用 `isAuthorizedHeader`（先转 `Buffer.from` 再比较字节长度 + `timingSafeEqual`）。
     - POST 请求先由 `readBoundedJsonBody(req, MAX_BODY_BYTES)` 带字节上限完整读取并解析 JSON（超限回 `413`、非法 JSON 回 `400`），再调用 `await session.transport.handleRequest(req, res, parsedBody)`，避免与 SDK 抢读请求流；非 POST 请求仍直接 `handleRequest(req, res)`。
     - `createSession` 改为 `async` 并 `await server.connect(transport)`；用 `LruSessionStore` 管理会话，命中时刷新时间戳，淘汰时调用旧会话 `transport.close()` 与 `server.close()`。
     - `audit()` 改用 `appendFile`（`fs/promises`），`withImages()` 改用 `async` + `stat`/`readFile`（`fs/promises`）。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node tests/test_home_connect_async.mjs && node --test tests/test_home_connect_http.mjs`
  - Expected: 全部用例 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add plugins/home-connect/src/http-guards.ts plugins/home-connect/src/connection.ts plugins/home-connect/src/server-http.ts plugins/home-connect/src/tools-comfyui.ts plugins/home-connect/scripts/connect.sh plugins/home-connect/scripts/mac.sh tests/test_home_connect_async.mjs tests/test_home_connect_http.mjs && git commit -m "fix(home-connect): 加固超时强杀、HTTP 边界与 LAN 探测性能"`

---

### Task 6: 加固 `pi-worker` 锁回收、生命周期收尾与全链路性能

**Depends on:** `none` *(并行 worktree 需前置软链 `plugins/pi-worker/ui-src/node_modules`)*

**Files:**
- Modify: `plugins/pi-worker/src/protocol.ts:230-270`
- Modify: `plugins/pi-worker/src/store.ts:265-290, 535-620, 680-708`
- Modify: `plugins/pi-worker/src/runner.ts:415-475, 530-655, 905-940`
- Modify: `plugins/pi-worker/src/stream.ts:515-565`
- Modify: `plugins/pi-worker/src/worker-ext.ts:75-115, 260-285`
- Modify: `plugins/pi-worker/src/server.ts:400-455`
- Modify: `plugins/pi-worker/ui-src/app.tsx:490-530, 710-735`
- Modify: `plugins/pi-worker/ui/monitor.html`（由 `build.mjs` 生成）
- Test: `tests/test_pi_worker_store.mjs`, `tests/test_pi_worker_runner.mjs`, `tests/test_pi_worker_stream.mjs`, `tests/test_pi_worker_ext.mjs`, `tests/test_pi_worker_mcp.mjs`, `tests/test_pi_worker_app_ui.mjs`

**Interfaces:**
- Consumes: `plugins/pi-worker/src/protocol.ts`、`store.ts`、`stream.ts`。
- Produces:
  - `protocol.ts` 新增导出 `readSteerEntriesFromOffset(steerPath: string, offset: number): { entries: SteerEntry[]; nextOffset: number }`（只消费到最后一个 `\n`，半行留待下一轮；保留原 `readSteerEntries` 兼容）；
  - `LockPayload` 可选新增 `token?: string`、`ownerSignature?: string`，`TaskRecord` 可选新增 `pidSignature?: string`（统一字段名，向后兼容旧记录）；
  - `ui-src/build.mjs` 重新构建 `ui/monitor.html` 满足 `test_pi_worker_app_ui.mjs` 全部断言。

- [ ] **Step 1: 在现有 `tests/test_pi_worker_*.mjs` 编写失败测试**
  1. `test_pi_worker_store.mjs`：
     - `createLockExclusive` 原子临时文件+`link` 发布 + `<lock>.reclaim` 回收互斥：模拟陈旧锁并发回收及 0 字节损坏锁（仅 `mtime > 2s` 才回收）不误删活锁；
     - `ownerSignature` 不匹配（仅基于 `lstart` 指纹）时判定 PID 复用并安全回收；
     - `list()` 缓存键含 `(ino, mtimeMs, size)`，命中缓存时不重复解析历史终态任务文件。
  2. `test_pi_worker_runner.mjs`：
     - `spawn` 后 `store.save` 抛错时，子进程被终止且 `cwd` 写锁被释放；
     - 子任务派生继承 stdout 的后台孙进程（`sleep 10 &`）且主进程立即退出时，`exit` 宽限到期后先 `kill(-pid, "SIGKILL")` 杀掉残留孙进程组再完成 `finalize` 与释放 `cwd` 写锁；
     - 跨进程 `cancel` 在 `pidSignature` 不匹配时拒绝向无关进程组发 `SIGTERM`/`SIGKILL`。
  3. `test_pi_worker_ext.mjs`：
     - 验证 `readSteerEntriesFromOffset` 增量读取只解析完整行（半行不推进 `nextOffset`），且文件截断（`size < offset`）时自动归零。
  4. `test_pi_worker_mcp.mjs`：
     - 验证 `conversationTitleCache` 失败返回 `null` 后在短过期后可重新获取成功，且受 LRU 容量上限（256）控制。
  5. `test_pi_worker_app_ui.mjs`：
     - 验证 `ui/monitor.html` 通过全部现有尺寸/文案断言，且 `app.tsx` 对前端保留事件数组施加滑动窗口上限（`MAX_UI_EVENTS = 2000`）。

- [ ] **Step 2: 运行测试确认新增用例失败**
  - Run: `for t in tests/test_pi_worker_*.mjs; do node "$t" || echo "FAILED: $t"; done`
  - Expected: 新增用例 FAIL，原有 7 个测试文件基线用例 PASS。

- [ ] **Step 3: 最小化实现修复并重建 UI**
  1. `plugins/pi-worker/src/store.ts`：
     - 实现进程启动时间指纹 `getProcessSignature(pid: number): string | null`：执行 `LC_ALL=C TZ=UTC ps -p <pid> -o lstart=` 并 trim（**不含 `comm`**，可注入测试 stub）；仅在写锁/落盘、回收陈旧锁与跨进程 `cancel` 时调用，**不放入 `status`/`list` 的 `isPidAlive` 热路径**。
     - `createLockExclusive` 改为写私有临时文件（含 `token`、`ownerSignature`）+ `linkSync(tmp, lockPath)` 原子发布，消除 0 字节窗口。
     - `acquireCwdLock` 陈旧锁与损坏锁（要求 `mtime > 2s` 宽限）全部走 Global Constraints 的 `<lockPath>.reclaim` 回收互斥，重读校验 `ino`+`token`+死 PID（或 `ownerSignature` 不匹配）后再 `unlinkSync`。
     - `list()` 增加按 `filename → { ino, mtimeMs, size, record }` 的内存缓存，非 `running` 终态记录在 `(ino, mtimeMs, size)` 未变时直接复用缓存。
  2. `plugins/pi-worker/src/runner.ts` & `stream.ts`：
     - `launchRound` 中 `spawn` 后的 `store.save(record)` 与流创建包入 `try/catch`，异常时强杀进程组、关闭流、清理 `inFlight`/`active` 并释放写锁。
     - 监听 `child.on("exit")` 与 `child.on("close")`：`exit` 后启动 1500ms 管道排空宽限，若孙进程霸占管道未触发 `close`，到期先 `kill(-child.pid, "SIGKILL")` 清除残留孙进程组（防止释锁后继续写 `cwd`）、`destroy()` stdio 管道并触发 `finalize`；`finalize` 中 `logStream.end` 与 `eventsStream.end` 均包 1000ms 超时兜底。
     - 本进程运行态 steer 事件经活跃 runner 的 `eventsStream` 写入，避免与 `appendFileSync` 混写；跨进程 steer 沿用 `appendSteerEvent`。
     - 跨进程 `cancel` 在发信号前核验 `record.pidSignature`（与当前 `getProcessSignature(targetPid)` 不匹配时不发信号，仅标记取消并释锁）。
     - 启动子进程前从 `childEnv.NODE_OPTIONS` 剥离 `--heapsnapshot-near-heap-limit` / `--diagnostic-dir` 等诊断参数。
  3. `plugins/pi-worker/src/protocol.ts` & `worker-ext.ts`：
     - 实现 `readSteerEntriesFromOffset(steerPath, offset)`：`statSync` 判 `size === offset` 零读返回、`size < offset` 归零，读增量区间后只解析到最后一个 `\n`（`nextOffset` 停在最后换行符后，半行留待下一轮）；`worker-ext.ts` 维护 `steerOffset`。
  4. `plugins/pi-worker/src/server.ts`：
     - `conversationTitleCache` 改为容量 256 的 LRU Map：有效标题缓存 30 分钟，`null` 失败缓存 15 秒。
  5. `plugins/pi-worker/ui-src/app.tsx` & `ui/monitor.html`：
     - 前端事件数组按 `MAX_UI_EVENTS = 2000` 截断保留最新窗口，用 `useMemo` 避免无关重渲染重复归约。
     - 运行 `node plugins/pi-worker/ui-src/build.mjs` 重新生成 `plugins/pi-worker/ui/monitor.html`。

- [ ] **Step 4: 运行全量 7 个 `pi-worker` 测试文件验证通过**
  - Run: `node plugins/pi-worker/ui-src/build.mjs && for t in tests/test_pi_worker_*.mjs; do node "$t" || exit 1; done`
  - Expected: 全部 7 个测试文件 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add plugins/pi-worker/src/protocol.ts plugins/pi-worker/src/store.ts plugins/pi-worker/src/runner.ts plugins/pi-worker/src/stream.ts plugins/pi-worker/src/worker-ext.ts plugins/pi-worker/src/server.ts plugins/pi-worker/ui-src/app.tsx plugins/pi-worker/ui/monitor.html tests/test_pi_worker_*.mjs && git commit -m "fix(pi-worker): 加固锁回收、退出收尾与增量事件读取性能"`

---

### Task 7: 修复 `playwright` 启动超时孤儿清理、枚举隔离与崩溃租约自愈

**Depends on:** `none`

**Files:**
- Modify: `plugins/playwright/src/runtime/lifecycle.ts:104-210`
- Create: `tests/test_playwright_runtime.mjs`

**Interfaces:**
- Consumes: `plugins/playwright/src/runtime/contracts.ts`。
- Produces: 保持 `startRuntime`、`getRuntimeStatus`、`listRuntimeInstances`、`sendRuntimeCommand`、`stopRuntime`、`serveRuntime` 全部签名与 `owner.json`/`ready.json` 既有字段不变；`owner.json` 增量追加可选 `daemonPid` / `daemonSignature`（仅基于 `LC_ALL=C TZ=UTC ps -o lstart=`）。

- [ ] **Step 1: 创建失败测试 `tests/test_playwright_runtime.mjs`（无需真实 Chrome）**
  - 使用 `mkdtemp` 沙箱 + 假 daemon 脚本 / 假 `BrowserAdapter`：
    1. `startRuntime startup timeout waits for SIGTERM/SIGKILL termination before rejecting`：假 daemon 收到 `{ cancel: true }` 后忽略并挂起，调用 `startRuntime`（`startupTimeoutMs: 200`），断言在 reject `startup-timeout` **之时** 假 daemon 已确实终止（`kill(pid, 0)` 立即 `ESRCH`，不依赖 `unref` 异步定时）。
    2. `listRuntimeInstances skips dotfiles and isolates broken/dead instance directories with warning`：在 `stateRoot` 放 `.DS_Store`、一个损坏 `ready.json` 目录与一个健康实例，断言 `listRuntimeInstances` 返回健康实例数组而非抛错。
    3. `serveRuntime safely reclaims stale instance dir and .sdk-lease from dead daemon via reclaim mutex, and preserves live/unknown leases`：
       - 预置含已死 `daemonPid` 的 `instances/<name>/owner.json` 与 `profile/.sdk-lease/owner.json`，调用 `serveRuntime`（假 adapter），断言自动安全回收后成功启动且 `stopRuntime` 清理干净；
       - 预置缺失/损坏 `owner.json` 或指向存活 `daemonPid`（或 named profile 下 `SingletonLock` 指向存活 PID）时，断言保守抛出 `instance-in-use` / `profile-in-use`。

- [ ] **Step 2: 运行测试确认失败**
  - Run: `node --test tests/test_playwright_runtime.mjs`
  - Expected: 3 个新增用例 FAIL。

- [ ] **Step 3: 最小化实现 `plugins/playwright/src/runtime/lifecycle.ts`**
  1. `startRuntime` 超时处理（L119-L130）：
     - 超时后先发 `{ cancel: true }` 并等待短暂退出宽限（300ms），若 `child.exitCode === null && child.signalCode === null` 则通过 `child.kill("SIGTERM")`（并尝试 `-child.pid`）再等 500ms，仍未退出升级 `child.kill("SIGKILL")` 并等待 `exit`（上限 500ms），**确认子进程收尾后再 `finish(new RuntimeFault('browser', 'startup-timeout'))`**，避免短命 CLI 提前退出导致升级逻辑不执行。
  2. `listRuntimeInstances`（L135-L140）：
     - 跳过 `.` 开头点文件（如 `.DS_Store`）；
     - 对单实例 `safeName(name)` + `getRuntimeStatus(...)` 做 `try/catch` 隔离；若遇到 `unsafe-*` 等异常，向 `console.error` 记录告警日志后跳过（不静默掩盖篡改，也不拖垮健康实例枚举）。
  3. `serveRuntime` 崩溃租约安全自愈（L187-L195）：
     - `owner.json` 写入时追加 `daemonPid: process.pid` 与 `daemonSignature`（`LC_ALL=C TZ=UTC ps -p <pid> -o lstart=`）。
     - `mkdir(directory)` 或 `mkdir(lease)` 报 `EEXIST` 时：走 Global Constraints 的 `.reclaim` 回收互斥，重读既有 `owner.json`（缺失或 JSON 解析失败一律保守按 `in-use` 处理）；仅当存在有效 `daemonPid` 且确认进程已死（`ESRCH` 或 `daemonSignature` 不匹配）、对应 socket 探活报 `ENOENT`/`ECONNREFUSED`、且对 named profile 额外核查 `SingletonLock` 目标 PID（若存在）也已死时，才安全移除陈旧目录并重试一次 `mkdir`。

- [ ] **Step 4: 运行测试验证通过**
  - Run: `node --test tests/test_playwright_runtime.mjs`
  - Expected: 3 pass / 0 fail，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add plugins/playwright/src/runtime/lifecycle.ts tests/test_playwright_runtime.mjs && git commit -m "fix(playwright): 修复启动超时孤儿进程、枚举隔离与崩溃租约回收"`

---

### Task 8: 加固 Python 锁/进程管理与 AGY Hook 热路径优化

**Depends on:** `none`

**Files:**
- Modify: `.agents/skills/pi-manage-provider/manage-providers.py:65-115, 198-225, 289-297`
- Modify: `qwen/extensions/codex-proxy/scripts/manager.py:20-230`
- Modify: `init-agy.sh:270-330`
- Modify: `agy/hooks/pi-worker-session-injector.py:15-105`
- Test: `tests/test_pi_manage_provider.py`
- Test: `tests/test_qwen_routing.py`
- Test: `tests/test_agy_sync.py`
- Create: `tests/test_codex_proxy.py`

**Interfaces:**
- Consumes: Python 标准库 `fcntl`、`shlex`、`tempfile`、`subprocess`。
- Produces:
  - `manage-providers.py` 保留 `_models_lock` 名称（底层改 `fcntl.flock` 并保护 `models.json` 与 `auth.json`）；
  - `init-agy.sh` 生成的 `hooks.json` 保留既有三个 `matcher`、`timeout: 5` 与脚本绝对路径（用 `shlex.quote` 安全拼装快过滤命令）；
  - `pi-worker-session-injector.py` 保留 `inject_pi_worker_session(payload)` 签名与 fail-open 语义。

- [ ] **Step 1: 编写失败测试（全隔离，绝不触碰真实 `HOME`/`TMPDIR`/端口 8317）**
  - `tests/test_pi_manage_provider.py`：
    1. `test_models_lock_uses_flock_and_recovers_after_crash`：预留已存在 `.models.json.lock` 空文件，验证 `_models_lock()` 立即获取锁而不阻塞；同时验证跨进程 `flock` 真实互斥。
    2. `test_remove_provider_and_set_key_serialize_auth_json`：验证 `cmd_set_key`（先读 TTY 再拿锁）与 `cmd_remove_provider` 均在单次 `_models_lock()` 保护下更新 `auth.json` / `models.json` 且不重入死锁。
  - 创建 `tests/test_codex_proxy.py`（**全部通过独立子进程执行，显式设置 `HOME=<tmp>`、动态空闲端口 `CODEX_PROXY_API_PORT`、并在 `PATH` 最前放置假 `cliproxyapi` 可执行桩**，严禁触碰真实 `~/.qwen/codex-proxy` 或端口 8317）：
    3. `test_ensure_running_exits_early_when_process_crashes`：假 `cliproxyapi` 立即 `exit 1`，运行 `manager.py register`，断言 <1.5s 快速结束而非空等 10s。
    4. `test_stop_proxy_verifies_process_identity_escalates_sigkill_and_rotates_log`：验证 `pid` 对应无关进程时不误杀；对忽略 `SIGTERM` 的假 `cliproxyapi` 升级 `SIGKILL`；验证 `status` 不在锁外创建/覆写配置；验证 >5MB `proxy.log` 启动前轮转为 `proxy.log.1`。
  - `tests/test_agy_sync.py`：
    5. `test_git_commit_guard_shell_fast_path_skips_python_and_catches_obfuscated_git`：执行 `init-agy.sh` 生成的 hook `command`：
       - 普通非 git 命令（如 `ls -la`，不含 `git`/`\`/`'`）把 `PATH` 中 `python3` 替换为失败桩仍直接返回 `{"decision":"allow"}`；
       - 混淆绕过命令 `g''it commit -m bad` 与 `gi\t commit -m bad` **必须命中 Python guard 并被拦截**（不走快放行）。
    6. `test_pi_worker_injector_fast_path_and_title_cache`：非 `pi_worker_start`/`pi_worker_monitor` 的 `call_mcp_tool` 零 Python 启动直接放行；同一 `(address, conversationId)` 第二次调用命中 `AGY_TITLE_CACHE_PATH` 缓存不再发 HTTP 请求（同时为现有 `test_pi_worker_session_injector_title_injection` 设置临时 `AGY_TITLE_CACHE_PATH` 避免污染真实 `TMPDIR`）。

- [ ] **Step 2: 运行测试确认新增用例失败**
  - Run: `python3 -m unittest tests.test_pi_manage_provider tests.test_qwen_routing tests.test_agy_sync tests.test_codex_proxy -v`
  - Expected: 新增用例 FAIL，原有基线测试 PASS。

- [ ] **Step 3: 最小化实现修复**
  1. `.agents/skills/pi-manage-provider/manage-providers.py`：
     - 保留 `_models_lock()` 名称，改用持久锁文件 `.models.json.lock`（`0o600`）+ `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` 带 10s deadline 短暂轮询（永不 `unlink` 锁文件，退出时 `LOCK_UN` + `close(fd)`）。
     - `cmd_set_key` **先读取 TTY 输入**，再进入 `_models_lock()` 读取/更新/保存 `auth.json`（不持锁等人类输入）。
     - `cmd_remove_provider` 将整个读取/删除 `auth.json` + `_save_models_json` + 异常回滚纳入单次 `_models_lock()` 临界区（避免调用嵌套加锁的 `_update_models` 导致同进程自锁）。
  2. `qwen/extensions/codex-proxy/scripts/manager.py`：
     - 移除 `main()` 中无条件锁外调用 `gen_config()`，仅在持锁启动路径以临时文件 + `os.replace` 原子生成配置。
     - `ensure_running()` 等待端口循环中每轮检查 `if proc.poll() is not None: break` 立即中止；PID 状态同步记录 `LC_ALL=C TZ=UTC ps -p <pid> -o lstart=` 指纹。
     - `stop_proxy()` 与 `watchdog()` 发信号前先校验进程启动指纹（兼容无指纹旧 PID 文件时回退 `ps -o args=` 含 `cliproxyapi` 校验）；`stop_proxy()` 在 `SIGTERM` 等待宽限后若仍存活则升级 `SIGKILL`。
     - 启动前若 `proxy.log` 超过 5MB，原子轮转到 `proxy.log.1`。
  3. `init-agy.sh` & `agy/hooks/pi-worker-session-injector.py`：
     - `init-agy.sh` 使用 `shlex.quote` 安全拼装 `sh -c` 快过滤命令，保持三个 `matcher`、脚本绝对路径与 `timeout: 5` 不变：
       - `git-commit-guard` 快放行条件：**仅当 `body` 同时不含 `git`、不含反斜杠 `\`、不含单引号 `'` 时** 才直接输出 `{"decision":"allow"}\n` 跳过 Python（确保 `g''it`、`gi\t`、含转义双引号 `\"` 的命令全部进入 Python guard，零安全降级；注：因 JSON 含 `lastUserInput`/`workspacePaths`，实际命中率取决于上下文文本，但常规命令仍可免 Python 启动）。
       - `pi-worker-session-injector` 快放行条件：不含 `pi_worker_start` 且不含 `pi_worker_monitor` 时直接输出 `{"decision":"allow"}\n`。
       - 命中时统一用 `printf '%s\n' "$body" | python3 <quoted_script>`。
     - `agy/hooks/pi-worker-session-injector.py` 增加本地 TTL 缓存：默认路径放私有 `0700` 目录（`~/.cache/harness-config/agy-pi-worker-title-cache.json`，支持 `AGY_TITLE_CACHE_PATH` 覆盖），读写使用 `O_NOFOLLOW` + 同目录临时文件原子 `os.replace`（`0o600`），有效标题缓存 300s、失败 `None` 缓存 30s、上限 128 条，任何异常静默降级。

- [ ] **Step 4: 运行全部相关 Python 测试验证通过**
  - Run: `python3 -m unittest tests.test_pi_manage_provider tests.test_qwen_routing tests.test_agy_sync tests.test_codex_proxy -v`
  - Expected: 全部用例 PASS，exit code 0。

- [ ] **Step 5: Commit**
  - Run: `git add .agents/skills/pi-manage-provider/manage-providers.py qwen/extensions/codex-proxy/scripts/manager.py init-agy.sh agy/hooks/pi-worker-session-injector.py tests/test_pi_manage_provider.py tests/test_qwen_routing.py tests/test_agy_sync.py tests/test_codex_proxy.py && git commit -m "fix(hooks,scripts): 加固 Python 文件锁、代理进程管理与 hook 快过滤"`

---

## Whole-Branch Final Verification

全部 Task 合并到特性分支后，运行全仓回归套件确认零回归：

```bash
node --test tests/test_remote_terminal.mjs tests/test_deepseek_search.mjs tests/test_pi_session_owner.mjs tests/test_pi_extensions.mjs tests/test_home_connect_http.mjs tests/test_playwright_runtime.mjs && \
node tests/test_home_connect_async.mjs && \
for t in tests/test_pi_worker_*.mjs; do node "$t" || exit 1; done && \
python3 -m unittest tests.test_remote_terminal tests.test_pi_sync tests.test_pi_manage_provider tests.test_qwen_routing tests.test_agy_sync tests.test_codex_proxy -v
```

---

## Independent Plan Review Record

- **Reviewer**：`plan-reviewer`（Swarm `claude-opus-5-5-high`，只读审查）
- **关键修订（全部 C1–C11 与 S1–S11 已吸收落盘）**：
  - C1/C10：统一用临时文件 + `link` 原子发布 + `<lock>.reclaim` 回收互斥，根除陈旧锁 `rename` ABA 竞态与 `pi-worker` 0 字节窗口；
  - C2：`launcher.zsh` 适配 `no_unset`/`err_return` 与 `$node_bin`，补 `#!/usr/bin/env node` 的 `--version` bypass 测试；
  - C3：`git-commit-guard` 快过滤收紧为“不含 `git` 且不含 `\` 且不含 `'`”才放行，防 `g''it`/`gi\t` 绕过；
  - C4：`test_codex_proxy.py` 强制子进程隔离 `HOME`/空闲端口/假 `cliproxyapi` 桩，避免影响真实代理；
  - C5/C6/C7：`remote-terminal` 与 `home-connect` 抽离零第三方依赖纯模块供本地单测；`server-http.ts` 改为带上限完整读解析 JSON 后传 `parsedBody` 给 `transport.handleRequest` 避免抢读流；
  - C8：`deepseek-search` 测试使用本地自签 HTTPS 与 `{ timeoutMs, ca }` 接缝并测 `CONNECT 200` 后 TLS 挂起；
  - C9：进程指纹统一用 `LC_ALL=C TZ=UTC ps -o lstart=`（去 `comm` 防 Pi `process.title` 误判）并统一字段名；
  - C11：补充并行 worktree 软链 `node_modules` 前置准备；
  - S1–S11 & Minor：逐条合入（`session-owner` 多进程竞态测与循环 `readSync`、`bash-cwd` 缓存放 `extension.ts`、`compact-tools` 挂 `session_shutdown` 与可注入时钟、`endpoint-fallback` 保留同步首轮探活、`security-gates` 非字符串 fail-closed、`pi-worker` 释锁前杀孙进程组/半行不推进偏移/缓存加 `ino`/热路径不 spawn `ps`、`playwright` 先确认终止再 reject 并检 `SingletonLock`、`home-connect` 缓存 in-flight Promise 与 4MB 默认上限、`title` 缓存落私有目录 `O_NOFOLLOW`、`shell.zsh` `emulate -L zsh` 与 `agent.pid`、`deepseek` keepAlive idle timeout、`manage-providers` 先读 TTY 后拿锁、`init-agy` 用 `shlex.quote`）。
- **遗留/延期项**：无（全部 Critical 与 Suggestion 均已吸收）。
