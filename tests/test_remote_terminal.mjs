import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKPRESSURE_CHECK_MS,
  BACKPRESSURE_HIGH_BYTES,
  is192168,
  MAX_WS_MESSAGE_BYTES,
  normalizeFingerprint,
  PAIR_TTL_MS,
  PROTOCOL_VERSION,
  safeEqualHex,
  sha256Hex,
} from "../remote-terminal/src/protocol.ts";
import { loadRemoteSettings, validateRemoteSettings } from "../remote-terminal/src/relay/config.ts";
import { addPending, approveByCode, denyByCode, readActivePending, readDevices, revokeById } from "../remote-terminal/src/relay/devices.ts";
import { statusReport, withEnsureLock } from "../remote-terminal/src/relay/ensure.ts";
import {
  createEarlyBuffer,
  createHeaderRewriter,
  forceConnectionClose,
  MAX_EARLY_BUFFER_BYTES,
  MAX_HEADER_BUFFER_BYTES,
} from "../remote-terminal/src/relay/header-rewrite.ts";
import { parseInjection } from "../remote-terminal/src/relay/join.ts";
import { parseRequestUrl } from "../remote-terminal/src/web/url.ts";

const VALID_FP = "a".repeat(64);
const VALID_TOKEN = "abcdefgh12345678";

test("protocol: 指纹归一化、摘要比对与协议版本常量与 pi-relay-server v2 对齐", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  const norm = normalizeFingerprint(`SHA256:${VALID_FP}`);
  assert.equal(norm, Array(32).fill("AA").join(":"));
  assert.equal(normalizeFingerprint("not-a-fp"), null);
  assert.equal(safeEqualHex(sha256Hex("secret"), sha256Hex("secret")), true);
  assert.equal(safeEqualHex(sha256Hex("secret"), sha256Hex("other")), false);
  assert.equal(is192168("192.168.31.25"), true);
  assert.equal(is192168("10.0.0.1"), false);
});

test("config: 缺失文件默认 off，合法 public 配置与非法字段校验符合 fail-closed", async () => {
  const missing = await loadRemoteSettings("/nonexistent/remote-config.json");
  assert.deepEqual(missing, { exposure: "off", relay: null });

  const parsed = validateRemoteSettings({
    webExposure: "public",
    webRelay: {
      url: "wss://1.2.3.4:8443",
      agentToken: VALID_TOKEN,
      caFingerprint: `SHA256:${VALID_FP}`,
    },
  });
  assert.equal(parsed.exposure, "public");
  assert.equal(parsed.relay?.caFingerprint, Array(32).fill("AA").join(":"));

  assert.throws(() => validateRemoteSettings({ webExposure: "invalid" }), /webExposure/);
  assert.throws(
    () => validateRemoteSettings({ webExposure: "public", webRelay: { url: "http://1.2.3.4", agentToken: VALID_TOKEN, caFingerprint: VALID_FP } }),
    /wss:\/\//,
  );
  assert.throws(
    () => validateRemoteSettings({ webExposure: "public", webRelay: { url: "wss://1.2.3.4", agentToken: VALID_TOKEN, caFingerprint: VALID_FP, extra: 1 } }),
    /不支持的字段/,
  );
});

test("devices: 批准/拒绝/吊销与过期 pending 过滤", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-dev-"));
  try {
    const now = Date.now();
    // 写入一条已过期的 pending + 一条有效的 pending
    writeFileSync(
      join(dir, "pair-pending.json"),
      JSON.stringify([
        { id: "old1", code: "111111", ua: "OldPhone", ip: "1.1.1.1", secretHash: sha256Hex("old"), ts: now - PAIR_TTL_MS - 10_000, status: "pending" },
      ]),
    );
    await addPending(dir, { id: "dev1", code: "654321", ua: "iPhone", ip: "2.2.2.2", secretHash: sha256Hex("s1"), ts: now, status: "pending" });
    await addPending(dir, { id: "dev2", code: "999999", ua: "Android", ip: "3.3.3.3", secretHash: sha256Hex("s2"), ts: now, status: "pending" });

    const active = await readActivePending(dir, now);
    assert.deepEqual(active.map((p) => p.id).sort(), ["dev1", "dev2"]);

    const approved = await approveByCode(dir, "654321", "我的手机");
    assert.equal(approved.name, "我的手机");
    assert.equal((await readDevices(dir)).length, 1);

    await denyByCode(dir, "999999");
    assert.equal((await readActivePending(dir, now)).length, 0);

    await revokeById(dir, "dev1");
    assert.equal((await readDevices(dir)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join & status: 从杂散文本提取注入 JSON，且 off 态 statusReport 正确输出", async () => {
  const raw = `=== ECS init output ===\n${JSON.stringify({
    webExposure: "public",
    webRelay: { url: "wss://8.8.8.8:8443", agentToken: VALID_TOKEN, caFingerprint: `SHA256:${VALID_FP}` },
  })}\nDone.\n`;
  const parsed = parseInjection(raw);
  assert.equal(parsed.webExposure, "public");
  assert.equal(parsed.webRelay.url, "wss://8.8.8.8:8443");

  const dir = mkdtempSync(join(tmpdir(), "rt-status-"));
  try {
    const report = await statusReport(dir, join(dir, "config.json"));
    assert.match(report, /webExposure：off/);
    assert.match(report, /web-server：未运行/);
    assert.match(report, /relay-agent：未运行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web url parser: rejects malformed HTTP/upgrade URLs cleanly without throwing", async () => {
  assert.equal(parseRequestUrl("http://[invalid"), null);
  assert.equal(parseRequestUrl(""), null);
  assert.equal(parseRequestUrl(undefined), null);
  const parsed = parseRequestUrl("/ws?session=a&token=b");
  assert.ok(parsed instanceof URL);
  assert.equal(parsed.pathname, "/ws");
  assert.equal(parsed.searchParams.get("session"), "a");
  assert.equal(parsed.searchParams.get("token"), "b");

  const server = createServer((req, res) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    res.writeHead(200);
    res.end(url.pathname);
  });
  server.on("upgrade", (req, socket) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");

    const sendRaw = (raw) =>
      new Promise((resolve, reject) => {
        const sock = connect(addr.port, "127.0.0.1", () => sock.write(raw));
        let buf = "";
        sock.on("data", (d) => {
          buf += d.toString("latin1");
        });
        sock.on("end", () => resolve(buf));
        sock.on("close", () => resolve(buf));
        sock.on("error", reject);
      });

    const httpResp = await sendRaw("GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    assert.match(httpResp, /^HTTP\/1\.1 400 Bad Request/);

    const wsResp = await sendRaw("GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    assert.match(wsResp, /^HTTP\/1\.1 400 Bad Request/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const serverSrc = readFileSync(new URL("../remote-terminal/src/web/server.ts", import.meta.url), "utf8");
  assert.match(serverSrc, /parseRequestUrl/);
  assert.match(serverSrc, /maxPayload:\s*MAX_WS_MESSAGE_BYTES/);
  assert.match(serverSrc, /ws\.bufferedAmount\s*>\s*BACKPRESSURE_HIGH_BYTES/);
  assert.match(serverSrc, /att\.pause\(\)/);
  assert.match(serverSrc, /att\.resume\(\)/);
  assert.match(serverSrc, /BACKPRESSURE_CHECK_MS/);
  assert.match(serverSrc, /closeAllConnections/);
  assert.match(serverSrc, /ws\.terminate\(\)/);
  assert.equal(MAX_WS_MESSAGE_BYTES, 4 * 1024 * 1024);
  assert.equal(BACKPRESSURE_HIGH_BYTES, 1024 * 1024);
  assert.equal(BACKPRESSURE_CHECK_MS, 20);
});

test("relay locks & atomicWriteJson: atomic link publish + reclaim mutex handles dead lock and concurrent writes safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-lock-"));
  try {
    // 预置已死 PID 的 devices.lock 与 ensure.lock
    const deadPayload = JSON.stringify({ pid: 99999999, token: "dead-token" });
    writeFileSync(join(dir, "devices.lock"), deadPayload, { mode: 0o600 });
    writeFileSync(join(dir, "ensure.lock"), deadPayload, { mode: 0o600 });

    const now = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        addPending(dir, {
          id: `dev-${i}`,
          code: String(100000 + i),
          ua: `UA-${i}`,
          ip: "1.2.3.4",
          secretHash: sha256Hex(`s-${i}`),
          ts: now,
          status: "pending",
        }),
      ),
    );
    const pending = await readActivePending(dir, now);
    assert.equal(pending.length, 10);

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => approveByCode(dir, String(100000 + i), `Device-${i}`)),
    );
    const devices = await readDevices(dir);
    assert.equal(devices.length, 5);
    assert.equal((await readActivePending(dir, now)).length, 5);

    // 验证 0 字节损坏锁：mtime > 2s 才能回收，新鲜 0 字节锁在宽限期内不被误删
    const corruptFile = join(dir, "devices.lock");
    writeFileSync(corruptFile, "", { mode: 0o600 });
    const oldTime = new Date(Date.now() - 3_000);
    utimesSync(corruptFile, oldTime, oldTime);
    await addPending(dir, {
      id: "dev-after-corrupt",
      code: "200001",
      ua: "UA-after",
      ip: "1.2.3.5",
      secretHash: sha256Hex("s-after"),
      ts: now,
      status: "pending",
    });
    assert.equal((await readActivePending(dir, now)).length, 6);

    // 验证 ensure.ts 的 withEnsureLock 也能回收死锁并串行化执行
    let concurrent = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withEnsureLock(dir, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 15));
          concurrent -= 1;
        }),
      ),
    );
    assert.equal(maxConcurrent, 1);

    const devicesSrc = readFileSync(new URL("../remote-terminal/src/relay/devices.ts", import.meta.url), "utf8");
    const ensureSrc = readFileSync(new URL("../remote-terminal/src/relay/ensure.ts", import.meta.url), "utf8");
    assert.match(devicesSrc, /randomUUID/);
    assert.match(devicesSrc, /\.reclaim/);
    assert.match(devicesSrc, /link\(/);
    assert.doesNotMatch(ensureSrc, /open\(lockFile,\s*"wx"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay header-rewrite: split HTTP headers across multiple chunks still rewrite Connection: close and cap early buffer", () => {
  assert.equal(MAX_HEADER_BUFFER_BYTES, 65536);
  assert.equal(MAX_EARLY_BUFFER_BYTES, 1024 * 1024);

  const rewriter = createHeaderRewriter();
  const r1 = rewriter.push(Buffer.from("GET / HTTP/1.1\r\nConnection: keep-alive", "latin1"));
  assert.equal(r1.done, false);
  assert.equal(r1.overflow, false);
  assert.equal(r1.output, null);

  const r2 = rewriter.push(Buffer.from("\r\n\r\n", "latin1"));
  assert.equal(r2.done, true);
  assert.equal(r2.overflow, false);
  assert.ok(r2.output);
  const text = r2.output.toString("latin1");
  assert.match(text, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(text, /keep-alive/i);

  const r3 = rewriter.push(Buffer.from("body-part", "latin1"));
  assert.equal(r3.done, true);
  assert.equal(r3.output?.toString("latin1"), "body-part");

  // Upgrade 头保持透传
  const wsRewriter = createHeaderRewriter();
  const u1 = wsRewriter.push(Buffer.from("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade", "latin1"));
  assert.equal(u1.done, false);
  const u2 = wsRewriter.push(Buffer.from("\r\n\r\n", "latin1"));
  assert.equal(u2.done, true);
  assert.match(u2.output?.toString("latin1") ?? "", /Connection: Upgrade/);

  // 头部缓冲区超限拒绝
  const smallRewriter = createHeaderRewriter(32);
  const o1 = smallRewriter.push(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nX-Long: 1234567890", "latin1"));
  assert.equal(o1.overflow, true);
  assert.equal(o1.output, null);

  // forceConnectionClose 直接调用兼容末行 Connection 头
  const direct = forceConnectionClose(Buffer.from("GET / HTTP/1.1\r\nHost: a\r\nConnection: keep-alive\r\n\r\n", "latin1"));
  assert.doesNotMatch(direct.toString("latin1"), /keep-alive/i);
  assert.match(direct.toString("latin1"), /Connection: close\r\n\r\n$/);

  // EarlyBuffer 限流
  const early = createEarlyBuffer(16);
  assert.equal(early.push(Buffer.alloc(10, 0x61)), true);
  assert.equal(early.push(Buffer.alloc(7, 0x62)), false);
  assert.equal(early.drain().length, 1);
  assert.equal(early.bytes, 0);

  const agentSrc = readFileSync(new URL("../remote-terminal/src/relay/agent.ts", import.meta.url), "utf8");
  assert.match(agentSrc, /createHeaderRewriter/);
  assert.match(agentSrc, /createEarlyBuffer/);
  assert.match(agentSrc, /\.finally\(\(\)\s*=>\s*process\.exit\(/);
});
