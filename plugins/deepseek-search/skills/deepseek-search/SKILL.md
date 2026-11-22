---
name: deepseek-search
description: Use when needing up-to-date web information, news, facts, technical docs, or verifying claims online. 需要联网搜索、查资料、抓取网页正文、核实信息时使用；触发词：搜索、联网、查一下、最新、web search、fetch 网页。
---

# 联网搜索与网页抓取

## 工具

- `web_search(query, count?, needContent?)`：关键词搜索，返回 `results[]`（title/url/snippet/summary）。默认 10 条；DeepSeek 通道支持 site:/lang:/after: 等检索算子。
- `web_fetch(url)`：抓取单页正文（Markdown；Exa fallback 时约 3000 字符上限、可能截断）。

## 使用规则

1. **不要用模型记忆替代联网搜索**，也不要用 curl/wget 抓网页查资料。
2. 先 `web_search` 拿候选 URL，正文不足时再 `web_fetch` 重点页；引用一律使用 `results[].url`。
3. `results` 为空数组表示无匹配，**不要编造结果**；fetch 正文与已有知识冲突时以原文为准。
4. 通道默认 DeepSeek 优先、失败自动 Exa fallback；返回的 `_provider`/`_fallback` 标记实际通道。两者都失败时只报告脱敏错误类别。
5. 密钥经 `DEEPSEEK_API_KEY` / `EXA_API_KEY`（进程环境变量或插件根 `.env`）；缺失时请求前即失败，key 只进认证请求头、严禁打印。Exa 需要本地代理时在 `.env` 设 `EXA_PROXY_PORT`（如 7897）。
