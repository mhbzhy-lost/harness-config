# Qwen Code 主题随系统明暗：macOS light→Xcode / dark→Qwen Dark；非 macOS 回退 auto。
# 与 qwen/settings.json 模板的 ui.theme="${QWEN_THEME}" 配对；由 init-qwen.sh 注册 source 到 ~/.zshrc。
# 注意：/theme 对话框选主题会把固定值写回 ui.theme，覆盖插值。
qwen() {
  local appearance theme
  if (( $+commands[defaults] )); then
    appearance=$(defaults read -g AppleInterfaceStyle 2>/dev/null)
    if [[ "${appearance:l}" == "dark" ]]; then
      theme="Qwen Dark"
    else
      theme="Xcode"
    fi
  else
    theme="auto"
  fi
  QWEN_THEME="$theme" command qwen "$@"
}