#!/usr/bin/env bash
set -euo pipefail
ROOT="${HOME_CONNECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG="$ROOT/config/windows.env"
KEY="${HOME_CONNECT_WIN_KEY:-$ROOT/.ssh/windows_ed25519}"
KNOWN="${ROOT}/.ssh/known_hosts"
SSH_BIN="${SSH_BIN:-$(command -v ssh)}"
SFTP_BIN="${SFTP_BIN:-$(command -v sftp)}"

[[ -f "$CONFIG" && -f "$KEY" && -f "$KNOWN" ]] || { echo 'home-connect Windows credentials are incomplete' >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
WINDOWS_HOST="${WINDOWS_HOST_OVERRIDE:-$WINDOWS_HOST}"
for v in WINDOWS_HOST WINDOWS_USER WINDOWS_PORT WINDOWS_HOST_KEY_ALIAS; do [[ -n "${!v:-}" ]] || { echo "missing $v" >&2; exit 1; }; done
[[ "$WINDOWS_PORT" =~ ^[0-9]+$ ]]
chmod 600 "$CONFIG" "$KEY" "$KNOWN"

tmp="$(mktemp)"
errtmp="$(mktemp)"
trap 'rm -f "$tmp" "$errtmp"' EXIT
chmod 600 "$tmp" "$errtmp"

# 连接复用：首次握手建 master，后续调用（win-exec 的落盘+执行、win-put 的上传+核验
# 都是双连接）全部走多路复用通道——LAN 下近乎本地速度，中继路径省一半握手往返。
# socket 目录固定（跨调用共享），目录私有防他人捲接；master 断线后 auto 语义自动重建。
CM_DIR="/tmp/home-connect-cm-$(id -u)"
mkdir -p "$CM_DIR" && chmod 700 "$CM_DIR" 2>/dev/null || true

# 过滤 OpenSSH 客户端的 post-quantum KEX 警告：每条工具结果 3-6 行纯噪音（对经本通道
# 运行的远程模型会话是双重浪费）；其余 stderr 原样透传，退出码不受影响
pq_filter() {
  grep -a -vE '^\*\* (WARNING: connection is not using a post-quantum key exchange algorithm|This session may be vulnerable to "store now, decrypt later" attacks\.|The server may need to be upgraded\. See https://openssh\.com/pq\.html)' || true
}

if [[ "${WINDOWS_VIA_RELAY:-0}" == "1" ]]; then
  MAC_CONFIG="$ROOT/config/mac-tunnel.env"
  RELAY_CONFIG="$ROOT/config/relay.env"
  [[ -f "$MAC_CONFIG" && -f "$RELAY_CONFIG" ]] || { echo 'windows relay configuration is incomplete' >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$MAC_CONFIG"
  # shellcheck disable=SC1090
  source "$RELAY_CONFIG"
  [[ -n "${RELAY_HOST:-}" && -n "${RELAY_ADMIN_USER:-}" && -n "${WINDOWS_RELAY_PORT:-}" ]] || { echo 'missing windows relay settings' >&2; exit 1; }
  [[ "$WINDOWS_RELAY_PORT" =~ ^[0-9]+$ ]] || { echo 'invalid WINDOWS_RELAY_PORT' >&2; exit 1; }
  case "${RELAY_IDENTITY:-}" in
    '~/'*) RELAY_IDENTITY="${HOME}/${RELAY_IDENTITY#\~/}" ;;
    /*) ;;
    '') ;;
    *) RELAY_IDENTITY="${ROOT}/${RELAY_IDENTITY#./}" ;;
  esac
  [[ -f "${RELAY_IDENTITY:-}" ]] || { echo 'relay identity is unavailable' >&2; exit 1; }
  cat > "$tmp" <<CFG
Host windows-relay-hop
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

Host windows-openssh-target
  HostName 127.0.0.1
  Port ${WINDOWS_RELAY_PORT}
  User ${WINDOWS_USER}
  IdentityFile "${KEY}"
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile "${KNOWN}"
  HostKeyAlias ${WINDOWS_HOST_KEY_ALIAS}
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  ConnectTimeout 10
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600
  ProxyJump windows-relay-hop
CFG
else
  cat > "$tmp" <<CFG
Host windows-openssh-target
  HostName ${WINDOWS_HOST}
  User ${WINDOWS_USER}
  Port ${WINDOWS_PORT}
  IdentityFile "${KEY}"
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile "${KNOWN}"
  HostKeyAlias ${WINDOWS_HOST_KEY_ALIAS}
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  ConnectTimeout 10
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600
CFG
fi

case "${1:-connect}" in
  --check|status)
    rc=0
    "$SSH_BIN" -F "$tmp" -o BatchMode=yes windows-openssh-target 'cmd.exe /d /c echo WINDOWS_OPENSSH_OK' >/dev/null 2>"$errtmp" || rc=$?
    pq_filter <"$errtmp" >&2
    [[ $rc -eq 0 ]] || exit $rc
    echo 'windows_openssh=ok'
    ;;
  --tty)
    shift
    [[ $# -gt 0 ]] || { echo 'missing remote command' >&2; exit 2; }
    exec "$SSH_BIN" -tt -F "$tmp" windows-openssh-target "$@"
    ;;
  --sftp-batch)
    # 批量上传：单条 sftp 会话执行 batch 文件里的全部 put（会话内串行，无并发通道问题）。
    # batch 文件由调用方生成（每行 put "本地" "远程"），遇错即退。
    shift
    [[ $# -eq 1 && -f "$1" ]] || { echo '用法: windows-ssh.sh --sftp-batch <batch文件>' >&2; exit 2; }
    rc=0
    "$SFTP_BIN" -F "$tmp" -b "$1" windows-openssh-target 2>"$errtmp" || rc=$?
    pq_filter <"$errtmp" >&2
    exit "$rc"
    ;;
  --sftp-put)
    # sftp 子系统上传：与 ssh 同一账户/密钥/通道配置（sshd 已配 Subsystem sftp sftp-server.exe），
    # 无需额外凭据。绕开 cmd→PowerShell→conhost 层——并发多路复用 exec channel 的 stdin
    # 投递在 Windows OpenSSH 上会卡死（实测 7 并发 6 个 hang >60s），sftp 子系统不受影响。
    shift
    [[ $# -eq 2 ]] || { echo '用法: windows-ssh.sh --sftp-put <本地文件> <远程绝对路径>' >&2; exit 2; }
    # 远端绝对路径须写 /D:/...（前导斜杠 + 盘符）：Windows sftp-server 把无前导斜杠的 D:/ 当相对路径拼 home
    remote_sftp="/${2//\\//}"
    rc=0
    printf 'put "%s" "%s"\n' "$1" "$remote_sftp" | "$SFTP_BIN" -F "$tmp" -b - windows-openssh-target 2>"$errtmp" || rc=$?
    pq_filter <"$errtmp" >&2
    exit "$rc"
    ;;
  --)
    shift
    [[ $# -gt 0 ]] || { echo 'missing remote command' >&2; exit 2; }
    # 不用 exec：stderr 先落临时文件再过滤回放（同步无竞态），退出码原样传递
    rc=0
    "$SSH_BIN" -F "$tmp" windows-openssh-target "$@" 2>"$errtmp" || rc=$?
    pq_filter <"$errtmp" >&2
    exit "$rc"
    ;;
  connect)
    exec "$SSH_BIN" -F "$tmp" windows-openssh-target
    ;;
  *)
    exec "$SSH_BIN" -F "$tmp" windows-openssh-target "$@"
    ;;
esac
