import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { is192168, normalizeFingerprint, PAIR_TTL_MS, PROTOCOL_VERSION, safeEqualHex, sha256Hex } from "../remote-terminal/src/protocol.ts";
import { loadRemoteSettings, validateRemoteSettings } from "../remote-terminal/src/relay/config.ts";
import { addPending, approveByCode, denyByCode, readActivePending, readDevices, revokeById } from "../remote-terminal/src/relay/devices.ts";
import { statusReport } from "../remote-terminal/src/relay/ensure.ts";
import { parseInjection } from "../remote-terminal/src/relay/join.ts";

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
