#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOME_CONNECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
MAC_CONFIG="${ROOT}/config/mac-tunnel.env"
WSL_CONFIG="${ROOT}/config/wsl.env"
RELAY_CONFIG="${ROOT}/config/relay.env"
KNOWN="${ROOT}/config/wsl-known-hosts"
for path in "$MAC_CONFIG" "$WSL_CONFIG" "$RELAY_CONFIG" "$KNOWN"; do
  [[ -f "$path" ]] || { echo 'wsl relay configuration is incomplete' >&2; exit 1; }
done
# These are existing local, private configuration files, not model input.
source "$MAC_CONFIG"
source "$WSL_CONFIG"
source "$RELAY_CONFIG"
[[ "${RELAY_HOST:-}" =~ ^[A-Za-z0-9_.:-]+$ ]] || { echo 'invalid relay host' >&2; exit 1; }
[[ "${RELAY_ADMIN_USER:-}" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'invalid relay user' >&2; exit 1; }
[[ "${WSL_USER:-}" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'invalid WSL user' >&2; exit 1; }
[[ "${WSL_RELAY_PORT:-}" =~ ^[0-9]+$ ]] && (( WSL_RELAY_PORT >= 1 && WSL_RELAY_PORT <= 65535 )) || { echo 'invalid relay port' >&2; exit 1; }
case "${RELAY_IDENTITY:-}" in
  '~/'*) RELAY_IDENTITY="${HOME}/${RELAY_IDENTITY#\~/}" ;;
  /*) ;;
  '') ;;
  *) RELAY_IDENTITY="${ROOT}/${RELAY_IDENTITY#./}" ;;
esac

# 可选：中继末端（WSL）的身份密钥。未配置或文件缺失时不写 IdentityFile，坐回默认身份。
WSL_RELAY_IDENTITY_FILE=""
if [[ -n "${WSL_IDENTITY:-}" ]]; then
  case "$WSL_IDENTITY" in
    '~/'*) cand="${HOME}/${WSL_IDENTITY#\~/}" ;;
    /*) cand="$WSL_IDENTITY" ;;
    *) cand="${ROOT}/${WSL_IDENTITY#./}" ;;
  esac
  [[ -f "$cand" ]] && WSL_RELAY_IDENTITY_FILE="$cand"
fi
WSL_RELAY_IDENTITY_LINE=""
if [[ -n "$WSL_RELAY_IDENTITY_FILE" ]]; then
  WSL_RELAY_IDENTITY_LINE="$(printf '  IdentityFile "%s"\n  IdentitiesOnly yes' "$WSL_RELAY_IDENTITY_FILE")"
fi
[[ -f "${RELAY_IDENTITY:-}" && "$RELAY_IDENTITY" != *$'\n'* && "$RELAY_IDENTITY" != *'"'* ]] || { echo 'relay identity is unavailable' >&2; exit 1; }
[[ "$KNOWN" != *$'\n'* && "$KNOWN" != *'"'* ]] || { echo 'invalid known-hosts path' >&2; exit 1; }

config="$(mktemp "${TMPDIR:-/tmp}/wsl-relay-ssh.XXXXXXXX")"
trap 'rm -f "$config"' EXIT
chmod 600 "$config"

# 连接复用（ControlMaster）：跳板+末端两跳都能免重复握手
CM_DIR="/tmp/home-connect-cm-$(id -u)"
mkdir -p "$CM_DIR" 2>/dev/null || true
chmod 700 "$CM_DIR" 2>/dev/null || true

# 服务端 post-quantum KEX 警告过滤（与 windows-ssh.sh / wsl.sh 同款）
pq_filter() {
  grep -a -vE '^\*\* (WARNING: connection is not using a post-quantum key exchange algorithm|This session may be vulnerable to "store now, decrypt later" attacks\.|The server may need to be upgraded\. See https://openssh\.com/pq\.html)' || true
}
ssh_run() {
  local rc=0 errtmp
  errtmp="$(mktemp "${TMPDIR:-/tmp}/wsl-relay-err.XXXXXXXX")"
  ssh -F "$config" "$@" 2>"$errtmp" || rc=$?
  pq_filter <"$errtmp" >&2
  rm -f "$errtmp"
  if (( rc != 0 )); then
    echo "提示：WSL2 约 60 秒无活动会自动关机（sshd 与反向隧道随之消失）；可跑 wake 子命令经 Windows 唤醒后重试" >&2
  fi
  return "$rc"
}

# WSL2 idle ~60s 自动关机的自愈：经 Windows 通道拉起 Ubuntu + sshd，反向隧道的
# systemd 用户服务随 WSL 启动自动恢复，再轮询中继末端就绪。探测不用 ssh_run，避免提示刷屏。
wake() {
  local distro="${WSL_DISTRO:-Ubuntu}" i werr
  echo "经 Windows 通道唤醒 ${distro}（systemctl start ssh.service），随后等反向隧道恢复..." >&2
  # wsl.exe 的 stderr 常带 UTF-16 警告噪音，成功时丢弃、失败时才回放（与 wsl.sh wake 同款）
  werr="$(mktemp "${TMPDIR:-/tmp}/wsl-relay-wake-err.XXXXXXXX")"
  if ! "$SCRIPT_DIR/windows.sh" win-sh "wsl -d $distro -u root -- systemctl start ssh.service" >/dev/null 2>"$werr"; then
    cat "$werr" >&2
    rm -f "$werr"
    echo '唤醒失败：Windows 通道执行 wsl 命令出错（上方为原始错误）' >&2
    return 1
  fi
  rm -f "$werr"
  for i in $(seq 1 15); do
    if ssh -F "$config" -o ConnectTimeout=3 wsl-relay-target 'true' 2>/dev/null; then
      echo 'WSL 中继已就绪（wsl-relay-target 可达）' >&2
      return 0
    fi
    sleep 2
  done
  echo '唤醒超时：中继末端仍不可达。检查 Windows 侧唤醒输出与反向隧道 systemd 服务' >&2
  return 1
}

cat > "$config" <<CFG
Host wsl-relay-hop
  HostName ${RELAY_HOST}
  User ${RELAY_ADMIN_USER}
  IdentityFile "${RELAY_IDENTITY}"
  IdentitiesOnly yes
  BatchMode yes
  ConnectTimeout 10
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600

Host wsl-relay-target
  HostName 127.0.0.1
  Port ${WSL_RELAY_PORT}
  User ${WSL_USER}
  HostKeyAlias wsl-relay-home
  UserKnownHostsFile "${KNOWN}"
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 10
  ServerAliveInterval 30
  ServerAliveCountMax 3
${WSL_RELAY_IDENTITY_LINE}
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600
  ProxyJump wsl-relay-hop
CFG

case "${1:---check}" in
  wake)
    wake
    ;;
  --check)
    ssh_run wsl-relay-target 'id -un' >/dev/null
    echo 'wsl_relay=ok'
    ;;
  status)
    ssh_run wsl-relay-target 'printf "wsl_relay=ok\n"; whoami; uptime -p; nvidia-smi --query-gpu=name,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null || true'
    ;;
  sh)
    shift
    # 用法一（推荐）：wsl-relay sh <<'EOF' —— stdin/heredoc 直通，任意引号零转义
    # 用法二：wsl-relay sh '<单行命令>' —— 本地单引号包裹，脚本内不能再出现单引号
    if [[ $# -eq 0 || ( $# -eq 1 && "$1" == "-" ) ]]; then
      if [[ -t 0 ]]; then
        echo "wsl-relay sh: stdin 是终端；用 heredoc（<<'EOF'）或管道提供脚本" >&2
        exit 2
      fi
      ssh_run wsl-relay-target 'bash -s'
    else
      [[ $# -eq 1 ]] || { echo "Usage: connect.sh sh '<命令>'（或 heredoc 走 stdin）" >&2; exit 2; }
      payload="$(printf '%s' "$1" | base64 | tr -d '\n')"
      ssh_run wsl-relay-target "printf %s '$payload' | base64 -d | /bin/bash"
    fi
    ;;
  exec)
    shift
    [[ $# -eq 1 && -f "$1" ]] || { echo 'Usage: connect.sh exec <local-script>' >&2; exit 2; }
    ssh_run wsl-relay-target 'bash -s' < "$1"
    ;;
  get|put)
    operation="$1"
    shift
    [[ "${WSL_RELAY_ALLOW_TRANSFER:-}" == 1 ]] || { echo 'relay transfer requires explicit approval: set WSL_RELAY_ALLOW_TRANSFER=1' >&2; exit 2; }
    [[ $# -eq 2 ]] || { echo "Usage: connect.sh $operation <source> <destination>" >&2; exit 2; }
    if [[ "$operation" == get ]]; then
      [[ "$1" == /* ]] || { echo 'remote path must be absolute' >&2; exit 2; }
      errtmp="$(mktemp "${TMPDIR:-/tmp}/wsl-relay-scp.XXXXXXXX")"
      scp -F "$config" "wsl-relay-target:$1" "$2" 2>"$errtmp" || rc=$?
      pq_filter <"$errtmp" >&2; rm -f "$errtmp"; exit "$rc"
    else
      [[ "$2" == /* ]] || { echo 'remote path must be absolute' >&2; exit 2; }
      errtmp="$(mktemp "${TMPDIR:-/tmp}/wsl-relay-scp.XXXXXXXX")"
      scp -F "$config" "$1" "wsl-relay-target:$2" 2>"$errtmp" || rc=$?
      pq_filter <"$errtmp" >&2; rm -f "$errtmp"; exit "$rc"
    fi
    ;;
  *) echo 'Usage: relay.sh [wake|--check|status|sh <command>|exec <local-script>|get <remote> <local>|put <local> <remote>]' >&2; exit 2 ;;
esac
