/**
 * 将 `git status --short` 单行输出解析为合法的 `file://` URI（供 AGY toggle-aux-pane 打开源码）。
 * 已删除条目（D）或目录条目（末尾 /）返回 null。
 */

function decodeGitQuoted(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < quoted.length) {
    if (quoted[i] === "\\" && i + 1 < quoted.length) {
      const oct = quoted.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(Number.parseInt(oct, 8));
        i += 4;
        continue;
      }
      const esc = quoted[i + 1];
      const map: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const decoded = map[esc] ?? esc;
      for (const b of encoder.encode(decoded)) bytes.push(b);
      i += 2;
      continue;
    }
    for (const b of encoder.encode(quoted[i])) bytes.push(b);
    i += 1;
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeGitQuoted(trimmed.slice(1, -1));
  }
  return trimmed;
}

export function extractGitStatusPath(statusLine: string): { status: string; relPath: string } | null {
  if (typeof statusLine !== "string" || statusLine.length < 4) return null;
  const status = statusLine.slice(0, 2);
  let rest = statusLine.slice(3).trim();
  if (!rest) return null;

  // 仅当状态为重命名（R）或复制（C）时拆解 "old -> new"
  if (status.includes("R") || status.includes("C")) {
    const arrowIdx = rest.lastIndexOf(" -> ");
    if (arrowIdx >= 0) {
      rest = rest.slice(arrowIdx + 4).trim();
    }
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
