#!/usr/bin/env bash
# init-pi.sh — 将仓库中的 Pi 专属配置、全局指令、扩展、快捷键、shell 包装与跨运行时插件同步到本机：
#   1. pi/settings.json 深度合并进 ~/.pi/agent/settings.json，按序注入仓内 pi/extensions/* 与 skills/（保留本机配置与其他扩展）
#   2. pi/keybindings.json 软链接为 ~/.pi/agent/keybindings.json
#   3. pi/GLOBAL.md 软链接为 ~/.pi/agent/AGENTS.md（全局指令，跨机同步）
#   4. plugins/* 逐插件软链接进 ~/.agents/plugins/（复用 lib-plugins.sh）
#   5. pi/shell.zsh 注册 source 进 ~/.zshrc（标记块，幂等；接入 session-owner launcher）
#   6. 探测本机 @earendil-works/pi-coding-agent 包路径，软链接 docs/examples/schemas/README.md 到 .agents/skills/pi-docs/
#   7. 复制 pi/bin/apply_patch 到 ~/.pi/agent/bin/apply_patch（fd/rg 由 Pi 原生管理）
# 模型/提供商/认证/密钥均为 per-machine 配置，不在同步范围。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/pi/settings.json"
KEYBINDINGS_SRC="$SCRIPT_DIR/pi/keybindings.json"
GLOBAL_MD_SRC="$SCRIPT_DIR/pi/GLOBAL.md"
SHELL_SNIPPET="$SCRIPT_DIR/pi/shell.zsh"
APPLY_PATCH_SRC="$SCRIPT_DIR/pi/bin/apply_patch"
EXTENSIONS_SRC="$SCRIPT_DIR/pi/extensions"
SKILLS_SRC="$SCRIPT_DIR/skills"
PLUGINS_SRC="$SCRIPT_DIR/plugins"

AGENT_DIR="${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
SETTINGS_TARGET="${PI_SETTINGS_PATH:-$AGENT_DIR/settings.json}"
KEYBINDINGS_TARGET="${PI_KEYBINDINGS_PATH:-$AGENT_DIR/keybindings.json}"
GLOBAL_MD_TARGET="${PI_GLOBAL_MD:-$AGENT_DIR/AGENTS.md}"
APPLY_PATCH_TARGET="$AGENT_DIR/bin/apply_patch"
PI_PLUGINS_TARGET="${PI_PLUGINS_DIR:-$HOME/.agents/plugins}"
SHELL_RC="${PI_SHELL_RC:-$HOME/.zshrc}"
PI_DOCS_SKILL_TARGET="${PI_DOCS_SKILL_DIR:-$SCRIPT_DIR/.agents/skills/pi-docs}"
DRY_RUN=0

usage() {
  cat <<EOF
用法: ./init-pi.sh [--dry-run]

将仓库中的 Pi 设置模板、全局指令、扩展、快捷键、shell 包装与跨运行时插件同步到本机。
  --dry-run   只预览将发生的变更，不写入
  -h, --help  显示本帮助

环境变量:
  PI_AGENT_DIR        覆盖 Pi 配置根目录（默认 \$PI_CODING_AGENT_DIR 或 ~/.pi/agent）
  PI_SETTINGS_PATH    覆盖 settings.json 路径（默认 \$PI_AGENT_DIR/settings.json）
  PI_KEYBINDINGS_PATH 覆盖 keybindings.json 路径（默认 \$PI_AGENT_DIR/keybindings.json）
  PI_GLOBAL_MD        覆盖全局 AGENTS.md 链接目标（默认 \$PI_AGENT_DIR/AGENTS.md）
  PI_PLUGINS_DIR      覆盖跨运行时插件链接目录（默认 ~/.agents/plugins）
  PI_SHELL_RC         覆盖 shell 注册目标（默认 ~/.zshrc）
  PI_PACKAGE_DIR      指定本机 @earendil-works/pi-coding-agent 包目录（默认自动探测）
  PI_DOCS_SKILL_DIR   覆盖 pi-docs 文档软链落点（默认 <仓库根>/.agents/skills/pi-docs）
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
[[ -f "$TEMPLATE" ]] || die "找不到 Pi 设置模板: $TEMPLATE"
[[ -f "$KEYBINDINGS_SRC" ]] || die "找不到 Pi 快捷键模板: $KEYBINDINGS_SRC"
[[ -f "$GLOBAL_MD_SRC" ]] || die "找不到 Pi 全局指令文件: $GLOBAL_MD_SRC"
[[ -f "$SHELL_SNIPPET" ]] || die "找不到 Pi shell 片段: $SHELL_SNIPPET"
[[ -f "$APPLY_PATCH_SRC" ]] || die "找不到 apply_patch 工具: $APPLY_PATCH_SRC"

# --- 1. 合并 pi/settings.json + 注入受管 pi/extensions/* 与 skills/ ---
PI_SYNC_DRY_RUN="$DRY_RUN" python3 - "$TEMPLATE" "$SETTINGS_TARGET" "$EXTENSIONS_SRC" "$SKILLS_SRC" <<'PY'
import copy, json, os, sys, tempfile
from datetime import datetime

template_path, target_path, extensions_dir, skills_dir = sys.argv[1:5]
dry_run = os.environ.get("PI_SYNC_DRY_RUN") == "1"

# 受管扩展加载顺序：ask-user-question / dcp / subagents 位于 compact-tools 之前，确保自定义渲染器优先于通用兜底。
MANAGED_EXTENSIONS = [
    "agent-plugins",
    "cliproxyapi",
    "ask-user-question",
    "dcp",
    "subagents",
    "compact-tools",
    "bash-cwd",
    "bash-async",
    "endpoint-fallback",
    "network-recovery",
    "security-gates",
    "session-owner",
    "tool-timing",
    "tui-lite",
]

# 已退役的受管扩展：仓内不再提供，重跑脚本时按路径后缀从本机 settings 中剔除，保留其余非受管条目
RETIRED_EXTENSIONS = [
    "openai-proxy",
]

managed_entries = []
managed_suffixes = []
for name in MANAGED_EXTENSIONS:
    entry = os.path.join(extensions_dir, name, f"{name}.ts")
    if not os.path.isfile(entry):
        sys.exit(f"错误: 缺少受管扩展入口文件（须与扩展名一致）: {entry}")
    managed_entries.append(entry)
    managed_suffixes.append(f"/pi/extensions/{name}/{name}.ts")
retired_suffixes = [f"/pi/extensions/{name}/{name}.ts" for name in RETIRED_EXTENSIONS]

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

PACKAGE_ALIASES = {
    ("git", "github.com/mhbzhy-lost/pi-dcp-migrate"): ("git", "github.com/mhbzhy-lost/pi-dcp"),
}

def package_identity(spec):
    if not isinstance(spec, str):
        return None
    if spec.startswith("npm:"):
        body = spec[4:]
        if not body:
            return None
        if body.startswith("@"):
            slash = body.find("/")
            if slash == -1:
                return None
            at = body.find("@", slash + 1)
            ident = ("npm", body[:at] if at != -1 else body)
            return PACKAGE_ALIASES.get(ident, ident)
        at = body.find("@")
        ident = ("npm", body[:at] if at != -1 else body)
        return PACKAGE_ALIASES.get(ident, ident)
    if spec.startswith("git:") or spec.startswith("https://") or spec.startswith("http://"):
        body = spec
        for prefix in ("git:", "https://", "http://"):
            if body.startswith(prefix):
                body = body[len(prefix):]
                break
        if body.startswith("git@"):
            body = body[4:].replace(":", "/", 1)
        at = body.rfind("@")
        slash = body.rfind("/")
        if at > slash:
            body = body[:at]
        if "#" in body:
            body = body.split("#", 1)[0]
        body = body.rstrip("/")
        if body.endswith(".git"):
            body = body[:-4]
        if not body:
            return None
        ident = ("git", body.lower())
        return PACKAGE_ALIASES.get(ident, ident)
    return None

def merge_packages(base_list, template_list):
    if not isinstance(base_list, list):
        sys.exit(f"错误: 现有配置 {target_path} 的 packages 字段不是数组，无法合并")
    out = copy.deepcopy(base_list)
    for item in template_list:
        src = item.get("source") if isinstance(item, dict) else item
        pkg_id = package_identity(src)
        matched = False
        keep_idx = None
        for i, existing_item in enumerate(out):
            if existing_item == item:
                matched = True
                keep_idx = i
                break
            existing_src = existing_item.get("source") if isinstance(existing_item, dict) else existing_item
            if pkg_id and package_identity(existing_src) == pkg_id:
                if isinstance(existing_item, dict) and isinstance(src, str):
                    updated_item = dict(existing_item)
                    updated_item["source"] = src
                    out[i] = updated_item
                else:
                    out[i] = copy.deepcopy(item)
                matched = True
                keep_idx = i
                break
        if matched and pkg_id:
            out = [
                el for j, el in enumerate(out)
                if j == keep_idx or package_identity(el.get("source") if isinstance(el, dict) else el) != pkg_id
            ]
        elif not matched:
            out.append(copy.deepcopy(item))
    return out

def merge(base, override):
    out = dict(base)
    for k, v in override.items():
        if k == "defaultTools" and isinstance(v, list):
            current = list(out.get(k)) if isinstance(out.get(k), list) else []
            for item in v:
                if item not in current:
                    current.append(item)
            out[k] = current
        elif k == "packages" and isinstance(v, list):
            out[k] = merge_packages(out.get(k, []), v)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out

merged = merge(copy.deepcopy(existing), template)

# 合并 extensions：保留本机已有非受管扩展与内置 selector，替换旧路径受管条目并按固定顺序注入本仓扩展。
existing_exts = merged.get("extensions", [])
if not isinstance(existing_exts, list):
    sys.exit(f"错误: 现有配置 {target_path} 的 extensions 字段不是数组，无法注入")

def is_managed_ext(item):
    if not isinstance(item, str):
        return False
    normalized = item.replace("\\", "/")
    return (normalized in managed_entries
            or any(normalized.endswith(s) for s in managed_suffixes)
            or any(normalized.endswith(s) for s in retired_suffixes))

preserved = [item for item in existing_exts if not is_managed_ext(item)]
merged["extensions"] = preserved + managed_entries

# 合并 skills：确保包含仓库 skills/ 绝对路径，保留本机已有其他条目
existing_skills = merged.get("skills", [])
if not isinstance(existing_skills, list):
    sys.exit(f"错误: 现有配置 {target_path} 的 skills 字段不是数组，无法注入")
if skills_dir not in existing_skills:
    existing_skills = list(existing_skills) + [skills_dir]
merged["skills"] = existing_skills

changed = sorted(k for k in merged if existing.get(k) != merged[k])

if merged == existing and os.path.exists(target_path):
    print(f"Pi 设置已与模板一致，无需写入: {target_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] Pi 设置目标: {target_path}")
    print(f"[dry-run] 将变更的顶层键: {', '.join(changed) or '（无变更）'}")
    print(f"[dry-run] 将确保 extensions 含 {len(managed_entries)} 个仓内扩展（保留既有本机扩展）")
    print(f"[dry-run] 将确保 skills 含 {skills_dir}")
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

print(f"Pi 设置已写入: {target_path}（权限 600）")
if backup_path:
    print(f"已备份: {backup_path}")
print(f"同步的顶层键: {', '.join(changed) or '（无变更）'}")
PY

# --- 2. 软链接 pi/keybindings.json ---
if [[ -L "$KEYBINDINGS_TARGET" ]]; then
  if [[ "$(readlink "$KEYBINDINGS_TARGET")" == "$KEYBINDINGS_SRC" ]]; then
    echo "Pi 快捷键：链接已正确"
  elif [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] Pi 快捷键：重指链接 → $KEYBINDINGS_SRC"
  else
    ln -sfn "$KEYBINDINGS_SRC" "$KEYBINDINGS_TARGET"
    echo "Pi 快捷键：链接已重指 → $KEYBINDINGS_SRC"
  fi
elif [[ -e "$KEYBINDINGS_TARGET" ]]; then
  echo "警告: $KEYBINDINGS_TARGET 已存在且不是软链接，跳过（请手动处理）" >&2
elif [[ "$DRY_RUN" == 1 ]]; then
  echo "[dry-run] Pi 快捷键：新建链接 → $KEYBINDINGS_SRC"
else
  mkdir -p "$(dirname "$KEYBINDINGS_TARGET")"
  ln -s "$KEYBINDINGS_SRC" "$KEYBINDINGS_TARGET"
  echo "Pi 快捷键：已链接 → $KEYBINDINGS_SRC"
fi

# --- 3. 软链接 pi/GLOBAL.md → ~/.pi/agent/AGENTS.md ---
if [[ -L "$GLOBAL_MD_TARGET" ]]; then
  if [[ "$(readlink "$GLOBAL_MD_TARGET")" == "$GLOBAL_MD_SRC" ]]; then
    echo "Pi 全局指令：链接已正确"
  elif [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] Pi 全局指令：重指链接 → $GLOBAL_MD_SRC"
  else
    ln -sfn "$GLOBAL_MD_SRC" "$GLOBAL_MD_TARGET"
    echo "Pi 全局指令：链接已重指 → $GLOBAL_MD_SRC"
  fi
elif [[ -e "$GLOBAL_MD_TARGET" ]]; then
  echo "警告: $GLOBAL_MD_TARGET 已存在且不是软链接，跳过（请手动处理）" >&2
elif [[ "$DRY_RUN" == 1 ]]; then
  echo "[dry-run] Pi 全局指令：新建链接 → $GLOBAL_MD_SRC"
else
  mkdir -p "$(dirname "$GLOBAL_MD_TARGET")"
  ln -s "$GLOBAL_MD_SRC" "$GLOBAL_MD_TARGET"
  echo "Pi 全局指令：已链接 → $GLOBAL_MD_SRC"
fi

# --- 4. 跨运行时插件软链接（~/.agents/plugins） ---
# 遗留整目录软链接：指向本仓 plugins/ → 升级为逐插件链接；指向别处 → 不动
if [[ -L "$PI_PLUGINS_TARGET" ]]; then
  if [[ "$(readlink "$PI_PLUGINS_TARGET")" != "$PLUGINS_SRC" ]]; then
    die "$PI_PLUGINS_TARGET 是指向别处的软链接（$(readlink "$PI_PLUGINS_TARGET")），请手动处理"
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] ${PI_PLUGINS_TARGET}：整目录链接升级为真实目录，并逐插件链接："
    for d in "$PLUGINS_SRC"/*/; do
      [[ -f "${d}plugin.json" ]] && echo "[dry-run]   $(basename "${d%/}") → ${d%/}"
    done
  else
    rm "$PI_PLUGINS_TARGET"
    mkdir -p "$PI_PLUGINS_TARGET"
    echo "${PI_PLUGINS_TARGET}：整目录链接已升级为逐插件链接"
  fi
fi

if [[ ! -L "$PI_PLUGINS_TARGET" ]]; then
  source "$SCRIPT_DIR/lib-plugins.sh"
  link_plugins "$PLUGINS_SRC" "$PI_PLUGINS_TARGET" "$DRY_RUN"
fi

# --- 5. 注册 pi/shell.zsh 进 ~/.zshrc ---
PI_SYNC_DRY_RUN="$DRY_RUN" python3 - "$SHELL_RC" "$SHELL_SNIPPET" <<'PY'
import os, re, sys, tempfile
from datetime import datetime

rc_path, snippet_path = sys.argv[1:3]
dry_run = os.environ.get("PI_SYNC_DRY_RUN") == "1"

start_marker = "# >>> harness-config pi >>>"
end_marker = "# <<< harness-config pi <<<"
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
    print(f"Pi shell 注册已是最新，无需写入: {rc_path}")
    sys.exit(0)

if dry_run:
    print(f"[dry-run] Pi shell 注册目标: {rc_path}")
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

print(f"Pi shell 注册已写入: {rc_path}")
if backup_path:
    print(f"已备份: {backup_path}")
PY

# --- 6. 软链接本机 @earendil-works/pi-coding-agent 文档到 .agents/skills/pi-docs/ ---
PI_PKG_ROOT="$(python3 - "${PI_PACKAGE_DIR:-}" <<'PY'
import json, os, shutil, subprocess, sys
from pathlib import Path

override = sys.argv[1].strip()
valid_names = {"@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"}

def is_pi_pkg(path: Path) -> bool:
    pkg = path / "package.json"
    if not (pkg.is_file() and (path / "docs").is_dir()):
        return False
    try:
        name = json.loads(pkg.read_text(encoding="utf-8")).get("name")
    except Exception:
        return False
    return name in valid_names

def find_from_bin() -> Path | None:
    pi_bin = shutil.which("pi")
    if not pi_bin:
        return None
    real = Path(os.path.realpath(pi_bin))
    for parent in real.parents:
        if is_pi_pkg(parent):
            return parent
    return None

def candidates():
    if override:
        yield Path(override).expanduser()
        return
    from_bin = find_from_bin()
    if from_bin:
        yield from_bin
    npm = shutil.which("npm")
    if npm:
        try:
            res = subprocess.run([npm, "root", "-g"], text=True, capture_output=True, timeout=3, check=False)
            if res.returncode == 0 and res.stdout.strip():
                root = Path(res.stdout.strip())
                yield root / "@earendil-works" / "pi-coding-agent"
                yield root / "@mariozechner" / "pi-coding-agent"
        except Exception:
            pass
    for base in ("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"):
        yield Path(base) / "@earendil-works" / "pi-coding-agent"
        yield Path(base) / "@mariozechner" / "pi-coding-agent"

for cand in candidates():
    if is_pi_pkg(cand):
        print(os.path.realpath(cand))
        sys.exit(0)
PY
)"

if [[ -n "$PI_PKG_ROOT" ]]; then
  [[ "$DRY_RUN" == 1 ]] || mkdir -p "$PI_DOCS_SKILL_TARGET"
  for asset in docs examples schemas README.md; do
    src="$PI_PKG_ROOT/$asset"
    [[ -e "$src" ]] || continue
    dst="$PI_DOCS_SKILL_TARGET/$asset"
    if [[ -L "$dst" ]]; then
      if [[ "$(readlink "$dst")" == "$src" ]]; then
        echo "Pi 文档 ${asset}：链接已正确"
      elif [[ "$DRY_RUN" == 1 ]]; then
        echo "[dry-run] Pi 文档 ${asset}：重指链接 → $src"
      else
        ln -sfn "$src" "$dst"
        echo "Pi 文档 ${asset}：链接已重指 → $src"
      fi
    elif [[ -e "$dst" ]]; then
      echo "警告: $dst 已存在且不是软链接，跳过（请手动处理）" >&2
    elif [[ "$DRY_RUN" == 1 ]]; then
      echo "[dry-run] Pi 文档 ${asset}：新建链接 → $src"
    else
      ln -s "$src" "$dst"
      echo "Pi 文档 ${asset}：已链接 → $src"
    fi
  done
else
  echo "提示: 未找到本机 @earendil-works/pi-coding-agent 包，跳过 ${PI_DOCS_SKILL_TARGET} 文档软链（安装 pi 后重跑 ./init-pi.sh 或传 PI_PACKAGE_DIR=<包目录> 即可）"
fi

# --- 7. 复制 pi/bin/apply_patch → ~/.pi/agent/bin/apply_patch ---
if [[ -f "$APPLY_PATCH_TARGET" && ! -L "$APPLY_PATCH_TARGET" ]] && cmp -s "$APPLY_PATCH_SRC" "$APPLY_PATCH_TARGET" && [[ -x "$APPLY_PATCH_TARGET" ]]; then
  echo "Pi 工具 apply_patch：已是最新，无需复制"
elif [[ "$DRY_RUN" == 1 ]]; then
  echo "[dry-run] Pi 工具 apply_patch：复制到 $APPLY_PATCH_TARGET"
else
  mkdir -p "$(dirname "$APPLY_PATCH_TARGET")"
  tmp_bin="${APPLY_PATCH_TARGET}.tmp.$$"
  cp "$APPLY_PATCH_SRC" "$tmp_bin"
  chmod 0755 "$tmp_bin"
  mv -f "$tmp_bin" "$APPLY_PATCH_TARGET"
  echo "Pi 工具 apply_patch：已复制到 $APPLY_PATCH_TARGET"
fi

if [[ "$DRY_RUN" == 1 ]]; then
  echo "预览完成，未做任何写入。"
else
  echo "完成。新开终端（或 source ${SHELL_RC}）使 Pi shell 包装生效，重启 pi 加载设置、全局指令、扩展、快捷键与插件。"
fi
