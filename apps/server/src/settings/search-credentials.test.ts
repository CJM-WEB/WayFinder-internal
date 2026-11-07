/** 测试职责：请求凭据先校验再冻结，作者资格逐次复核，错误和响应不携带假秘密。 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SEARCH_CREDENTIALS_HEADER } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../app.js";
import { parseServerConfig } from "../config.js";
import { sendCredentialsAccessError } from "../routes/experience.js";
import { createExperienceCookie, CredentialsAccessError } from "./experience-authorization.js";
import { readExperienceConfig, updateExperienceConfig } from "./experience-config.js";
import { prepareSearchCredentialScope, type SearchCredentialScope } from "./search-credentials.js";

const directories: string[] = [];
const servers: FastifyInstance[] = [];
const headers = { host: "wayfinder.test", origin: "https://wayfinder.test" };
const own = { deepseek: { source: "own", apiKey: "fake-user-llm" }, serpapi: { source: "own", apiKey: "fake-user-search" } };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-credential-scope-"));
  directories.push(directory);
  const configPath = path.join(directory, "experience.json");
  await updateExperienceConfig(configPath, { inviteCode: "fake-code" });
  const config = parseServerConfig({
    LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
    LLM_API_KEY: "fake-author-llm", SERPAPI_API_KEY: "fake-author-search",
    EXPERIENCE_CONFIG_PATH: configPath, PUBLIC_ORIGIN: headers.origin,
  });
  const captured: SearchCredentialScope[] = [];
  const server = buildServer();
  servers.push(server);
  server.post("/scope", async (request, reply) => {
    try {
      captured.push(await prepareSearchCredentialScope(request, config, new AbortController().signal));
      return reply.code(204).send();
    } catch (error: unknown) {
      if (error instanceof CredentialsAccessError) return sendCredentialsAccessError(reply, error);
      throw error;
    }
  });
  const current = await readExperienceConfig(configPath);
  if (current === null) throw new Error("缺少测试配置");
  const cookie = createExperienceCookie(current).split(";")[0] ?? "";
  const send = (credentials: unknown, extra: Record<string, string> = {}) => server.inject({
    method: "POST", url: "/scope", headers: { ...headers,
      ...(credentials === undefined ? {} : { [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(credentials) }), ...extra },
  });
  return { config, configPath, captured, server, cookie, send };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("搜索请求凭据范围", () => {
  it("缺失、非法和重复头均在进入运行前固定拒绝，不回显原始Key", async () => {
    const { send, server, captured } = await fixture();
    expect((await send(undefined)).json()).toEqual({ code: "CREDENTIALS_REQUIRED" });
    for (const value of [{}, { ...own, verified: true }, { ...own, deepseek: { source: "author", apiKey: "fake-sentinel" } }]) {
      const response = await send(value);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("fake-sentinel");
    }
    for (const value of ['{"fake-sentinel"', "x".repeat(17_000)]) {
      const response = await send(own, { [SEARCH_CREDENTIALS_HEADER]: value });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("fake-sentinel");
    }
    const duplicate = await server.inject({ method: "POST", url: "/scope", headers: {
      ...headers, [SEARCH_CREDENTIALS_HEADER]: [JSON.stringify(own), JSON.stringify(own)],
    } });
    expect(duplicate.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("冻结本请求的双Key，自带凭据不读取损坏的作者配置", async () => {
    const { send, captured, configPath, config } = await fixture();
    await fs.writeFile(configPath, "{broken", { mode: 0o600 });
    expect((await send(own)).statusCode).toBe(204);
    const scope = captured[0];
    if (scope === undefined) throw new Error("缺少凭据范围");
    expect(scope.keys).toEqual({ llmApiKey: "fake-user-llm", serpApiKey: "fake-user-search" });
    expect(Object.isFrozen(scope.credentials.deepseek)).toBe(true);
    expect(Object.isFrozen(scope.keys)).toBe(true);
    expect(scope.authorGeneration).toBeNull();
    const signal = new AbortController().signal;
    await expect(scope.assertService("deepseek", signal)).resolves.toBeUndefined();
    await expect(scope.assertService("serpapi", signal)).resolves.toBeUndefined();
    expect(config.llmApiKey).toBe("fake-author-llm");
    expect(config.serpApiKey).toBe("fake-author-search");
  });

  it("混合来源只替换对应服务，公告更新保留资格，改码后中止原运行", async () => {
    const { send, captured, configPath, cookie } = await fixture();
    const mixed = { ...own, serpapi: { source: "author" } };
    expect((await send(mixed)).json()).toEqual({ code: "EXPERIENCE_REVOKED" });
    expect((await send(mixed, { cookie })).statusCode).toBe(204);
    const scope = captured[0];
    if (scope === undefined) throw new Error("缺少凭据范围");
    expect(scope.keys).toEqual({ llmApiKey: "fake-user-llm", serpApiKey: "fake-author-search" });
    await updateExperienceConfig(configPath, { announcement: "公告更新" });
    await expect(scope.assertService("serpapi", new AbortController().signal)).resolves.toBeUndefined();
    await updateExperienceConfig(configPath, { inviteCode: "fake-next" });
    await expect(scope.assertService("serpapi", new AbortController().signal)).rejects.toMatchObject({ code: "EXPERIENCE_REVOKED" });
    expect(scope.signal.aborted).toBe(true);
    expect((await send(mixed, { cookie })).statusCode).toBe(403);
  });

  it("配置丢失只使作者资格不可用，跨源准备不产生Scope", async () => {
    const { send, captured, configPath, cookie } = await fixture();
    await fs.unlink(configPath);
    expect((await send({ deepseek: { source: "author" }, serpapi: { source: "author" } }, { cookie })).statusCode).toBe(503);
    expect((await send(own, { origin: "https://other.test" })).statusCode).toBe(400);
    expect(captured).toHaveLength(0);
    expect((await send(own)).statusCode).toBe(204);
  });
});
