#!/usr/bin/env bash
# init-remote.sh — 初始化通用远程终端（remote-terminal）：
#   1. 检查 Node.js (>= 22.19.0) 与 tmux
#   2. 可选安装 remote-terminal/node_modules（支持 --skip-install 跳过联网安装）
#   3. 注册 remote-terminal/shell.zsh source 进 ~/.zshrc（标记块，幂等；提供 rt 与 rtctl）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_DIR="$SCRIPT_DIR/remote-terminal"
SHELL_SNIPPET="$REMOTE_DIR/shell.zsh"
SHELL_RC="${REMOTE_SHELL_RC:-$HOME/.zshrc}"
STATE_DIR="${HARNESS_REMOTE_DIR:-$HOME/.harness-remote}"
DRY_RUN=0
SKIP_INSTALL=0

usage() {
  cat <<EOF
用法: ./init-remote.sh [--dry-run] [--skip-install]

初始化通用 tmux 远程终端与中继模块（remote-terminal）。
  --dry-run       只预览将发生的变更，不写入、不安装依赖
  --skip-install  跳过 npm install（适合离线验证或已安装依赖）
  -h, --help      显示本帮助

环境变量:
  REMOTE_SHELL_RC      覆盖 shell 注册目标（默认 ~/.zshrc）
  HARNESS_REMOTE_DIR   覆盖运行时状态与配置目录（默认 ~/.harness-remote）
EOF
}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $1" ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || die "需要 python3"
[[ -f "$SHELL_SNIPPET" ]] || die "找不到 shell 片段: $SHELL_SNIPPET"
[[ -f "$REMOTE_DIR/package.json" ]] || die "找不到 package.json: $REMOTE_DIR/package.json"

# --- 1. 环境预检 ---
if ! command -v node >/dev/null 2>&1; then
  echo "警告: 未找到 node（remote-terminal 需要 Node.js >= 22.19.0）" >&2
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "提示: 未找到 tmux，远程共享依赖 tmux，请先运行: brew install tmux" >&2
fi

# --- 2. 安装 remote-terminal 独立依赖（仅隔离在 remote-terminal/node_modules） ---
if [[ "$SKIP_INSTALL" == 1 ]]; then
  echo "已跳过依赖安装（--skip-install）"
elif [[ -d "$REMOTE_DIR/node_modules" ]]; then
  echo "remote-terminal 依赖已就绪: $REMOTE_DIR/node_modules"
elif [[ "$DRY_RUN" == 1 ]]; then
  echo "[dry-run] 将运行: (cd \"$REMOTE_DIR\" && npm install --no-audit --no-fund)"
else
  command -v npm >/dev/null 2>&1 || die "需要 npm 安装 remote-terminal 依赖"
  echo "正在安装 remote-terminal 依赖（node-pty / xterm / ws）…"
  (cd "$REMOTE_DIR" && npm install --no-audit --no-fund)
fi

# --- 3. 注册 remote-terminal/shell.zsh 进 ~/.zshrc ---
REMOTE_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SHELL_RC" "$SHELL_SNIPPET" <<'PY'
import os, re, sys, tempfile
from datetime import datetime

rc_path, snippet_path = sys.argv[1:3]
dry_run = os.environ.get("REMOTE_SYNC_DRY_RUN") == "1"

start_marker = "# >>> harness-config remote-terminal >>>"
end_marker = "# <<< harness-config remote-terminal <<<"
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
    print(f"remote-terminal shell 注册已是最新，无需写入: {rc_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] remote-terminal shell 注册目标: {rc_path}")
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

print(f"remote-terminal shell 注册已写入: {rc_path}")
if backup_path:
    print(f"已备份: {backup_path}")
PY

if [[ "$DRY_RUN" != 1 && ! -f "$STATE_DIR/config.json" ]]; then
  echo "提示: 远程访问默认关闭（off）；如需开启局域网/公网访问，可复制 remote-terminal/config.example.json 到 ${STATE_DIR}/config.json 或运行 rtctl join"
fi

if [[ "$DRY_RUN" == 1 ]]; then
  echo "预览完成，未做任何写入。"
else
  echo "完成。新开终端（或 source ${SHELL_RC}）后可使用 rt <命令> 启动共享会话、rtctl 管理远程访问。"
fi
