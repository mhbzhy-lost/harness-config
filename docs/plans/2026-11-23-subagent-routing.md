# 子代理浅层混合路由 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 在 harness 中落地主模型负责调度与开发、非开发任务委派子代理的浅层混合路由。

**Architecture:** `qwen/QWEN.md` 提供跨项目软路由，少量 agent 定义提供职责和工具边界，原生 `/review` 继续承载完整审查。模型角色在仓内使用 `fast`/默认继承，具体模型映射留在本机。

**Tech Stack:** JSON、Markdown、Bash、Python 3 标准库 `unittest`

**Spec:** `docs/plans/2026-11-23-subagent-routing-design.md`

## Global Constraints

- 主模型负责调度、开发、集成和最终回复；独立非开发任务委派子代理。
- 不新增 researcher，不引入 hook 强拦截、外部编排框架或新的固定 workflow。
- 只新增验证专用 `test-runner`；Explore 使用 `fast`；general-purpose 默认继承；review-agent 保留 `qwen4-max-preview` 例外。
- 具体 `fastModel`、主模型、提供商和认证不得写入仓内模板。
- 第一版退役 `high` 调用档，不要求本机新增 `agents.modelGrades.high`；已有的本机档位仍须保留。
- test-runner 不开放文件写入工具，但 shell 禁改文件仅是提示词约束，不得声称存在只读沙箱。
- 在 `feat/qwen-subagent-routing` 分支实施，不直接在 `main` 上修改，不 push。
- Task 1 提交后立即执行 Task 2，避免全局 QWEN.md 已引用 test-runner、但本机 agent 链接尚未创建的空窗。
- 一次提交只包含路由这一逻辑变更，提交信息为 `feat(qwen): 增加子代理浅层混合路由`。

## Review Focus

- 本机模型配置被模板覆盖：临时 settings 必须验证 `model`、`fastModel` 和自定义 `agents.modelGrades` 原样保留。
- 测试验证者修改实现或测试：`test-runner` allowlist 不得包含 `write_file` 或 `edit`，测试必须检查。
- Explore 仍绑定具体模型：模板必须精确使用 `agents.builtin.exploreModel: "fast"`。
- 原生 `/review` 意外失去重模型：`review-agent.md` 的既有 `model: qwen4-max-preview` 必须保留并有测试。
- 把配置存在误当路由生效：本机同步后仍需新会话观察真实 Agent 调用，未完成时必须明确报告。

## Independent Plan Review

- Reviewer：fresh `review-agent`，2026-11-23，只读审查设计、计划和现有实现。
- Critical：无。
- S1 `high` 去向不明：已决定第一版退役 `high`，本机不新增；测试中的合成档位仅验证 init 保留已有本机配置，不构成路由依赖。
- S2 test-runner 只读边界过述：已改为“不开放文件写入工具 + shell 禁改文件的提示词约束”，测试增加对应提示词检查。
- S3 `/review` 产物干扰提交检查：不扩大 `.gitignore`；`.qwen/` 产物视为预期噪声且不入提交，改用 staged diff 验收。
- N1 新文件不出现在 `git diff HEAD`：已改为先 stage 指定文件，再检查 `git diff --cached`。
- N2 全局路由先于 agent 链接生效：已要求 Task 1 后立即执行 Task 2。
- N3 分支基点携带两个未推送提交：在 Step 1 明确记录；本次不 push、不开 PR。
- Deferred Minor：无。

---

### Task 1: 路由配置、agent 与回归测试

**Files:**
- Create: `tests/test_qwen_routing.py`
- Create: `qwen/agents/test-runner.md`
- Modify: `.gitignore`
- Modify: `qwen/settings.json`
- Modify: `qwen/QWEN.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Preserve: `qwen/agents/review-agent.md`

**Interfaces:**
- Consumes: `init-qwen.sh` 的 `QWEN_SETTINGS_PATH`、`QWEN_EXTENSIONS_DIR`、`QWEN_SHELL_RC`、`QWEN_GLOBAL_MD`、`QWEN_AGENTS_DIR` 覆盖入口。
- Produces: `exploreModel: fast`、验证专用 `test-runner`、跨项目路由表，以及命令 `python3 -m unittest discover -s tests -p 'test_*.py'`。

- [x] **Step 1: 创建功能分支**

Run: `git switch -c feat/qwen-subagent-routing`
Expected: 当前分支切换为 `feat/qwen-subagent-routing`，已有提交和工作区内容保留。基点包含 main 当前领先 origin/main 的 `e473f97`、`42fedbb` 两个未推送提交；本次不 push、不开 PR，后续若开 PR 须先单独处理基点。

- [x] **Step 2: 写失败测试**

`tests/test_qwen_routing.py` 使用标准库完成：
1. 读取模板并断言 `agents.builtin.exploreModel == "fast"`，模板不包含具体 `fastModel`。
2. 断言 `test-runner.md` 存在，frontmatter 不写具体 `model`，工具允许 `read_file`、`grep_search`、`glob`、`run_shell_command`，拒绝 `write_file`、`edit`，且正文明确禁止把 shell 用于修改源码或测试。
3. 断言 review-agent 仍使用 `qwen4-max-preview`。
4. 在临时目录写入含本机 `model.name`、`fastModel: deepseek-v4.1-flash-1017` 和合成 `agents.modelGrades.high` 的 settings，通过五个环境变量运行真实 `init-qwen.sh`；断言本机值保留、Explore 合并为 `fast`、`test-runner.md` 链接指向仓内文件。合成档位只验证已有本机配置不会被删除，不要求真实机器新增该档位。

- [x] **Step 3: 运行测试确认失败**

Run: `python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: FAIL，原因是 Explore 仍为具体模型且 `qwen/agents/test-runner.md` 不存在；不能通过删除断言规避失败。

- [x] **Step 4: 实现最小路由配置**

- `qwen/settings.json`：把 `exploreModel` 改为 `fast`，移除模板中的具体 `modelGrades`；不加入 `fastModel`。
- `qwen/agents/test-runner.md`：使用带 `Use PROACTIVELY` 的明确 description；不写 `model`，仅开放读取、搜索和 shell 工具；要求运行项目既有检查、不得修改实现或测试，明确禁止把 shell 用于修改文件，并报告真实命令、退出码、skip 和环境限制。不得把该约束描述为只读沙箱。
- `qwen/QWEN.md`：加入简短路由表和 2–4 路只读并行、主模型串行写入、结构化证据、用户显式指定优先等约束；联网调研路由到 general-purpose。
- `AGENTS.md`：区分可同步的抽象角色档位与本机具体模型映射，记录 review-agent 唯一例外。
- `README.md`：更新设置模板说明、per-machine `fastModel`、test-runner 用途和测试命令。

- [x] **Step 5: 运行完整验证**

Run: `python3 -m json.tool qwen/settings.json >/dev/null && python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: JSON 校验成功，全部 unittest 通过，临时 init 测试退出码为 0。

- [x] **Step 6: 运行 fresh-context 全量审查**

Run: `/review --effort medium`
Expected: 审查覆盖完整未提交变更和 Review Focus。Critical/Important 只做一轮修复，每个修复重跑相关失败测试及完整 unittest；Minor 记录为 deferred，不进入第二轮修复。
Outcome: 11 个维度及 verifier 完整运行，coverage 2/2，verdict 为 `Verdict: Comment`。低置信度安全 Critical 被驳回；`__pycache__/` Suggestion 经 probe 确认并完成一轮修复。新增 ignore 测试先失败后通过，完整 5 项 unittest 通过；无 deferred Minor。报告保存于 `.qwen/reviews/2026-11-23-134228-local.md`。

- [ ] **Step 7: 审查并提交**

Run: `git add .gitignore AGENTS.md README.md qwen/QWEN.md qwen/settings.json qwen/agents/test-runner.md tests/test_qwen_routing.py docs/plans/2026-11-23-subagent-routing-design.md docs/plans/2026-11-23-subagent-routing.md && git diff --cached --check && git diff --cached && git status --short`
Expected: 无空白错误，staged diff 只包含本任务文件及计划/设计文档；`.qwen/` 审查产物和 `skills/writing-plans/SKILL.md` 保持未暂存，不清理、不提交。

Run: `git commit -m "feat(qwen): 增加子代理浅层混合路由"`
Expected: 一个逻辑提交，无 AI 署名，不 push；最终回复列出所有 Ruling 和 deferred Minor。

### Task 2: 应用本机模型映射与同步

**Files:**
- Modify outside repository: `~/.qwen/settings.json`
- Create by init outside repository: `~/.qwen/agents/test-runner.md` symlink

**Interfaces:**
- Consumes: Task 1 的模板和 init 集成测试。
- Produces: 本机 `fastModel: deepseek-v4.1-flash-1017`、Explore `fast` 和 test-runner 用户级链接。

- [ ] **Step 1: 保留并设置本机具体模型**

在本机 `~/.qwen/settings.json` 设置 `fastModel: "deepseek-v4.1-flash-1017"`，保留当前 `model`、提供商、认证和其他本机字段；第一版不新增 `agents.modelGrades.high`，已存在的本机档位不删除。此文件不得 stage 或提交。

- [ ] **Step 2: 运行真实初始化**

Run: `./init-qwen.sh`
Expected: 设置合并成功并备份本机 settings，test-runner 链接创建，已有真实文件不被覆盖。

- [ ] **Step 3: 验证本机结果**

用 Python 读取本机 settings，断言 `fastModel` 和当前主模型仍在、`exploreModel == "fast"`；检查 `~/.qwen/agents/test-runner.md` 是指向本仓的软链接。再次运行 Task 1 的完整测试，预期全部通过。

- [ ] **Step 4: 新会话路由验收**

重启 Qwen Code 后分别提交广泛探索、联网调研、运行测试、明确小修改四类请求，记录实际 `subagent_type` 与模型；广泛探索应为 Explore/fast，联网调研与未分类任务应为 general-purpose，测试应为 test-runner，小修改由主模型开发。若当前会话无法重启验证，明确标记该项未验证，不声称路由已实测生效。
