/**
 * 将 `git status --short` 单行输出解析为合法的 `file://` URI（供 AGY toggle-aux-pane 打开源码）。
 * 已删除条目（D）或目录条目（末尾 /）返回 null。
 */

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export function extractGitStatusPath(statusLine: string): { status: string; relPath: string } | null {
  if (typeof statusLine !== "string" || statusLine.length < 4) return null;
  const status = statusLine.slice(0, 2);
  let rest = statusLine.slice(3).trim();
  if (!rest) return null;

  // 处理重命名 / 复制格式："old -> new"
  const arrowIdx = rest.lastIndexOf(" -> ");
  if (arrowIdx >= 0) {
    rest = rest.slice(arrowIdx + 4).trim();
  }
  const relPath = unquoteGitPath(rest);
  if (!relPath) return null;
  return { status, relPath };
}

export function parseGitStatusFileUri(cwd: string, statusLine: string): string | null {
  if (!cwd || typeof cwd !== "string") return null;
  const parsed = extractGitStatusPath(statusLine);
  if (!parsed) return null;
  if (parsed.status.includes("D")) return null;
  if (parsed.relPath.endsWith("/")) return null;

  const base = cwd.replace(/\/+$/, "");
  const fullPath = `${base}/${parsed.relPath.replace(/^\/+/, "")}`;
  const encoded = fullPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
}
