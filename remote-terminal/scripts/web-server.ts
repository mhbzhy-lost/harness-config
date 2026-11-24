#!/usr/bin/env node
// remote-terminal web-server：将本机任意 tmux 会话通过浏览器共享。
// 用法：node remote-terminal/scripts/web-server.ts [--port 7681] [--host 0.0.0.0] [--token xxx] [--cwd dir]
import { resolve } from "node:path";
import { checkTmux, startWebServer, type WebServerOptions } from "../src/web/server.ts";

function parseArgs(argv: string[]): Partial<WebServerOptions> {
  const opts: Partial<WebServerOptions> = {};
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--port" || arg === "-p") opts.port = Number(args.shift());
    else if (arg === "--host") opts.host = String(args.shift());
    else if (arg === "--token") opts.token = String(args.shift());
    else if (arg === "--session" || arg === "-s") opts.defaultSession = String(args.shift());
    else if (arg === "--cols") opts.cols = Number(args.shift());
    else if (arg === "--rows") opts.rows = Number(args.shift());
    else if (arg === "--cwd") opts.cwd = String(args.shift());
    else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const options: WebServerOptions = {
  port: 7681,
  host: "0.0.0.0",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  ...opts,
};
if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
  console.error("--port 必须是 1-65535 的整数");
  process.exit(1);
}
options.cwd = resolve(options.cwd);

const tmuxVersion = await checkTmux();
const { urls, close } = await startWebServer(options);
console.log(`remote-terminal 已启动（tmux ${tmuxVersion}，工作目录 ${options.cwd}）`);
console.log("  浏览器打开即见当前全部 tmux 会话，任意会话均可经 rt <命令> 或 tmux 创建。");
console.log(`  本机：    http://localhost:${options.port}`);
for (const url of urls.filter((u) => !u.includes("localhost"))) {
  console.log(`  局域网：  ${url}${options.token ? "（已启用 token 门禁，运行 rtctl status 查看完整链接）" : ""}`);
}
if (!options.token) {
  console.warn("⚠ 未设置 --token：同一局域网内任何设备都可以完全控制这些终端。");
}

const shutdown = () => {
  console.log("正在关闭…");
  close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
