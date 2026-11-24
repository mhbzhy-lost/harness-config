export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export type ProbeOptions = {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

/** 探测 url 是否可达；空 url 直接视为不可达，不发请求。任何 HTTP 状态码均视为链路可达。 */
export async function probeEndpointReachability(url: string, options: ProbeOptions = {}): Promise<boolean> {
  const { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, fetch: fetchImpl = globalThis.fetch } = options;
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
