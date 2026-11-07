/**
 * 测试职责：以真实生产组合根和临时假配置验证授权路由已接通，且不触发任何 Provider。
 * 覆盖服务重建后的持久资格、公告独立更新与改码撤销，不以单个工具函数代替 HTTP 交接。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExperienceStatusResponseSchema, SettingsPublicResponseSchema } from "@wayfinder/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { parseServerConfig } from "../config.js";
import { buildProductionServer } from "../production-server.js";
import { updateExperienceConfig } from "./experience-config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("生产服务的作者体验授权", () => {
  it("生产启动拒绝把体验签名配置放进公开Asset目录，即使文件尚未创建", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-experience-public-path-"));
    directories.push(root);
    const webAssetsDirectory = path.join(root, "web");
    await fs.mkdir(path.join(webAssetsDirectory, "assets"), { recursive: true });
    await fs.writeFile(path.join(webAssetsDirectory, "index.html"), '<div id="root"></div>');
    const config = parseServerConfig({
      LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash", LLM_API_KEY: "fake-llm", SERPAPI_API_KEY: "fake-search",
      EXPERIENCE_CONFIG_PATH: path.join(webAssetsDirectory, "assets", "experience.json"),
    });
    await expect(buildProductionServer({ config, repositoryRoot: root, webAssetsDirectory })).rejects.toThrow("公开静态目录之外");
  });

  it("通过专用Cookie恢复资格；公告更新不撤销，改码后无需重启或刷新即失效", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-experience-production-"));
    directories.push(root);
    const webAssetsDirectory = path.join(root, "web");
    await fs.mkdir(path.join(webAssetsDirectory, "assets"), { recursive: true });
    await fs.writeFile(path.join(webAssetsDirectory, "index.html"), '<div id="root"></div>');
    const configPath = path.join(root, "private", "experience.json");
    await updateExperienceConfig(configPath, { announcement: "作者原文\n体验说明", inviteCode: "fake-invite-original" });
    const origin = "https://wayfinder.test";
    const config = parseServerConfig({
      LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
      LLM_API_KEY: "fake-author-llm", SERPAPI_API_KEY: "fake-author-search",
      EXPERIENCE_CONFIG_PATH: configPath, PUBLIC_ORIGIN: origin,
    });
    let providerCalls = 0;
    const baseProviders = {
      searchProvider: {
        id: "fake-search", capabilities: ["general" as const],
        search: async () => { providerCalls += 1; throw new Error("授权操作不应检索"); },
      },
      llmProvider: {
        id: "fake-llm",
        structured: async () => { providerCalls += 1; throw new Error("授权操作不应调用模型"); },
      },
    };
    const start = () => buildProductionServer({ config, repositoryRoot: root, webAssetsDirectory, baseProviders });
    let server = await start();
    try {
      const announcement = await server.inject({ method: "GET", url: "/api/settings", headers: { host: "wayfinder.test" } });
      expect(SettingsPublicResponseSchema.parse(JSON.parse(announcement.body))).toEqual({
        announcement: "作者原文\n体验说明", experienceAvailable: true,
      });
      expect(announcement.headers["cache-control"]).toContain("no-store");
      expect(announcement.body).not.toContain("fake-invite-original");
      const grant = await server.inject({
        method: "POST", url: "/api/experience", headers: { origin, host: "wayfinder.test" },
        payload: { inviteCode: "fake-invite-original" },
      });
      expect(grant.statusCode).toBe(200);
      const header = grant.headers["set-cookie"];
      const cookieHeader = Array.isArray(header) ? header[0] : header;
      if (typeof cookieHeader !== "string") throw new Error("体验授权未设置Cookie");
      expect(cookieHeader).toContain("HttpOnly");
      expect(cookieHeader).toContain("Secure");
      expect(cookieHeader).toContain("SameSite=Strict");
      expect(cookieHeader).not.toContain("fake-invite-original");
      const cookie = cookieHeader.split(";")[0] ?? "";
      const status = async () => {
        const response = await server.inject({
          method: "GET", url: "/api/experience/status", headers: { origin, cookie, host: "wayfinder.test" },
        });
        expect(response.headers["cache-control"]).toContain("no-store");
        return ExperienceStatusResponseSchema.parse(JSON.parse(response.body)).authorized;
      };
      expect(await status()).toBe(true);
      await server.close();
      server = await start();
      expect(await status()).toBe(true);
      await updateExperienceConfig(configPath, { announcement: "公告已更新" });
      expect(await status()).toBe(true);
      await updateExperienceConfig(configPath, { inviteCode: "fake-invite-new" });
      expect(await status()).toBe(false);
      await updateExperienceConfig(configPath, { inviteCode: "fake-invite-original" });
      expect(await status()).toBe(false);
      expect(providerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});
