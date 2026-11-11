/** 测试职责：请求凭据先校验再冻结，作者资格逐次复核，错误和响应不携带假秘密。 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SEARCH_CREDENTIALS_HEADER, type ProviderSearchRequest } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { buildServer } from "../app.js";
import { parseServerConfig } from "../config.js";
import { createConcurrencyLimitedProviders, createProviderConcurrencyQueues } from "../orchestrator/provider-concurrency.js";
import { sendCredentialsAccessError } from "../routes/experience.js";
import { callAuthorizedLLM } from "./authorized-llm-call.js";
import { createExperienceCookie, CredentialsAccessError } from "./experience-authorization.js";
import { readExperienceConfig, updateExperienceConfig } from "./experience-config.js";
import { prepareSearchCredentialScope, type SearchCredentialScope } from "./search-credentials.js";

const identity = { userId: "fixture_user", sessionId: "fixture_session", email: "fixture@example.com" };
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
  let currentIdentity: typeof identity | null = identity;
  const auth = { getIdentity: vi.fn(async () => currentIdentity) };
  const captured: SearchCredentialScope[] = [];
  const server = buildServer();
  servers.push(server);
  server.post("/scope", async (request, reply) => {
    try {
      captured.push(await prepareSearchCredentialScope(request, config, new AbortController().signal, auth));
      return reply.code(204).send();
    } catch (error: unknown) {
      if (error instanceof CredentialsAccessError) return sendCredentialsAccessError(reply, error);
      throw error;
    }
  });
  const current = await readExperienceConfig(configPath);
  if (current === null) throw new Error("缺少测试配置");
  const cookie = createExperienceCookie(current, identity).split(";")[0] ?? "";
  const send = (credentials: unknown, extra: Record<string, string> = {}) => server.inject({
    method: "POST", url: "/scope", headers: { ...headers,
      ...(credentials === undefined ? {} : { [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(credentials) }), ...extra },
  });
  return { config, configPath, captured, server, cookie, send, auth,
    setIdentity: (next: typeof identity | null) => { currentIdentity = next; } };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("搜索请求凭据范围", () => {
  it("初次身份库故障固定503且不泄漏内部异常，双自带不访问身份库", async () => {
    const { send, auth, cookie } = await fixture();
    auth.getIdentity.mockRejectedValue(new Error("fixture-private-database-address"));
    const failure = await send({ deepseek: { source: "author" }, serpapi: { source: "author" } }, { cookie });
    expect(failure.statusCode).toBe(503);
    expect(failure.json()).toEqual({ code: "EXPERIENCE_UNAVAILABLE" });
    expect(failure.body).not.toContain("fixture-private");
    auth.getIdentity.mockClear();
    expect((await send(own)).statusCode).toBe(204);
    expect(auth.getIdentity).not.toHaveBeenCalled();
  });
  it("未登录拒绝作者，双自带仍可用；换号或会话撤销使旧范围失败闭合", async () => {
    const { send, cookie, captured, setIdentity } = await fixture();
    const author = { deepseek: { source: "author" }, serpapi: { source: "author" } };
    setIdentity(null);
    expect((await send(author, { cookie })).statusCode).toBe(401);
    expect((await send(author, { cookie })).json()).toEqual({ code: "ACCOUNT_REQUIRED" });
    expect((await send(own)).statusCode).toBe(204);
    setIdentity(identity);
    expect((await send(author, { cookie })).statusCode).toBe(204);
    const previous = captured[1];
    if (previous === undefined) throw new Error("缺少作者范围");
    setIdentity({ ...identity, sessionId: "new_session" });
    await expect(previous.assertService("deepseek", new AbortController().signal)).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
    expect(previous.signal.aborted).toBe(true);
    expect((await send(author, { cookie })).statusCode).toBe(403);
  });
  it.each([
    ["serpapi", "generation"], ["deepseek", "generation"], ["serpapi", "logout"], ["deepseek", "logout"],
  ] as const)("真实Cookie取得%s资格后排队，%s撤销使实际出队零作者调用且不误伤自带请求", async (service, revocation) => {
    const { send, captured, configPath, cookie, setIdentity } = await fixture();
    expect((await send(own)).statusCode).toBe(204);
    expect((await send({ deepseek: { source: "author" }, serpapi: { source: "author" } }, { cookie })).statusCode).toBe(204);
    const ownScope = captured[0], authorScope = captured[1];
    if (ownScope === undefined || authorScope === undefined) throw new Error("缺少真实校验后的假凭据范围");
    const queues = createProviderConcurrencyQueues({ search: 1, llm: 1 });
    const blocking = createDeferred<void>();
    const calls: string[] = [];
    const input = { system: "固定假指令", user: "固定假查询", schemaName: "test", schema: {} };
    const request: ProviderSearchRequest = { kind: "node", nodeId: "fake-node", query: "固定假查询", maxResults: 1, capability: "general", freshnessSensitive: false, language: "zh-CN" };
    const wrap = (scope: SearchCredentialScope, label: string) => createConcurrencyLimitedProviders({
      concurrency: { search: 1, llm: 1 }, queues,
      searchProvider: { id: label, capabilities: ["general"], search: async (_request, signal) => {
        // 与生产相同：资格复核位于共享许可内部，真实调用计数只在通过检查后增加。
        await scope.assertService("serpapi", signal);
        calls.push(label);
        if (label === "own") await blocking.promise;
        await scope.assertService("serpapi", signal);
        return [];
      } },
      llmProvider: { id: label, structured: (structuredInput, options) => callAuthorizedLLM({
        id: label, structured: async () => {
          calls.push(label);
          if (label === "own") await blocking.promise;
          return {};
        },
      }, structuredInput, options, signal => scope.assertService("deepseek", signal)) },
    });
    const ownProvider = wrap(ownScope, "own"), authorProvider = wrap(authorScope, "author");
    const run = (provider: ReturnType<typeof wrap>, scope: SearchCredentialScope) => service === "serpapi"
      ? provider.searchProvider.search(request, scope.signal)
      : provider.llmProvider.structured(input, { signal: scope.signal, timeoutMs: 30_000 });
    const active = run(ownProvider, ownScope);
    await vi.waitFor(() => expect(calls).toEqual(["own"]));
    const queued = run(authorProvider, authorScope);
    // 先安装拒绝断言，确保出队中止不会成为未处理的 Promise（异步结果）拒绝。
    const denied = expect(queued).rejects.toMatchObject({ code: revocation === "generation" ? "EXPERIENCE_REVOKED" : "ACCOUNT_REQUIRED", ...(revocation === "generation" ? { service } : {}) });
    const queue = service === "serpapi" ? queues.search : queues.llm;
    await vi.waitFor(() => expect(queue.pendingCount).toBe(1));
    const nextOwn = run(ownProvider, ownScope);
    expect(queue.pendingCount).toBe(2);
    if (revocation === "generation") await updateExperienceConfig(configPath, { inviteCode: "fake-after-queue" });
    else setIdentity(null);
    blocking.resolve();
    await Promise.all([active, denied, nextOwn]);
    expect(calls).toEqual(["own", "own"]);
    expect(authorScope.signal.aborted).toBe(true);
    expect(ownScope.signal.aborted).toBe(false);
    expect((await send({ deepseek: { source: "author" }, serpapi: { source: "author" } }, { cookie })).statusCode).toBe(revocation === "generation" ? 403 : 401);
  });

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
