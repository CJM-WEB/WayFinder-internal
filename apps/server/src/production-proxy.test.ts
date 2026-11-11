/**
 * 回归职责：从生产组合根验证唯一回环代理的IP进入认证限速，外部及多跳伪造不被采信。
 * 隔离边界：认证使用假实现，账号路由不调用数据库／邮件／Provider；同源检查仍用原始Host。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProductionServer } from "./production-server.js";
import { parseServerConfig } from "./config.js";
import type { AccountAuth } from "./accounts/auth.js";

describe("生产同机代理边界", () => {
  it("只信任127.0.0.1的第一跳，并重建内部认证IP头及保留原始Host校验", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-production-proxy-"));
    const webAssetsDirectory = path.join(directory, "web");
    await fs.mkdir(path.join(webAssetsDirectory, "assets"), { recursive: true });
    await fs.writeFile(path.join(webAssetsDirectory, "index.html"), '<div id="root"></div>');
    const received: string[] = [];
    const auth: AccountAuth = { initialize: async () => {}, migrate: async () => {}, getIdentity: async () => null,
      handle: async (_action, headers) => {
        received.push(headers.get("x-wayfinder-client-ip") ?? "");
        return { body: { accepted: true }, cookies: [] };
      },
    };
    const config = parseServerConfig({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
      LLM_API_KEY: "fixture-llm", SERPAPI_API_KEY: "fixture-search", PUBLIC_ORIGIN: "https://proxy.example" });
    const server = await buildProductionServer({ config, repositoryRoot: directory, webAssetsDirectory,
      accounts: { auth, database: { close: async () => {} } },
      providerFactory: () => { throw new Error("账号代理检查禁止调用Provider"); },
    });
    try {
      for (const [remoteAddress, forwarded, expected] of [
        ["127.0.0.1", "198.51.100.10", "198.51.100.10"],
        ["203.0.113.10", "198.51.100.10", "203.0.113.10"],
        ["127.0.0.2", "198.51.100.10", "127.0.0.2"],
        ["127.0.0.1", "198.51.100.10, 203.0.113.10", "203.0.113.10"],
      ] as const) {
        const response = await server.inject({ method: "POST", url: "/api/account", remoteAddress,
          headers: { host: "proxy.example", origin: "https://proxy.example", "x-forwarded-for": forwarded,
            "x-wayfinder-client-ip": "192.0.2.99" }, payload: { action: "logout" } });
        expect(response.statusCode).toBe(200);
        expect(received.at(-1)).toBe(expected);
      }
      const badHost = await server.inject({ method: "POST", url: "/api/account", remoteAddress: "127.0.0.1",
        headers: { host: "evil.example", origin: "https://proxy.example", "x-forwarded-host": "proxy.example",
          "x-forwarded-proto": "https" }, payload: { action: "logout" } });
      expect(badHost.statusCode).toBe(403);
      expect(received).toHaveLength(4);
    } finally { await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
