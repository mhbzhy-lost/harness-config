import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI_SRC = dirname(fileURLToPath(import.meta.url));
const OUT_HTML = resolve(UI_SRC, "..", "ui", "monitor.html");

const result = await build({
  entryPoints: [join(UI_SRC, "app.tsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  target: ["es2022"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  minify: true,
  // 页面声明 utf-8：保留中文文案原样输出，便于静态校验与可读性
  charset: "utf8",
  write: false,
});

const jsCode = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const streamdownCss = readFileSync(join(UI_SRC, "node_modules", "streamdown", "styles.css"), "utf8");
const appCss = readFileSync(join(UI_SRC, "styles.css"), "utf8");
const cssCode = `${streamdownCss}\n${appCss}`.replace(/<\/style/gi, "<\\/style");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi Worker Monitor</title>
<style>${cssCode}</style>
</head>
<body>
<div id="root"></div>
<script>${jsCode}</script>
</body>
</html>
`;

mkdirSync(dirname(OUT_HTML), { recursive: true });
writeFileSync(OUT_HTML, html, "utf8");
console.log(`Built ${OUT_HTML} (${Buffer.byteLength(html, "utf8")} bytes)`);
