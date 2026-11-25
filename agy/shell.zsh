# AGY shell 包装：通过本机代理启动或重启 Antigravity / Antigravity IDE。
# 由 init-agy.sh 注册 source 到 ~/.zshrc；默认代理地址可通过环境变量覆盖：
#   AGY_HTTP_PROXY  (默认 http://127.0.0.1:7897)
#   AGY_SOCKS_PROXY (默认 socks5://127.0.0.1:7897)
#   AGY_NO_PROXY    (默认 localhost,127.0.0.1,::1)

_agy_launch_with_proxy() {
  local app_name="$1"
  local proc_pattern="$2"
  shift 2

  local http_proxy_url="${AGY_HTTP_PROXY:-http://127.0.0.1:7897}"
  local socks_proxy_url="${AGY_SOCKS_PROXY:-socks5://127.0.0.1:7897}"
  local no_proxy_list="${AGY_NO_PROXY:-localhost,127.0.0.1,::1}"

  if pgrep -fq "$proc_pattern"; then
    echo "Restarting $app_name with proxy..."
    osascript -e "quit app \"$app_name\"" >/dev/null 2>&1
    local waited=0
    while pgrep -fq "$proc_pattern"; do
      if (( waited >= 50 )); then
        echo "$app_name did not quit gracefully, sending SIGTERM..." >&2
        pkill -f "$proc_pattern"
        local kill_waited=0
        while pgrep -fq "$proc_pattern" && (( kill_waited < 15 )); do
          sleep 0.2
          (( kill_waited++ ))
        done
        break
      fi
      sleep 0.2
      (( waited++ ))
    done
    if pgrep -fq "$proc_pattern"; then
      echo "Failed to stop $app_name — quit it manually and retry." >&2
      return 1
    fi
    sleep 0.3
  fi

  open -a "$app_name" \
    --env "http_proxy=$http_proxy_url" \
    --env "https_proxy=$http_proxy_url" \
    --env "HTTP_PROXY=$http_proxy_url" \
    --env "HTTPS_PROXY=$http_proxy_url" \
    --env "all_proxy=$socks_proxy_url" \
    --env "ALL_PROXY=$socks_proxy_url" \
    --env "no_proxy=$no_proxy_list" \
    --env "NO_PROXY=$no_proxy_list" \
    "$@"
}

agyui() {
  _agy_launch_with_proxy "Antigravity" 'Antigravity\.app/Contents/MacOS/Antigravity' "$@"
}

agyide() {
  _agy_launch_with_proxy "Antigravity IDE" 'Antigravity IDE\.app/Contents/MacOS/Electron' "$@"
}
