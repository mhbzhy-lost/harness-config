#!/usr/bin/env bash
# init-agy.sh — 将仓库中的跨运行时插件、独立 skills 与 AGY 专属配置同步到本机：
#   1. agy/settings.json 深度合并进 ~/.gemini/antigravity-cli/settings.json（保留本机状态）
#   2. plugins/* 逐插件软链接进 ~/.gemini/config/plugins/（复用 lib-plugins.sh）
#   3. 确保 ~/.gemini/config/skills.json 的 entries 含 <仓库根>/skills（保留已有条目）
#   4. agy/rules/*.md 逐文件软链接进 ~/.gemini/config/rules/（全局规则）
#   5. agy/agents/*.md 逐文件软链接进 ~/.gemini/config/agents/（自定义 subagent）
#   6. 注入内置 subagent 模型档位兜底 hook 到 ~/.gemini/config/hooks.json（按名幂等管理）
#   7. agy/shell.zsh 注册 source 进 ~/.zshrc（标记块，幂等；提供 agyui / agyide 代理启动器）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_TEMPLATE="$SCRIPT_DIR/agy/settings.json"
PLUGINS_SRC="$SCRIPT_DIR/plugins"
SKILLS_SRC="$SCRIPT_DIR/skills"
RULES_SRC="$SCRIPT_DIR/agy/rules"
AGENTS_SRC="$SCRIPT_DIR/agy/agents"
HOOK_SCRIPT="$SCRIPT_DIR/agy/hooks/subagent-model-router.py"
PI_WORKER_HOOK_SCRIPT="$SCRIPT_DIR/agy/hooks/pi-worker-session-injector.py"
SHELL_SNIPPET="$SCRIPT_DIR/agy/shell.zsh"

SETTINGS_TARGET="${AGY_SETTINGS_PATH:-$HOME/.gemini/antigravity-cli/settings.json}"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
PLUGINS_DIR="${AGY_PLUGINS_DIR:-$CONFIG_DIR/plugins}"
SKILLS_JSON="${AGY_SKILLS_JSON:-$CONFIG_DIR/skills.json}"
RULES_DIR="${AGY_RULES_DIR:-$CONFIG_DIR/rules}"
AGENTS_DIR="${AGY_AGENTS_DIR:-$CONFIG_DIR/agents}"
HOOKS_JSON="${AGY_HOOKS_JSON:-$CONFIG_DIR/hooks.json}"
SHELL_RC="${AGY_SHELL_RC:-$HOME/.zshrc}"
DRY_RUN=0

usage() {
  cat <<EOF
用法: ./init-agy.sh [--dry-run]

将仓库中的 AGY 设置模板、插件、独立 skills、全局规则、subagent 定义、生命周期 hooks 与 shell 包装同步到本机。
  --dry-run   只预览将发生的变更，不写入
  -h, --help  显示本帮助

环境变量:
  AGY_SETTINGS_PATH 覆盖 AGY CLI 设置路径（默认 ~/.gemini/antigravity-cli/settings.json）
  AGY_CONFIG_DIR    覆盖 AGY 全局配置根目录（默认 ~/.gemini/config）
  AGY_PLUGINS_DIR   覆盖插件链接目录（默认 \$AGY_CONFIG_DIR/plugins）
  AGY_SKILLS_JSON   覆盖 skills.json 路径（默认 \$AGY_CONFIG_DIR/skills.json）
  AGY_RULES_DIR     覆盖全局规则链接目录（默认 \$AGY_CONFIG_DIR/rules）
  AGY_AGENTS_DIR    覆盖 subagent 定义链接目录（默认 \$AGY_CONFIG_DIR/agents）
  AGY_HOOKS_JSON    覆盖 hooks.json 路径（默认 \$AGY_CONFIG_DIR/hooks.json）
  AGY_SHELL_RC      覆盖 shell 注册目标（默认 ~/.zshrc）
EOF
}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $1" ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || die "需要 python3"
[[ -f "$SETTINGS_TEMPLATE" ]] || die "找不到 AGY 设置模板: $SETTINGS_TEMPLATE"
[[ -f "$HOOK_SCRIPT" ]] || die "找不到 AGY hook 脚本: $HOOK_SCRIPT"
[[ -f "$PI_WORKER_HOOK_SCRIPT" ]] || die "找不到 AGY hook 脚本: $PI_WORKER_HOOK_SCRIPT"
[[ -f "$SHELL_SNIPPET" ]] || die "找不到 AGY shell 片段: $SHELL_SNIPPET"

# --- 1. 深度合并 agy/settings.json ---
AGY_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SETTINGS_TEMPLATE" "$SETTINGS_TARGET" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

template_path, target_path = sys.argv[1:3]
dry_run = os.environ.get("AGY_SYNC_DRY_RUN") == "1"

with open(template_path, encoding="utf-8") as f:
    template = json.load(f)

existing = {}
if os.path.exists(target_path):
    with open(target_path, encoding="utf-8") as f:
        text = f.read()
    if text.strip():
        try:
            existing = json.loads(text)
        except json.JSONDecodeError as e:
            sys.exit(f"错误: 现有配置 {target_path} 不是标准 JSON: {e}")
    if not isinstance(existing, dict):
        sys.exit(f"错误: {target_path} 顶层不是 JSON 对象")

def merge(base, override):
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out

merged = merge(copy.deepcopy(existing), template)
changed = sorted(k for k in merged if existing.get(k) != merged[k])

if merged == existing and os.path.exists(target_path):
    print(f"AGY 设置已与模板一致，无需写入: {target_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] AGY 设置目标: {target_path}")
    print(f"[dry-run] 将变更的顶层键: {', '.join(changed) or '（无变更）'}")
    sys.exit(0)

target_dir = os.path.dirname(target_path) or "."
os.makedirs(target_dir, exist_ok=True)

backup_path = None
if os.path.exists(target_path):
    backup_path = f"{target_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(target_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())
    os.chmod(backup_path, 0o600)

fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".settings-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, target_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"AGY 设置已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
print(f"同步的顶层键: {', '.join(changed) or '（无变更）'}")
PY

# --- 2. 插件软链接 ---
source "$SCRIPT_DIR/lib-plugins.sh"
link_plugins "$PLUGINS_SRC" "$PLUGINS_DIR" "$DRY_RUN"

# --- 3. 注册独立 skills 到 ~/.gemini/config/skills.json ---
AGY_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SKILLS_JSON" "$SKILLS_SRC" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

target_path, skills_dir = sys.argv[1:3]
dry_run = os.environ.get("AGY_SYNC_DRY_RUN") == "1"

existing = {}
if os.path.exists(target_path):
    with open(target_path, encoding="utf-8") as f:
        text = f.read()
    if text.strip():
        try:
            existing = json.loads(text)
        except json.JSONDecodeError as e:
            sys.exit(f"错误: 现有配置 {target_path} 不是标准 JSON: {e}")
    if not isinstance(existing, dict):
        sys.exit(f"错误: {target_path} 顶层不是 JSON 对象")

merged = copy.deepcopy(existing)
entries = merged.setdefault("entries", [])
if not isinstance(entries, list):
    sys.exit(f"错误: {target_path} 的 entries 字段不是数组，无法注入")

already = any(isinstance(e, dict) and e.get("path") == skills_dir for e in entries)
if not already:
    entries.append({"path": skills_dir})

if merged == existing and os.path.exists(target_path):
    print(f"skills.json 已包含仓库 skills 目录，无需写入: {target_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] skills.json 目标: {target_path}")
    print(f"[dry-run] 将确保 entries 含 {skills_dir}")
    sys.exit(0)

target_dir = os.path.dirname(target_path) or "."
os.makedirs(target_dir, exist_ok=True)

backup_path = None
if os.path.exists(target_path):
    backup_path = f"{target_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(target_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())
    os.chmod(backup_path, 0o600)

fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".skills-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, target_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"skills.json 已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
PY

# --- 4. AGY 全局规则软链接 ---
if [[ -d "$RULES_SRC" ]]; then
  [[ "$DRY_RUN" == 1 ]] || mkdir -p "$RULES_DIR"
  for rule_file in "$RULES_SRC"/*.md; do
    [[ -f "$rule_file" ]] || continue
    name="$(basename "$rule_file")"
    link="$RULES_DIR/$name"
    if [[ -L "$link" ]]; then
      if [[ "$(readlink "$link")" == "$rule_file" ]]; then
        echo "AGY 规则 ${name}：链接已正确"
      elif [[ "$DRY_RUN" == 1 ]]; then
        echo "[dry-run] AGY 规则 ${name}：重指链接 → $rule_file"
      else
        ln -sfn "$rule_file" "$link"
        echo "AGY 规则 ${name}：链接已重指 → $rule_file"
      fi
    elif [[ -e "$link" ]]; then
      echo "警告: $link 已存在且不是软链接，跳过（请手动处理）" >&2
    elif [[ "$DRY_RUN" == 1 ]]; then
      echo "[dry-run] AGY 规则 ${name}：新建链接 → $rule_file"
    else
      ln -s "$rule_file" "$link"
      echo "AGY 规则 ${name}：已链接 → $rule_file"
    fi
  done
else
  echo "（无 agy/rules/ 目录，跳过 AGY 规则链接）"
fi

# --- 5. AGY subagent 定义软链接 ---
if [[ -d "$AGENTS_SRC" ]]; then
  [[ "$DRY_RUN" == 1 ]] || mkdir -p "$AGENTS_DIR"
  for agent_file in "$AGENTS_SRC"/*.md; do
    [[ -f "$agent_file" ]] || continue
    name="$(basename "$agent_file")"
    link="$AGENTS_DIR/$name"
    if [[ -L "$link" ]]; then
      if [[ "$(readlink "$link")" == "$agent_file" ]]; then
        echo "AGY agent ${name}：链接已正确"
      elif [[ "$DRY_RUN" == 1 ]]; then
        echo "[dry-run] AGY agent ${name}：重指链接 → $agent_file"
      else
        ln -sfn "$agent_file" "$link"
        echo "AGY agent ${name}：链接已重指 → $agent_file"
      fi
    elif [[ -e "$link" ]]; then
      echo "警告: $link 已存在且不是软链接，跳过（请手动处理）" >&2
    elif [[ "$DRY_RUN" == 1 ]]; then
      echo "[dry-run] AGY agent ${name}：新建链接 → $agent_file"
    else
      ln -s "$agent_file" "$link"
      echo "AGY agent ${name}：已链接 → $agent_file"
    fi
  done
else
  echo "（无 agy/agents/ 目录，跳过 AGY agent 链接）"
fi

# --- 6. 注入受管 AGY hooks 到 ~/.gemini/config/hooks.json ---
AGY_SYNC_DRY_RUN="$DRY_RUN" python3 - "$HOOKS_JSON" "$HOOK_SCRIPT" "$PI_WORKER_HOOK_SCRIPT" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

target_path, router_hook_script, pi_worker_hook_script = sys.argv[1:4]
dry_run = os.environ.get("AGY_SYNC_DRY_RUN") == "1"
managed_hooks = {
    "harness-config-subagent-model-router": {
        "PreToolUse": [
            {
                "matcher": "invoke_subagent",
                "hooks": [
                    {
                        "type": "command",
                        "command": f'python3 "{router_hook_script}"',
                        "timeout": 5,
                    }
                ],
            }
        ]
    },
    "harness-config-pi-worker-session-injector": {
        "PreToolUse": [
            {
                "matcher": "call_mcp_tool|.*pi_worker_(start|monitor)$",
                "hooks": [
                    {
                        "type": "command",
                        "command": f'python3 "{pi_worker_hook_script}"',
                        "timeout": 5,
                    }
                ],
            }
        ]
    },
}

existing = {}
if os.path.exists(target_path):
    with open(target_path, encoding="utf-8") as f:
        text = f.read()
    if text.strip():
        try:
            existing = json.loads(text)
        except json.JSONDecodeError as e:
            sys.exit(f"错误: 现有配置 {target_path} 不是标准 JSON: {e}")
    if not isinstance(existing, dict):
        sys.exit(f"错误: {target_path} 顶层不是 JSON 对象")

merged = copy.deepcopy(existing)
for name, spec in managed_hooks.items():
    merged[name] = spec

if merged == existing and os.path.exists(target_path):
    print(f"hooks.json 已包含全部受管 hooks，无需写入: {target_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] hooks.json 目标: {target_path}")
    for name in managed_hooks:
        print(f"[dry-run] 将注入/更新 hook {name}")
    sys.exit(0)

target_dir = os.path.dirname(target_path) or "."
os.makedirs(target_dir, exist_ok=True)

backup_path = None
if os.path.exists(target_path):
    backup_path = f"{target_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(target_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())
    os.chmod(backup_path, 0o600)

fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".hooks-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, target_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"hooks.json 已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
PY

# --- 7. 注册 agy/shell.zsh 进 ~/.zshrc ---
AGY_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SHELL_RC" "$SHELL_SNIPPET" <<'PY'
import os, re, sys, tempfile
from datetime import datetime

rc_path, snippet_path = sys.argv[1:3]
dry_run = os.environ.get("AGY_SYNC_DRY_RUN") == "1"

start_marker = "# >>> harness-config agy >>>"
end_marker = "# <<< harness-config agy <<<"
line = f"[[ -f '{snippet_path}' ]] && source '{snippet_path}'"
block = f"{start_marker}\n{line}\n{end_marker}"

existing = ""
if os.path.exists(rc_path):
    with open(rc_path, encoding="utf-8") as f:
        existing = f.read()

pattern = re.compile(re.escape(start_marker) + r".*?" + re.escape(end_marker), re.DOTALL)
if pattern.search(existing):
    updated = pattern.sub(lambda m: block, existing, count=1)
else:
    sep = "" if (not existing or existing.endswith("\n")) else "\n"
    updated = existing + sep + "\n" + block + "\n"

if updated == existing:
    print(f"AGY shell 注册已是最新，无需写入: {rc_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] AGY shell 注册目标: {rc_path}")
    print(f"[dry-run] 将写入/更新标记块，source: {snippet_path}")
    sys.exit(0)

backup_path = None
if os.path.exists(rc_path):
    backup_path = f"{rc_path}.bak.{datetime.now():%Y%m%d-%H%M%S}"
    with open(rc_path, "rb") as src, open(backup_path, "wb") as dst:
        dst.write(src.read())

rc_dir = os.path.dirname(rc_path) or "."
os.makedirs(rc_dir, exist_ok=True)
fd, tmp_path = tempfile.mkstemp(dir=rc_dir, prefix=".zshrc-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(updated)
    if os.path.exists(rc_path):
        os.chmod(tmp_path, os.stat(rc_path).st_mode & 0o777)
    os.replace(tmp_path, rc_path)
except BaseException:
    os.unlink(tmp_path)
    raise

print(f"AGY shell 注册已写入: {rc_path}")
if backup_path:
    print(f"已备份: {backup_path}")
PY

if [[ "$DRY_RUN" == 1 ]]; then
  echo "预览完成，未做任何写入。"
else
  echo "完成。新开终端（或 source ${SHELL_RC}）使 AGY shell 包装生效；重启 agy 新开会话使设置、插件、skills、全局规则、subagent 与 hooks 生效。"
fi
