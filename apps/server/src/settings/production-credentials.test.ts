/**
 * 集成测试职责：从真实生产组合根验证请求范围凭据、作者缓存及运行中撤销。
 * 测试边界：只有 LLM（大语言模型）与 HTTP Fetch 边界使用假数据；规划、校验、排序、
 * 队列、缓存、授权及 NDJSON（逐行 JSON）均走生产代码，不调用真实付费 Provider（服务提供方）。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLOUD_ACCOUNT_HEADER, SEARCH_CREDENTIALS_HEADER, SearchRequestSchema, StreamEventSchema,
  type ProviderSearchRequest, type SearchCredentials, type StreamEvent,
} from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { GraphOutlineSchema } from "../ai/graph-outline.js";
import { SearchPlanBundleSchema } from "../ai/search-plan-generator.js";
import { parseServerConfig } from "../config.js";
import { RunLogRecordSchema } from "../observability/run-log.js";
import { buildProductionServer } from "../production-server.js";
import { SerpApiBingSearchProvider } from "../search/providers/serpapi-bing.js";
import { readExperienceConfig, updateExperienceConfig } from "./experience-config.js";
import type { EffectiveProviderKeys } from "./search-credentials.js";
import { AccountKeyAccessError, type AccountKeyStorage } from "../accounts/key-storage.js";

const QUERY = "TypeScript compiler guide";
const BROAD_QUERY = "TypeScript compiler ecosystem";
const ORIGIN = "https://wayfinder.example";
const BASE_HEADERS = { host: "wayfinder.example", origin: ORIGIN, "sec-fetch-site": "same-origin" };
const INVITE = "fake-production-invite";
const AUTHOR_KEYS = { llmApiKey: "fake-author-llm", serpApiKey: "fake-author-search" };
const OWN_A = { llmApiKey: "fake-user-a-llm", serpApiKey: "fake-user-a-search" };
const OWN_B = { llmApiKey: "fake-user-b-llm", serpApiKey: "fake-user-b-search" };

/** 同一合法轮廓供 Planner（规划器）和 Reviser（修订器）返回，覆盖四个真实 LLM 阶段。 */
const OUTLINE = GraphOutlineSchema.parse({
  analysis: {
    intent: "learn", topic: QUERY, freshnessSensitive: false, ambiguityLevel: "medium",
    broadSearchQueries: [BROAD_QUERY], strategy: "evidence_assisted", presentationMode: "compact",
  },
  nodes: [{ id: "compiler-guide", title: QUERY, description: "Learn TypeScript compiler options", nodeType: "primary", layer: 0, status: "planned" }],
  edges: [],
});
const BUNDLE = SearchPlanBundleSchema.parse({
  plans: [{ nodeId: "compiler-guide", queries: [QUERY], rankingProfile: "knowledge" }],
});
const RANKING = { ranking: [{
  candidateId: "candidate_1",
  scores: { relevance: 0.95, authority: 0.95, clarity: 0.95, completeness: 0.95, trustSafety: 0.95, freshness: 0.95 },
  summary: "TypeScript 编译器选项说明。", whySelected: "该文档直接解释当前节点主题。",
}] };
type LlmStage = "planner" | "reviser" | "searchPlan" | "rerank";
type LlmCall = { key: string; stage: LlmStage; prompt: string };
type SearchCall = { key: string | null; query: string };
type SearchRequestCall = { key: string; query: string; kind: ProviderSearchRequest["kind"] };
type FixtureOptions = {
  cloudKeys?: AccountKeyStorage;
  local?: boolean;
  runLogging?: boolean;
  beforeLlm?: (call: LlmCall) => Promise<void>;
  beforeFetchResponse?: (call: SearchCall) => Promise<void>;
  fetchResponse?: (call: SearchCall) => Promise<Response | undefined>;
};

const fixtureAccounts = {
  auth: { initialize: async () => {}, migrate: async () => {},
    getIdentity: async () => ({ userId: "fixture_user", sessionId: "fixture_session", email: "fixture@example.com" }),
    handle: async () => ({ body: { accepted: true as const }, cookies: [] as string[] }),
  }, database: { close: async () => {} },
};
const directories: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function credentials(keys: EffectiveProviderKeys): SearchCredentials {
  return { deepseek: { source: "own", apiKey: keys.llmApiKey }, serpapi: { source: "own", apiKey: keys.serpApiKey } };
}
const AUTHOR_CREDENTIALS: SearchCredentials = { deepseek: { source: "author" }, serpapi: { source: "author" } };
function payload(runId: string) { return SearchRequestSchema.parse({ runId, query: QUERY, language: "zh-CN" }); }
function credentialHeaders(selected: SearchCredentials, cookie?: string) {
  return { ...BASE_HEADERS, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(selected), ...(cookie === undefined ? {} : { cookie }) };
}
function events(text: string): StreamEvent[] {
  return text.split("\n").filter(line => line !== "").map(line => StreamEventSchema.parse(JSON.parse(line) as unknown));
}
function assertCompleted(text: string): void {
  const complete = events(text).find(event => event.type === "complete");
  expect(complete?.type).toBe("complete");
  if (complete?.type !== "complete") throw new Error("预期搜索真实完成");
  expect(complete.data.finalStatus).toBe("complete");
  expect(complete.data.result.graph.nodes.every(node => node.status === "ready")).toBe(true);
  for (const secret of [...Object.values(AUTHOR_KEYS), ...Object.values(OWN_A), ...Object.values(OWN_B), INVITE]) {
    expect(text).not.toContain(secret);
  }
}

/** 托管边界用假记录版本，后续实际Pipeline／队列／缓存／HTTP适配器仍走生产组合。 */
function cloudKeyFixture() {
  let revision = "fixture_cloud_revision_A";
  const storage: AccountKeyStorage = {
    read: vi.fn(), write: vi.fn(),
    resolve: vi.fn<AccountKeyStorage["resolve"]>().mockImplementation(async (_user, service) => ({
      apiKey: service === "deepseek" ? OWN_B.llmApiKey : OWN_B.serpApiKey, revision,
    })),
    assertCurrent: vi.fn<AccountKeyStorage["assertCurrent"]>().mockImplementation(async (_user, revisions) => {
      for (const service of ["deepseek", "serpapi"] as const) if (revisions[service] !== undefined && revisions[service] !== revision) throw new AccountKeyAccessError("KEY_CONFLICT", service);
    }),
  };
  return { storage, replace: () => { revision = "fixture_cloud_revision_B"; } };
}

async function fixture(options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-production-credentials-"));
  directories.push(root);
  const webAssetsDirectory = path.join(root, "web");
  await fs.mkdir(path.join(webAssetsDirectory, "assets"), { recursive: true });
  await fs.writeFile(path.join(webAssetsDirectory, "index.html"), '<div id="root"></div>');
  const configPath = path.join(root, "private", "experience.json");
  await updateExperienceConfig(configPath, { announcement: "假公告", inviteCode: INVITE });
  const calls = { factories: [] as EffectiveProviderKeys[], llm: [] as LlmCall[], search: [] as SearchCall[], requests: [] as SearchRequestCall[] };
  const requestHeaders = options.local
    ? { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin" } : BASE_HEADERS;
  const config = parseServerConfig({
    LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
    LLM_API_KEY: AUTHOR_KEYS.llmApiKey, SERPAPI_API_KEY: AUTHOR_KEYS.serpApiKey,
    EXPERIENCE_CONFIG_PATH: configPath, PUBLIC_ORIGIN: options.local ? "" : ORIGIN,
    RUN_LOGGING: options.runLogging ? "true" : "false",
  });
  const server = await buildProductionServer({
    config, repositoryRoot: root, webAssetsDirectory, accounts: { ...fixtureAccounts, ...(options.cloudKeys === undefined ? {} : { keys: options.cloudKeys }) },
    providerFactory: (keys, beforeSearchAttempt) => {
      calls.factories.push({ ...keys });
      let outlines = 0;
      // 实际使用 SerpAPI Adapter；只替换 Fetch，核对发出的 api_key，而非仅检查工厂参数。
      const searchProvider = new SerpApiBingSearchProvider({
          apiKey: keys.serpApiKey, searchTimeoutMs: 1_000, beforeAttempt: beforeSearchAttempt,
          fetchImplementation: async input => {
            const url = new URL(String(input));
            const call = { key: url.searchParams.get("api_key"), query: url.searchParams.get("q") ?? "" };
            calls.search.push(call);
            await options.beforeFetchResponse?.(call);
            const override = await options.fetchResponse?.(call);
            if (override !== undefined) return override;
            return new Response(JSON.stringify({
              search_metadata: { status: "Success" },
              organic_results: [{ position: 1, title: QUERY, link: `https://docs.example.com/${call.query === BROAD_QUERY ? "ecosystem" : "compiler"}`, snippet: "Learn TypeScript compiler options with practical examples." }],
            }), { headers: { "content-type": "application/json" } });
          },
      });
      return {
        searchProvider: {
          id: searchProvider.id, capabilities: [...searchProvider.capabilities],
          search: (request, signal) => {
            calls.requests.push({ key: keys.serpApiKey, query: request.query, kind: request.kind });
            return searchProvider.search(request, signal);
          },
        },
        llmProvider: {
          id: "fake-credential-llm",
          structured: async (input, requestOptions) => {
            requestOptions.signal.throwIfAborted();
            let stage: LlmStage;
            if (input.schemaName === "graph_outline") stage = outlines++ === 0 ? "planner" : "reviser";
            else if (input.schemaName === "search_plan_bundle") stage = "searchPlan";
            else if (input.schemaName === "resource_rerank") stage = "rerank";
            else throw new Error("假模型收到了未知输出协议");
            const call = { key: keys.llmApiKey, stage, prompt: `${input.system}\n${input.user}` };
            calls.llm.push(call);
            await options.beforeLlm?.(call);
            requestOptions.signal.throwIfAborted();
            return input.schemaName === "graph_outline" ? OUTLINE : input.schemaName === "search_plan_bundle" ? BUNDLE : RANKING;
          },
        },
      };
    },
  });
  servers.push(server);
  const search = (runId: string, selected: SearchCredentials, cookie?: string) => server.inject({
    method: "POST", url: "/api/search", headers: { ...credentialHeaders(selected, cookie), ...requestHeaders,
      ...(options.cloudKeys === undefined ? {} : { [CLOUD_ACCOUNT_HEADER]: "fixture_user" }) }, payload: payload(runId),
  });
  const grant = async (inviteCode = INVITE): Promise<string> => {
    const response = await server.inject({ method: "POST", url: "/api/experience", headers: requestHeaders, payload: { inviteCode } });
    expect(response.statusCode).toBe(200);
    const value = response.headers["set-cookie"];
    const cookie = Array.isArray(value) ? value[0] : value;
    if (typeof cookie !== "string") throw new Error("预期已签发假体验 Cookie");
    return cookie.split(";")[0] ?? "";
  };
  return { server, configPath, root, calls, search, grant };
}

/** 用真正回环 HTTP 观察撤销后的物理断流；所有访问均为临时本机服务。 */
async function startCredentialStream(server: FastifyInstance, selected = AUTHOR_CREDENTIALS) {
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const grant = await fetch(`${address}/api/experience`, {
    method: "POST", headers: { origin: address, "content-type": "application/json" }, body: JSON.stringify({ inviteCode: INVITE }),
  });
  expect(grant.status).toBe(200);
  const header = grant.headers.get("set-cookie");
  if (header === null) throw new Error("预期真实HTTP授权返回专用Cookie");
  const cookie = header.split(";")[0] ?? "";
  await grant.body?.cancel();
  const response = await fetch(`${address}/api/search`, {
    method: "POST", headers: { origin: address, cookie, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(selected), "content-type": "application/json",
      ...(selected.deepseek.source === "cloud" || selected.serpapi.source === "cloud" ? { [CLOUD_ACCOUNT_HEADER]: "fixture_user" } : {}) },
    body: JSON.stringify(payload("bounded-retry-revocation")),
  });
  expect(response.status).toBe(200);
  if (response.body === null) throw new Error("预期提供真实搜索流");
  const reader = response.body.getReader();
  const received = (async () => {
    let text = "", terminated = false;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } catch {
      // 断流是待验证的取消结论，不把它当作完整或成功响应。
      terminated = true;
    } finally { reader.releaseLock(); }
    return { text, terminated };
  })();
  return { received };
}

describe("生产搜索的请求凭据接线", () => {
  it.each(["改码", "A→B→A"])("真实SerpAPI唯一重试前%s，旧Cookie不得发出第二次HTTP", async change => {
    const firstAttempt = createDeferred<void>();
    const responseGate = createDeferred<Response>();
    const { server, configPath, calls } = await fixture({ local: true, fetchResponse: async () => {
      firstAttempt.resolve();
      return responseGate.promise;
    } });
    const { received } = await startCredentialStream(server);
    await firstAttempt.promise;
    await updateExperienceConfig(configPath, { inviteCode: "fake-retry-next" });
    if (change === "A→B→A") await updateExperienceConfig(configPath, { inviteCode: INVITE });
    // 503 在原有规则下允许唯一重试；资格检查必须先于该次真实HTTP及尝试遥测。
    responseGate.resolve(new Response("fake-upstream-private-response", { status: 503 }));
    const result = await received;
    expect(result.terminated).toBe(true);
    expect(events(result.text).some(event => event.type === "complete")).toBe(false);
    expect(calls.search).toHaveLength(1);
    expect(calls.requests.map(call => call.kind)).toEqual(["broad_discovery"]);
    expect(calls.llm.map(call => call.stage)).toEqual(["planner"]);
    expect(result.text).not.toContain("fake-upstream-private-response");
  });

  it("真实业务日志在自带、作者冷/热缓存及失败路径均无凭据或授权材料", async () => {
    let privateFailureBody = "";
    const { root, configPath, search, grant } = await fixture({ runLogging: true,
      fetchResponse: async call => call.key === OWN_B.serpApiKey ? new Response(privateFailureBody, { status: 401 }) : undefined,
    });
    const cookie = await grant();
    const current = await readExperienceConfig(configPath);
    if (current === null) throw new Error("缺少临时假配置");
    const secrets = [...Object.values(AUTHOR_KEYS), ...Object.values(OWN_A), ...Object.values(OWN_B),
      INVITE, cookie, cookie.split("=")[1] ?? "", current.signingSecret];
    privateFailureBody = JSON.stringify({ apiKey: OWN_B.serpApiKey, inviteCode: INVITE, cookie, signingSecret: current.signingSecret });
    assertCompleted((await search("own-log", credentials(OWN_A))).body);
    assertCompleted((await search("author-cold-log", AUTHOR_CREDENTIALS, cookie)).body);
    assertCompleted((await search("author-hot-log", AUTHOR_CREDENTIALS, cookie)).body);
    const failed = await search("failed-own-log", credentials(OWN_B));
    expect(events(failed.body).some(event => event.type === "run.failed")).toBe(true);
    const directory = path.join(root, "data", "runs");
    await vi.waitFor(async () => {
      const names = await fs.readdir(directory);
      expect(names).toHaveLength(4);
      const raw = await Promise.all(names.map(name => fs.readFile(path.join(directory, name), "utf8")));
      const records = raw.map(text => RunLogRecordSchema.parse(JSON.parse(text) as unknown));
      expect(records.filter(record => record.outcome === "complete")).toHaveLength(3);
      expect(records.some(record => record.outcome === "failed")).toBe(true);
      expect(records.some(record => record.cache.search.hitCount === 2 && record.counts.searchHttpAttempts === 0)).toBe(true);
      for (const text of raw) {
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/"(?:apiKey|llmApiKey|serpApiKey|inviteCode|signingSecret|cookie|authorization)"/i);
      }
    }, { timeout: 3_000 });
  });

  it("缺失、非法、重复凭据头及跨源请求在流式200和Provider工厂前拒绝", async () => {
    const { server, calls } = await fixture();
    const valid = credentialHeaders(credentials(OWN_A));
    const variants = [
      { ...BASE_HEADERS },
      { ...valid, [SEARCH_CREDENTIALS_HEADER]: "{" },
      { ...valid, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify({ deepseek: { source: "own" }, serpapi: { source: "author" } }) },
      { ...valid, [SEARCH_CREDENTIALS_HEADER]: [valid[SEARCH_CREDENTIALS_HEADER], valid[SEARCH_CREDENTIALS_HEADER]] },
      { ...valid, origin: "https://evil.example" },
      { ...valid, "sec-fetch-site": "same-site" },
    ];
    for (const headers of variants) {
      const response = await server.inject({ method: "POST", url: "/api/search", headers, payload: payload("rejected-run") });
      expect([400, 403]).toContain(response.statusCode);
      expect(response.headers["content-type"]).not.toContain("application/x-ndjson");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(OWN_A.llmApiKey);
      expect(response.body).not.toContain(OWN_A.serpApiKey);
    }
    const malformed = await server.inject({
      method: "POST", url: "/api/search", headers: { ...valid, "content-type": "application/json" },
      payload: '{"query":"fake-json-error-sentinel"',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["cache-control"]).toBe("no-store");
    expect(malformed.body).not.toContain("fake-json-error-sentinel");
    const smuggled = await server.inject({
      method: "POST", url: "/api/search", headers: valid,
      payload: { ...payload("body-secret"), credentials: credentials(OWN_A) },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(calls).toEqual({ factories: [], llm: [], search: [], requests: [] });
  });

  it("两个自带用户并发时四个LLM阶段及实际Search鉴权不串用Key", async () => {
    const entered = new Set<string>();
    const bothPlanners = createDeferred<void>();
    const { calls, search } = await fixture({ beforeLlm: async call => {
      if (call.stage !== "planner") return;
      entered.add(call.key);
      if (entered.size === 2) bothPlanners.resolve();
      await bothPlanners.promise;
    } });
    const responses = await Promise.all([search("own-a", credentials(OWN_A)), search("own-b", credentials(OWN_B))]);
    for (const response of responses) { expect(response.statusCode).toBe(200); assertCompleted(response.body); }
    expect(calls.factories).toHaveLength(2);
    expect(calls.factories).toEqual(expect.arrayContaining([OWN_A, OWN_B]));
    for (const keys of [OWN_A, OWN_B]) {
      expect(calls.llm.filter(call => call.key === keys.llmApiKey).map(call => call.stage)).toEqual(["planner", "reviser", "searchPlan", "rerank"]);
      expect(calls.search.filter(call => call.key === keys.serpApiKey).map(call => call.query)).toEqual([BROAD_QUERY, QUERY]);
      expect(calls.requests.filter(call => call.key === keys.serpApiKey).map(call => call.kind)).toEqual(["broad_discovery", "node"]);
    }
    for (const call of calls.llm) for (const key of [...Object.values(OWN_A), ...Object.values(OWN_B), ...Object.values(AUTHOR_KEYS)]) {
      expect(call.prompt).not.toContain(key);
    }
  });

  it.each(["own-llm", "own-search"] as const)("独立选择支持混合来源：%s", async mode => {
    const { calls, search, grant } = await fixture();
    const cookie = await grant();
    const selected: SearchCredentials = mode === "own-llm"
      ? { deepseek: { source: "own", apiKey: OWN_A.llmApiKey }, serpapi: { source: "author" } }
      : { deepseek: { source: "author" }, serpapi: { source: "own", apiKey: OWN_A.serpApiKey } };
    const expected = mode === "own-llm"
      ? { llmApiKey: OWN_A.llmApiKey, serpApiKey: AUTHOR_KEYS.serpApiKey }
      : { llmApiKey: AUTHOR_KEYS.llmApiKey, serpApiKey: OWN_A.serpApiKey };
    const response = await search(`mixed-${mode}`, selected, cookie);
    expect(response.statusCode).toBe(200);
    assertCompleted(response.body);
    expect(calls.factories).toEqual([expected]);
    expect(calls.llm.every(call => call.key === expected.llmApiKey)).toBe(true);
    expect(calls.search.every(call => call.key === expected.serpApiKey)).toBe(true);
  });

  it.each(["cloud-llm", "cloud-search", "cloud-both"] as const)("显式%s经真实Pipeline取对应服务Key，cloud检索跨Run不共用作者缓存", async mode => {
    const { storage } = cloudKeyFixture();
    const { calls, search, grant } = await fixture({ cloudKeys: storage });
    const cookie = await grant();
    const selected: SearchCredentials = mode === "cloud-llm"
      ? { deepseek: { source: "cloud" }, serpapi: { source: "author" } }
      : { deepseek: mode === "cloud-both" ? { source: "cloud" } : { source: "own", apiKey: OWN_A.llmApiKey }, serpapi: { source: "cloud" } };
    const expected = { llmApiKey: mode === "cloud-search" ? OWN_A.llmApiKey : OWN_B.llmApiKey,
      serpApiKey: mode === "cloud-llm" ? AUTHOR_KEYS.serpApiKey : OWN_B.serpApiKey };
    assertCompleted((await search(`first-${mode}`, selected, cookie)).body);
    assertCompleted((await search(`second-${mode}`, selected, cookie)).body);
    expect(calls.factories).toEqual([expected, expected]);
    expect(calls.llm.every(call => call.key === expected.llmApiKey)).toBe(true);
    expect(calls.search.every(call => call.key === expected.serpApiKey)).toBe(true);
    expect(calls.search).toHaveLength(mode === "cloud-llm" ? 2 : 4);
    for (const call of calls.llm) for (const key of Object.values(OWN_B)) expect(call.prompt).not.toContain(key);
  });

  it("cloud更换后，混合own搜索的已允许重试也不能发第二次HTTP或伪造complete", async () => {
    const keys = cloudKeyFixture(), entered = createDeferred<void>(), gate = createDeferred<Response>();
    const { server, calls } = await fixture({ local: true, cloudKeys: keys.storage, fetchResponse: async () => { entered.resolve(); return gate.promise; } });
    const { received } = await startCredentialStream(server, { deepseek: { source: "cloud" }, serpapi: { source: "own", apiKey: OWN_A.serpApiKey } });
    await entered.promise; keys.replace(); gate.resolve(new Response("fixture-private-upstream-body", { status: 503 }));
    const result = await received;
    expect(result.terminated).toBe(true); expect(events(result.text).some(event => event.type === "complete")).toBe(false);
    expect(calls.search).toHaveLength(1); expect(calls.llm.map(call => call.stage)).toEqual(["planner"]);
    expect(result.text).not.toContain(OWN_B.llmApiKey); expect(result.text).not.toContain("fixture-private-upstream-body");
  });

  it("作者同代际命中共享缓存；改码拒绝旧Cookie，新代际重新检索", async () => {
    const { calls, search, grant, configPath } = await fixture();
    const cookie = await grant();
    assertCompleted((await search("author-first", AUTHOR_CREDENTIALS, cookie)).body);
    expect(calls.search).toHaveLength(2);
    assertCompleted((await search("author-cached", AUTHOR_CREDENTIALS, cookie)).body);
    expect(calls.search).toHaveLength(2);
    await updateExperienceConfig(configPath, { inviteCode: "fake-next-invite" });
    const rejected = await search("author-revoked", AUTHOR_CREDENTIALS, cookie);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ code: "EXPERIENCE_REVOKED" });
    expect(calls.factories).toHaveLength(2);
    expect(calls.search).toHaveLength(2);
    const currentCookie = await grant("fake-next-invite");
    assertCompleted((await search("author-next-generation", AUTHOR_CREDENTIALS, currentCookie)).body);
    expect(calls.search).toHaveLength(4);
  });

  it("自带同查询跨请求不共享缓存，作者配置损坏或缺失仍能正常搜索", async () => {
    const { calls, search, grant, configPath } = await fixture();
    const cookie = await grant();
    assertCompleted((await search("own-first", credentials(OWN_A))).body);
    assertCompleted((await search("own-next-request", credentials(OWN_A))).body);
    expect(calls.search).toHaveLength(4);
    for (const state of ["broken", "missing"]) {
      if (state === "broken") await fs.writeFile(configPath, "{fake-broken-config", { mode: 0o600 });
      else await fs.unlink(configPath);
      assertCompleted((await search(`own-${state}`, credentials(OWN_A))).body);
      const before = calls.search.length;
      const author = await search(`author-${state}`, AUTHOR_CREDENTIALS, cookie);
      expect(author.statusCode).toBe(503);
      expect(author.json()).toEqual({ code: "EXPERIENCE_UNAVAILABLE" });
      expect(calls.search).toHaveLength(before);
    }
    expect(calls.search).toHaveLength(8);
  });

  it("进行中改码允许已发请求收敛，但不调用下一个作者阶段或伪造complete", async () => {
    const enteredNodeFetch = createDeferred<void>();
    const releaseNodeFetch = createDeferred<void>();
    const { server, configPath, calls } = await fixture({ local: true, beforeFetchResponse: async call => {
      if (call.query !== QUERY) return;
      enteredNodeFetch.resolve();
      await releaseNodeFetch.promise;
    } });
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    // 真实回环请求使用它自己的 Host / Origin，不假装浏览器能改写生产站点 Host。
    const grantResponse = await fetch(`${address}/api/experience`, {
      method: "POST", headers: { origin: address, "content-type": "application/json" }, body: JSON.stringify({ inviteCode: INVITE }),
    });
    expect(grantResponse.status).toBe(200);
    const cookieHeader = grantResponse.headers.get("set-cookie");
    if (cookieHeader === null) throw new Error("预期真实HTTP授权返回专用Cookie");
    const cookie = cookieHeader.split(";")[0] ?? "";
    await grantResponse.body?.cancel();
    const response = await fetch(`${address}/api/search`, {
      method: "POST", headers: { origin: address, cookie, [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(AUTHOR_CREDENTIALS), "content-type": "application/json" },
      body: JSON.stringify(payload("mid-run-revocation")),
    });
    expect(response.status).toBe(200);
    if (response.body === null) throw new Error("预期搜索提供真实流");
    const reader = response.body.getReader();
    const received = (async () => {
      let text = "";
      let terminated = false;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          text += decoder.decode(next.value, { stream: true });
        }
      } catch {
        // 授权撤销沿既有物理取消路径关闭；显式返回状态，不能把断流伪装成正常完成。
        terminated = true;
      } finally { reader.releaseLock(); }
      return { text, terminated };
    })();
    await enteredNodeFetch.promise;
    await updateExperienceConfig(configPath, { inviteCode: "fake-revoked-during-run" });
    releaseNodeFetch.resolve();
    const result = await received;
    expect(result.terminated).toBe(true);
    const observed = events(result.text);
    expect(observed.some(event => event.type === "graph.plan")).toBe(true);
    expect(observed.some(event => event.type === "complete")).toBe(false);
    expect(calls.llm.map(call => call.stage)).toEqual(["planner", "reviser", "searchPlan"]);
    expect(calls.search).toHaveLength(2);
    for (const key of Object.values(AUTHOR_KEYS)) expect(result.text).not.toContain(key);
  });
});
