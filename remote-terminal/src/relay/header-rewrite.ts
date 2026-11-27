/**
 * relay 数据通道 HTTP 头部改写与早到缓冲限流（零第三方依赖，可独立单测）。
 */
export const MAX_HEADER_BUFFER_BYTES = 65536;
export const MAX_EARLY_BUFFER_BYTES = 1024 * 1024;

export type HeaderRewriteResult = {
  done: boolean;
  overflow: boolean;
  output: Buffer | null;
};

export type HeaderRewriteState = {
  readonly done: boolean;
  readonly overflowed: boolean;
  push(chunk: Buffer): HeaderRewriteResult;
};

export type EarlyBuffer = {
  readonly bytes: number;
  push(chunk: Buffer): boolean;
  drain(): Buffer[];
  clear(): void;
};

export function forceConnectionClose(chunk: Buffer): Buffer {
  const idx = chunk.indexOf("\r\n\r\n");
  if (idx < 0) return chunk;
  const header = chunk.subarray(0, idx).toString("latin1");
  const lines = header.split("\r\n");
  if (lines.some((line) => /^upgrade\s*:/i.test(line))) return chunk;
  const filtered = lines.filter((line) => !/^connection\s*:/i.test(line));
  filtered.push("Connection: close");
  return Buffer.concat([Buffer.from(filtered.join("\r\n"), "latin1"), chunk.subarray(idx)]);
}

export function createHeaderRewriter(maxBytes = MAX_HEADER_BUFFER_BYTES): HeaderRewriteState {
  let done = false;
  let overflowed = false;
  let pending: Buffer = Buffer.alloc(0);

  return {
    get done() {
      return done;
    },
    get overflowed() {
      return overflowed;
    },
    push(chunk: Buffer): HeaderRewriteResult {
      if (overflowed) return { done: false, overflow: true, output: null };
      if (done) return { done: true, overflow: false, output: chunk };

      const prevLen = pending.length;
      const combined = prevLen === 0 ? chunk : Buffer.concat([pending, chunk]);
      const searchFrom = Math.max(0, prevLen - 3);
      const idx = combined.indexOf("\r\n\r\n", searchFrom);
      if (idx >= 0) {
        pending = Buffer.alloc(0);
        if (idx > maxBytes) {
          overflowed = true;
          return { done: false, overflow: true, output: null };
        }
        done = true;
        return { done: true, overflow: false, output: forceConnectionClose(combined) };
      }

      if (combined.length > maxBytes) {
        pending = Buffer.alloc(0);
        overflowed = true;
        return { done: false, overflow: true, output: null };
      }

      pending = combined;
      return { done: false, overflow: false, output: null };
    },
  };
}

export function createEarlyBuffer(maxBytes = MAX_EARLY_BUFFER_BYTES): EarlyBuffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return {
    get bytes() {
      return totalBytes;
    },
    push(chunk: Buffer): boolean {
      if (totalBytes + chunk.length > maxBytes) return false;
      chunks.push(chunk);
      totalBytes += chunk.length;
      return true;
    },
    drain(): Buffer[] {
      totalBytes = 0;
      return chunks.splice(0);
    },
    clear(): void {
      totalBytes = 0;
      chunks.length = 0;
    },
  };
}
