/**
 * 测试职责：验证 Fastify 服务壳既支持无网络的路由注入测试，
 * 也能在临时端口真实监听，并保证 Health 输出不携带运行配置或 Secret。
 */
import { describe, expect, it } from "vitest";

import { buildServer } from "./app.js";

describe("buildServer", () => {
  it("通用服务默认不信任回环请求携带的转发IP", async () => {
    const server = buildServer();
    server.get("/fixture-ip", request => ({ ip: request.ip }));
    try {
      const response = await server.inject({ url: "/fixture-ip", remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.10" } });
      expect(response.json()).toEqual({ ip: "127.0.0.1" });
    } finally { await server.close(); }
  });

  it("通过 GET /health 返回最小健康状态", async () => {
    const server = buildServer();

    try {
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      expect(response.body).not.toContain("API_KEY");
      expect(response.body).not.toContain("deepseek");
    } finally {
      await server.close();
    }
  });

  it("可在严格 TypeScript 构建对应的 Node.js 运行时真实启动", async () => {
    const server = buildServer();

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${address}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await server.close();
    }
  });
});
