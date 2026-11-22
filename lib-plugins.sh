# lib-plugins.sh — 插件软链接共享逻辑，由 init-qwen.sh / init-pi.sh source。
# link_plugins <plugins_src_dir> <target_dir> <dry_run:0|1>
link_plugins() {
  local src="$1" target="$2" dry="$3"
  if [[ ! -d "$src" ]]; then
    echo "（无 plugins/ 目录，跳过插件链接）"
    return 0
  fi
  if [[ "$dry" != 1 ]]; then
    mkdir -p "$target"
  fi
  local plugin_path name link
  for plugin_path in "$src"/*/; do
    plugin_path="${plugin_path%/}"
    [[ -d "$plugin_path" ]] || continue
    name="$(basename "$plugin_path")"
    if [[ ! -f "$plugin_path/plugin.json" ]]; then
      echo "跳过 ${name}：缺少 plugin.json"
      continue
    fi
    link="$target/$name"
    if [[ -L "$link" ]]; then
      if [[ "$(readlink "$link")" == "$plugin_path" ]]; then
        echo "插件 ${name}：链接已正确"
        continue
      fi
      if [[ "$dry" == 1 ]]; then
        echo "[dry-run] 插件 ${name}：重指链接 → $plugin_path"
      else
        ln -sfn "$plugin_path" "$link"
        echo "插件 ${name}：链接已重指 → $plugin_path"
      fi
    elif [[ -e "$link" ]]; then
      echo "警告: $link 已存在且不是软链接，跳过（请手动处理）" >&2
      continue
    else
      if [[ "$dry" == 1 ]]; then
        echo "[dry-run] 插件 ${name}：新建链接 → $plugin_path"
      else
        ln -s "$plugin_path" "$link"
        echo "插件 ${name}：已链接 → $plugin_path"
      fi
    fi
    if [[ "$dry" != 1 ]]; then
      if [[ -f "$plugin_path/package.json" && ! -d "$plugin_path/node_modules" ]] \
        && python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("dependencies") else 1)' "$plugin_path/package.json" 2>/dev/null; then
        echo "  提示: $name 需要依赖，请运行 (cd \"$plugin_path\" && npm install)"
      fi
      if [[ -f "$plugin_path/.env.example" && ! -f "$plugin_path/.env" ]]; then
        echo "  提示: $name 需要凭据，请复制 .env.example 为 .env 并填写"
      fi
    fi
  done
}
