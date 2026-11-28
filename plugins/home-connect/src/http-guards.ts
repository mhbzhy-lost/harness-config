import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export class PayloadTooLargeError extends Error {
	readonly statusCode = 413;

	constructor(message = "payload_too_large") {
		super(message);
		this.name = "PayloadTooLargeError";
	}
}

export class InvalidJsonError extends Error {
	readonly statusCode = 400;

	constructor(message = "invalid_json") {
		super(message);
		this.name = "InvalidJsonError";
	}
}

export class RequestAbortedError extends Error {
	readonly statusCode = 400;

	constructor(message = "request_aborted") {
		super(message);
		this.name = "RequestAbortedError";
	}
}

/** 按 UTF-8 字节长度与常量时间比较校验 Bearer 鉴权头，避免多字节字符引发 RangeError。 */
export function isAuthorizedHeader(given: string | undefined, expectedApiKey: string): boolean {
	if (!given || !expectedApiKey) return false;
	const givenBuf = Buffer.from(given, "utf8");
	const expectedBuf = Buffer.from(`Bearer ${expectedApiKey}`, "utf8");
	if (givenBuf.length !== expectedBuf.length) return false;
	return timingSafeEqual(givenBuf, expectedBuf);
}

/** 带字节上限读取完整 JSON 请求体，兼顾 Content-Length 与 Transfer-Encoding: chunked。 */
export function readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
	const contentLength = req.headers["content-length"];
	if (contentLength !== undefined) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) {
			req.pause();
			return Promise.reject(new PayloadTooLargeError());
		}
	}

	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;

		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onAborted);
			req.off("close", onClose);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onData = (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (total > maxBytes) {
				req.pause();
				fail(new PayloadTooLargeError());
				return;
			}
			chunks.push(buf);
		};

		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			const raw = Buffer.concat(chunks, total).toString("utf8");
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new InvalidJsonError());
			}
		};

		const onError = (error: Error) => fail(error);
		const onAborted = () => fail(new RequestAbortedError());
		const onClose = () => {
			if (!req.complete) fail(new RequestAbortedError());
		};

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
		req.on("close", onClose);
	});
}

/** 固定容量 LRU 会话存储：访问刷新活跃序，驱逐时关闭被淘汰会话。 */
export class LruSessionStore<T extends { close?: () => Promise<void> | void }> {
	private readonly maxSize: number;
	private readonly entries = new Map<string, T>();

	constructor(maxSize: number) {
		if (!Number.isInteger(maxSize) || maxSize < 1) {
			throw new RangeError(`maxSize must be a positive integer, got ${maxSize}`);
		}
		this.maxSize = maxSize;
	}

	get size(): number {
		return this.entries.size;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): T | undefined {
		const value = this.entries.get(id);
		if (value === undefined) return undefined;
		this.entries.delete(id);
		this.entries.set(id, value);
		return value;
	}

	set(id: string, value: T): void {
		if (this.entries.has(id)) {
			this.entries.delete(id);
			this.entries.set(id, value);
			return;
		}
		while (this.entries.size >= this.maxSize) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			const evicted = this.entries.get(oldestKey);
			this.entries.delete(oldestKey);
			if (evicted?.close) {
				void Promise.resolve(evicted.close()).catch(() => {});
			}
		}
		this.entries.set(id, value);
	}

	delete(id: string): boolean {
		return this.entries.delete(id);
	}

	async closeAll(): Promise<void> {
		const items = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(items.map((item) => item.close?.()));
	}
}
