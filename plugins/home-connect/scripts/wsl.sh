#!/usr/bin/env bash
# 家中 Windows 的 WSL Ubuntu 直连（mirrored networking，端口 22）
# 入口：wake | status | sh ['<命令>'|-] | exec <本地脚本> | get <远程> <本地> | put <本地> <远程>
# 依赖：本机默认 SSH 身份（~/.ssh，用户手动装好 authorized_keys；agent 沙箱禁止触碰 ~/.ssh）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOME_CONNECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
CONFIG="$ROOT/config/wsl.env"
[[ -f "$CONFIG" ]] || { echo "missing config: $CONFIG" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"
HOST="${WSL_HOST_OVERRIDE:-${WSL_HOST:-192.168.31.25}}"
PORT="${WSL_PORT:-22}"
USER_NAME="${WSL_USER:-mhbzhy}"

# 连接复用（ControlMaster）：重复调用免重新握手；socket 目录按 uid 隔离
CM_DIR="/tmp/home-connect-cm-$(id -u)"
mkdir -p "$CM_DIR" 2>/dev/null || true
chmod 700 "$CM_DIR" 2>/dev/null || true
SSH_OPTS=(-p "$PORT" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto -o "ControlPath=$CM_DIR/%C" -o ControlPersist=600)
# scp 用 -P 传端口；身份选项必须与 ssh 同源，否则 put/get 会丢专用密钥被拒
SCP_OPTS=(-P "$PORT" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto -o "ControlPath=$CM_DIR/%C" -o ControlPersist=600)

# 可选：WSL 专用身份密钥。未配置时坐回默认身份（不改变其它机器已有行为）。
# 值为 ~/... 或相对 skill 根的路径。
if [[ -n "${WSL_IDENTITY:-}" ]]; then
  case "$WSL_IDENTITY" in
    '~/'*) wsl_key="${HOME}/${WSL_IDENTITY#\~/}" ;;
    /*) wsl_key="$WSL_IDENTITY" ;;
    *) wsl_key="$ROOT/${WSL_IDENTITY#./}" ;;
  esac
  if [[ -f "$wsl_key" ]]; then
    SSH_OPTS+=(-i "$wsl_key" -o IdentitiesOnly=yes)
    SCP_OPTS+=(-i "$wsl_key" -o IdentitiesOnly=yes)
  else
    echo "wsl identity not found, falling back to default: $wsl_key" >&2
  fi
fi

# 服务端 post-quantum KEX 警告过滤：stderr 先落盘再精确剔除三行回放，
# 真实错误与退出码原样透传（与 windows-ssh.sh 同款）
pq_filter() {
  grep -a -vE '^\*\* (WARNING: connection is not using a post-quantum key exchange algorithm|This session may be vulnerable to "store now, decrypt later" attacks\.|The server may need to be upgraded\. See https://openssh\.com/pq\.html)' || true
}
ssh_run() {
  local rc=0 errtmp
  errtmp="$(mktemp "${TMPDIR:-/tmp}/wsl-ssh-err.XXXXXXXX")"
  ssh "${SSH_OPTS[@]}" "$USER_NAME@$HOST" "$@" 2>"$errtmp" || rc=$?
  pq_filter <"$errtmp" >&2
  rm -f "$errtmp"
  if (( rc != 0 )); then
    echo "提示：WSL2 约 60 秒无活动会自动关机（sshd 随之消失）；可跑 wake 子命令经 Windows 唤醒后重试" >&2
  fi
  return "$rc"
}
scp_run() {
  local rc=0 errtmp
  errtmp="$(mktemp "${TMPDIR:-/tmp}/wsl-scp-err.XXXXXXXX")"
  scp "${SCP_OPTS[@]}" "$@" 2>"$errtmp" || rc=$?
  pq_filter <"$errtmp" >&2
  rm -f "$errtmp"
  if (( rc != 0 )); then
    echo "提示：WSL2 约 60 秒无活动会自动关机（sshd 随之消失）；可跑 wake 子命令经 Windows 唤醒后重试" >&2
  fi
  return "$rc"
}

# WSL2 idle ~60s 自动关机的自愈：经 Windows 通道拉起 Ubuntu + sshd（反向隧道的
# systemd 用户服务随 WSL 启动自动恢复），再轮询直连 ssh 就绪。探测不走 ssh_run，避免提示刷屏。
wake() {
  local distro="${WSL_DISTRO:-Ubuntu}" i werr
  echo "经 Windows 通道唤醒 ${distro}（systemctl start ssh.service）..." >&2
  # wsl.exe 的 stderr 常带 UTF-16 警告噪音（如 localhostForwarding 提示），成功时丢弃、失败时才回放
  werr="$(mktemp "${TMPDIR:-/tmp}/wsl-wake-err.XXXXXXXX")"
  if ! "$SCRIPT_DIR/windows.sh" win-sh "wsl -d $distro -u root -- systemctl start ssh.service" >/dev/null 2>"$werr"; then
    cat "$werr" >&2
    rm -f "$werr"
    echo '唤醒失败：Windows 通道执行 wsl 命令出错（上方为原始错误）' >&2
    return 1
  fi
  rm -f "$werr"
  for i in $(seq 1 15); do
    if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=2 "$USER_NAME@$HOST" 'true' 2>/dev/null; then
      echo "WSL 已就绪：${USER_NAME}@${HOST}:${PORT}（中继反向隧道随 WSL 启动自动恢复，稍慢属正常）" >&2
      return 0
    fi
    sleep 2
  done
  echo "唤醒超时：直连仍不可达。排查 Windows 通道输出、WSL sshd 与 LAN 路径" >&2
  return 1
}

case "${1:-}" in
  wake)
    wake
    ;;
  status)
    ssh_run 'echo wsl-direct=ok; whoami; uptime -p; nvidia-smi --query-gpu=name,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null || echo gpu=不可见; df -h / | tail -1'
    ;;
  sh)
    shift
    # 用法一（推荐）：wsl.sh sh <<'EOF' —— stdin/heredoc 直通，任意引号零转义
    # 用法二：wsl.sh sh '<单行命令>' —— 本地单引号包裹，脚本内不能再出现单引号
    if [[ $# -eq 0 || ( $# -eq 1 && "$1" == "-" ) ]]; then
      if [[ -t 0 ]]; then
        echo "wsl sh: stdin 是终端；用 heredoc（<<'EOF'）或管道提供脚本" >&2
        exit 2
      fi
      ssh_run 'bash -s'
    else
      [[ $# -eq 1 ]] || { echo "Usage: wsl.sh sh '<命令>'（或 heredoc 走 stdin）" >&2; exit 2; }
      # base64 载荷：本地零转义、远程零转义（载荷只有 [A-Za-z0-9+/=]）
      payload="$(printf '%s' "$1" | base64 | tr -d '\n')"
      ssh_run "printf %s '$payload' | base64 -d | /bin/bash"
    fi
    ;;
  exec)
    shift
    [[ $# -eq 1 && -f "$1" ]] || { echo "Usage: connect.sh exec <本地脚本文件>" >&2; exit 1; }
    # stdin 整体执行：任意内容（引号/中文/$/反引号）零转义，无大小限制；
    # 与 sh 的 stdin 模式等价，保留给已有调用方
    ssh_run 'bash -s' < "$1"
    ;;
  get)
    shift
    [[ $# -eq 2 ]] || { echo "Usage: connect.sh get <远程路径> <本地路径>" >&2; exit 1; }
    scp_run "$USER_NAME@$HOST:$1" "$2"
    ;;
  put)
    shift
    [[ $# -eq 2 ]] || { echo "Usage: connect.sh put <本地路径> <远程路径>" >&2; exit 1; }
    scp_run "$1" "$USER_NAME@$HOST:$2"
    ;;
  *)
    echo "Usage: wsl.sh [wake|status|sh '<命令>'|exec <本地脚本>|get <远程> <本地>|put <本地> <远程>]" >&2
    exit 1
    ;;
esac
