/**
 * 轻量、零依赖、XSS 安全的 GFM 子集 Markdown 渲染器（供 Pi Worker 侧面板使用）。
 * 所有非代码与代码文本均先经过 HTML 转义后再生成有限白名单标签；
 * 链接仅放行 http:// 与 https:// 协议，拒绝 javascript:/data: 等危险协议。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineSegment(raw: string): string {
  let out = escapeHtml(raw);

  // 仅放行 http(s) 链接，其余协议退化为纯文本
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 粗体 **...**（避免误伤代码标识符里的下划线，不做 _..._ 斜体）
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  // 删除线 ~~...~~
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  // 斜体 *...*（排除已处理的 <strong> 和两侧空白）
  out = out.replace(/(?<!\*)\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "<em>$1</em>");

  return out;
}

export function renderInline(raw: string): string {
  // 先拆分行内代码（支持单反引号与双反引号），避免代码内部被二次解析为加粗/链接
  const tokenRe = /``([^`\n]+?)``|`([^`\n]+?)`/g;
  let result = "";
  let lastIndex = 0;
  for (const match of raw.matchAll(tokenRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      result += renderInlineSegment(raw.slice(lastIndex, idx));
    }
    const codeText = match[1] ?? match[2] ?? "";
    result += `<code>${escapeHtml(codeText)}</code>`;
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < raw.length) {
    result += renderInlineSegment(raw.slice(lastIndex));
  }
  return result;
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableSeparator(line: string): Array<"left" | "center" | "right" | null> | null {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return null;
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return null;
  const cells = splitTableCells(trimmed);
  if (cells.length === 0) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const BQ_RE = /^\s*>\s?(.*)$/;

function isBlockStarter(lines: string[], idx: number): boolean {
  const line = lines[idx];
  if (!line.trim()) return true;
  if (HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line) || BQ_RE.test(line)) {
    return true;
  }
  if (UL_RE.test(line) || OL_RE.test(line)) return true;
  if (idx + 1 < lines.length && line.includes("|") && parseTableSeparator(lines[idx + 1]) !== null) {
    return true;
  }
  return false;
}

function renderList(lines: string[], startIndex: number): { html: string; nextIndex: number } {
  const firstUl = UL_RE.exec(lines[startIndex]);
  const firstOl = OL_RE.exec(lines[startIndex]);
  const tag = firstOl ? "ol" : "ul";
  const baseIndent = (firstUl?.[1] ?? firstOl?.[1] ?? "").length;
  const itemRe = tag === "ol" ? OL_RE : UL_RE;

  const items: string[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = itemRe.exec(line);
    if (!m || m[1].length !== baseIndent) break;

    const itemLines: string[] = [m[2]];
    let nestedHtml = "";
    i += 1;

    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      const nextUl = UL_RE.exec(next);
      const nextOl = OL_RE.exec(next);
      const nextListIndent = nextUl ? nextUl[1].length : nextOl ? nextOl[1].length : -1;

      if (nextListIndent > baseIndent) {
        const sub = renderList(lines, i);
        nestedHtml += sub.html;
        i = sub.nextIndex;
        continue;
      }
      if (nextListIndent >= 0 && nextListIndent <= baseIndent) {
        break;
      }
      if (/^\s{2,}/.test(next) && !FENCE_RE.test(next)) {
        itemLines.push(next.trim());
        i += 1;
        continue;
      }
      break;
    }

    const body = itemLines.map((l) => renderInline(l)).join("<br />");
    items.push(`<li>${body}${nestedHtml}</li>`);
  }

  return { html: `<${tag} class="md-list">${items.join("")}</${tag}>`, nextIndex: i };
}

export function renderMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const markerLen = fence[2].length;
      const lang = fence[3].trim().split(/\s+/)[0] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closeLine = lines[i].trim();
        if (closeLine.startsWith(marker.repeat(markerLen)) && new RegExp(`^\\${marker}{${markerLen},}\\s*$`).test(closeLine)) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      const langAttr = lang && /^[a-z0-9_+-]+$/i.test(lang) ? ` data-lang="${escapeHtml(lang)}"` : "";
      blocks.push(`<pre class="md-code"${langAttr}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level} class="md-h md-h${level}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (HR_RE.test(line)) {
      blocks.push(`<hr class="md-hr" />`);
      i += 1;
      continue;
    }

    // 引用块
    if (BQ_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qm = BQ_RE.exec(lines[i]);
        if (!qm) break;
        quoteLines.push(qm[1]);
        i += 1;
      }
      blocks.push(`<blockquote class="md-quote">${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    // GFM 表格
    if (i + 1 < lines.length && line.includes("|")) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
        const headerCells = splitTableCells(line);
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          if (HEADING_RE.test(lines[i]) || FENCE_RE.test(lines[i])) break;
          bodyRows.push(splitTableCells(lines[i]));
          i += 1;
        }
        const colCount = Math.max(headerCells.length, aligns.length);
        const alignAttr = (idx: number): string => {
          const a = aligns[idx];
          return a ? ` style="text-align:${a}"` : "";
        };
        const ths = Array.from({ length: colCount }, (_, idx) =>
          `<th${alignAttr(idx)}>${renderInline(headerCells[idx] ?? "")}</th>`,
        ).join("");
        const trs = bodyRows.map((row) =>
          `<tr>${Array.from({ length: colCount }, (_, idx) =>
            `<td${alignAttr(idx)}>${renderInline(row[idx] ?? "")}</td>`,
          ).join("")}</tr>`,
        ).join("");
        blocks.push(
          `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`,
        );
        continue;
      }
    }

    // 有序 / 无序列表
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const list = renderList(lines, i);
      blocks.push(list.html);
      i = list.nextIndex;
      continue;
    }

    // 普通段落
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p class="md-p">${paraLines.map((l) => renderInline(l)).join("<br />")}</p>`);
  }

  return blocks.join("");
}
