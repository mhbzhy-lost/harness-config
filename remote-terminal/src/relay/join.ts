/**
 * 新主机交互式接入：把 ECS 中继注入材料（webExposure/webRelay）合并进本机
 * ~/.harness-remote/config.json，随后自动执行 fetch-ca → ensure → status。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { validateRemoteSettings } from "./config.ts";

function fail(message: string): never {
  console.error(`[rtctl join] ${message}`);
  process.exit(1);
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function maskToken(token: string): string {
  return `${token.slice(0, 4)}…（${token.length} 字符，已隐去）`;
}

export function parseInjection(raw: string): { webExposure: "public"; webRelay: { url: string; agentToken: string; caFingerprint: string } } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) fail("未找到 JSON 对象：请确认取回的是 ECS init 输出的注入材料");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    fail("注入材料不是合法 JSON");
  }
  const settings = validateRemoteSettings(parsed as { webExposure?: unknown; webRelay?: unknown });
  if (settings.exposure !== "public" || !settings.relay) fail("注入材料必须是 webExposure=public 且含完整 webRelay");
  return parsed as { webExposure: "public"; webRelay: { url: string; agentToken: string; caFingerprint: string } };
}

export async function runJoin(pkgRoot: string, stateDir: string, configPath: string): Promise<void> {
  try {
    await joinFlow(pkgRoot, stateDir, configPath);
  } catch (e) {
    if ((e as { code?: string }).code === "ABORT_ERR") fail("输入已结束（Ctrl+D/EOF），已取消；未写入的配置不受影响");
    throw e;
  }
}

async function joinFlow(pkgRoot: string, stateDir: string, configPath: string): Promise<void> {
  if (!process.stdin.isTTY) fail("需要交互式终端（stdin 非 TTY）：请在终端直接运行 rtctl join");
  const ctlScript = path.join(pkgRoot, "scripts", "remote-ctl.ts");
  if (!existsSync(ctlScript)) fail(`找不到控制脚本：${ctlScript}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = ""): Promise<string> => {
    const suffix = fallback ? `（默认 ${fallback}）` : "";
    const answer = (await rl.question(`${question}${suffix}：`)).trim();
    return answer || fallback;
  };
  const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
    const answer = (await rl.question(`${question}（${defaultYes ? "Y/n" : "y/N"}）：`)).trim().toLowerCase();
    return answer === "" ? defaultYes : answer === "y" || answer === "yes";
  };

  console.log("remote-terminal 新主机接入：合并中继注入材料 → fetch-ca → ensure → status");

  let raw: string;
  const mode = await ask("注入材料来源：1=ssh 从 ECS 取回，2=手工粘贴", "1");
  if (mode === "2") {
    console.log("请粘贴 init 输出的注入 JSON（含 webExposure/webRelay），以单独一行 END 结束：");
    raw = await new Promise<string>((resolve) => {
      const lines: string[] = [];
      const onLine = (line: string): void => {
        if (line.trim() === "END") {
          rl.removeListener("line", onLine);
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
        }
      };
      rl.on("line", onLine);
      rl.once("close", () => {
        rl.removeListener("line", onLine);
        resolve(lines.join("\n"));
      });
    });
  } else if (mode === "1") {
    const ecs = await ask("ECS ssh 目标（user@host）");
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ecs)) fail("ssh 目标格式应为 user@host（不含空格/特殊字符）");
    const pemRaw = await ask("pem 私钥路径");
    const pem = expandHome(pemRaw);
    if (!pem || !existsSync(pem)) fail(`私钥文件不存在：${pem || "(空)"}`);
    const port = await ask("ssh 端口", "22");
    if (!/^[0-9]{1,5}$/.test(port)) fail("ssh 端口必须是数字");
    const remote = await ask("远端注入材料路径（相对登录家目录）", "pi-relay-server/init-output-agent2.txt");
    if (!/^[A-Za-z0-9_./-]+$/.test(remote)) fail("远端路径只允许字母/数字/_-./");
    const base = path.posix.basename(remote);
    const remoteCmd = `cat '${remote}' 2>/dev/null || find /home /root -maxdepth 3 -name '${base}' -exec cat {} \\;`;
    console.log(`正在经 ssh 取回 ${ecs}:${remote} …`);
    const res = spawnSync(
      "ssh",
      ["-i", pem, "-p", port, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ecs, remoteCmd],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (res.status !== 0 || !res.stdout?.trim()) {
      console.error(res.stderr?.trim() || "(无 stderr)");
      fail("ssh 取回失败：请核对目标/私钥/端口/路径，或改用手工粘贴（来源选 2）");
    }
    raw = res.stdout;
  } else {
    fail("来源只能是 1 或 2");
  }

  const injection = parseInjection(raw);
  let current: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      fail(`现有 ${configPath} 不是合法 JSON：请先手动修复`);
    }
  }
  const merged = { ...current, ...injection };
  validateRemoteSettings(merged);
  console.log("将写入以下远程访问配置（其余字段保持不变）：");
  console.log("  webExposure：public");
  console.log(`  webRelay.url：${injection.webRelay.url}`);
  console.log(`  webRelay.agentToken：${maskToken(injection.webRelay.agentToken)}`);
  console.log(`  webRelay.caFingerprint：${injection.webRelay.caFingerprint}`);
  console.log(`  目标文件：${configPath}`);
  if (!(await confirm("确认写入？"))) fail("已取消：未写入任何配置");
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  console.log("已写入。");
  rl.close();

  const env = { ...process.env, HARNESS_REMOTE_DIR: stateDir, HARNESS_REMOTE_CONFIG: configPath };
  const run = (args: string[]): number => spawnSync(process.execPath, [ctlScript, ...args], { cwd: pkgRoot, stdio: "inherit", env }).status ?? 1;
  const caPath = path.join(stateDir, "root-ca.crt");
  const caMtimeBefore = existsSync(caPath) ? statSync(caPath).mtimeMs : 0;
  console.log("\n—— fetch-ca（下载并按指纹校验中继 CA）——");
  run(["fetch-ca"]);
  if (!existsSync(caPath) || statSync(caPath).mtimeMs <= caMtimeBefore) fail("CA 未被本次 fetch-ca 重写：取回/校验失败，请修复后重跑");
  console.log("\n—— ensure（启动 web-server + relay-agent）——");
  run(["ensure"]);
  console.log("\n—— status ——");
  run(["status"]);
  console.log("\n接入完成。手机侧打开中继入口后，在本机运行 rtctl approve <配对码> 批准。");
}
