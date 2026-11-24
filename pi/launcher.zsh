#!/usr/bin/env zsh
# pi/launcher.zsh — session-owner 启动预检与真实 pi 进程拉起。
emulate -LR zsh
setopt err_return no_unset pipe_fail

pi_root=${${(%):-%N}:A:h}
launcher_path=${(%):-%N:A}
node_bin=${PI_HOST_NODE:-$(whence -p node 2>/dev/null || true)}
[[ "$node_bin" == /* && -f "$node_bin" && -x "$node_bin" ]] || { print -u2 -- "错误: 未找到可用 Node.js（session-owner 需要 Node >= 22.19.0）"; exit 1; }
node_bin=${node_bin:A}
node_ok=$("$node_bin" -p 'const [a,b]=process.versions.node.split(".").map(Number);a>22||(a===22&&b>=19)?"yes":"no"') || exit 1
[[ "$node_ok" == yes ]] || { print -u2 -- "错误: Node 版本必须 >= 22.19.0"; exit 1; }

# 解析真实 pi 可执行文件：优先 PI_REAL_BIN，其次 PATH 中的物理 pi（排除自身 launcher）
real_bin="${PI_REAL_BIN:-}"
if [[ -z "$real_bin" ]]; then
  real_bin="$(whence -p pi 2>/dev/null || true)"
fi
if [[ -z "$real_bin" || ! -e "$real_bin" || "${real_bin:A}" == "$launcher_path" ]]; then
  print -u2 -- "错误: 未找到 pi 可执行文件。请先安装 @earendil-works/pi-coding-agent，或通过 PI_REAL_BIN 指定路径。"
  exit 1
fi
real_bin=${real_bin:A}

_exec_pi() {
  case "$real_bin" in
    *.js|*.mjs|*.cjs) exec "$node_bin" "$real_bin" "$@" ;;
    *) exec "$real_bin" "$@" ;;
  esac
}

decision_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-session-owner.XXXXXXXX") || exit 1
chmod 700 "$decision_dir" || { rmdir "$decision_dir"; exit 1; }
cleanup() { rm -rf -- "$decision_dir" }
trap cleanup EXIT HUP INT TERM

private_file() {
  local path=$1 metadata uid mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  if [[ "$(/usr/bin/uname -s)" == Darwin ]]; then metadata=$(/usr/bin/stat -f '%u %Lp' -- "$path")
  else metadata=$(/usr/bin/stat -c '%u %a' -- "$path"); fi
  uid=${metadata%% *}; mode=${metadata##* }
  [[ "$uid" == "$EUID" && "$mode" == 600 ]]
}
private_directory() {
  local path=$1 metadata uid mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  if [[ "$(/usr/bin/uname -s)" == Darwin ]]; then metadata=$(/usr/bin/stat -f '%u %Lp' -- "$path")
  else metadata=$(/usr/bin/stat -c '%u %a' -- "$path"); fi
  uid=${metadata%% *}; mode=${metadata##* }
  [[ "$uid" == "$EUID" && "$mode" == 700 ]]
}
private_text() {
  local path="$decision_dir/$1"
  private_file "$path" || return 1
  REPLY=$(<"$path")
  [[ "$REPLY" != *$'\n'* && "$REPLY" != *$'\r'* ]]
}

# 提前确定 registry 目录，使 prepare 决策日志与运行期 extension 使用同一路径
registry_dir="${PI_SESSION_OWNER_REGISTRY:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-session-owner-${EUID}}"
export PI_SESSION_OWNER_REGISTRY="$registry_dir"

stdin_tty=0; stdout_tty=0
[[ -t 0 ]] && stdin_tty=1
[[ -t 1 ]] && stdout_tty=1
"$node_bin" "$pi_root/scripts/pi-session-owner.ts" prepare --pid "$$" --cwd "$PWD" --stdin-tty "$stdin_tty" --stdout-tty "$stdout_tty" --decision-dir "$decision_dir" --pi-binary "$real_bin" -- "$@" >/dev/null || exit 1

private_directory "$decision_dir" || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
private_text action || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
action=$REPLY
case "$action" in
  blocked)
    print -u2 -- 'Pi session 已阻断：目标正被其他 Pi 使用。请回到原窗口；或运行普通 `pi` 新建 session；关闭占用窗口后重试 `pi -c`。'
    exit 1
    ;;
  bypass)
    unset PI_SESSION_OWNER_ID PI_SESSION_OWNER_REGISTRY
    cleanup; trap - EXIT HUP INT TERM
    _exec_pi "$@"
    ;;
  pass|pin-session) ;;
  *) print -u2 -- "Pi launch decision is invalid"; exit 1 ;;
esac

private_text owner-id || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
owner_id=$REPLY
[[ "$owner_id" =~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$' ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }

args=("$@")
if [[ "$action" == pin-session ]]; then
  private_text continue-arg-index || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  continue_index=$REPLY
  [[ "$continue_index" =~ '^[0-9]+$' && "$continue_index" -lt ${#args} ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  [[ "${args[$((continue_index + 1))]}" == -c || "${args[$((continue_index + 1))]}" == --continue ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  session_file="$decision_dir/session-path"
  private_file "$session_file" || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  exec {session_fd}<"$session_file"
  IFS= read -r -d '' -u $session_fd session_path || { exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1; }
  if IFS= read -r -d '' -u $session_fd extra; then
    exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1
  elif [[ -n "$extra" ]]; then
    exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1
  fi
  exec {session_fd}<&-
  [[ -n "$session_path" && -e "$session_path" ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  rewritten=()
  for (( index = 1; index <= ${#args}; index += 1 )); do
    (( index == continue_index + 1 )) || rewritten+=("${args[index]}")
  done
  args=(--session "$session_path" "${rewritten[@]}")
fi

export PI_SESSION_OWNER_ID="$owner_id"

# 为长生命周期 Pi 进程保留充足堆内存与近 OOM 诊断快照
heap_diagnostic_dir="${${PI_HEAP_DIAGNOSTIC_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/diagnostics/heap}:a}"
if mkdir -p "$heap_diagnostic_dir" && chmod 700 "$heap_diagnostic_dir"; then
  node_heap_mb="${PI_NODE_MAX_OLD_SPACE_SIZE:-8192}"
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_heap_mb} --heapsnapshot-near-heap-limit=2 --diagnostic-dir=${heap_diagnostic_dir}"
fi

cleanup; trap - EXIT HUP INT TERM
_exec_pi -e "$pi_root/extensions/session-owner/session-owner.ts" "${args[@]}"
