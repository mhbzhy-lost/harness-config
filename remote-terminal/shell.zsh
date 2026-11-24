# remote-terminal shell 包装：为任意命令（pi / qwen / agy / claude / 任意 CLI / 普通 shell）
# 提供统一 tmux 会话托管与 web/relay 三态自动 ensure（off / lan / public）。
# 由 init-remote.sh 注册 source 到 ~/.zshrc。

typeset -g _HARNESS_REMOTE_ROOT="${${(%):-%N}:A:h}"
typeset -g _HARNESS_CONFIG_ROOT="${_HARNESS_REMOTE_ROOT:h}"

_rt_node() {
  print -r -- "${HARNESS_REMOTE_NODE:-node}"
}

rtctl() {
  "$(_rt_node)" "${_HARNESS_REMOTE_ROOT}/scripts/remote-ctl.ts" "$@"
}

# 按 ~/.harness-remote/config.json 的 webExposure 同步 web-server 与 relay-agent 状态。
# 配置不存在且本 shell 已检查过时走快路径；任何错误只告警，绝不阻断前台会话。
_rt_ensure_server() {
  local node_bin="$(_rt_node)"
  command -v "$node_bin" >/dev/null 2>&1 || return 0
  local state_dir="${HARNESS_REMOTE_DIR:-$HOME/.harness-remote}"
  local cfg="${HARNESS_REMOTE_CONFIG:-$state_dir/config.json}"
  if [[ ! -f "$cfg" && "${_HARNESS_REMOTE_ENSURED:-}" == "1" ]]; then
    return 0
  fi
  # 依赖尚未安装时静默跳过（提示由 init-remote.sh / rtctl status 承担）
  [[ -d "${_HARNESS_REMOTE_ROOT}/node_modules" ]] || return 0
  "$node_bin" "${_HARNESS_REMOTE_ROOT}/scripts/remote-ctl.ts" ensure || true
  typeset -g _HARNESS_REMOTE_ENSURED=1
  return 0
}

# tmux 全局 TUI 调优（幂等）：低延迟 Esc、24bit 真彩色、修饰键穿透、触控逐行滚轮
_rt_tmux_tune() {
  tmux set-option -s escape-time 10 >/dev/null 2>&1 || true
  tmux set-option -as terminal-overrides ',*:RGB' >/dev/null 2>&1 || true
  tmux set-option -g extended-keys on >/dev/null 2>&1 || true
  tmux set-option -g extended-keys-format csi-u >/dev/null 2>&1 || true
  tmux set-option -g mouse on >/dev/null 2>&1 || true
  tmux unbind-key -T root WheelUpPane >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode WheelUpPane 'select-pane ; send-keys -X -N 1 scroll-up' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode WheelDownPane 'select-pane ; send-keys -X -N 1 scroll-down' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode-vi WheelUpPane 'select-pane ; send-keys -X -N 1 scroll-up' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode-vi WheelDownPane 'select-pane ; send-keys -X -N 1 scroll-down' >/dev/null 2>&1 || true
}

# 生成可读会话名：<标签>-<目录名>-<路径哈希4>-<序号>，同目录多开自动递增
_rt_session_name() {
  local tag="${1:-shell}" base hash prefix n
  tag="${tag:t}"
  tag="${tag//[^A-Za-z0-9_-]/_}"
  [[ -n "$tag" ]] || tag=shell
  base="${PWD:t}"
  base="${base//[^A-Za-z0-9_-]/_}"
  [[ -n "$base" ]] || base=root
  hash="$(printf '%s' "$PWD" | md5 -q 2>/dev/null)"
  [[ -n "$hash" ]] || hash="$(printf '%s' "$PWD" | md5sum 2>/dev/null | cut -c1-4)"
  hash="${hash:0:4}"
  # 限制总长度在 64 字符内以符合 SESSION_NAME_RE
  tag="${tag:0:16}"
  base="${base:0:28}"
  prefix="${tag}-${base}-${hash}"
  n=1
  while tmux has-session -t "${prefix}-${n}" 2>/dev/null; do
    (( n += 1 ))
  done
  print -r -- "${prefix}-${n}"
}

# 通用会话启动器：
#   rt                          → 启动交互式 shell 的 tmux 会话
#   rt qwen / rt agy / rt pi …  → 在 tmux 会话中运行任意命令，手机端即刻可见可操控
#   rt -n myname <cmd...>       → 指定自定义会话名（[A-Za-z0-9_-]，≤64 字符）
rt() {
  local custom_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name)
        if [[ $# -lt 2 ]]; then
          print -u2 -- "用法: rt [-n 会话名] [命令 [参数...]]"
          return 1
        fi
        custom_name="$2"
        shift 2
        ;;
      -h|--help)
        cat <<'EOF'
用法: rt [-n 会话名] [命令 [参数...]]

在 tmux 中启动任意终端或 CLI Agent 会话，并按本机配置自动启停远程 Web/中继服务。
  rt                      启动交互式 shell 会话
  rt pi [参数...]          在共享会话中启动 pi（保留 session-owner）
  rt qwen [参数...]        在共享会话中启动 qwen（保留主题自动跟随）
  rt agy [参数...]         在共享会话中启动 agy
  rt -n dev npm run dev   使用自定义会话名启动任意命令

管理命令: rtctl <status|ls|ensure|stop|devices|approve|deny|revoke|fetch-ca|join>
EOF
        return 0
        ;;
      --)
        shift
        break
        ;;
      *)
        break
        ;;
    esac
  done

  if [[ -n "$custom_name" && ! "$custom_name" =~ '^[A-Za-z0-9_-]{1,64}$' ]]; then
    print -u2 -- "错误: 会话名只允许字母/数字/_/- 且不超过 64 字符：$custom_name"
    return 1
  fi

  _rt_ensure_server

  # 已在 tmux 内：不嵌套，直接执行目标命令（无命令时提示当前已在共享会话中）
  if [[ -n "${TMUX:-}" ]]; then
    if [[ $# -eq 0 ]]; then
      print -P "%F{green}当前已在 tmux 会话中，可被远程终端直接接入。%f"
      return 0
    fi
    "$@"
    return $?
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    print -P "%F{yellow}tmux 未安装，远程共享不可用（brew install tmux）；回退直接执行。%f"
    if [[ $# -gt 0 ]]; then
      "$@"
    fi
    return $?
  fi

  _rt_tmux_tune
  local cols rows name
  cols="${COLUMNS:-$(tput cols 2>/dev/null)}"
  rows="${LINES:-$(tput lines 2>/dev/null)}"
  cols="${cols:-100}"
  rows="${rows:-30}"

  if [[ $# -eq 0 ]]; then
    name="${custom_name:-$(_rt_session_name shell)}"
    tmux new-session -s "$name" -x "$cols" -y "$rows"
    return $?
  fi

  local cmd="$1"
  name="${custom_name:-$(_rt_session_name "$cmd")}"

  # 保留本仓 pi / qwen 包装能力，其余任意命令按原 argv 数组直传（无 shell 注入风险）
  if [[ "$cmd" == "pi" && -x "${_HARNESS_CONFIG_ROOT}/pi/launcher.zsh" ]]; then
    shift
    tmux new-session -s "$name" -x "$cols" -y "$rows" \
      "${_HARNESS_CONFIG_ROOT}/pi/launcher.zsh" "$@"
  elif [[ "$cmd" == "qwen" && -f "${_HARNESS_CONFIG_ROOT}/qwen/shell.zsh" ]]; then
    shift
    tmux new-session -s "$name" -x "$cols" -y "$rows" \
      zsh -c 'source "$1"; shift; qwen "$@"' _ "${_HARNESS_CONFIG_ROOT}/qwen/shell.zsh" "$@"
  else
    tmux new-session -s "$name" -x "$cols" -y "$rows" -- "$@"
  fi
}
