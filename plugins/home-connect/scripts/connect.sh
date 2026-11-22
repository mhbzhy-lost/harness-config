#!/usr/bin/env bash
set -euo pipefail
# 脚本随插件分发，彼此用自身目录定位；配置/身份根由 HOME_CONNECT_ROOT 决定。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC="$SCRIPT_DIR/mac.sh"
WINDOWS="$SCRIPT_DIR/windows.sh"
LAN="$SCRIPT_DIR/lan.sh"
WSL="$SCRIPT_DIR/wsl.sh"
WSL_RELAY="$SCRIPT_DIR/relay.sh"
TAILSCALE="$SCRIPT_DIR/tailscale.sh"
usage() {
  cat >&2 <<'USAGE'
Usage: connect.sh <target> <operation> [args...]

  ts|tailscale <status|peers|ping NAME|require-direct NAME|tcp-check NAME PORT>
  mac   <sh|--check|lan-check|status|get|get-lan|put-lan|lan sh|lan --|--|--sudo> ...
        （远程 shell 一律 mac sh <<'EOF' / mac lan sh <<'EOF'，stdin/heredoc 零转义）
  windows <windows-check|win-sh|win-exec|...>  (LAN 可用则直连，否则走杭州中继)
  windows-relay <windows-check|win-sh|win-exec|...>  (强制经杭州中继直连 Windows)
  lan   <status|require|tcp-check PORT>
  wsl   <status|sh|exec|get|put|wake>   (LAN 可用则直连，否则走中继；sh 支持 stdin/heredoc；wake 唤醒 idle 关机的 WSL)
  wsl-relay <--check|status|sh|exec|get|put|wake>

网络层判断（是否在线 / direct 还是 DERP / 端口可达）一律先走 ts，
再交给对应传输层；上层认证成功与网络可达是两件事。
USAGE
}
case "${1:-}" in
  ts|tailscale) shift; exec "$TAILSCALE" "$@" ;;
  mac) shift; exec "$MAC" "$@" ;;
  windows) shift; exec "$WINDOWS" "$@" ;;
  windows-relay) shift; WINDOWS_FORCE_RELAY=1 exec "$WINDOWS" "$@" ;;
  lan) shift; exec "$LAN" "$@" ;;
  wsl-relay) shift; exec "$WSL_RELAY" "$@" ;;
  wsl)
    shift
    [[ $# -ge 1 ]] || { usage; exit 2; }
    if "$LAN" require >/dev/null 2>&1; then
      if [[ "$1" == --check ]]; then exec "$WSL" status; fi
      exec "$WSL" "$@"
    fi
    exec "$WSL_RELAY" "$@"
    ;;
  *) usage; exit 2 ;;
esac