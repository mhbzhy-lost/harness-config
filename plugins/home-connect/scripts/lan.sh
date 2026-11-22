#!/usr/bin/env bash
set -euo pipefail
ROOT="${HOME_CONNECT_ROOT:-${SKILL_ROOT_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
CONFIG="$ROOT/config/lan.env"
ROUTE_BIN="${ROUTE_BIN:-/sbin/route}"
IPCONFIG_BIN="${IPCONFIG_BIN:-/usr/sbin/ipconfig}"
NC_BIN="${NC_BIN:-$(command -v nc)}"
[[ -f "$CONFIG" ]] || { echo 'home-connect LAN config is missing' >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
for v in LAN_HOST LAN_CIDR LAN_WINDOWS_SSH_PORT; do [[ -n "${!v:-}" ]] || { echo "missing $v" >&2; exit 1; }; done
[[ "$LAN_WINDOWS_SSH_PORT" =~ ^[0-9]+$ ]]
chmod 600 "$CONFIG"

probe() {
  local port="$1" route_info iface local_ip
  route_info="$($ROUTE_BIN -n get "$LAN_HOST" 2>/dev/null)" || return 1
  iface="$(awk '/interface:/{print $2;exit}' <<<"$route_info")"
  [[ "$iface" =~ ^en[0-9]+$ ]] || return 1
  local_ip="$($IPCONFIG_BIN getifaddr "$iface" 2>/dev/null)" || return 1
  python3 - "$local_ip" "$LAN_HOST" "$LAN_CIDR" <<'PY' >/dev/null
import ipaddress,sys
local=ipaddress.ip_address(sys.argv[1]); host=ipaddress.ip_address(sys.argv[2]); net=ipaddress.ip_network(sys.argv[3],strict=False)
raise SystemExit(0 if local in net and host in net else 1)
PY
  [[ $? -eq 0 ]] || return 1
  if [[ "$(uname -s)" == Darwin ]]; then
    "$NC_BIN" -z -G 3 "$LAN_HOST" "$port" >/dev/null 2>&1
  else
    "$NC_BIN" -z -w 3 "$LAN_HOST" "$port" >/dev/null 2>&1
  fi
}

case "${1:-status}" in
  status)
    if probe "$LAN_WINDOWS_SSH_PORT"; then echo 'lan=available'; else echo 'lan=unproven'; fi
    ;;
  require)
    probe "$LAN_WINDOWS_SSH_PORT" || { echo 'lan=unproven' >&2; exit 4; }
    echo 'lan=available'
    ;;
  tcp-check)
    port="${2:-}"
    [[ "$port" =~ ^[0-9]+$ ]] || { echo 'Usage: connect.sh tcp-check <port>' >&2; exit 2; }
    probe "$port" || { echo 'tcp=blocked' >&2; exit 5; }
    echo 'tcp=reachable'
    ;;
  *) echo 'Usage: connect.sh [status|require|tcp-check PORT]' >&2; exit 2;;
esac
