import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import test from "node:test";
import {
	InvalidJsonError,
	LruSessionStore,
	PayloadTooLargeError,
	RequestAbortedError,
	isAuthorizedHeader,
	readBoundedJsonBody,
} from "../plugins/home-connect/src/http-guards.ts";

test("isAuthorizedHeader handles multi-byte UTF-8 of same JS string length without throwing RangeError", () => {
	const apiKey = "secret-key-123";
	const expected = `Bearer ${apiKey}`;
	assert.equal(isAuthorizedHeader(expected, apiKey), true);

	// 构造与 expected 字符长度完全相等但含多字节 UTF-8 字符的请求头
	const sameCharLenMultiByte = `Bearer 中${"x".repeat(apiKey.length - 1)}`;
	assert.equal(sameCharLenMultiByte.length, expected.length);
	assert.notEqual(Buffer.byteLength(sameCharLenMultiByte), Buffer.byteLength(expected));
	assert.equal(isAuthorizedHeader(sameCharLenMultiByte, apiKey), false);

	assert.equal(isAuthorizedHeader(undefined, apiKey), false);
	assert.equal(isAuthorizedHeader("", apiKey), false);
	assert.equal(isAuthorizedHeader("Bearer wrong", apiKey), false);
	assert.equal(isAuthorizedHeader(expected, ""), false);
});

test("readBoundedJsonBody parses valid chunked JSON and rejects oversized or invalid payloads", async () => {
	const MAX_BYTES = 128;
	const server = createServer(async (req, res) => {
		try {
			const parsed = await readBoundedJsonBody(req, MAX_BYTES);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ parsed }));
		} catch (error) {
			if (error instanceof PayloadTooLargeError) {
				res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
				res.end(JSON.stringify({ error: "payload_too_large" }));
				return;
			}
			if (error instanceof InvalidJsonError) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_json" }));
				return;
			}
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: error.message }));
		}
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	assert.ok(addr && typeof addr === "object");
	const baseUrl = `http://127.0.0.1:${addr.port}`;

	const sendChunked = (chunks) =>
		new Promise((resolve, reject) => {
			const req = httpRequest(
				`${baseUrl}/mcp`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
				},
				(res) => {
					const out = [];
					res.on("data", (c) => out.push(c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(out).toString("utf8") }));
				},
			);
			req.on("error", reject);
			for (const c of chunks) req.write(c);
			req.end();
		});

	try {
		// 1. 合法 chunked JSON
		const okRes = await sendChunked(['{"jsonrpc":"2.0",', '"method":"ping"}']);
		assert.equal(okRes.status, 200);
		assert.deepEqual(JSON.parse(okRes.body).parsed, { jsonrpc: "2.0", method: "ping" });

		// 2. 无 Content-Length 的 chunked 超限请求应返回 413
		const bigRes = await sendChunked(['{"data":"', "a".repeat(200), '"}']);
		assert.equal(bigRes.status, 413);

		// 3. 声明 Content-Length 超限应返回 413
		const declaredBig = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: "b".repeat(200) }),
		});
		assert.equal(declaredBig.status, 413);

		// 4. 非法 JSON 应返回 400
		const badJson = await sendChunked(["{not-valid-json"]);
		assert.equal(badJson.status, 400);
	} finally {
		await new Promise((resolve) => server.close(() => resolve()));
	}
});

test("LruSessionStore refreshes access order on get and closes evicted session", async () => {
	const closed = [];
	const makeSession = (id) => ({
		id,
		close: () => {
			closed.push(id);
		},
	});

	const store = new LruSessionStore(2);
	const a = makeSession("a");
	const b = makeSession("b");
	const c = makeSession("c");

	store.set("a", a);
	store.set("b", b);
	assert.equal(store.get("a"), a); // 刷新 a，使 b 成为最久未使用

	store.set("c", c); // 应淘汰 b 并调用 b.close()
	assert.deepEqual(closed, ["b"]);
	assert.equal(store.get("b"), undefined);
	assert.equal(store.get("a"), a);
	assert.equal(store.get("c"), c);
	assert.equal(store.size, 2);

	// delete 不应再次调用 close（用于 transport onsessionclosed 回调）
	store.delete("a");
	assert.deepEqual(closed, ["b"]);
	assert.equal(store.size, 1);

	await store.closeAll();
	assert.deepEqual(closed, ["b", "c"]);
	assert.equal(store.size, 0);
});

test("readBoundedJsonBody rejects with RequestAbortedError on mid-POST abort and server-http guards unhandled rejections", async () => {
	let caughtError = null;
	let abortedResolve;
	const abortedDone = new Promise((resolve) => {
		abortedResolve = resolve;
	});

	const server = createServer(async (req, res) => {
		try {
			const parsed = await readBoundedJsonBody(req, 1024);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ parsed }));
		} catch (error) {
			if (error instanceof RequestAbortedError) {
				caughtError = error;
				if (!res.headersSent && !res.writableEnded) res.destroy();
				abortedResolve();
				return;
			}
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: error.message }));
		}
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	assert.ok(addr && typeof addr === "object");

	try {
		// 1. 发送部分 chunked POST 后强制断连
		await new Promise((resolve, reject) => {
			const sock = netConnect(addr.port, "127.0.0.1", () => {
				sock.write(
					"POST /home HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n5\r\n{\"a\":",
					() => {
						setTimeout(() => {
							sock.destroy();
							resolve();
						}, 30);
					},
				);
			});
			sock.on("error", reject);
		});

		await Promise.race([
			abortedDone,
			new Promise((_, reject) => setTimeout(() => reject(new Error("readBoundedJsonBody 未在断连后 reject")), 1000)),
		]);
		assert.ok(caughtError instanceof RequestAbortedError, `应抛出 RequestAbortedError，实际: ${caughtError}`);

		// 2. 断连后服务仍可正常响应后续请求
		const nextRes = await fetch(`http://127.0.0.1:${addr.port}/home`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ok: true }),
		});
		assert.equal(nextRes.status, 200);
		assert.deepEqual(await nextRes.json(), { parsed: { ok: true } });

		// 3. 核验 server-http.ts 已捕获 RequestAbortedError 并对 handle() 挂载兜底 .catch
		const serverSrc = readFileSync(new URL("../plugins/home-connect/src/server-http.ts", import.meta.url), "utf8");
		assert.match(serverSrc, /instanceof RequestAbortedError/);
		assert.match(serverSrc, /handle\(req,\s*res,\s*"relay"\)\.catch\(/);
		assert.match(serverSrc, /handle\(req,\s*res,\s*"lan"\)\.catch\(/);
	} finally {
		await new Promise((resolve) => server.close(() => resolve()));
	}
});
