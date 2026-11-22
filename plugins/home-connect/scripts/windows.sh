#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOME_CONNECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
LAN="$SCRIPT_DIR/lan.sh"
WIN="$SCRIPT_DIR/windows-ssh.sh"
WINDOWS_LAN_HOST="${HOME_WINDOWS_LAN_HOST:-192.168.31.25}"
WSL_DISTRO="${HOME_WSL_DISTRO:-Ubuntu}"
for s in "$LAN" "$WIN"; do [[ -x "$s" ]] || { echo "missing dependency: $s" >&2; exit 1; }; done

network_check() {
  unset WINDOWS_HOST_OVERRIDE || true
  unset WINDOWS_VIA_RELAY || true
  if [[ "${WINDOWS_FORCE_RELAY:-0}" == "1" ]]; then
    export WINDOWS_VIA_RELAY=1
    WINDOWS_SELECTED_PATH=relay
    return 0
  fi
  if "$LAN" require >/dev/null 2>&1; then
    export WINDOWS_HOST_OVERRIDE="$WINDOWS_LAN_HOST"
    WINDOWS_SELECTED_PATH=lan
  elif [[ -f "$ROOT/config/relay.env" ]] && grep -Eq '^WINDOWS_RELAY_PORT=[0-9]+' "$ROOT/config/relay.env"; then
    export WINDOWS_VIA_RELAY=1
    WINDOWS_SELECTED_PATH=relay
  else
    echo "lan=unproven：Windows 管理入口需要家庭局域网或配置 WINDOWS_RELAY_PORT 中继" >&2
    exit 1
  fi
}
windows_check() { network_check; "$WIN" --check >/dev/null; }

case "${1:-windows}" in
  win-sh)
    # 短命令直通车：命令字符串直接执行，不必先写 .ps1 文件——零转义机制与 win-exec 完全
    # 同款（stdin 落盘远程 .ps1 → -File 执行），只是省掉本地文件这一步。
    # 用法一（推荐，心智模型＝直接操作远程 PowerShell）：connect.sh win-sh <<'EOF' … EOF
    #   （省略 - 也读 stdin）；脚本引号/here-string/中文原样直通零转义
    # 用法二：connect.sh win-sh '<PowerShell 代码>'（bash 单引号包裹；PS 代码里不能有裸单引号，
    #   有则改用法一——PS 单引号串/here-string @'…'@ 与 bash 单引号嵌套要 '\'' 转义，事故高发）
    shift
    network_check
    # BSD mktemp 的模板必须以 X 结尾（带 .ps1 后缀会被当字面名，并发第二次必撞），
    # 所以临时文件不带后缀，内容与清理逻辑不受影响
    tmp_ps="$(mktemp /tmp/win-sh-XXXXXXXXXXXX)" || exit 1
    trap 'rm -f "$tmp_ps"' EXIT
    if [[ -z "${1:-}" || "${1:-}" == "-" ]]; then
      # 无参数或 -：脚本从 stdin 读入（heredoc/管道）。交互终端下 stdin 是 TTY 会挂死，防呆报错
      if [[ -t 0 ]]; then
        echo "用法: connect.sh win-sh <<'EOF'（stdin 读入脚本）或 win-sh '<PowerShell 代码>'" >&2
        exit 2
      fi
      [[ "$#" -le 1 ]] || { echo "用法: win-sh 不接受额外参数" >&2; exit 2; }
      cat > "$tmp_ps"
    else
      printf '%s\n' "$1" > "$tmp_ps"
    fi
    [[ -s "$tmp_ps" ]] || { echo "win-sh 脚本为空" >&2; exit 2; }
    # 复用 win-exec 的完整通道（编码/落盘/执行全走同一份逻辑）；不用 exec——要保住 EXIT trap 清理
    "$0" win-exec "$tmp_ps"
    rc=$?
    rm -f "$tmp_ps"
    exit $rc
    ;;
  win-run)
    # 登录态后台直跑（GPU/长任务的标准入口）——复刻「SSH 前台跑 + 本地转后台」的标准化。
    # 为什么不用 schtasks/Start-Process：schtasks 跑在 Session 0（服务会话，CUDA 不可用，
    #   GPU 负载秒死无输出）；Start-Process 在 SSH 非交互 exec 通道会静默失败。Windows 把
    #   进程绑死在登录会话上——唯一可靠的「GPU 后台」= 一条活跃 SSH 连接承载进程。
    # 机制：本地 fork 守护进程（nohup 脱离本会话），守护进程维持 SSH 长连接跑远程脚本；
    #   连接断了自动重连续跑（任务须可断点续跑：训练类天然满足，epoch checkpoint）。
    #   完成判定：远程日志出现 [done] 标记（脚本结尾自己 echo）或进程表无 python。
    # 【旧版陷阱（2026-11-07 事故根因，已修复）】落盘曾硬编码 D:\yugang-agent-task.ps1，
    #   而 .bat 任务的 launcher 执行 D:\yugang-agent-task.bat——每轮都在重跑远程残留的旧文件
    #   （症状：行为与本地脚本不符、目标日志空、rc=1 死循环；旧 bat 的输出还写去了别的日志）。
    #   现在落盘与执行同文件名，且落盘后做 SHA256 核验（远程哈希 ≠ 本地期望 → 拒绝启动守护）。
    #   守护另带：快速失败连击计数（连续 5 轮 <120s 即退 → SUSPENDED，防重试风暴）、
    #   重连前清远程孤儿进程（D:\yugang-agent-cleanup.ps1，Windows 进程不随 sshd 断线消亡）。
    #   最佳实践仍不变：
    #   1. 复杂/长脚本：先用 win-exec 落盘成远程固定路径（D:\svc\xxx.bat），再让 win-run 只跑
    #      一行「cmd /c <远程固定路径>」的迷你 bat——落盘由 win-exec 验证过的通道完成；
    #   2. win-run 直接传本地脚本仅适用于短脚本（<20 行）。
    # 用法：connect.sh win-run <本地脚本.ps1|bat> <任务名> [远程日志路径] [--no-resume]
    #   --no-resume：任务不可断点续跑——断线后守护只告警不重跑（防止从头来过的死循环），
    #   守护日志里打 [guard] SUSPENDED 标记并退出，由人决定下一步。
    #   缺省（可续跑）：断线自动重连续跑。
    no_resume=0
    for arg in "$@"; do [[ "$arg" == "--no-resume" ]] && no_resume=1; done
    #   本地守护日志：/tmp/win-run-<任务名>.log（SSH 每轮输出都在里面）
    shift
    network_check
    script_file="${1:?用法: connect.sh win-run <本地脚本> <任务名> [远程日志]}"
    task_name="${2:?缺少任务名}"
    remote_log="${3:-D:\\yugang-agent-run.log}"
    [[ -f "$script_file" ]] || { echo "脚本不存在: $script_file" >&2; exit 1; }
    case "$script_file" in
      *.ps1) remote_task='D:\yugang-agent-task.ps1'
             launcher="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File D:\\yugang-agent-task.ps1" ;;
      *.bat) remote_task='D:\yugang-agent-task.bat'
             launcher="cmd.exe /c D:\\yugang-agent-task.bat" ;;
      *) echo "只支持 .ps1 / .bat" >&2; exit 2 ;;
    esac
    # 落盘远程脚本（stdin 通道，零转义；ps1 注入 UTF-8 输出头，bat 注入 chcp 65001）
    case "$script_file" in
      *.ps1)
        encoded="$(python3 - "$script_file" <<'PY'
import base64, hashlib, sys
src = open(sys.argv[1], encoding="utf-8").read().replace("\r\n", "\n").replace("\n", "\r\n")
prefix = "chcp 65001 > $null; [Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8; "
data = b"\xef\xbb\xbf" + (prefix + src).encode("utf-8")
print(base64.b64encode(data).decode(), hashlib.sha256(data).hexdigest())
PY
)" ;;
      *.bat)
        encoded="$(python3 - "$script_file" <<'PY'
import base64, hashlib, sys
src = open(sys.argv[1], encoding="utf-8").read().replace("\r\n", "\n").replace("\n", "\r\n")
src = "@chcp 65001 >nul\r\n" + src
data = src.encode("utf-8")
print(base64.b64encode(data).decode(), hashlib.sha256(data).hexdigest())
PY
)" ;;
    esac
    local_hash="${encoded##* }"
    encoded="${encoded%% *}"
    printf '%s' "$encoded" | "$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "$b=[Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes(\"'"$remote_task"'\", [Convert]::FromBase64String($b))"'
    # 落盘核验：远程 SHA256 必须等于本地期望，否则拒绝启动（防重跑远程残留旧文件——2026-11-07 事故）
    remote_hash="$("$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "(Get-FileHash -LiteralPath \"'"$remote_task"'\" -Algorithm SHA256).Hash.ToLower()"' 2>/dev/null | grep -Eo '[a-f0-9]{64}' | head -1)"
    if [[ -z "$remote_hash" || "$remote_hash" != "$local_hash" ]]; then
      echo "win-run 落盘核验失败: 远程=$remote_hash 期望=$local_hash ($remote_task)" >&2
      echo "守护未启动。请改用 win-exec 把脚本部署到远程固定路径，再用迷你 bat 跑（见 win-run 注释）。" >&2
      exit 1
    fi
    # 部署孤儿进程清理脚本（守护重连前调用；Windows 进程不随 sshd 断线消亡，
    # 旧 cmd/python 会锁日志文件、双跑任务——2026-11-07 重试风暴事故的帮凶）。固定路径，幂等覆盖。
    cleanup_b64="$(python3 - <<'PY'
import base64
src = (
  "$c = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'yugang-agent-task' }\n"
  "$k = Get-CimInstance Win32_Process | Where-Object { @($c).ProcessId -contains $_.ParentProcessId }\n"
  "@($k) + @($c) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n"
)
print(base64.b64encode(b"\xef\xbb\xbf" + src.encode("utf-8")).decode())
PY
)"
    printf '%s' "$cleanup_b64" | "$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "$b=[Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes(\"D:\yugang-agent-cleanup.ps1\", [Convert]::FromBase64String($b))"'
    # 本地守护进程：脱离当前会话，循环维持 SSH 长连接
    guard_log="/tmp/win-run-${task_name}.log"
    nohup bash -c '
      WIN='"$WIN"'
      LAUNCHER="'"$launcher"'"
      REMOTE_LOG="'"$remote_log"'"
      GUARD_LOG="'"$guard_log"'"
      NO_RESUME="'"$no_resume"'"
      CLEANUP="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File D:\\yugang-agent-cleanup.ps1"
      round=0
      fail_streak=0
      while true; do
        round=$((round+1))
        echo "[guard] round $round start $(date +%H:%M:%S)" >> "$GUARD_LOG"
        # SSH 长连接承载进程：跑完（exit 0）或断线（非 0）都进入下一轮判定
        t0=$(date +%s)
        "$WIN" -- "$LAUNCHER >> $REMOTE_LOG 2>&1" >> "$GUARD_LOG" 2>&1
        rc=$?
        elapsed=$(( $(date +%s) - t0 ))
        echo "[guard] ssh exited rc=$rc elapsed=${elapsed}s $(date +%H:%M:%S)" >> "$GUARD_LOG"
        # 完成判定：远程日志出现 [done]（脚本约定标记）
        if "$WIN" -- "type $REMOTE_LOG 2>nul | findstr /c:\"[done]\" >nul 2>&1"; then
          echo "[guard] DONE 标记已出现，守护结束 $(date +%H:%M:%S)" >> "$GUARD_LOG"
          break
        fi
        # rc=0 且无 [done]：脚本正常退出但没打标记——视为完成（调用方没按约定写 [done]）
        if [ $rc -eq 0 ]; then
          echo "[guard] 脚本 exit 0 且无 [done] 标记，视为完成 $(date +%H:%M:%S)" >> "$GUARD_LOG"
          break
        fi
        # 快速失败连击：<120s 即退多为脚本/环境问题而非网络断线，连续 5 次 → SUSPENDED
        # （防 rc=1 无限重试风暴；真断线通常伴随长运行或网络层错误，不会稳定连击）
        if [ $elapsed -lt 120 ]; then fail_streak=$((fail_streak+1)); else fail_streak=0; fi
        if [ $fail_streak -ge 5 ]; then
          echo "[guard] SUSPENDED 连续 $fail_streak 轮快速失败（<120s），疑似脚本/环境问题而非断线，停止重试等待人工处置 $(date +%H:%M:%S)" >> "$GUARD_LOG"
          break
        fi
        # 断线：不可续跑 → 告警挂起（防从头来过的死循环）
        if [ "$NO_RESUME" = "1" ]; then
          echo "[guard] SUSPENDED 任务不可续跑，断线不重跑，等待人工处置 $(date +%H:%M:%S)" >> "$GUARD_LOG"
          break
        fi
        # 重连前清远程孤儿（旧轮次的 cmd 及其 python 子进程；不清会锁日志/双跑）
        echo "[guard] 清理远程孤儿进程" >> "$GUARD_LOG"
        "$WIN" -- "$CLEANUP" >> "$GUARD_LOG" 2>&1
        echo "[guard] 断线重连，10s 后续跑" >> "$GUARD_LOG"
        sleep 10
      done
    ' > /dev/null 2>&1 &
    guard_pid=$!
    echo "win-run 已启动（任务 ${task_name}）"
    echo "  守护 PID ${guard_pid}；SSH 断线自动重连续跑；远程日志 ${remote_log}"
    echo "  本地守护日志 ${guard_log}；任务脚本结尾请 echo [done] 作完成标记"
    ;;
  win-exec)
    # 零转义执行 PowerShell 脚本：本地 UTF-8 纯文本 → base64 落盘远程 .ps1 → powershell -File 执行。
    # 调用方在本地脚本文件里想写什么就写什么（引号/中文/换行/here-string 全部原样到达），
    # 彻底绕开「本地 shell → SSH → cmd → PowerShell」四层引号嵌套的转义地狱。
    # 【为什么不走 powershell -EncodedCommand 传内容】Windows Defender 行为检测会把「SSH 发起的
    #  长 base64 EncodedCommand」当混淆载荷特征直接杀（实测 payload≥150B 必拦，exec channel
    #  直接 failed）——落盘明文 .ps1 再 -File 执行没有混淆特征，静态扫描也友好。落盘那一步用
    #  极短的 EncodedCommand（只含写文件语句）不会触发阈值。
    # 用法：connect.sh win-exec <本地脚本文件>
    shift
    network_check
    script_file="${1:?用法: connect.sh win-exec <本地脚本文件>}"
    [[ -f "$script_file" ]] || { echo "脚本不存在: $script_file" >&2; exit 1; }
    encoded="$(python3 - "$script_file" <<'PY'
import base64, sys
src = open(sys.argv[1], encoding="utf-8").read()
src = src.replace("\r\n", "\n").replace("\n", "\r\n")
# 头部注入 UTF-8 输出设置（消除 GBK 乱码：远程 PowerShell 默认按代码页 936 输出，
# SSH 原样字节回来本地 UTF-8 终端就是天书）+ BOM（-File 对带 BOM 的 .ps1 才认 UTF-8 中文）
prefix = "chcp 65001 > $null; [Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8; $__e0 = @($Error).Count; "
# 尾部收尾出码：PS 5.1 的 -File 下脚本运行时错误退出码恒为 0，agent 无法判成败——
# 用 $Error 增量（本次脚本有无报错）与 $LASTEXITCODE（末次原生命令退出码）补丁；
# 用户脚本自带 exit N 时尾部不执行，N 原样透传
tail = "\r\nif (@($Error).Count -gt $__e0) { exit 1 }\r\nelseif ($LASTEXITCODE) { exit $LASTEXITCODE }\r\nelse { exit 0 }\r\n"
print(base64.b64encode(b"\xef\xbb\xbf" + (prefix + src + tail).encode("utf-8")).decode())
PY
)"
    # 落盘：base64 走 SSH stdin（远程命令行只有一句短小的解码语句——不触发 Defender 的
    # 「长 EncodedCommand」特征，也没有 cmd 8191 字符上限；任意大小脚本都安全）
    printf '%s' "$encoded" | "$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "$b=[Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes(\"D:\yugang-agent-task.ps1\", [Convert]::FromBase64String($b))"'
    # 执行：-File 直跑（退出码语义由脚本内嵌尾部处理，见上方编码器 tail）
    exec "$WIN" -- "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File D:\\yugang-agent-task.ps1"
    ;;
  win-put)
    # 上传文件到 Windows：sftp 子系统（与 ssh 同一账户/密钥/通道配置，无需额外凭据）+ 远程大小核验。
    # 旧 base64→PowerShell stdin 路径已废弃：并发多路复用 exec channel 的 stdin 投递在 Windows
    # OpenSSH 上不可靠（实测 7 并发 6 个 hang >60s）；sftp 子系统不经 cmd→PowerShell→conhost 层。
    # GB 级大文件不走这里：中继路径按流量计费，应改在远程用 curl 直连下载。
    # 用法：connect.sh win-put <本地文件> <远程绝对路径>（如 D:\svc\start.ps1）
    shift
    network_check
    local_file="${1:?用法: connect.sh win-put <本地文件> <远程绝对路径>}"
    remote_path="${2:?缺少远程绝对路径}"
    [[ -f "$local_file" ]] || { echo "本地文件不存在: $local_file" >&2; exit 1; }
    # 远程路径白名单校验：盘符绝对路径，仅限字母数字/下划线/点/连字符/斜杠——排除空格与
    # " ` $ 等 PS 双引号串、cmd 层的元字符（嵌入 -Command 串防注入；含空格路径先 Rename 再传）
    [[ "$remote_path" =~ ^[A-Za-z]:[\\/][A-Za-z0-9_.\\/:-]*$ ]] || {
      echo "远程路径须为 Windows 绝对路径且不含空格/特殊字符: $remote_path" >&2; exit 2; }
    local_size="$(wc -c < "$local_file" | tr -d ' ')"
    "$WIN" --sftp-put "$local_file" "$remote_path"
    remote_size="$("$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "(Get-Item -LiteralPath \"'"$remote_path"'\").Length"' 2>/dev/null | grep -Eo '[0-9]+' | head -1 || true)"
    if [[ -z "$remote_size" || "$remote_size" != "$local_size" ]]; then
      echo "win-put 核验失败: 远程=$remote_size 本地=$local_size ($remote_path)" >&2
      exit 1
    fi
    echo "win-put 完成: $remote_path ($local_size bytes)"
    ;;
  win-put-batch)
    # 批量上传：单条 sftp 会话内串行 put 全部文件 + 逐个远程大小核验。
    # 会话内串行天然避开并发多路复用通道卡死问题；MCP 层另有单飞门禁，同一时刻只允许一个 copy 任务。
    # 用法：connect.sh win-put-batch <本地1> <远程1> <本地2> <远程2> ...（成对）
    shift
    network_check
    [[ $# -ge 2 && $(( $# % 2 )) -eq 0 ]] || { echo "用法: connect.sh win-put-batch <本地文件> <远程绝对路径> ...（成对）" >&2; exit 2; }
    pairs=("$@")
    # 先全量预校验（本地存在 + 远程路径白名单），避免传一半才发现非法参数
    for ((i = 0; i < $#; i += 2)); do
      [[ -f "${pairs[i]}" ]] || { echo "本地文件不存在: ${pairs[i]}" >&2; exit 1; }
      [[ "${pairs[i+1]}" =~ ^[A-Za-z]:[\\/][A-Za-z0-9_.\\/:-]*$ ]] || {
        echo "远程路径须为 Windows 绝对路径且不含空格/特殊字符: ${pairs[i+1]}" >&2; exit 2; }
    done
    # BSD mktemp 模板必须以 X 结尾（不带后缀）；batch 每行 put "本地" "/盘符:/..."（前导斜杠才是绝对路径）
    batch="$(mktemp /tmp/win-put-batch-XXXXXXXXXXXX)" || exit 1
    trap 'rm -f "$batch"' EXIT
    for ((i = 0; i < $#; i += 2)); do
      printf 'put "%s" "/%s"\n' "${pairs[i]}" "${pairs[i+1]//\\//}" >> "$batch"
    done
    "$WIN" --sftp-batch "$batch"
    # 逐个核验远端大小（复用 win-put 已验证的单文件核验语句；|| true 保住友好报错路径）
    fail=0
    for ((i = 0; i < $#; i += 2)); do
      lf="${pairs[i]}"; rp="${pairs[i+1]}"
      local_size="$(wc -c < "$lf" | tr -d ' ')"
      remote_size="$("$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "(Get-Item -LiteralPath \"'"$rp"'\").Length"' 2>/dev/null | grep -Eo '[0-9]+' | head -1 || true)"
      if [[ -z "$remote_size" || "$remote_size" != "$local_size" ]]; then
        echo "win-put-batch 核验失败: 远程=$remote_size 本地=$local_size ($rp)" >&2
        fail=1
      else
        echo "win-put-batch 完成: $rp ($local_size bytes)"
      fi
    done
    exit "$fail"
    ;;
  win-bat)
    # 零转义执行 Windows 批处理：本地 UTF-8 文本 → CRLF/GBK 规范化 → base64 落盘 → schtasks 拉起。
    # 后台长任务专用（SSH 会话断开不连带杀死进程）。为什么用 schtasks 而不是 Start-Process：
    #   Start-Process 在 SSH 非交互会话里会静默失败（无报错、无进程）；schtasks 的进程归
    #   Task Scheduler 托管，最可靠。坑：Windows 死机重启后旧任务会进入坏状态（/run 报成功
    #   但不执行，LastTaskResult=267011），必须先 /delete 再 /create 重建——本命令每次都重建。
    # 用法：connect.sh win-bat <本地bat文件> <远程任务名> [日志路径]
    #   bat 文件写法与本地完全一致：重定向 > log 2>&1 不需要 ^ 转义（文件内容不经 shell 解析）
    shift
    network_check
    bat_file="${1:?用法: connect.sh win-bat <本地bat文件> <任务名> [日志路径]}"
    task_name="${2:?缺少任务名}"
    log_path="${3:-D:\\yugang-agent-last.log}"
    [[ -f "$bat_file" ]] || { echo "bat 不存在: $bat_file" >&2; exit 1; }
    encoded="$(python3 - "$bat_file" <<'PY'
import base64, sys
src = open(sys.argv[1], encoding="utf-8").read()
src = src.replace("\r\n", "\n").replace("\n", "\r\n")
# 头部注入 chcp 65001（cmd 输出切 UTF-8，消除 GBK 乱码）；cmd 切页后逐行读后续行，
# 所以 bat 内容整体按 UTF-8 落盘（不转 GBK），与 chcp 65001 后的解析一致
src = "@chcp 65001 >nul\r\n" + src
print(base64.b64encode(src.encode("utf-8")).decode())
PY
)"
    # 两步：stdin 落盘 bat（与 win-exec 同款，无长度/Defender 风险）→ 重建 schtasks 并运行
    printf '%s' "$encoded" | "$WIN" -- 'powershell.exe -NoProfile -NonInteractive -Command "$b=[Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes(\"D:\yugang-agent-task.bat\", [Convert]::FromBase64String($b))"'
    "$WIN" -- "schtasks /delete /tn $task_name /f >nul 2>&1 & schtasks /create /tn $task_name /tr \"cmd /c D:\\yugang-agent-task.bat\" /sc once /st 23:59 /f & schtasks /run /tn $task_name"
    echo "win-bat 已拉起（任务名 ${task_name}；bat 落盘 D:\\yugang-agent-task.bat）"
    ;;
  windows)
    shift
    network_check
    if [[ "${1:-}" == -- ]]; then shift; exec "$WIN" -- "$@"; fi
    exec "$WIN" "$@"
    ;;
  windows-check)
    windows_check
    echo 'home_windows=ok'
    ;;
  wsl-start)
    # WSL2 保活（防 ~60s idle 自动关机）：计划任务 WSLKeepalive 每 5 分钟触发
    # wsl.exe -d <distro> --exec /bin/sleep infinity；Task Scheduler 默认多实例策略
    # IgnoreNew（已在运行则跳过不叠加），开机后 5 分钟内自动恢复，进程被杀自愈。
    # 子操作：无参/install=幂等安装并立即启动一次；status=任务与发行版状态；remove=卸载并停保活进程。
    # （经 WSL 的操作一律走 wsl 通道；本子命令只负责 Windows 侧的保活设施管理）
    action="${2:-install}"
    network_check
    case "$action" in
      install)
        "$0" win-sh "schtasks /Create /F /TN WSLKeepalive /TR \"wsl.exe -d $WSL_DISTRO --exec /bin/sleep infinity\" /SC MINUTE /MO 5; schtasks /Run /TN WSLKeepalive"
        ;;
      status)
        # wsl.exe 重定向输出是 UTF-16LE：读入时切 Unicode、输出前切回 UTF-8（读写解耦，
        # 否则要么读成乱码、要么整个会话输出变 UTF-16）。stdin 直通零转义，heredoc 单引号防 bash 展开
        "$0" win-sh - <<'PSEOF'
schtasks /Query /TN WSLKeepalive /FO LIST
[Console]::OutputEncoding=[Text.Encoding]::Unicode
$wsl_running = wsl.exe --list --running | Out-String
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$wsl_running
PSEOF
        ;;
      remove)
        "$0" win-sh "schtasks /Delete /TN WSLKeepalive /F; wsl.exe -d $WSL_DISTRO --exec pkill -f 'sleep infinity'; echo keepalive-removed"
        ;;
      *) echo 'Usage: connect.sh wsl-start [install|status|remove]' >&2; exit 2 ;;
    esac
    ;;
  status)
    network_check
    printf 'selected_path=%s\n' "$WINDOWS_SELECTED_PATH"
    "$WIN" --check
    ;;
  *)
    echo 'Usage: windows.sh <windows-check|win-sh|win-exec|win-put|win-put-batch|win-bat|win-run|wsl-start|status>（裸 windows 透传 windows-ssh.sh）' >&2
    exit 2
    ;;
esac
