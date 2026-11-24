#!/usr/bin/env bash
# 无 WSL 密钥的机器（宿主 mac）经 Windows 的 wsl.exe 操作 WSL：不直连 WSL 的 sshd。
# 入口：--check|status|sh（stdin 脚本）|get <远程> <本地>|put <本地> <远程>|wake
# Windows OpenSSH 的默认 shell 是 cmd.exe：单引号不成组（原样传给 wsl.exe），只能用双引号；
# 交互文本走 stdin，文件走 base64（纯 ASCII，过 cmd 不会被重编码）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN="$SCRIPT_DIR/windows-ssh.sh"
WINDOWS_SH="$SCRIPT_DIR/windows.sh"
export WINDOWS_HOST_OVERRIDE="${HOME_WINDOWS_LAN_HOST:-192.168.31.25}"
DISTRO="${HOME_WSL_DISTRO:-Ubuntu}"
[[ -x "$WIN" && -x "$WINDOWS_SH" ]] || { echo "missing dependency: windows-ssh.sh / windows.sh" >&2; exit 1; }

safe_path() {
  [[ "$1" =~ ^[A-Za-z0-9_./~+-]+$ ]] || {
    echo "路径只允许字母数字与 _./~+-（经 cmd 传递，不能有空白或元字符）: $1" >&2; exit 2; }
}

base64_decode() {
  if printf 'aGk=' | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi
}

case "${1:-}" in
  --check)
    "$WIN" -- "wsl.exe -d $DISTRO --exec true"
    echo 'wsl_via_win=ok'
    ;;
  status)
    "$WIN" -- "wsl.exe -d $DISTRO --exec sh -c \"echo wsl_via_win=ok; whoami; uptime -p\""
    ;;
  sh)
    # stdin 整段交给 WSL 内的 bash：引号/中文/$ 零转义，退出码原样透传
    "$WIN" -- "wsl.exe -d $DISTRO -- bash -s"
    ;;
  get)
    remote="${2:?用法: wsl-via-win.sh get <远程路径> <本地路径>}"
    local_file="${3:?用法: wsl-via-win.sh get <远程路径> <本地路径>}"
    safe_path "$remote"
    tmp="$(mktemp "${TMPDIR:-/tmp}/wslwin-get.XXXXXXXX")"
    trap 'rm -f "$tmp" "$tmp.err"' EXIT
    rc=0
    "$WIN" -- "wsl.exe -d $DISTRO --exec base64 -w0 $remote" 2>"$tmp.err" | tr -d '\r\n' >"$tmp" || rc=$?
    if [[ $rc -ne 0 || ! -s "$tmp" ]]; then
      grep -a -v '^\*\* ' "$tmp.err" >&2 || true
      echo "wsl 取回失败 rc=$rc: $remote" >&2
      exit 1
    fi
    base64_decode <"$tmp" >"$local_file"
    ;;
  put)
    local_file="${2:?用法: wsl-via-win.sh put <本地路径> <远程路径>}"
    remote="${3:?用法: wsl-via-win.sh put <本地路径> <远程路径>}"
    safe_path "$remote"
    [[ -f "$local_file" ]] || { echo "本地文件不存在: $local_file" >&2; exit 1; }
    local_size="$(wc -c <"$local_file" | tr -d ' ')"
    base64 <"$local_file" | tr -d '\n' | "$WIN" -- "wsl.exe -d $DISTRO -- sh -c \"base64 -d > $remote\""
    remote_size="$("$WIN" -- "wsl.exe -d $DISTRO --exec stat -c %s $remote" 2>/dev/null | tr -d '\r\n' || true)"
    if [[ "$remote_size" != "$local_size" ]]; then
      echo "wsl put 核验失败: 远程=$remote_size 本地=$local_size ($remote)" >&2
      exit 1
    fi
    echo "wsl put 完成: $remote ($local_size bytes)"
    ;;
  wake)
    echo "经 Windows 通道唤醒 ${DISTRO}（systemctl start ssh.service）..." >&2
    werr="$(mktemp "${TMPDIR:-/tmp}/wslwin-wake-err.XXXXXXXX")"
    if ! "$WINDOWS_SH" win-sh "wsl -d $DISTRO -u root -- systemctl start ssh.service" >/dev/null 2>"$werr"; then
      cat "$werr" >&2
      rm -f "$werr"
      echo '唤醒失败：Windows 通道执行 wsl 命令出错（上方为原始错误）' >&2
      exit 1
    fi
    rm -f "$werr"
    for _ in $(seq 1 15); do
      if "$WIN" -- "wsl.exe -d $DISTRO --exec true" >/dev/null 2>&1; then
        echo "WSL 已就绪（经 Windows wsl.exe 可执行）" >&2
        exit 0
      fi
      sleep 2
    done
    echo '唤醒超时：wsl.exe 仍无法执行命令' >&2
    exit 1
    ;;
  *)
    echo "Usage: wsl-via-win.sh [--check|status|sh|get <远程> <本地>|put <本地> <远程>|wake]" >&2
    exit 2
    ;;
esac
