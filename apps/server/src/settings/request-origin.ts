/**
 * 模块职责：确定可信应用 Origin（来源），不依赖客户端可伪造的转发头。
 * 边界：正式站点使用 HTTPS；未配置站点时仅接纳规范回环 Host / Origin，供本地同源代理使用。
 */
import type { FastifyRequest } from "fastify";

/** URL 会把缩写或整数 IPv4 转成另一种表示；此处只接受明确、规范的回环主机名。 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" ||
    /^127\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(hostname);
}

function parsePureOrigin(value: string): URL | null {
  try {
    if (/[\s\p{Cc}]/u.test(value)) return null;
    const origin = new URL(value);
    if (!new Set(["http:", "https:"]).has(origin.protocol) ||
      origin.username !== "" || origin.password !== "" || origin.pathname !== "/" ||
      origin.search !== "" || origin.hash !== "" ||
      (value !== origin.origin && value !== `${origin.origin}/`)) return null;
    return origin;
  } catch {
    return null;
  }
}

/** 返回规范化 Origin；null 表示部署输入无效，而不是自动信任请求 Host。 */
export function normalizePublicOrigin(value: string): string | null {
  const origin = parsePureOrigin(value);
  return origin !== null && (origin.protocol === "https:" || isLoopbackHostname(origin.hostname))
    ? origin.origin : null;
}

/**
 * POST 必须显式携带精确 Origin；GET 可省略，但声明了来源时同样校验。
 * same-site（同站但不同源）仍拒绝，防止兄弟子域借浏览器 Cookie 发起作者调用。
 * 本地跨端口开发通过 Vite 同源代理，不能借此放宽为任意同站或转发头来源。
 */
export function isSameOriginRequest(
  request: Pick<FastifyRequest, "headers" | "method">,
  publicOrigin: string | null,
): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const host = request.headers.host;
  const originHeader = request.headers.origin;
  if (typeof host !== "string" || (originHeader !== undefined && typeof originHeader !== "string")) return false;
  if (request.method === "POST" && originHeader === undefined) return false;

  if (publicOrigin !== null) {
    const trusted = parsePureOrigin(publicOrigin);
    return trusted !== null && host === trusted.host &&
      (originHeader === undefined || originHeader === trusted.origin);
  }

  const localHost = parsePureOrigin(`http://${host}`);
  if (localHost === null || !isLoopbackHostname(localHost.hostname)) return false;
  if (originHeader === undefined) return true;
  return originHeader === localHost.origin;
}
