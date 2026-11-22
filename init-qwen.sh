#!/usr/bin/env bash
# init-qwen.sh — 将仓库中的 Qwen Code 配置与插件同步到本机：
#   1. qwen/settings.json 深度合并进 ~/.qwen/settings.json，并注入 env.HARNESS_CONFIG_ROOT=仓库根
#   2. plugins/* 软链接进 ~/.qwen/extensions/
#   3. qwen/shell.zsh 注册 source 进 ~/.zshrc（标记块，幂等；qwen 主题随系统明暗）
# 模型/提供商/认证/密钥均为 per-machine 配置，不在同步范围。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/qwen/settings.json"
PLUGINS_SRC="$SCRIPT_DIR/plugins"
TARGET="${QWEN_SETTINGS_PATH:-$HOME/.qwen/settings.json}"
EXT_DIR="${QWEN_EXTENSIONS_DIR:-$HOME/.qwen/extensions}"
SHELL_RC="${QWEN_SHELL_RC:-$HOME/.zshrc}"
SHELL_SNIPPET="$SCRIPT_DIR/qwen/shell.zsh"
DRY_RUN=0

usage() {
  cat <<EOF
用法: ./init-qwen.sh [--dry-run]

  --dry-run   只预览将发生的变更，不写入
  -h, --help  显示本帮助

环境变量:
  QWEN_SETTINGS_PATH    覆盖目标配置路径（默认 ~/.qwen/settings.json）
  QWEN_EXTENSIONS_DIR   覆盖插件链接目录（默认 ~/.qwen/extensions）
  QWEN_SHELL_RC         覆盖 shell 注册目标（默认 ~/.zshrc）

脚本会向目标设置的 env 注入 HARNESS_CONFIG_ROOT（本仓库绝对路径），
并把 qwen/shell.zsh 的 source 行注册进 ~/.zshrc（标记块，幂等）。
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
[[ -f "$SHELL_SNIPPET" ]] || die "找不到 shell 片段: $SHELL_SNIPPET"

# --- 1. 合并设置 + 注入 HARNESS_CONFIG_ROOT ---
QWEN_SYNC_DRY_RUN="$DRY_RUN" python3 - "$TEMPLATE" "$TARGET" "$SCRIPT_DIR" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

template_path, target_path, repo_root = sys.argv[1:4]
dry_run = os.environ.get("QWEN_SYNC_DRY_RUN") == "1"

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

# 深拷贝，避免合并结果与 existing 共享子对象导致变更检测失效
merged = merge(copy.deepcopy(existing), template)
env = merged.setdefault("env", {})
if not isinstance(env, dict):
    sys.exit("错误: 现有配置的 env 字段不是对象，无法注入 HARNESS_CONFIG_ROOT")
env["HARNESS_CONFIG_ROOT"] = repo_root
changed = sorted(k for k in merged if existing.get(k) != merged[k])

if dry_run:
    print(f"[dry-run] 设置目标: {target_path}")
    print(f"[dry-run] 将变更的顶层键: {', '.join(changed) or '（无变更）'}")
    print(f"[dry-run] 将注入 env.HARNESS_CONFIG_ROOT = {repo_root}")
    sys.exit(0)

if merged == existing:
    print(f"设置已与模板一致，无需写入: {target_path}")
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

print(f"设置已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
print(f"同步的顶层键: {', '.join(changed) or '（无变更）'}")
PY

# --- 2. 插件软链接 ---
source "$SCRIPT_DIR/lib-plugins.sh"
link_plugins "$PLUGINS_SRC" "$EXT_DIR" "$DRY_RUN"

# --- 3. 注册 qwen shell 片段进 ~/.zshrc ---
QWEN_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SHELL_RC" "$SHELL_SNIPPET" <<'PY'
import os, re, sys, tempfile
from datetime import datetime

rc_path, snippet_path = sys.argv[1:3]
dry_run = os.environ.get("QWEN_SYNC_DRY_RUN") == "1"

start_marker = "# >>> harness-config qwen >>>"
end_marker = "# <<< harness-config qwen <<<"
line = f"[[ -f '{snippet_path}' ]] && source '{snippet_path}'"
block = f"{start_marker}\n{line}\n{end_marker}"

existing = ""
if os.path.exists(rc_path):
    with open(rc_path, encoding="utf-8") as f:
        existing = f.read()

pattern = re.compile(re.escape(start_marker) + r".*?" + re.escape(end_marker), re.DOTALL)
if pattern.search(existing):
    updated = pattern.sub(lambda m: block, existing, count=1)
else:
    sep = "" if (not existing or existing.endswith("\n")) else "\n"
    updated = existing + sep + "\n" + block + "\n"

if updated == existing:
    print(f"shell 注册已是最新，无需写入: {rc_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] shell 注册目标: {rc_path}")
    print(f"[dry-run] 将写入/更新标记块，source: {snippet_path}")
    sys.exit(0)

backup_path = None
if os.path.exists(rc_path):
    backup_path = f"{rc_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(rc_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())

rc_dir = os.path.dirname(rc_path) or "."
os.makedirs(rc_dir, exist_ok=True)
fd, tmp_path = tempfile.mkstemp(dir=rc_dir, prefix=".zshrc-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(updated)
    if os.path.exists(rc_path):
        os.chmod(tmp_path, os.stat(rc_path).st_mode & 0o777)
    os.replace(tmp_path, rc_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"shell 注册已写入: {rc_path}")
if backup_path:
    print(f"已备份: {backup_path}")
PY

if [[ "$DRY_RUN" == 1 ]]; then
  echo "预览完成，未做任何写入。"
else
  echo "完成。重启 Qwen Code（或 /reload-plugins）使设置/插件变更生效；新开终端使 qwen 主题包装生效。"
fi
