import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as providers from "../plugins/deepseek-search/src/providers.ts";

const PROVIDERS_URL = pathToFileURL(join(process.cwd(), "plugins/deepseek-search/src/providers.ts")).href;

function generateSelfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "ds-search-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: "pipe" });
  return {
    dir,
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

test("direct fetch: timeout covers slow response body streaming", async () => {
  assert.equal(typeof providers.postJson, "function", "postJson 必须导出");
  const tls = generateSelfSignedCert();
  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"partial":');
    // 故意保持连接不调用 res.end()，模拟慢速/挂起的响应体流
  });

  try {
    const port = await listenServer(server);
    const script = `
      import { postJson, ProviderFailure } from ${JSON.stringify(PROVIDERS_URL)};
      const started = Date.now();
      try {
        await postJson("deepseek", ${JSON.stringify(`https://127.0.0.1:${port}/v1/tools/search`)}, { query: "test" }, { "Content-Type": "application/json" }, { timeoutMs: 150 });
        console.error("UNEXPECTED_SUCCESS");
        process.exit(2);
      } catch (err) {
        const elapsed = Date.now() - started;
        console.log(JSON.stringify({
          isProviderFailure: err instanceof ProviderFailure,
          name: err?.name,
          message: err?.message,
          elapsed,
        }));
      }
    `;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: tls.certPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, `子进程异常退出 code=${result.code}, stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.isProviderFailure, true, `应抛出 ProviderFailure，实际: ${result.stdout}`);
    assert.ok(parsed.elapsed < 600, `慢响应体超时应在 600ms 内触发，实际 ${parsed.elapsed}ms`);
  } finally {
    await closeServer(server);
    rmSync(tls.dir, { recursive: true, force: true });
  }
});

test("proxy tunnel: stalled TLS handshake after CONNECT 200 times out and destroys socket", async () => {
  assert.equal(typeof providers.postJson, "function", "postJson 必须导出");
  const tls = generateSelfSignedCert();
  let proxySocketClosed = false;
  let proxySocketCloseResolve;
  const proxySocketClosedPromise = new Promise((resolve) => {
    proxySocketCloseResolve = resolve;
  });

  const proxy = createHttpServer();
  const proxySockets = new Set();
  proxy.on("connect", (_req, clientSocket) => {
    proxySockets.add(clientSocket);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    clientSocket.resume();
    clientSocket.once("end", () => clientSocket.destroy());
    clientSocket.once("error", () => clientSocket.destroy());
    clientSocket.once("close", () => {
      proxySockets.delete(clientSocket);
      proxySocketClosed = true;
      proxySocketCloseResolve();
    });
    // CONNECT 200 后故意不返回任何 TLS 握手字节
  });

  try {
    const proxyPort = await listenServer(proxy);
    const started = Date.now();
    await assert.rejects(
      () => providers.postJson(
        "exa",
        "https://127.0.0.1:443/search",
        { query: "test" },
        { "Content-Type": "application/json" },
        { timeoutMs: 150, ca: tls.cert, proxyPort },
      ),
      (err) => err instanceof providers.ProviderFailure,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 600, `TLS 握手挂死超时应在 600ms 内结束，实际 ${elapsed}ms`);

    await Promise.race([
      proxySocketClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("proxy socket 未在超时后关闭")), 500)),
    ]);
    assert.equal(proxySocketClosed, true, "代理侧底层 socket 应收到 close 事件不泄漏");
  } finally {
    for (const s of proxySockets) s.destroy();
    await closeServer(proxy);
    rmSync(tls.dir, { recursive: true, force: true });
  }
});

test("proxy tunnel: premature response close rejects promptly instead of hanging", async () => {
  assert.equal(typeof providers.postJson, "function", "postJson 必须导出");
  const tls = generateSelfSignedCert();
  const targetServer = createHttpsServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": "1000",
    });
    res.write("hello", () => {
      res.socket?.destroy();
    });
  });

  const proxy = createHttpServer();
  const proxyConns = new Set();
  proxy.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(":");
    const upstream = netConnect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    proxyConns.add(clientSocket);
    proxyConns.add(upstream);
    const cleanup = () => {
      proxyConns.delete(clientSocket);
      proxyConns.delete(upstream);
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("error", cleanup);
    clientSocket.on("error", cleanup);
    upstream.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });

  try {
    const targetPort = await listenServer(targetServer);
    const proxyPort = await listenServer(proxy);
    const started = Date.now();
    await assert.rejects(
      () => providers.postJson(
        "exa",
        `https://127.0.0.1:${targetPort}/search`,
        { query: "test" },
        { "Content-Type": "application/json" },
        { timeoutMs: 2000, ca: tls.cert, proxyPort },
      ),
      (err) => err instanceof providers.ProviderFailure,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `premature close 应在 500ms 内立即 reject，实际 ${elapsed}ms`);
  } finally {
    for (const s of proxyConns) s.destroy();
    await closeServer(proxy);
    await closeServer(targetServer);
    rmSync(tls.dir, { recursive: true, force: true });
  }
});

test("proxy tunnel: getProxyTunnelAgent reuses agent per port with idle timeout", () => {
  assert.equal(typeof providers.getProxyTunnelAgent, "function", "getProxyTunnelAgent 必须导出");
  const agentA1 = providers.getProxyTunnelAgent(18081);
  const agentA2 = providers.getProxyTunnelAgent(18081);
  const agentB = providers.getProxyTunnelAgent(18082);
  const customAgent = providers.getProxyTunnelAgent(18081, { timeoutMs: 123 });

  try {
    assert.equal(agentA1, agentA2, "相同端口两次获取应返回同一 Agent 实例");
    assert.notEqual(agentA1, agentB, "不同端口应返回不同 Agent 实例");
    assert.notEqual(customAgent, agentA1, "传入自定义选项不应复用或污染默认端口缓存池");
    assert.equal(providers.getProxyTunnelAgent(18081), agentA1, "自定义调用后默认池实例保持不变");
    assert.equal(agentA1.keepAlive, true);
    assert.equal(agentA1.maxSockets, 8);
    assert.equal(agentA1.options.timeout, 30_000);
  } finally {
    agentA1.destroy();
    agentB.destroy();
    customAgent.destroy();
  }
});
