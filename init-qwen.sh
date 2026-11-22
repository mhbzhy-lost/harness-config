#!/usr/bin/env bash
# init-qwen.sh — 将仓库中的 qwen/settings.json 合并进本机 Qwen Code 配置，
# 用于多机同步。API 密钥只在本机解析，绝不进入仓库。
set -euo pipefail

KEY_NAME="BAILIAN_TOKEN_PLAN_API_KEY"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/qwen/settings.json"
SECRETS_FILE="$SCRIPT_DIR/secrets.env"
TARGET="${QWEN_SETTINGS_PATH:-$HOME/.qwen/settings.json}"
DRY_RUN=0

usage() {
  cat <<EOF
用法: ./init-qwen.sh [--dry-run]

将仓库 qwen/settings.json 深度合并进本机 Qwen Code 配置（默认 ~/.qwen/settings.json）。
  --dry-run   只预览将发生的变更，不写入
  -h, --help  显示本帮助

环境变量:
  QWEN_SETTINGS_PATH        覆盖目标配置路径（测试用）
  ${KEY_NAME}  直接提供 API 密钥

密钥解析顺序: secrets.env > 环境变量 > 本机配置已有值 > 交互输入
EOF
}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $1" ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || die "需要 python3"
[[ -f "$TEMPLATE" ]] || die "找不到模板: $TEMPLATE"

# --- 解析 API 密钥（通过环境变量传给 python，避免出现在 ps 可见的命令行参数里）---
api_key=""

if [[ -f "$SECRETS_FILE" ]]; then
  api_key="$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?${KEY_NAME}[[:space:]]*=[[:space:]]*//p" "$SECRETS_FILE" | tail -n 1)"
  api_key="${api_key%\"}"; api_key="${api_key#\"}"
  api_key="${api_key%\'}"; api_key="${api_key#\'}"
fi

if [[ -z "$api_key" && -n "${!KEY_NAME:-}" ]]; then
  api_key="${!KEY_NAME}"
fi

if [[ -z "$api_key" && -f "$TARGET" ]]; then
  api_key="$(python3 - "$TARGET" "$KEY_NAME" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    value = data.get("env", {}).get(sys.argv[2], "")
    print(value if isinstance(value, str) else "")
except Exception:
    pass
PY
)"
fi

# 权限位检查不够：无控制终端时 /dev/tty 存在但打开会失败，需实际试开
if [[ -z "$api_key" ]] && (exec 3<>/dev/tty) 2>/dev/null; then
  printf '本机未找到 %s，请输入（输入不回显）: ' "$KEY_NAME" > /dev/tty
  IFS= read -rs api_key < /dev/tty || true
  printf '\n' > /dev/tty
fi

api_key="${api_key#"${api_key%%[![:space:]]*}"}"
api_key="${api_key%"${api_key##*[![:space:]]}"}"

[[ -n "$api_key" ]] || die "无法获得 ${KEY_NAME}。请写入 secrets.env、导出为环境变量，或在交互终端中运行"

QWEN_SYNC_API_KEY="$api_key" QWEN_SYNC_DRY_RUN="$DRY_RUN" python3 - "$TEMPLATE" "$TARGET" "$KEY_NAME" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

template_path, target_path, key_name = sys.argv[1:4]
dry_run = os.environ.get("QWEN_SYNC_DRY_RUN") == "1"
api_key = os.environ["QWEN_SYNC_API_KEY"]

with open(template_path, encoding="utf-8") as f:
    template = json.load(f)

existing = {}
if os.path.exists(target_path):
    with open(target_path, encoding="utf-8") as f:
        text = f.read()
    if text.strip():
        try:
            existing = json.loads(text)
        except json.JSONDecodeError as e:
            sys.exit(f"错误: 现有配置 {target_path} 不是标准 JSON（若手写了 // 注释请先移除）: {e}")
    if not isinstance(existing, dict):
        sys.exit(f"错误: {target_path} 顶层不是 JSON 对象")

def merge(base, override):
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out

# 深拷贝，避免注入密钥时经浅拷贝别名同步改动 existing，导致变更检测失效
merged = merge(copy.deepcopy(existing), template)
env = merged.setdefault("env", {})
if not isinstance(env, dict):
    sys.exit("错误: 现有配置的 env 字段不是对象，无法注入密钥")
env[key_name] = api_key

changed = sorted(k for k in merged if existing.get(k) != merged[k])

if dry_run:
    print(f"[dry-run] 目标: {target_path}")
    print(f"[dry-run] 将变更的顶层键: {', '.join(changed) or '（无变更）'}")
    print(f"[dry-run] 将注入 env.{key_name}（值不显示）")
    sys.exit(0)

if merged == existing:
    print(f"配置已与模板一致，无需写入: {target_path}")
    sys.exit(0)

target_dir = os.path.dirname(target_path) or "."
os.makedirs(target_dir, exist_ok=True)

backup_path = None
if os.path.exists(target_path):
    backup_path = f"{target_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(target_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())
    os.chmod(backup_path, 0o600)

fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".settings-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, target_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
print(f"同步的顶层键: {', '.join(changed) or '（无变更）'}")
print("请重启 Qwen Code（/exit 后重新进入）使配置生效。")
PY
