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

node_heap_mb=""
heap_diagnostic_dir=""

# 交互式会话专属的锁版包清单（如 pi-subagents）：不写入 settings.json，因此 pi-worker 与 bypass 模式不会加载
interactive_manifest="$pi_root/interactive-packages.json"
interactive_manifest_check='const fs = require("node:fs");
const file = process.env.PI_INTERACTIVE_MANIFEST;
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (error) { process.stderr.write(`错误: ${file} 不是合法 JSON: ${error.message}\n`); process.exit(1); }
if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.packages)
    || !data.packages.every((pkg) => typeof pkg === "string" && pkg.trim().length > 0)) {
  process.stderr.write(`错误: ${file} 的 packages 必须是非空字符串组成的数组\n`);
  process.exit(1);
}
process.stdout.write(data.packages.join("\0"));'

# 读取 interactive-packages.json 的 packages 字符串数组到 interactive_pkgs（以 NUL 分隔，防止含空格的参数被错误切分）；文件不存在时静默跳过
_load_interactive_packages() {
  interactive_pkgs=()
  [[ -f "$interactive_manifest" ]] || return 0
  local stream=""
  if ! stream=$(PI_INTERACTIVE_MANIFEST="$interactive_manifest" "$node_bin" -e "$interactive_manifest_check"); then
    print -u2 -- "错误: 无法加载 $interactive_manifest"
    return 1
  fi
  [[ -n "$stream" ]] || return 0
  interactive_pkgs=("${(@0)stream}")
  (( ${#interactive_pkgs} > 0 )) || return 1
}

_exec_pi() {
  local -a heap_flags=()
  if [[ -n "${node_heap_mb:-}" && -n "${heap_diagnostic_dir:-}" ]]; then
    heap_flags=(
      "--max-old-space-size=${node_heap_mb}"
      "--heapsnapshot-near-heap-limit=2"
      "--diagnostic-dir=${heap_diagnostic_dir}"
    )
  fi
  case "$real_bin" in
    *.js|*.mjs|*.cjs) exec "$node_bin" "${heap_flags[@]}" "$real_bin" "$@" ;;
    *)
      local first_line=""
      IFS= read -r first_line < "$real_bin" || true
      if [[ "$first_line" == '#!'*node* ]]; then
        exec "$node_bin" "${heap_flags[@]}" "$real_bin" "$@"
      fi
      exec "$real_bin" "$@"
      ;;
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

# 与 contract.ts 的 VALUE_OPTIONS 保持一致：这些参数的下一个 token 是值，不能被当作 -e/--extension 的扩展名或 --agent-dir
pi_value_options=(-n -t -xt --use-theme --tui-mode -e --extension --skill --prompt-template --theme --provider --model --models --thinking --tools --exclude-tools --api-key --name --system-prompt --append-system-prompt --session-dir --agent-dir --session --session-id --fork --mode --export)

# 扫描 `--` 之前的参数：收集已有的 -e/--extension 扩展列表（OSC 7577 Program Resume 恢复命令会原样重复）与 --agent-dir <dir>
args_agent_dir=""
existing_extensions=()
for (( index = 1; index <= ${#args}; index += 1 )); do
  arg="${args[index]}"
  [[ "$arg" == -- ]] && break
  if [[ "$arg" == -e || "$arg" == --extension ]]; then
    (( index < ${#args} )) || break
    (( index += 1 ))
    existing_extensions+=("${args[index]}")
  elif [[ "$arg" == --agent-dir ]]; then
    (( index < ${#args} )) || break
    (( index += 1 ))
    args_agent_dir="${args[index]}"
  elif [[ " ${pi_value_options[*]} " == *" $arg "* ]]; then
    (( index += 1 ))
  fi
done
case "$args_agent_dir" in
  "~") args_agent_dir="$HOME" ;;
  "~/"*) args_agent_dir="$HOME/${args_agent_dir#\~/}" ;;
  "") unset args_agent_dir ;;
esac

# 判断扩展是否已由用户参数传入：非本地路径（npm:/git: 等）精确匹配，本地路径按规范化后的绝对路径比较
_extension_present() {
  local candidate=$1 ext
  local normalized=${candidate:A}
  for ext in "${existing_extensions[@]}"; do
    [[ "$ext" == "$candidate" ]] && return 0
    [[ "$ext" != *:* && "${ext:A}" == "$normalized" ]] && return 0
  done
  return 1
}

# 为长生命周期 Pi 进程保留充足堆内存与近 OOM 诊断快照（仅直传 Pi 主进程，不通过 NODE_OPTIONS 泄漏给下游子进程）
# Pi 1.7.0 的 --agent-dir 与 PI_CODING_AGENT_DIR 一样决定诊断目录
if [[ -n "${PI_HEAP_DIAGNOSTIC_DIR:-}" ]]; then
  heap_diagnostic_dir="${PI_HEAP_DIAGNOSTIC_DIR:a}"
elif [[ -n "${args_agent_dir:-}" ]]; then
  heap_diagnostic_dir="${args_agent_dir:A}/diagnostics/heap"
else
  heap_base="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  heap_diagnostic_dir="${heap_base:a}/diagnostics/heap"
fi
if mkdir -p "$heap_diagnostic_dir" && chmod 700 "$heap_diagnostic_dir"; then
  node_heap_mb="${PI_NODE_MAX_OLD_SPACE_SIZE:-8192}"
else
  heap_diagnostic_dir=""
  node_heap_mb=""
fi

_load_interactive_packages
# 仅注入尚未由用户参数（含终端 OSC 7577 恢复命令）传入的扩展，避免 Pi 1.7.0 下重复 -e
inject_flags=()
_extension_present "$pi_root/extensions/session-owner/session-owner.ts" || inject_flags+=(-e "$pi_root/extensions/session-owner/session-owner.ts")
for pkg in "${interactive_pkgs[@]}"; do
  _extension_present "$pkg" || inject_flags+=(-e "$pkg")
done

cleanup; trap - EXIT HUP INT TERM
_exec_pi "${inject_flags[@]}" "${args[@]}"
