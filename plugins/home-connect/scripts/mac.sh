#!/usr/bin/env bash
set -euo pipefail

ROOT="${HOME_CONNECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT_ENV="${HOME_MAC_ROOT_ENV:-${ROOT}/.env}"
CONFIG_FILE="${HOME_TUNNEL_CONFIG:-${ROOT}/config/mac-tunnel.env}"

usage() {
  cat <<'USAGE'
Usage: scripts/connect.sh [--check|lan-check|status|sh|get <remote> [local]|get-lan <absolute-remote-path> [local]|put-lan <local-file> <absolute-remote-path>|-- <remote command>]

  (no args)         interactive SSH session to the home Mac
  --check           non-interactive hostname probe through the relay
  sh                run a remote shell script: stdin/heredoc (recommended, zero
                    quoting) or a single-quoted one-liner argument; goes through
                    the relay - see also `lan sh`
  lan-check         non-interactive hostname probe directly over the LAN
  lan -- <cmd...>   run a remote command directly over the LAN (no relay); on home LAN only
  lan sh            run a remote shell script over the LAN: stdin/heredoc or a
                    single-quoted one-liner
  --sudo            run a remote command via sudo (password from skill .env ROOT_PWD,
                    fed on stdin first line; never echoed)
  status            three-step diagnosis: relay listener / home Mac LAN / end-to-end
  get <remote> [local]
                    fetch exactly one remote file (absolute path); default local
                    destination mirrors the remote path under .remote-files/
                    NOTE: goes through the metered relay - for large files prefer
                    get-lan while on the home LAN (run lan-check first)
  get --stdout <remote>
                    print the remote file to stdout
  get-lan <absolute-remote-path> [local]
                    fetch one remote file directly over the LAN (no relay, no
                    metered traffic); run lan-check first, fails fast when not
                    on the home LAN; default local destination is ./basename
  put-lan <local-file> <absolute-remote-path>
                    upload one regular local file directly over the LAN
USAGE
}

expand_path() {
  local value="$1"
  case "${value}" in
    "~"|"~/"*) printf '%s\n' "${HOME}${value#\~}" ;;
    /*) printf '%s\n' "${value}" ;;
    *) printf '%s/%s\n' "${ROOT}" "${value#./}" ;;
  esac
}

[[ -f "${CONFIG_FILE}" ]] || {
  printf 'Missing config: %s\n' "${CONFIG_FILE}" >&2
  exit 1
}

# shellcheck disable=SC1090
source "${CONFIG_FILE}"

[[ "${REMOTE_PORT}" =~ ^[0-9]+$ ]] || {
  printf 'REMOTE_PORT must be numeric\n' >&2
  exit 1
}
[[ "${REMOTE_BIND_HOST}" =~ ^[A-Za-z0-9_.:-]+$ ]] || {
  printf 'REMOTE_BIND_HOST contains unsupported characters\n' >&2
  exit 1
}

RELAY_IDENTITY="$(expand_path "${RELAY_IDENTITY}")"
HOME_MAC_IDENTITY="$(expand_path "${HOME_MAC_IDENTITY}")"
for key in "${RELAY_IDENTITY}" "${HOME_MAC_IDENTITY}"; do
  [[ -f "${key}" ]] || {
    printf 'Missing identity file: %s\n' "${key}" >&2
    exit 1
  }
done

tmp_config=""
tmp_download=""
errtmp=""
trap '[[ -z "${tmp_config}" ]] || rm -f "${tmp_config}"; [[ -z "${tmp_download}" ]] || rm -f "${tmp_download}"; [[ -z "${errtmp}" ]] || rm -f "${errtmp}"' EXIT

# 连接复用（ControlMaster）：中继两跳与 LAN 直连都免重复握手；socket 目录按 uid 隔离
CM_DIR="/tmp/home-connect-cm-$(id -u)"
mkdir -p "${CM_DIR}" 2>/dev/null || true
chmod 700 "${CM_DIR}" 2>/dev/null || true
CM_OPTS=(-o ControlMaster=auto -o "ControlPath=${CM_DIR}/%C" -o ControlPersist=600)

# 服务端 post-quantum KEX 警告过滤：stderr 先落盘再精确剔除三行回放，
# 真实错误与退出码原样透传（与 windows-ssh.sh 同款）
pq_filter() {
  grep -a -vE '^\*\* (WARNING: connection is not using a post-quantum key exchange algorithm|This session may be vulnerable to "store now, decrypt later" attacks\.|The server may need to be upgraded\. See https://openssh\.com/pq\.html)' || true
}
new_errtmp() {
  [[ -z "${errtmp:-}" ]] || rm -f "${errtmp}"
  errtmp="$(mktemp "${TMPDIR:-/tmp}/home-mac-err.XXXXXXXX")"
  printf '%s' "${errtmp}"
}
relay_ssh() {
  local rc=0
  new_errtmp >"/dev/null"
  ssh -F "${tmp_config}" "${CM_OPTS[@]}" "$@" 2>"${errtmp}" || rc=$?
  pq_filter <"${errtmp}" >&2
  return "${rc}"
}
lan_ssh() {
  local rc=0
  new_errtmp >"/dev/null"
  ssh -i "${HOME_MAC_IDENTITY}" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new "${CM_OPTS[@]}" \
    "${HOME_MAC_USER}@${HOME_MAC_LAN_HOST}" "$@" 2>"${errtmp}" || rc=$?
  pq_filter <"${errtmp}" >&2
  return "${rc}"
}

create_relay_config() {
  [[ -n "${tmp_config}" ]] && return
  tmp_config="$(mktemp "${TMPDIR:-/tmp}/home-mac-ssh.XXXXXX")"
  cat >"${tmp_config}" <<SSHCONFIG
Host ${RELAY_SSH_ALIAS}
  HostName ${RELAY_HOST}
  User ${RELAY_ADMIN_USER}
  IdentityFile "${RELAY_IDENTITY}"
  IdentitiesOnly yes
  ConnectTimeout 10
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600

Host ${HOME_SSH_ALIAS}
  HostName ${REMOTE_BIND_HOST}
  Port ${REMOTE_PORT}
  User ${HOME_MAC_USER}
  IdentityFile "${HOME_MAC_IDENTITY}"
  IdentitiesOnly yes
  ConnectTimeout 10
  HostKeyAlias ${HOME_HOST_KEY_ALIAS}
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ${CM_DIR}/%C
  ControlPersist 600
  ProxyJump ${RELAY_SSH_ALIAS}
SSHCONFIG
}

# 远程脚本执行（stdin/heredoc 直通或单行参数）—— agent 的日常入口
# 用法一（推荐）：mac.sh sh <<'EOF' … EOF（任意引号零转义，等同直接操作远程 bash）
# 用法二：mac.sh sh '<单行命令>'（本地单引号包裹，命令内不能再出现单引号）
run_script_stdin_or_arg() {
  local transport="$1"  # relay | lan
  shift
  if [[ $# -eq 0 || ( $# -eq 1 && "$1" == "-" ) ]]; then
    if [[ -t 0 ]]; then
      echo "mac ${transport} sh: stdin 是终端；用 heredoc（<<'EOF'）或管道提供脚本" >&2
      exit 2
    fi
    if [[ "${transport}" == lan ]]; then
      lan_ssh 'bash -s'
    else
      relay_ssh "${HOME_SSH_ALIAS}" 'bash -s'
    fi
  else
    [[ $# -eq 1 ]] || { echo "Usage: connect.sh ${transport} sh '<命令>'（或 heredoc 走 stdin）" >&2; exit 2; }
    if [[ "${transport}" == lan ]]; then
      lan_ssh "$1"
    else
      relay_ssh "${HOME_SSH_ALIAS}" "$1"
    fi
  fi
}

mode="${1:-connect}"
case "${mode}" in
  --check)
    create_relay_config
    relay_ssh -o BatchMode=yes "${HOME_SSH_ALIAS}" hostname
    exit "$?"
    ;;
  lan-check)
    new_errtmp >/dev/null
    rc=0
    ssh -i "${HOME_MAC_IDENTITY}" -o BatchMode=yes -o ConnectTimeout=5 \
      -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "${CM_OPTS[@]}" \
      "${HOME_MAC_USER}@${HOME_MAC_LAN_HOST}" hostname 2>"${errtmp}" || rc=$?
    pq_filter <"${errtmp}" >&2
    exit "${rc}"
    ;;
  sh)
    shift
    create_relay_config
    run_script_stdin_or_arg relay "$@"
    exit "$?"
    ;;
  status)
    create_relay_config
    status_failed=0
    printf 'Relay listener:\n'
    new_errtmp >/dev/null
    rc=0
    ssh -i "${RELAY_IDENTITY}" -o IdentitiesOnly=yes -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=accept-new "${CM_OPTS[@]}" "${RELAY_ADMIN_USER}@${RELAY_HOST}" \
      "ss -ltn sport = :${REMOTE_PORT}" 2>"${errtmp}" || rc=$?
    pq_filter <"${errtmp}" >&2
    [[ ${rc} -eq 0 ]] || status_failed=1
    printf '\nHome Mac LAN check:\n'
    if lan_ssh hostname; then :; else status_failed=1; fi
    printf '\nEnd-to-end check:\n'
    if relay_ssh -o BatchMode=yes "${HOME_SSH_ALIAS}" hostname; then :; else status_failed=1; fi
    exit "${status_failed}"
    ;;
  get)
    create_relay_config
    [[ $# -ge 2 ]] || {
      usage >&2
      exit 2
    }
    remote="$2"
    case "${remote}" in
      --stdout)
        [[ $# -ge 3 ]] || {
          usage >&2
          exit 2
        }
        [[ "$3" == /* ]] || {
          printf 'Remote path must be absolute\n' >&2
          exit 2
        }
        tmp_download="$(mktemp "${TMPDIR:-/tmp}/home-mac-get.XXXXXXXX")"
        new_errtmp >/dev/null
        rc=0
        scp -F "${tmp_config}" "${CM_OPTS[@]}" "${HOME_SSH_ALIAS}:${3}" "${tmp_download}" 2>"${errtmp}" || rc=$?
        pq_filter <"${errtmp}" >&2
        [[ ${rc} -eq 0 ]] || exit "${rc}"
        cat "${tmp_download}"
        exit 0
        ;;
      /*)
        local_path="${3:-${ROOT}/.remote-files/${remote#/}}"
        mkdir -p "$(dirname "${local_path}")"
        new_errtmp >/dev/null
        rc=0
        scp -F "${tmp_config}" "${CM_OPTS[@]}" "${HOME_SSH_ALIAS}:${remote}" "${local_path}" 2>"${errtmp}" || rc=$?
        pq_filter <"${errtmp}" >&2
        exit "${rc}"
        ;;
      *)
        printf 'Remote path must be absolute\n' >&2
        exit 2
        ;;
    esac
    ;;
  get-lan)
    [[ $# -ge 2 && $# -le 3 ]] || {
      usage >&2
      exit 2
    }
    case "$2" in
      /*) ;;
      *)
        printf 'Remote path must be absolute\n' >&2
        exit 2
        ;;
    esac
    local_path="${3:-$(basename "$2")}"
    new_errtmp >/dev/null
    rc=0
    scp -i "${HOME_MAC_IDENTITY}" -o IdentitiesOnly=yes -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=accept-new "${CM_OPTS[@]}" \
      "${HOME_MAC_USER}@${HOME_MAC_LAN_HOST}:$2" "${local_path}" 2>"${errtmp}" || rc=$?
    pq_filter <"${errtmp}" >&2
    exit "${rc}"
    ;;
  put-lan)
    [[ $# -eq 3 ]] || {
      usage >&2
      exit 2
    }
    [[ -f "$2" && ! -L "$2" ]] || {
      printf 'Local path must be a regular file\n' >&2
      exit 2
    }
    case "$3" in
      /*) ;;
      *)
        printf 'Remote path must be absolute\n' >&2
        exit 2
        ;;
    esac
    new_errtmp >/dev/null
    rc=0
    scp -i "${HOME_MAC_IDENTITY}" -o IdentitiesOnly=yes -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=accept-new "${CM_OPTS[@]}" \
      "$2" "${HOME_MAC_USER}@${HOME_MAC_LAN_HOST}:$3" 2>"${errtmp}" || rc=$?
    pq_filter <"${errtmp}" >&2
    exit "${rc}"
    ;;
  lan)
    shift
    [[ $# -ge 1 ]] || { usage >&2; exit 2; }
    if [[ "$1" == sh ]]; then
      shift
      run_script_stdin_or_arg lan "$@"
      exit "$?"
    fi
    [[ "$1" == "--" ]] && shift
    [[ $# -ge 1 ]] || { usage >&2; exit 2; }
    lan_ssh "$@"
    exit "$?"
    ;;
  --)
    create_relay_config
    shift
    relay_ssh "$@"
    exit "$?"
    ;;
  --sudo)
    create_relay_config
    shift
    [[ $# -ge 1 ]] || {
      usage >&2
      exit 2
    }
    SUDO_PWD=""
    if [[ -f "${ROOT_ENV}" ]]; then
      SUDO_PWD="$(sed -n 's/^ROOT_PWD=//p' "${ROOT_ENV}" | head -1)"
    fi
    [[ -n "${SUDO_PWD}" ]] || {
      printf 'Missing ROOT_PWD in %s/.env (or empty value)\n' "${ROOT}" >&2
      exit 1
    }
    remote="$(printf '%q ' "$@")"
    new_errtmp >/dev/null
    rc=0
    {
      printf '%s\n' "${SUDO_PWD}"
      cat
    } | ssh -F "${tmp_config}" "${CM_OPTS[@]}" "${HOME_SSH_ALIAS}" "sudo -S -p '' -- bash -c ${remote}" 2>"${errtmp}" || rc=$?
    pq_filter <"${errtmp}" >&2
    exit "${rc}"
    ;;
  *)
    # 底层原语：无参数 = 交互 SSH；带参数 = 命令直传（经中继）。日常请用 sh / lan sh
    create_relay_config
    ssh -F "${tmp_config}" "${CM_OPTS[@]}" "${HOME_SSH_ALIAS}" "$@"
    exit "$?"
    ;;
esac
