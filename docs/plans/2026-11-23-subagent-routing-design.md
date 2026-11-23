# 子代理浅层混合路由设计

日期：2026-11-23

## 目标

主模型只负责需求澄清、调度、开发、集成和最终回复；探索、联网调研、测试、审查及其他独立非开发任务交给子代理。第一版采用浅层混合路由，不引入外部编排框架、hook 强拦截或新的固定 workflow。

## 已确认决策

- 不新增 `researcher`：本轮三个 `general-purpose` 子代理已验证能通过 deepseek-search 完成联网调研。
- 新增验证专用 `test-runner`：不开放 `write_file` / `edit`，统一返回命令与退出码。shell 仅用于运行既有检查；禁止用 shell 修改源码或测试属于提示词约束，不是文件系统沙箱。
- 保留原生 `/review`；`review-agent` 暂时保留 `qwen4-max-preview` 作为唯一具体模型例外。
- Explore 使用抽象档位 `fast`；`general-purpose` 与其他未显式设模型的 agent 继承当前主模型。
- `fastModel` 的具体模型 ID 由各机器配置，不写入同步模板。
- 第一版退役 `high` 调用档，不要求各机器新增 `agents.modelGrades.high`；init 仍须保留机器上已经存在的自定义模型档位。
- 用户明确指定的路由优先；开发所需的明确文件读取和定向搜索可由主模型直接完成。

## 路由表

| 任务 | 执行者 | 约束与返回证据 |
|---|---|---|
| 调度、开发、集成、最终回复 | 主模型 | 核验子代理证据，不重复整轮工作 |
| 跨目录探索、超过 3 次搜索、调用链调查 | Explore | 只读；返回文件、行号和未确定项 |
| 联网调研、最新文档、外部事实 | general-purpose | 先搜索再抓正文；返回真实 URL |
| 测试、构建、lint、类型检查 | test-runner | 不开放文件写入工具，shell 禁改源码或测试；返回命令、退出码、skip 和环境问题 |
| 完整代码审查 | `/review` medium/high | 不用 low 代替需要子代理的审查 |
| 其他独立非开发任务 | general-purpose | 有界任务、明确输出 |

独立只读任务可并行 2–4 路；写入默认由主模型串行完成。子代理不直接回复用户，主模型统一综合。

## 配置边界

仓内同步：路由表、agent 定义、`agents.builtin.exploreModel: "fast"`，以及 review-agent 的既有具体模型例外。

本机配置：`fastModel`、主模型、模型提供商、认证和其他模型映射。`init-qwen.sh` 深合并时必须保留这些本机值。第一版不分发 `high`，已有本机档位只作为本机配置保留，不作为路由依赖。

## 验证

- 用标准库 `unittest` 检查模板角色档位、review 例外、test-runner 工具边界及 shell 禁改文件约束。
- 用临时目录运行真实 `init-qwen.sh`，确认本机 `fastModel`、主模型及已有自定义模型档位保留，并正确链接 test-runner。
- 当前机器同步后需重启 Qwen Code，再以实际 Agent 调用验证路由；不能仅凭回答文本认定路由成功。

## 关键调研来源

- https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/
- https://openai.github.io/openai-agents-python/multi_agent/
- https://www.anthropic.com/research/building-effective-agents?lang=en-US
- https://github.com/mock-server/mockserver-monorepo/blob/39c7529c10c6295ddfa23ebfaf4154478e3b65fa/.opencode/rules/subagent-routing.md
