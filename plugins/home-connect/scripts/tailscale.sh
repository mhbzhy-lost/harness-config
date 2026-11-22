#!/usr/bin/env bash
set -euo pipefail

find_tailscale() {
  if [[ -n "${TAILSCALE_BIN:-}" && -x "${TAILSCALE_BIN}" ]]; then printf '%s\n' "$TAILSCALE_BIN"; return; fi
  for p in "$(command -v tailscale 2>/dev/null || true)" /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
    [[ -n "$p" && -x "$p" ]] && { printf '%s\n' "$p"; return; }
  done
  printf 'Tailscale CLI not found\n' >&2
  return 1
}
TS="$(find_tailscale)"

status_json() { "$TS" status --json; }

resolve_target() {
  local target="$1"
  status_json | python3 -c '
import json,sys
needle=sys.argv[1].lower(); d=json.load(sys.stdin)
for p in (d.get("Peer") or {}).values():
 h=str(p.get("HostName") or ""); dns=str(p.get("DNSName") or "")
 if needle in (h.lower(),dns.lower().rstrip(".")):
  ips=p.get("TailscaleIPs") or []
  if ips: print(ips[0]); raise SystemExit(0)
raise SystemExit(2)
' "$target"
}

ping_target() {
  local target="$1" ip raw
  ip="$(resolve_target "$target")"
  set +e
  raw="$($TS ping --c 3 --timeout 5s "$ip" 2>&1)"
  set -e
  python3 -c '
import re,sys
s=sys.stdin.read()
mode="derp" if re.search(r"via DERP",s,re.I) else "direct" if re.search(r"via\s+[^\s]+:\d+",s) else "unknown"
vals=[float(x) for x in re.findall(r"in\s+([0-9.]+)ms",s)]
print("path="+mode)
print("responses="+str(len(vals)))
if vals: print(f"latency_ms={sum(vals)/len(vals):.1f}")
if not vals: raise SystemExit(3)
' <<<"$raw"
}

case "${1:-status}" in
  status)
    status_json | python3 -c '
import json,sys
d=json.load(sys.stdin); peers=list((d.get("Peer") or {}).values())
print("tailscale="+("running" if str(d.get("BackendState","")).lower()=="running" else "not_running"))
print("online_peers="+str(sum(bool(p.get("Online")) for p in peers)))
print("peer_count="+str(len(peers)))
'
    ;;
  peers)
    status_json | python3 -c '
import json,sys
d=json.load(sys.stdin)
for i,p in enumerate((d.get("Peer") or {}).values(),1):
 print(f"peer_{i}={p.get(chr(72)+chr(111)+chr(115)+chr(116)+chr(78)+chr(97)+chr(109)+chr(101),"unnamed")} os={p.get("OS","unknown")} online={str(bool(p.get("Online"))).lower()}")
'
    ;;
  ping)
    [[ $# -eq 2 ]] || { echo 'Usage: connect.sh ping <logical-name>' >&2; exit 2; }
    ping_target "$2"
    ;;
  require-direct)
    [[ $# -eq 2 ]] || { echo 'Usage: connect.sh require-direct <logical-name>' >&2; exit 2; }
    result="$(ping_target "$2")"
    grep -qx 'path=direct' <<<"$result" || { printf '%s\n' "$result" >&2; exit 4; }
    printf '%s\n' "$result"
    ;;
  tcp-check)
    [[ $# -eq 3 && "$3" =~ ^[0-9]+$ ]] || { echo 'Usage: connect.sh tcp-check <logical-name> <port>' >&2; exit 2; }
    ip="$(resolve_target "$2")"
    if nc -z -w 5 "$ip" "$3" >/dev/null 2>&1; then echo 'tcp=reachable'; else echo 'tcp=blocked'; exit 5; fi
    ;;
  *)
    echo 'Usage: connect.sh [status|peers|ping NAME|require-direct NAME|tcp-check NAME PORT]' >&2
    exit 2
    ;;
esac
