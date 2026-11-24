#!/usr/bin/env node
/**
 * remote-terminal 统一控制 CLI（rtctl）：
 * ensure / status / stop / ls / fetch-ca / devices / approve / deny / revoke / join
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFingerprint } from "../src/protocol.ts";
import { defaultConfigPath, defaultStateDir, loadRemoteSettings } from "../src/relay/config.ts";
import { approveByCode, denyByCode, readActivePending, readDevices, readLastSeen, revokeById } from "../src/relay/devices.ts";
import { ensureRemote, statusReport, stopAll } from "../src/relay/ensure.ts";
import { runJoin } from "../src/relay/join.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = defaultStateDir();
const configPath = defaultConfigPath();

function usage(): never {
  console.error(
    "用法：rtctl <ensure|status|stop|ls|fetch-ca|devices|approve <配对码> [--name 名称]|deny <配对码>|revoke <设备id>|join>",
  );
  process.exit(1);
}

async function fetchCa(): Promise<void> {
  const settings = await loadRemoteSettings(configPath);
  if (!settings.relay) throw new Error(`缺少 webRelay 配置：请先写入 ${configPath} 或运行 rtctl join`);
  const url = new URL(settings.relay.url);
  const target = `https://${url.hostname}${url.port ? `:${url.port}` : ""}/ca.crt`;
  const pem = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(target, { rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载 CA 失败：HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("下载 CA 超时")); });
    req.on("error", reject);
    req.end();
  });
  const base64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(base64, "base64");
  const fingerprint = normalizeFingerprint(createHash("sha256").update(der).digest("hex"));
  if (!fingerprint || fingerprint !== settings.relay.caFingerprint) {
    throw new Error("CA 指纹与 webRelay.caFingerprint 不一致：拒绝保存（请核对 ECS init 输出，谨防中间人）");
  }
  const file = path.join(stateDir, "root-ca.crt");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
  console.log(`CA 已校验并保存：${file}`);
}

async function listDevices(): Promise<void> {
  const pending = await readActivePending(stateDir);
  const devices = await readDevices(stateDir);
  const lastSeen = await readLastSeen(stateDir);
  if (pending.length > 0) {
    console.log("待批准设备（核对手机屏幕配对码后执行 rtctl approve <配对码>）：");
    for (const p of pending) {
      console.log(`  配对码 ${p.code}  id=${p.id}  来源=${p.ip}  时间=${new Date(p.ts).toLocaleString()}  UA=${p.ua}`);
    }
  } else {
    console.log("无待批准设备。");
  }
  if (devices.length > 0) {
    console.log("可信设备：");
    for (const d of devices) {
      console.log(`  id=${d.id}  名称=${d.name}  批准于=${d.approvedAt}  最近活跃=${lastSeen[d.id] ?? "未知"}  UA=${d.ua}`);
    }
  } else {
    console.log("无可信设备。");
  }
}

async function listSessions(): Promise<void> {
  const { listTmuxSessions } = await import("../src/web/server.ts");
  const sessions = await listTmuxSessions();
  if (sessions.length === 0) {
    console.log("当前没有运行中的 tmux 会话。");
    return;
  }
  for (const s of sessions) {
    const cmd = s.command ? `  cmd=${s.command}` : "";
    const att = s.attached ? " [attached]" : "";
    console.log(`  ${s.name}  (${s.windows}w)${cmd}${att}  创建于 ${s.created}`);
  }
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "ensure": {
      try {
        const result = await ensureRemote(pkgRoot, stateDir, configPath);
        for (const message of result.messages) console.log(message);
      } catch (error) {
        console.error(`remote-terminal 未启用：${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(0);
      break;
    }
    case "status":
      console.log(await statusReport(stateDir, configPath));
      break;
    case "stop":
      await stopAll(stateDir);
      console.log("已停止本机 remote-terminal web-server 与 relay-agent。");
      break;
    case "ls":
      await listSessions();
      break;
    case "fetch-ca":
      await fetchCa();
      break;
    case "devices":
      await listDevices();
      break;
    case "approve": {
      const code = rest[0];
      if (!code) usage();
      const nameIdx = rest.indexOf("--name");
      const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
      const device = await approveByCode(stateDir, code, name);
      console.log(`已批准设备：id=${device.id} 名称=${device.name}（配对页将自动获得凭据并跳转）`);
      break;
    }
    case "deny": {
      const code = rest[0];
      if (!code) usage();
      await denyByCode(stateDir, code);
      console.log(`已拒绝配对码 ${code} 对应的设备。`);
      break;
    }
    case "revoke": {
      const id = rest[0];
      if (!id) usage();
      const device = await revokeById(stateDir, id);
      console.log(`已吊销设备：id=${device.id} 名称=${device.name}（存量连接即时切断，再次访问需重新配对）`);
      break;
    }
    case "join":
      await runJoin(pkgRoot, stateDir, configPath);
      break;
    case "_agent": {
      const { runAgent } = await import("../src/relay/agent.ts");
      await runAgent(stateDir, configPath);
      break;
    }
    default:
      usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
