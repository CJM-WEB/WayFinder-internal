/**
 * 回归职责：加载真实 Vite 配置，经过真实开发代理验证本地体验授权与同源边界。
 * 安全边界：后端仅注册配置 / 授权路由，全部使用临时假邀请码；不加载环境文件或调用搜索服务。
 * 负对照保留旧字符串代理的实际语义，不能在重定向测试目标时顺带修复 changeOrigin（改写来源主机）。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CredentialsErrorResponseSchema, ExperienceStatusResponseSchema } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";
import { createServer, loadConfigFromFile, type ProxyOptions, type ViteDevServer } from "vite";

import { buildServer } from "../../../server/src/app.js";
import { registerExperienceRoutes } from "../../../server/src/routes/experience.js";
import { updateExperienceConfig } from "../../../server/src/settings/experience-config.js";

const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_FILE = fileURLToPath(new URL("../../vite.config.mjs", import.meta.url));
const INVITE = "fixture-development-proxy-code";
type ObservedRequest = { host: string | undefined; origin: string | undefined; url: string };
type ProxyFixture = { origin: string; upstream: string; requests: ObservedRequest[] };

/** 仅修改本地目标地址：旧条目仍是字符串，新条目才复制对象，严禁无条件展开成对象。 */
function redirectApiProxy(proxy: Record<string, string | ProxyOptions> | undefined, target: string, legacy: boolean) {
  const configured = proxy?.["/api"];
  if (configured === undefined) throw new Error("真实开发配置缺少 /api 代理");
  const entry = legacy ? target : configured;
  return { ...proxy, "/api": typeof entry === "string" ? target : { ...entry, target } };
}

async function withDevelopmentProxy(legacy: boolean, verify: (fixture: ProxyFixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-development-proxy-"));
  const backend = buildServer();
  let vite: ViteDevServer | undefined;
  const requests: ObservedRequest[] = [];
  try {
    const configPath = path.join(directory, "experience.json");
    await updateExperienceConfig(configPath, { announcement: "开发代理的假体验公告", inviteCode: INVITE });
    backend.addHook("onRequest", async request => {
      // 只观察公开来源和路由，不记录 Cookie（浏览器凭证）、邀请码或请求正文。
      requests.push({ host: request.headers.host, origin: request.headers.origin, url: request.url });
    });
    registerExperienceRoutes(backend, { configPath, publicOrigin: null });
    const upstream = await backend.listen({ host: "127.0.0.1", port: 0 });
    const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, CONFIG_FILE, WEB_ROOT, "silent");
    if (loaded === null) throw new Error("无法读取真实 Vite 开发配置");
    vite = await createServer({
      ...loaded.config, configFile: false, root: WEB_ROOT,
      envFile: false, envDir: false, logLevel: "silent", clearScreen: false,
      cacheDir: path.join(directory, "vite-cache"),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...loaded.config.server, host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null,
        proxy: redirectApiProxy(loaded.config.server?.proxy, upstream, legacy),
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") throw new Error("开发代理未监听动态端口");
    const origin = `http://127.0.0.1:${address.port}`;
    expect(origin).not.toBe(upstream);
    await verify({ origin, upstream, requests });
  } finally {
    try { await vite?.close(); }
    finally {
      try { await backend.close(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  }
}

/** 每次本地 HTTP 调用均有短超时；Cookie 仅在本测试内存中用于后续同源状态读取。 */
function postInvite(origin: string, inviteCode: string, requestOrigin = origin, cookie?: string) {
  return fetch(`${origin}/api/experience`, {
    method: "POST", signal: AbortSignal.timeout(5_000),
    headers: { Origin: requestOrigin, "Content-Type": "application/json", ...(cookie === undefined ? {} : { Cookie: cookie }) },
    body: JSON.stringify({ inviteCode }),
  });
}

describe("开发代理的体验授权回归", () => {
  it.each(["127.0.0.1", "localhost"] as const)("真实配置保留%s客户端Host和Origin，授权及Cookie恢复成功，跨源仍拒绝", async hostname => {
    await withDevelopmentProxy(false, async ({ origin: listeningOrigin, requests }) => {
      // 使用真实客户端 URL 选择回环主机，不能注入 Host 头伪造代理成功。
      const client = new URL(listeningOrigin);
      client.hostname = hostname;
      const origin = client.origin;
      const granted = await postInvite(origin, INVITE);
      expect(granted.status).toBe(200);
      expect(ExperienceStatusResponseSchema.parse(await granted.json())).toEqual({ authorized: true });
      expect(granted.headers.get("cache-control")).toBe("no-store");
      const cookieHeader = granted.headers.get("set-cookie");
      if (cookieHeader === null) throw new Error("代理授权未返回专用 Cookie");
      expect(cookieHeader).toContain("__Host-wayfinder_experience=");
      expect(cookieHeader).toContain("HttpOnly");
      expect(cookieHeader).toContain("Secure");
      expect(cookieHeader).toContain("SameSite=Strict");
      expect(cookieHeader).not.toContain("Domain=");
      const cookie = cookieHeader.split(";")[0] ?? "";
      const restored = await fetch(`${origin}/api/experience/status`, {
        headers: { Origin: origin, Cookie: cookie }, signal: AbortSignal.timeout(5_000),
      });
      expect(restored.status).toBe(200);
      expect(ExperienceStatusResponseSchema.parse(await restored.json())).toEqual({ authorized: true });
      const invalid = await postInvite(origin, "fixture-invalid-code", origin, cookie);
      expect(invalid.status).toBe(403);
      expect(CredentialsErrorResponseSchema.parse(await invalid.json())).toEqual({ code: "INVITE_CODE_INVALID" });
      expect(invalid.headers.get("set-cookie")).toBeNull();
      const hostileOrigin = "https://untrusted.example";
      const crossed = await postInvite(origin, INVITE, hostileOrigin, cookie);
      expect(crossed.status).toBe(403);
      expect(CredentialsErrorResponseSchema.parse(await crossed.json())).toEqual({ code: "CREDENTIALS_INVALID" });
      expect(requests.map(request => request.url)).toEqual([
        "/api/experience", "/api/experience/status", "/api/experience", "/api/experience",
      ]);
      for (const request of requests) expect(request.host).toBe(new URL(origin).host);
      expect(requests.map(request => request.origin)).toEqual([origin, origin, origin, hostileOrigin]);
    });
  });

  it("历史字符串简写负对照真实改写Host，原本同源的正确邀请码也被403拒绝", async () => {
    await withDevelopmentProxy(true, async ({ origin, upstream, requests }) => {
      const rejected = await postInvite(origin, INVITE);
      expect(rejected.status).toBe(403);
      expect(CredentialsErrorResponseSchema.parse(await rejected.json())).toEqual({ code: "CREDENTIALS_INVALID" });
      expect(rejected.headers.get("set-cookie")).toBeNull();
      expect(requests).toEqual([{ host: new URL(upstream).host, origin, url: "/api/experience" }]);
      expect(requests[0]?.host).not.toBe(new URL(origin).host);
    });
  });
});
