import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI_SRC = dirname(fileURLToPath(import.meta.url));
const OUT_HTML = resolve(UI_SRC, "..", "ui", "monitor.html");

const result = await build({
  entryPoints: [join(UI_SRC, "app.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  minify: true,
  write: false,
});

const jsCode = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const cssCode = readFileSync(join(UI_SRC, "styles.css"), "utf8").replace(/<\/style/gi, "<\\/style");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi Worker Monitor</title>
<style>${cssCode}</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <span class="brand">Pi Worker</span>
    <select id="task-select" class="task-select" aria-label="选择任务"></select>
    <button id="btn-refresh" class="btn" type="button">刷新</button>
    <button id="btn-cancel" class="btn btn-danger" type="button" disabled>取消</button>
  </header>
  <main id="main" class="main"></main>
</div>
<script>${jsCode}</script>
</body>
</html>
`;

mkdirSync(dirname(OUT_HTML), { recursive: true });
writeFileSync(OUT_HTML, html, "utf8");
console.log(`Built ${OUT_HTML} (${Buffer.byteLength(html, "utf8")} bytes)`);
