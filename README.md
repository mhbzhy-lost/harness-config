# harness-config

Qwen Code 个人配置的多机同步仓库。

## 结构

| 文件 | 说明 |
|---|---|
| `init-qwen.sh` | 同步脚本：把模板合并进本机 `~/.qwen/settings.json` |
| `qwen/settings.json` | 要同步的配置模板（**不含密钥**） |
| `secrets.env.example` | 密钥文件模板，复制为 `secrets.env` 使用（已 gitignore） |

## 新机器用法

```bash
git clone <repo-url> harness-config && cd harness-config
./init-qwen.sh
```

按提示提供 API 密钥，或提前用下面任一方式准备好。

## API 密钥（绝不入库）

解析顺序：

1. 仓库目录下的 `secrets.env`（从 `secrets.env.example` 复制，填写 `BAILIAN_TOKEN_PLAN_API_KEY=`）
2. 环境变量 `BAILIAN_TOKEN_PLAN_API_KEY`
3. 本机 `~/.qwen/settings.json` 中已有的值（重复运行无需再输入）
4. 交互输入（不回显）

## 同步语义

- **深度合并**：模板定义的键覆盖本机值；数组（如 `modelProviders.openai`）整体替换；本机其余已有键保留。
- **不同步机器本地状态**：`ui.autoModeAcknowledged`、`ui.feedbackLastShownTimestamp`、`providerMetadata`、`$version` 由各机器自行维护。
- 写入前自动备份为 `<目标>.bak.<时间戳>`；原子写入；目标与备份权限均为 600。
- 内容已一致时不写入（幂等，可重复运行）。

## 常用命令

```bash
./init-qwen.sh --dry-run                          # 预览变更
QWEN_SETTINGS_PATH=/tmp/test.json ./init-qwen.sh  # 对测试文件运行
```

## 更新模板

在某台机器上调好配置后，把想同步的键手动复制进 `qwen/settings.json`（去掉 `env` 中的密钥和机器本地状态），提交推送；其他机器 `git pull && ./init-qwen.sh`。

## 注意

- 需要 bash + python3（macOS / Linux / WSL）。
- 本机配置必须是标准 JSON；脚本不处理手写的 `//` 注释（Qwen Code 自身写出的文件是标准 JSON）。
- 同步后重启 Qwen Code 生效。
