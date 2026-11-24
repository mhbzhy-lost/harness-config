# Pi shell 包装：经本仓 pi/launcher.zsh 启动，提供跨窗口 session-owner 独占保护。
# 由 init-pi.sh 注册 source 到 ~/.zshrc。
typeset -g _HARNESS_PI_ROOT="${${(%):-%N}:A:h}"

pi() {
  "$_HARNESS_PI_ROOT/launcher.zsh" "$@"
}
