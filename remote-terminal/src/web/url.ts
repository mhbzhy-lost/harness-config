/**
 * 解析 HTTP / WebSocket 请求 URL，非法目标返回 null 而非抛错崩溃服务。
 */
export function parseRequestUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl, "http://localhost");
  } catch {
    return null;
  }
}
