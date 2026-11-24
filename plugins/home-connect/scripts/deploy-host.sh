#!/usr/bin/env bash
# 把宿主模式入口部署到家中 mac。在开发机上跑：包经 connect.sh mac 的 stdin 送上去（不走 scp，
# 不在家庭局域网也能部署），远端先用临时端口冒烟，通过后才切换 launchd；起不来自动回滚。
#
#   scripts/deploy-host.sh                 上传 → 冒烟（含 windows/wsl 远程通道）→ 切换 launchd
#   scripts/deploy-host.sh --local-only    冒烟跳过远程通道
#   scripts/deploy-host.sh --no-restart    只上传并冒烟，不动 launchd
#
# 可用环境变量覆盖：HOME_CONNECT_HOST_DIR（远端目录，默认 ~/home-connect-host）、
# HOME_CONNECT_HOST_LAUNCHD（默认 com.home-mac-mcp）、HOME_CONNECT_WIN_KEY（mac 上已有的 Windows 密钥，
# 默认 ~/.ssh/yugang_comfyui_ed25519）、HOME_CONNECT_RELAY_URL、HOME_CONNECT_HOST_NODE。
# 包里只有代码与非机密的通道事实（lan.env / windows.env / known_hosts 都是公开主机信息），不含任何私钥。
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME_CONNECT_ROOT="${HOME_CONNECT_ROOT:-$PLUGIN_ROOT}"
CONNECT="$PLUGIN_ROOT/scripts/connect.sh"
# 远端目录传字面量（不在本机展开 $HOME），到远端再展开；必须在远端家目录之下
REMOTE_DIR="${HOME_CONNECT_HOST_DIR:-~/home-connect-host}"
LABEL="${HOME_CONNECT_HOST_LAUNCHD:-com.home-mac-mcp}"
WIN_KEY="${HOME_CONNECT_WIN_KEY:-.ssh/yugang_comfyui_ed25519}"
case "$WIN_KEY" in /*) ;; *) WIN_KEY="\$HOME/$WIN_KEY" ;; esac
RELAY_URL="${HOME_CONNECT_RELAY_URL:-}"
RESTART=1
REMOTE_FLAG="--with-remote"
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --local-only) REMOTE_FLAG="" ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

extras=()
for f in config/lan.env config/windows.env .ssh/known_hosts; do
  [[ -f "$PLUGIN_ROOT/$f" ]] && extras+=("$f")
done
if ((${#extras[@]} == 0)); then
  echo "本机缺 config/lan.env、config/windows.env 或 .ssh/known_hosts，远端无法选路" >&2
  exit 1
fi

archive="$(mktemp "${TMPDIR:-/tmp}/home-connect-release.XXXXXXXX")"
trap 'rm -f "$archive"' EXIT
COPYFILE_DISABLE=1 tar czf "$archive" -C "$PLUGIN_ROOT" src scripts workflows deploy "${extras[@]}"
payload="$(base64 <"$archive" | tr -d '\n')"

{
  printf 'export REMOTE_DIR=%q PAYLOAD=%q LABEL=%q WIN_KEY=%q RELAY_URL=%q RESTART=%q REMOTE_FLAG=%q NODE_HINT=%q\n' \
    "$REMOTE_DIR" "$payload" "$LABEL" "$WIN_KEY" "$RELAY_URL" "$RESTART" "$REMOTE_FLAG" "${HOME_CONNECT_HOST_NODE:-}"
  cat <<'REMOTE'
set -euo pipefail
umask 077
b64d() { if printf 'aGk=' | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi; }
# 硬闸：部署目录必须是远端家目录的下一级或更深，绝不在家目录本身落任何文件。
# （2026-11-24 事故：本机展开了 $HOME，mkdir 无权限后 cd 没执行，后续步骤全写进了家目录。）
REMOTE_DIR="${REMOTE_DIR/#~\//$HOME/}"
[[ "$REMOTE_DIR" == "$HOME"/* && -d "$HOME" ]] || { echo "部署目录必须位于 $HOME 之下: $REMOTE_DIR" >&2; exit 1; }
mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"
[[ "$(pwd -P)" == "$HOME"/* && "$(pwd -P)" != "$HOME" ]] || { echo "pwd 不在家目录之下，中止" >&2; exit 1; }
printf '%s' "$PAYLOAD" | b64d >.release.tgz
if [[ -d src ]]; then tar czf "release-backup-$(date +%Y%m%dT%H%M%S).tgz" src scripts 2>/dev/null || true; fi
tar xzf .release.tgz && rm -f .release.tgz
chmod +x scripts/*.sh

NODE="${NODE_HINT:-}"
if [[ -z "$NODE" ]]; then
  old_plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [[ -f "$old_plist" ]]; then NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$old_plist" 2>/dev/null || true)"; fi
  [[ -x "${NODE:-}" ]] || NODE=/opt/homebrew/bin/node
fi
[[ -x "$NODE" ]] || { echo "node 不可执行: $NODE" >&2; exit 1; }

# 依赖：只有 server-http 需要 MCP SDK。远端首次没有 node_modules 时就地 npm install（需能访问 npm 源）
if [[ ! -d node_modules/@modelcontextprotocol ]]; then
  printf '{"type":"module","private":true,"dependencies":{"@modelcontextprotocol/sdk":"^1.32.2","zod":"^3.25.76"}}\n' >package.json
  NPM="$(dirname "$NODE")/npm"
  [[ -x "$NPM" ]] || { echo "找不到 npm（$NPM）：远端需先在 $REMOTE_DIR 执行 npm install" >&2; exit 1; }
  "$NPM" install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || { echo "npm install 失败：远端需在 $REMOTE_DIR 手工执行 npm install" >&2; exit 1; }
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
[[ -n "$LAN_IP" ]] || { echo "取不到 en0 的局域网 IP" >&2; exit 1; }

# host.json：首次部署生成随机 token（只写入文件，不打印）；之后只补缺省字段，不改已有值
NODE="$NODE" RELAY_URL="${RELAY_URL:-https://121.40.187.130:18787}" LAN_IP="$LAN_IP" "$NODE" --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
const file = "host.json";
let cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
let generated = false;
if (!cfg.apiKey) { cfg = { ...cfg, apiKey: randomBytes(32).toString("hex") }; generated = true; }
cfg = { bind: "0.0.0.0", port: 8787, auditPath: "~/.home-mac-mcp-audit.log", ...cfg,
  lanUrl: cfg.lanUrl ?? `http://${process.env.LAN_IP}:8787`, relayUrl: cfg.relayUrl ?? process.env.RELAY_URL };
if (existsSync("tls/server.crt") && existsSync("tls/server.key")) cfg.tls = { port: 8788, cert: "tls/server.crt", key: "tls/server.key", ca: "tls/ca.crt", ...(cfg.tls ?? {}) };
else delete cfg.tls;
writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`host.json: lan=${cfg.lanUrl} relay=${cfg.relayUrl} tls=${cfg.tls ? "on:" + cfg.tls.port : "off"}${generated ? "（已生成新 token，见 host.json）" : ""}`);
'

export HOME_CONNECT_HOST=mac HOME_CONNECT_ROOT="$REMOTE_DIR"
HOME_CONNECT_WIN_KEY="$(eval printf '%s' "$WIN_KEY")"
export HOME_CONNECT_WIN_KEY
[[ -f "$HOME_CONNECT_WIN_KEY" ]] || { echo "mac 上找不到 Windows 密钥: $HOME_CONNECT_WIN_KEY" >&2; exit 1; }
[[ -f config/windows.env && -f .ssh/known_hosts ]] || { echo "包里缺 config/windows.env 或 .ssh/known_hosts" >&2; exit 1; }

# 冒烟：临时端口、只绑回环、不开 TLS
"$NODE" --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync("host.json", "utf8"));
delete cfg.tls;
writeFileSync("host.smoke.json", JSON.stringify({ ...cfg, bind: "127.0.0.1", port: 8797, lanUrl: "http://127.0.0.1:8797" }));
'
HOME_CONNECT_HOST_CONFIG="$REMOTE_DIR/host.smoke.json" "$NODE" src/server-http.ts >smoke.log 2>&1 &
smoke_pid=$!
trap 'kill "$smoke_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  curl -s -m 2 -o /dev/null http://127.0.0.1:8797/healthz && break
  sleep 0.5
done
smoke_rc=0
"$NODE" deploy/smoke.mjs http://127.0.0.1:8797 "$("$NODE" -p 'JSON.parse(require("fs").readFileSync("host.json","utf8")).apiKey')" $REMOTE_FLAG || smoke_rc=$?
kill "$smoke_pid" 2>/dev/null || true
rm -f host.smoke.json
if [[ $smoke_rc -ne 0 ]]; then echo "冒烟失败，未切换 launchd。日志：" >&2; cat smoke.log >&2; exit 1; fi
[[ "$RESTART" == 1 ]] || { echo "已上传并冒烟通过（未重启线上入口）"; exit 0; }

# 切换 launchd：同一个 label，旧 server 被替换；覆盖前把现有 plist 存为 .prev，新入口起不来时回滚到它。
# bootout 之后服务要几百毫秒才真正退出，立刻 bootstrap 会报 "Input/output error"——先等它消失，再带重试。
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
[[ -f "$plist" ]] && cp -p "$plist" "$plist.prev"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$REMOTE_DIR/src/server-http.ts</string></array>
<key>WorkingDirectory</key><string>$REMOTE_DIR</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
<key>HOME_CONNECT_HOST</key><string>mac</string>
<key>HOME_CONNECT_ROOT</key><string>$REMOTE_DIR</string>
<key>HOME_CONNECT_WIN_KEY</key><string>$HOME_CONNECT_WIN_KEY</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$REMOTE_DIR/server.log</string>
<key>StandardErrorPath</key><string>$REMOTE_DIR/server.err</string>
</dict></plist>
PLIST
rollback() {
  echo "新入口起不来，回滚旧 plist" >&2
  tail -20 server.err >&2 || true
  if [[ -f "$plist.prev" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist.prev" && echo "已回滚到上一次的 plist（$plist.prev）" >&2
  else
    echo "没有旧 plist 备份，入口处于停止状态" >&2
  fi
  exit 1
}
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 40); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
booted=0
for _ in 1 2 3 4 5 6; do
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then booted=1; break; fi
  sleep 1
done
[[ "$booted" == 1 ]] || rollback

port="$("$NODE" -p 'JSON.parse(require("fs").readFileSync("host.json","utf8")).port')"
healthy=0
for _ in $(seq 1 20); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/healthz"; then healthy=1; break; fi
  sleep 0.5
done
[[ "$healthy" == 1 ]] || rollback
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state =|pid =' | tr '\n' ' '; echo
echo "已切换：$REMOTE_DIR/src/server-http.ts 监听 :$port"
REMOTE
} | "$CONNECT" mac sh
