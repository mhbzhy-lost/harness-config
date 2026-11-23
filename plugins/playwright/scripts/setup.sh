#!/usr/bin/env bash
# setup.sh — 幂等安装 playwright 插件依赖（懒加载初始化入口）。
# 只用 package-lock.json 锁定版本；不下载浏览器（运行时使用系统 Chrome）。
# 用法: bash scripts/setup.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  -h|--help) echo "用法: bash scripts/setup.sh [--force]"; exit 0 ;;
  "") ;;
  *) echo "错误: 未知参数 $1" >&2; exit 2 ;;
esac

command -v npm >/dev/null 2>&1 || { echo "错误: 需要 npm（Node.js >= 20）" >&2; exit 1; }
[[ -f "$ROOT/package-lock.json" ]] || { echo "错误: 找不到 $ROOT/package-lock.json" >&2; exit 1; }

if [[ "$FORCE" == 0 && -f "$ROOT/node_modules/playwright/package.json" ]]; then
  echo "playwright 依赖已安装，跳过: $ROOT/node_modules"
  exit 0
fi

cd "$ROOT"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
echo "playwright 依赖已安装: $ROOT/node_modules（使用系统 Chrome，未下载浏览器）"