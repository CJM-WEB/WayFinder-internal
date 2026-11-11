/**
 * 云Key运行边界：只用假会话／假托管记录／假Provider，覆盖混合来源、共享队列和绝对期限。
 * 任一选用cloud的版本撤销必须阻止整次旧Run的后续调用，不能只拦该服务自己的阶段。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLOUD_ACCOUNT_HEADER, SEARCH_CREDENTIALS_HEADER, type CredentialService, type ProviderSearchRequest, type SearchCredentials } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { buildServer } from "../app.js";
import type { AccountAuth } from "../accounts/auth.js";
import { AccountKeyAccessError, type AccountKeyStorage } from "../accounts/key-storage.js";
import { parseServerConfig } from "../config.js";
import { createAbsoluteRunDeadline } from "../orchestrator/absolute-run-deadline.js";
import { createConcurrencyLimitedProviders, createProviderConcurrencyQueues } from "../orchestrator/provider-concurrency.js";
import { createMemoryCachedSearchProvider } from "../search/memory-cached-provider.js";
import { sendCredentialsAccessError } from "../routes/experience.js";
import { callAuthorizedLLM } from "./authorized-llm-call.js";
import { CredentialsAccessError, createExperienceCookie } from "./experience-authorization.js";
import { readExperienceConfig, updateExperienceConfig } from "./experience-config.js";
import { prepareSearchCredentialScope, type SearchCredentialScope } from "./search-credentials.js";

const identity = { userId: "owner_A", sessionId: "session_A", email: "fixture@example.test" };
const headers = { host: "fixture.test", origin: "https://fixture.test", [CLOUD_ACCOUNT_HEADER]: identity.userId };
const own: SearchCredentials = { deepseek: { source: "own", apiKey: "fixture-own-llm" }, serpapi: { source: "own", apiKey: "fixture-own-search" } };
const cloud: SearchCredentials = { deepseek: { source: "cloud" }, serpapi: { source: "cloud" } };
const servers: FastifyInstance[] = [], directories: string[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-cloud-credentials-")); directories.push(directory);
  const configPath = path.join(directory, "experience.json"); await updateExperienceConfig(configPath, { inviteCode: "fixture-invite" });
  const config = parseServerConfig({ PUBLIC_ORIGIN: headers.origin, EXPERIENCE_CONFIG_PATH: configPath,
    LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash", LLM_API_KEY: "fixture-author-llm", SERPAPI_API_KEY: "fixture-author-search" });
  const current = new Map<CredentialService, { apiKey: string; revision: string }>([
    ["deepseek", { apiKey: "fixture-cloud-llm", revision: "revision_llm_A" }], ["serpapi", { apiKey: "fixture-cloud-search", revision: "revision_search_A" }],
  ]);
  const auth = { getIdentity: vi.fn<AccountAuth["getIdentity"]>().mockResolvedValue(identity) };
  const storage: AccountKeyStorage = {
    read: vi.fn(), write: vi.fn(),
    resolve: vi.fn<AccountKeyStorage["resolve"]>().mockImplementation(async (_userId, service) => current.get(service) ?? null),
    assertCurrent: vi.fn<AccountKeyStorage["assertCurrent"]>().mockImplementation(async (_userId, revisions) => {
      for (const service of ["deepseek", "serpapi"] as const) if (revisions[service] !== undefined && current.get(service)?.revision !== revisions[service]) throw new AccountKeyAccessError("KEY_CONFLICT", service);
    }),
  };
  const captured: SearchCredentialScope[] = [], server = buildServer(); servers.push(server);
  server.post("/scope", async (request, reply) => {
    try { captured.push(await prepareSearchCredentialScope(request, config, new AbortController().signal, auth, Date.now() + 40_000, storage)); return reply.code(204).send(); }
    catch (error: unknown) { if (error instanceof CredentialsAccessError) return sendCredentialsAccessError(reply, error); throw error; }
  });
  const send = (credentials: unknown, extra: Record<string, string> = {}) => server.inject({ method: "POST", url: "/scope",
    headers: { ...headers, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(credentials), ...extra } });
  const experience = await readExperienceConfig(configPath); if (experience === null) throw new Error("缺少假体验配置");
  const cookie = createExperienceCookie(experience, identity).split(";", 1)[0] ?? "";
  return { server, config, current, auth, storage, captured, send, cookie };
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
describe("云Key请求范围", () => {
  it("显式cloud才读取托管，双own访客零身份／数据库读取且无作者回退", async () => {
    const { send, auth, storage, captured } = await fixture();
    auth.getIdentity.mockResolvedValue(null);
    expect((await send(own)).statusCode).toBe(204); expect(auth.getIdentity).not.toHaveBeenCalled(); expect(storage.resolve).not.toHaveBeenCalled();
    expect((await send(cloud)).statusCode).toBe(401);
    auth.getIdentity.mockResolvedValue(identity);
    expect((await send(cloud)).statusCode).toBe(204);
    expect(captured.at(-1)?.keys).toEqual({ llmApiKey: "fixture-cloud-llm", serpApiKey: "fixture-cloud-search" });
    expect(captured.at(-1)?.authorGeneration).toBeNull();
  });
  it("错预期账号／伪造cloud字段／缺Key／密文故障在入口固定拒绝，不回退浏览器或作者", async () => {
    const { send, storage, current } = await fixture();
    expect((await send(cloud, { [CLOUD_ACCOUNT_HEADER]: "owner_B" })).statusCode).toBe(401); expect(storage.resolve).not.toHaveBeenCalled();
    expect((await send({ ...cloud, deepseek: { source: "cloud", apiKey: "fixture-private-value" } })).statusCode).toBe(400);
    current.delete("deepseek"); const missing = await send(cloud);
    expect(missing.statusCode).toBe(400); expect(missing.json()).toEqual({ code: "CLOUD_KEY_REQUIRED", service: "deepseek" });
    vi.mocked(storage.resolve).mockRejectedValueOnce(new Error("fixture-private-value"));
    const failed = await send(cloud); expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain("fixture-private-value");
  });
  it("cloud与author分别取对应Key，换会话使own阶段也中止整个混合运行", async () => {
    const { send, captured, cookie, auth } = await fixture();
    expect((await send({ deepseek: { source: "cloud" }, serpapi: { source: "author" } }, { cookie })).statusCode).toBe(204);
    expect(captured[0]?.keys).toEqual({ llmApiKey: "fixture-cloud-llm", serpApiKey: "fixture-author-search" });
    expect((await send({ deepseek: { source: "cloud" }, serpapi: own.serpapi })).statusCode).toBe(204);
    const previous = captured[1]; if (previous === undefined) throw new Error("缺少混合范围");
    auth.getIdentity.mockResolvedValue({ ...identity, sessionId: "session_B" });
    await expect(previous.assertService("serpapi", new AbortController().signal)).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
    expect(previous.signal.aborted).toBe(true);
  });
  it("全部cloud版本都复核；同值更换也撤销另一个服务已命中缓存的旧运行", async () => {
    const { send, captured, current } = await fixture(); expect((await send(cloud)).statusCode).toBe(204);
    const scope = captured[0]; if (scope === undefined) throw new Error("缺少云范围");
    const underlying = vi.fn(async () => []), cached = createMemoryCachedSearchProvider({ id: "fake", capabilities: ["general"], search: underlying });
    const request: ProviderSearchRequest = { kind: "node", nodeId: "fixture", query: "固定查询", maxResults: 1, capability: "general", freshnessSensitive: false, language: "zh-CN" };
    const search = async () => { await scope.assertService("serpapi", scope.signal); return cached.search(request, scope.signal); };
    await search(); current.set("deepseek", { apiKey: "fixture-cloud-llm", revision: "revision_llm_B" });
    await expect(search()).rejects.toMatchObject({ code: "CLOUD_KEY_REVOKED", service: "deepseek" });
    expect(underlying).toHaveBeenCalledTimes(1); expect(scope.signal.aborted).toBe(true);
  });
  it.each(["serpapi", "deepseek"] as const)("%s共享队列出队时复核另一个cloud的删除，own访客仍可取得槽位", async service => {
    const { send, captured, current } = await fixture();
    const revokedService = service === "serpapi" ? "deepseek" : "serpapi";
    const selected: SearchCredentials = { ...own, [revokedService]: { source: "cloud" } };
    expect((await send(selected)).statusCode).toBe(204); const scope = captured[0]; if (scope === undefined) throw new Error("缺少云范围");
    const queues = createProviderConcurrencyQueues({ search: 1, llm: 1 }), blocker = createDeferred<void>(), calls: string[] = [];
    const wrap = (label: string, authorize: (signal: AbortSignal) => Promise<void>) => createConcurrencyLimitedProviders({ queues, concurrency: { search: 1, llm: 1 },
      searchProvider: { id: label, capabilities: ["general"], search: async (_input, signal) => { await authorize(signal); calls.push(label); if (label === "blocking") await blocker.promise; return []; } },
      llmProvider: { id: label, structured: (input, options) => callAuthorizedLLM({ id: label, structured: async () => { calls.push(label); if (label === "blocking") await blocker.promise; return {}; } }, input, options, authorize) },
    });
    const blocking = wrap("blocking", async () => {}), cloudRun = wrap("cloud", signal => scope.assertService(service, signal)), ownRun = wrap("own", async () => {});
    const request: ProviderSearchRequest = { kind: "node", nodeId: "fixture", query: "固定查询", maxResults: 1, capability: "general", freshnessSensitive: false, language: "zh-CN" };
    const run = (provider: ReturnType<typeof wrap>) => service === "serpapi" ? provider.searchProvider.search(request, new AbortController().signal)
      : provider.llmProvider.structured({ system: "假指令", user: "假查询", schemaName: "fixture", schema: {} }, { signal: new AbortController().signal, timeoutMs: 1_000 });
    const active = run(blocking); await vi.waitFor(() => expect(calls).toEqual(["blocking"]));
    const queued = run(cloudRun), rejected = expect(queued).rejects.toMatchObject({ code: "CLOUD_KEY_REVOKED", service: revokedService });
    const queue = service === "serpapi" ? queues.search : queues.llm;
    await vi.waitFor(() => expect(queue.pendingCount).toBe(1)); const later = run(ownRun);
    current.delete(revokedService); blocker.resolve(); await Promise.all([active, rejected, later]); expect(calls).toEqual(["blocking", "own"]);
  });
  it("数据库读取沿用同一绝对Run预算；同步跨期限保留scope唯一reason且零后续调用", async () => {
    const { server, config, auth, storage } = await fixture(); vi.useFakeTimers(); vi.setSystemTime(0);
    const run = createAbsoluteRunDeadline({ parentSignal: new AbortController().signal });
    vi.mocked(storage.resolve).mockImplementation(async (_user, service, operation) => {
      expect(operation.deadline).toBeLessThanOrEqual(run.deadlineAt); vi.setSystemTime(40_001);
      return { apiKey: `fixture-${service}`, revision: "fixture_revision" };
    });
    server.post("/deadline", async (request, reply) => {
      try { await prepareSearchCredentialScope(request, config, run.signal, auth, run.deadlineAt, storage, run.requirePositiveRemainingMs); return reply.code(204).send(); }
      catch (error: unknown) { expect(run.isDeadlineReason(error)).toBe(true); return reply.code(408).send(); }
    });
    try {
      expect((await server.inject({ method: "POST", url: "/deadline", headers: { ...headers, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(cloud) } })).statusCode).toBe(408);
      expect(storage.resolve).toHaveBeenCalledTimes(1); expect(storage.assertCurrent).not.toHaveBeenCalled(); expect(run.signal.aborted).toBe(true);
    } finally { run.dispose(); vi.useRealTimers(); }
  });
});
