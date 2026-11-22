# harness-config

Qwen Code 个人配置与插件的多机同步仓库。

## 结构

| 路径 | 说明 |
|---|---|
| `init-qwen.sh` | 同步脚本：合并设置 + 链接插件 |
| `qwen/settings.json` | 设置模板（仅跨机通用偏好，当前只有 TUI 精简） |
| `plugins/` | Agent Plugins v1 插件：deepseek-search / home-connect / playwright |

## 同步范围

- **同步**：模板中定义的设置键；`plugins/*` → `~/.qwen/extensions/<name>` 软链接。
- **不同步（per-machine）**：`model`、`modelProviders`、`security.auth`、`env` 中的密钥、`providerMetadata`、`$version`、`ui.autoModeAcknowledged` 等机器本地状态。模型/提供商/认证在各机器自行配置。

## 新机器用法

```bash
git clone <repo-url> harness-config && cd harness-config
./init-qwen.sh
# 按需补齐本机内容：
(cd plugins/playwright && npm install)
cp plugins/deepseek-search/.env.example plugins/deepseek-search/.env   # 填写密钥
# home-connect 凭据/身份在 ~/.pi/agent/home-connect（.env、.ssh/、config/*.env），
# 不随仓库分发，需自行准备；config/ 下有各 .env.example 模板
# 模型/提供商/认证在本机自行配置
```

## 设置合并语义

- 深度合并：模板键覆盖本机值，数组整体替换，本机其余已有键保留。
- 写入前自动备份为 `<目标>.bak.<时间戳>`；原子写入；权限 600。
- 内容已一致时不写入（幂等）。

## 插件链接语义

- 已是正确链接 → 跳过；指向别处的链接 → 重指；真实目录/文件 → 警告并跳过（不破坏）。
- 凭据（`.env`）与 `node_modules/` 不入库；缺依赖或缺凭据时脚本会给出提示。

## 常用命令

```bash
./init-qwen.sh --dry-run    # 预览变更
QWEN_SETTINGS_PATH=/tmp/t.json QWEN_EXTENSIONS_DIR=/tmp/ext ./init-qwen.sh   # 测试
```

## 更新

- 设置：把想同步的键手动加进 `qwen/settings.json`（勿加 per-machine 配置），提交推送。
- 插件：直接改 `plugins/` 下内容（本机链接即时生效），提交推送；其他机器 `git pull` 即可，新增插件需重跑 `./init-qwen.sh` 建链接。

## 注意

- 需要 bash + python3；插件运行依赖 node（playwright 还需 `npm install`）。
- 本机设置必须是标准 JSON；脚本不处理手写的 `//` 注释。
- 设置变更重启 Qwen Code 生效；插件变更可用 `/reload-plugins`。
