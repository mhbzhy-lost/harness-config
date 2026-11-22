#!/usr/bin/env bash
# init-pi.sh — 将仓库 plugins/* 软链接进 pi 的插件加载目录（默认 ~/.agents/plugins）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_SRC="$SCRIPT_DIR/plugins"
PI_DIR="${PI_PLUGINS_DIR:-$HOME/.agents/plugins}"
DRY_RUN=0

usage() {
  cat <<EOF
用法: ./init-pi.sh [--dry-run]

将仓库 plugins/* 软链接进 pi 的插件加载目录（默认 ~/.agents/plugins）。
  --dry-run   只预览将发生的变更，不写入
  -h, --help  显示本帮助

环境变量:
  PI_PLUGINS_DIR  覆盖 pi 的插件加载目录
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

# 遗留整目录软链接：指向本仓 plugins/ → 升级为逐插件链接；指向别处 → 不动
if [[ -L "$PI_DIR" ]]; then
  if [[ "$(readlink "$PI_DIR")" != "$PLUGINS_SRC" ]]; then
    die "$PI_DIR 是指向别处的软链接（$(readlink "$PI_DIR")），请手动处理"
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] ${PI_DIR}：整目录链接升级为真实目录，并逐插件链接："
    for d in "$PLUGINS_SRC"/*/; do
      [[ -f "${d}plugin.json" ]] && echo "[dry-run]   $(basename "${d%/}") → ${d%/}"
    done
    echo "预览完成，未做任何写入。"
    exit 0
  fi
  rm "$PI_DIR"
  mkdir -p "$PI_DIR"
  echo "${PI_DIR}：整目录链接已升级为逐插件链接"
fi

source "$SCRIPT_DIR/lib-plugins.sh"
link_plugins "$PLUGINS_SRC" "$PI_DIR" "$DRY_RUN"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "预览完成，未做任何写入。"
else
  echo "完成。重启 pi（或相应 agent）加载插件。"
fi
