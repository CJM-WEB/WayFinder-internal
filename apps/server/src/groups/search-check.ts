/**
 * 显式小组搜索集成：真实生产组合根、隔离MySQL和回环HTTP；仅LLM及SerpAPI Fetch使用假实现。
 * 验证发起者凭据、公共队列、真实完成签名和预览应用门禁；不读取.env、不访问真实外部API。
 * 所有身份、密钥、邀请码和网页均为固定假样例；结束后清理本轮数据与临时配置。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { FastifyInstance } from "fastify";
import {
  CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, GROUP_SEARCH_TARGET_HEADER, SEARCH_CREDENTIALS_HEADER,
  EditableGraphSchema, GroupGraphWriteResponseSchema, GroupSyncEventSchema, StreamEventSchema,
  type GroupGraphAction, type GroupGraphRecord, type GroupSearchReceipt, type GroupSearchTarget,
  type SearchCredentials, type StreamEvent,
} from "@wayfinder/contracts";
import { GraphOutlineSchema } from "../ai/graph-outline.js";
import { SearchPlanBundleSchema } from "../ai/search-plan-generator.js";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData } from "../accounts/database.js";
import { createAccountKeyStorage } from "../accounts/key-storage.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { createWorkspaceStorage } from "../accounts/workspace-storage.js";
import { parseServerConfig } from "../config.js";
import { buildProductionServer } from "../production-server.js";
import { SerpApiBingSearchProvider } from "../search/providers/serpapi-bing.js";
import { updateExperienceConfig } from "../settings/experience-config.js";
import type { EffectiveProviderKeys } from "../settings/search-credentials.js";
import { migrateGroupData } from "./database.js";
import { createGroupSearch } from "./search.js";
import { createGroupStorage } from "./storage.js";
import { createGroupSync, readGroupSyncSnapshot } from "./sync.js";
import { createGroupWorkspaceStorage } from "./workspace-storage.js";

const QUERY = "TypeScript compiler guide";
const OUTLINE = GraphOutlineSchema.parse({ analysis: { intent: "learn", topic: QUERY, freshnessSensitive: false,
  ambiguityLevel: "medium", broadSearchQueries: [], strategy: "plan_first", presentationMode: "compact" },
  nodes: [{ id: "compiler-guide", title: QUERY, description: "Learn TypeScript compiler options", nodeType: "primary", layer: 0, status: "planned" }], edges: [] });
const BUNDLE = SearchPlanBundleSchema.parse({ plans: [{ nodeId: "compiler-guide", queries: [QUERY], rankingProfile: "knowledge" }] });
const RANKING = { ranking: [{ candidateId: "candidate_1", scores: { relevance: 0.95, authority: 0.95, clarity: 0.95,
  completeness: 0.95, trustSafety: 0.95, freshness: 0.95 }, summary: "编译器选项说明。", whySelected: "直接解释目标主题。" }] };
const AUTHOR = { llmApiKey: "fixture-author-llm", serpApiKey: "fixture-author-search" };
const OWN = { a: { llmApiKey: "fixture-own-a-llm", serpApiKey: "fixture-own-a-search" },
  b: { llmApiKey: "fixture-own-b-llm", serpApiKey: "fixture-own-b-search" } };
const CLOUD = { a: { llmApiKey: "fixture-cloud-a-llm", serpApiKey: "fixture-cloud-a-search" },
  b: { llmApiKey: "fixture-cloud-b-llm", serpApiKey: "fixture-cloud-b-search" } };
const own = (who: "a" | "b"): SearchCredentials => ({ deepseek: { source: "own", apiKey: OWN[who].llmApiKey }, serpapi: { source: "own", apiKey: OWN[who].serpApiKey } });
const cloud: SearchCredentials = { deepseek: { source: "cloud" }, serpapi: { source: "cloud" } };
const author: SearchCredentials = { deepseek: { source: "author" }, serpapi: { source: "author" } };
const secrets = [...Object.values(AUTHOR), ...Object.values(OWN.a), ...Object.values(OWN.b), ...Object.values(CLOUD.a), ...Object.values(CLOUD.b)];
const gate = () => { let release: () => void = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function bounded<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("假搜索集成等待超时")), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function abortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try { await bounded(Promise.race([promise, new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
  })])); } finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}
type Block = { key: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; used: boolean; signal?: AbortSignal };
type Complete = Extract<StreamEvent, { type: "complete" }>;
type Run = { status: number; code?: string; events: StreamEvent[]; terminated: boolean };
const complete = (run: Run): { event: Complete; receipt: GroupSearchReceipt } => {
  assert.equal(run.status, 200);
  const event = run.events.find((value): value is Complete => value.type === "complete"); assert.ok(event?.data.groupSearchReceipt);
  return { event, receipt: event.data.groupSearchReceipt };
};

let database: AccountDatabase | undefined, server: FastifyInstance | undefined;
let sync: ReturnType<typeof createGroupSync> | undefined, directory: string | undefined;
const closers: Array<() => Promise<void>> = [], controllers: AbortController[] = [], blocks: Block[] = [];
try {
  const raw = process.env.WF_TEST_MYSQL_URL; if (!raw) throw new Error("缺少测试配置");
  const dbConfig = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(dbConfig.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(dbConfig.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(dbConfig); const db = database;
  const operation = () => databaseOperation(new AbortController().signal, 5_000), mutation = () => randomUUID(), id = randomUUID();
  const identities = { a: { userId: `fixtureSearchA_${id}`, sessionId: `sessionA_${id}`, email: "fixtureSearchA@example.com" },
    b: { userId: `fixtureSearchB_${id}`, sessionId: `sessionB_${id}`, email: "fixtureSearchB@example.com" } };
  const sessions = new Map<string, AccountIdentity>(Object.entries(identities).map(([who, identity]) => [who, identity]));
  const authorCookies = new Map<string, string>();
  const auth: AccountAuth = { initialize: async () => {}, migrate: async () => {}, handle: async () => ({ body: { accepted: true }, cookies: [] }),
    async getIdentity(headers, op) { op.signal.throwIfAborted();
      const who = headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith("fixture_identity="))?.slice("fixture_identity=".length);
      return who === undefined ? null : sessions.get(who) ?? null;
    } };
  const profile = createAccountProfileStorage(db), groups = createGroupStorage(db), personal = createWorkspaceStorage(db);
  const keys = createAccountKeyStorage(db, Buffer.alloc(32, 73).toString("base64")); assert.ok(keys);
  sync = createGroupSync({ auth, readSnapshot: (userId, groupId, op) => readGroupSyncSnapshot(db, userId, groupId, op), leaseMs: 1_000, heartbeatMs: 100 });
  const groupSearch = createGroupSearch({ database: db, auth, sync, secret: "fixture-group-search-signing-secret", publicOrigin: null });
  const workspace = createGroupWorkspaceStorage(db, { search: groupSearch });
  const groupIds = new Set<string>();
  await migrateAccountData(db, operation()); await migrateGroupData(db, operation());
  directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-group-search-"));
  const assets = path.join(directory, "web"), configPath = path.join(directory, "private", "experience.json");
  await fs.mkdir(path.join(assets, "assets"), { recursive: true }); await fs.writeFile(path.join(assets, "index.html"), '<div id="root"></div>');
  await updateExperienceConfig(configPath, { inviteCode: "fixture-author-invite", announcement: "假体验配置" });
  const config = parseServerConfig({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash", LLM_API_KEY: AUTHOR.llmApiKey,
    SERPAPI_API_KEY: AUTHOR.serpApiKey, EXPERIENCE_CONFIG_PATH: configPath, PUBLIC_ORIGIN: "", RUN_LOGGING: "false", SEARCH_CONCURRENCY: "1", LLM_CONCURRENCY: "1" });
  assert.equal(config.runDeadlineMs, 40_000);
  const calls = { factories: [] as EffectiveProviderKeys[], llm: [] as Array<{ key: string; schema: string; prompt: string }>, search: [] as string[],
    activeLlm: 0, activeSearch: 0, maxLlm: 0, maxSearch: 0 };
  let llmBlock: Block | undefined, searchBlock: Block | undefined, failPlanner = false;
  server = await buildProductionServer({ config, repositoryRoot: directory, webAssetsDirectory: assets,
    accounts: { auth, database: { close: async () => {} }, workspace: personal, keys, profile, groups, groupWorkspace: workspace, groupSync: sync, groupSearch },
    providerFactory: (effective, beforeAttempt) => {
      calls.factories.push({ ...effective }); const ordinal = calls.factories.length;
      const searchProvider = new SerpApiBingSearchProvider({ apiKey: effective.serpApiKey, searchTimeoutMs: 2_000, beforeAttempt,
        fetchImplementation: async (input, init) => {
          const url = new URL(String(input)), key = url.searchParams.get("api_key"); assert.ok(key);
          calls.search.push(key); calls.activeSearch++; calls.maxSearch = Math.max(calls.maxSearch, calls.activeSearch);
          try {
            if (searchBlock?.key === key && !searchBlock.used) { searchBlock.used = true; searchBlock.entered.release(); await abortable(searchBlock.release.promise, init?.signal ?? new AbortController().signal); }
            return new Response(JSON.stringify({ search_metadata: { status: "Success" }, organic_results: [{ position: 1, title: QUERY,
              link: `https://docs.example.com/compiler-${ordinal}`, snippet: "Learn TypeScript compiler options with practical examples." }] }), { headers: { "content-type": "application/json" } });
          } finally { calls.activeSearch--; }
        } });
      return { searchProvider, llmProvider: { id: "fixture-group-search-llm", async structured(input, options) {
        options.signal.throwIfAborted(); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30_000);
        calls.llm.push({ key: effective.llmApiKey, schema: input.schemaName, prompt: `${input.system}\n${input.user}` });
        calls.activeLlm++; calls.maxLlm = Math.max(calls.maxLlm, calls.activeLlm);
        try {
          if (input.schemaName === "graph_outline" && failPlanner) { failPlanner = false; throw new Error("fixture model failure"); }
          if (input.schemaName === "graph_outline" && llmBlock?.key === effective.llmApiKey && !llmBlock.used) {
            llmBlock.used = true; llmBlock.signal = options.signal; llmBlock.entered.release(); await abortable(llmBlock.release.promise, options.signal);
          }
          options.signal.throwIfAborted();
          if (input.schemaName === "graph_outline") return OUTLINE;
          if (input.schemaName === "search_plan_bundle") return BUNDLE;
          if (input.schemaName === "resource_rerank") return RANKING;
          throw new Error("假模型收到未知协议");
        } finally { calls.activeLlm--; }
      } } };
    } });
  const origin = await server.listen({ host: "127.0.0.1", port: 0 });
  const headers = (who: "a" | "b", proof?: string, borrowedCookie?: string) => ({ origin, "content-type": "application/json",
    cookie: `fixture_identity=${who}${borrowedCookie ?? authorCookies.get(who) ? `; ${borrowedCookie ?? authorCookies.get(who)}` : ""}`,
    [CLOUD_ACCOUNT_HEADER]: identities[who].userId, ...(proof === undefined ? {} : { [GROUP_CONNECTION_HEADER]: proof }) });
  const post = (route: string, who: "a" | "b", body: unknown, proof?: string) => fetch(`${origin}${route}`, {
    method: "POST", headers: headers(who, proof), body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const open = async (who: "a" | "b", groupId: string) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${origin}/api/group-sync?groupId=${encodeURIComponent(groupId)}`, { headers: headers(who), signal: controller.signal });
    assert.equal(response.status, 200); assert.ok(response.body);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    const next = async () => {
      while (true) {
        const end = buffer.indexOf("\n");
        if (end >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) return GroupSyncEventSchema.parse(JSON.parse(line) as unknown); }
        const chunk = await bounded(reader.read(), 2_500); if (chunk.done) throw new Error("证明流已关闭");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    const first = await next(); assert.equal(first.type, "snapshot"); if (first.type !== "snapshot") throw new Error("缺少初始快照");
    const close = async () => { controller.abort(); try { await reader.cancel(); } catch { /* 已续租或被撤销的流可直接清理。 */ } };
    closers.push(close);
    return { proof: first.connectionId, snapshot: first, next, close };
  };
  const makeGroup = async (label: string) => {
    const made = await groups.write(sessions.get("a")!, { action: "create", name: label, description: "", mutationId: mutation() }, operation());
    assert.ok(made.details?.invitationCode); const groupId = made.details.group.groupId; groupIds.add(groupId);
    await groups.write(sessions.get("b")!, { action: "join", invitationCode: made.details.invitationCode, mutationId: mutation() }, operation());
    const document = EditableGraphSchema.parse({ version: "workspace.v1", id: mutation(), title: label, query: QUERY, language: "zh-CN",
      presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastRunId: null,
      nodes: [{ id: "compiler-guide", title: QUERY, description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] }], edges: [], positions: {} });
    const result = await workspace.write(identities.a.userId, { action: "create", groupId, document, mutationId: mutation() }, operation());
    const graphId = result.workspace.activeOrder[0]; assert.ok(graphId);
    return { groupId, graphId, invitationCode: made.details.invitationCode };
  };
  type Target = Awaited<ReturnType<typeof makeGroup>>;
  const current = async (target: Target): Promise<GroupGraphRecord> => {
    const record = (await workspace.read(identities.a.userId, target.groupId, operation())).graphs.find(value => value.document.id === target.graphId);
    assert.ok(record); return record;
  };
  const receive = async (response: Response): Promise<Run> => {
    if (!response.ok) { const body = await response.json() as { code?: string }; return { status: response.status, ...(body.code === undefined ? {} : { code: body.code }), events: [], terminated: false }; }
    assert.ok(response.body); const reader = response.body.getReader(), decoder = new TextDecoder(); let text = "", terminated = false;
    try { for (;;) { const chunk = await bounded(reader.read(), 5_000); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); } }
    catch { terminated = true; } finally { reader.releaseLock(); }
    for (const secret of secrets) assert.equal(text.includes(secret), false);
    const lines = text.split("\n"); if (terminated && lines.at(-1)?.trim()) lines.pop();
    return { status: response.status, events: lines.filter(value => value.trim()).map(value => StreamEventSchema.parse(JSON.parse(value) as unknown)), terminated };
  };
  const start = async (who: "a" | "b", credentials: SearchCredentials, target: Target, options: { node?: boolean; private?: boolean; runId?: string; borrowed?: string; signal?: AbortSignal } = {}) => {
    const before = await current(target), live = options.private ? null : await open(who, target.groupId), runId = options.runId ?? mutation();
    const searchTarget: GroupSearchTarget = { groupId: target.groupId, graphId: target.graphId, expectedRevision: before.revision, ...(options.node ? { nodeId: "compiler-guide" } : {}) };
    const response = await fetch(`${origin}/api/search`, { method: "POST", headers: { ...headers(who, live?.proof, options.borrowed),
      [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(credentials), ...(options.private ? {} : { [GROUP_SEARCH_TARGET_HEADER]: JSON.stringify(searchTarget) }) },
      body: JSON.stringify({ runId, query: QUERY, language: "zh-CN" }), signal: options.signal ?? AbortSignal.timeout(8_000) });
    const result = receive(response).finally(async () => { await live?.close(); });
    return { live, result, runId, before, target: searchTarget };
  };
  const run = async (who: "a" | "b", credentials: SearchCredentials, target: Target, options: Parameters<typeof start>[3] = {}) => (await start(who, credentials, target, options)).result;
  const application = async (who: "a" | "b", target: Target, generated: ReturnType<typeof complete>, mode: "append" | "replace", extras: { confirmedRevision?: number; expectedRevision?: number; receipt?: GroupSearchReceipt } = {}) => {
    const live = await open(who, target.groupId), record = await current(target);
    try { const body: GroupGraphAction = { action: "applySearch", groupId: target.groupId, graphId: target.graphId,
      expectedRevision: extras.expectedRevision ?? record.revision, mutationId: mutation(), receipt: extras.receipt ?? generated.receipt,
      result: generated.event.data.result, mode, ...(extras.confirmedRevision === undefined ? {} : { confirmedRevision: extras.confirmedRevision }) };
      const response = await post("/api/group-workspace", who, body, live.proof);
      return { response, body, json: await response.json() as unknown };
    } finally { await live.close(); }
  };
  const edit = async (who: "a" | "b", target: Target, title: string) => {
    const live = await open(who, target.groupId), before = await current(target);
    try { const response = await post("/api/group-workspace", who, { action: "edit", groupId: target.groupId, graphId: target.graphId,
      expectedRevision: before.revision, before: before.document, after: { ...before.document, title }, kind: "graph.rename", subject: title, mutationId: mutation() }, live.proof);
      assert.equal(response.status, 200); GroupGraphWriteResponseSchema.parse(await response.json());
    } finally { await live.close(); }
  };
  const newBlock = (key: string): Block => { const block = { key, entered: gate(), release: gate(), used: false }; blocks.push(block); return block; };
  let cleanupFailed = false;
  try {
    for (const who of ["a", "b"] as const) {
      await profile.write(identities[who].userId, who, operation());
      for (const service of ["deepseek", "serpapi"] as const) await keys.write(identities[who].userId,
        { action: "save", service, apiKey: service === "deepseek" ? CLOUD[who].llmApiKey : CLOUD[who].serpApiKey, expectedRevision: null, mutationId: mutation() }, operation());
    }
    const target = await makeGroup("发起者与预览假组"), initial = await current(target);
    const withoutProof = await fetch(`${origin}/api/search`, { method: "POST", headers: { ...headers("a"),
      [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(own("a")), [GROUP_SEARCH_TARGET_HEADER]: JSON.stringify({ groupId: target.groupId, graphId: target.graphId, expectedRevision: initial.revision }) },
      body: JSON.stringify({ runId: mutation(), query: QUERY, language: "zh-CN" }) });
    assert.equal((await receive(withoutProof)).code, "GROUP_OFFLINE"); assert.equal(calls.factories.length, 0);

    // 同一组的发起者仍各自解析自己的own/cloud，组资格不授予作者额度或借用创建者资格。
    for (const [who, credentials, expected] of [["a", own("a"), OWN.a], ["b", own("b"), OWN.b], ["a", cloud, CLOUD.a], ["b", cloud, CLOUD.b],
      ["b", { deepseek: { source: "cloud" }, serpapi: own("b").serpapi }, { llmApiKey: CLOUD.b.llmApiKey, serpApiKey: OWN.b.serpApiKey }]] as const) {
      const beforeFactory: number = calls.factories.length; complete(await run(who, credentials, target));
      assert.deepEqual(calls.factories[beforeFactory], expected);
    }
    const beforeDeniedAuthor = calls.factories.length;
    assert.equal((await run("b", author, target)).code, "EXPERIENCE_REVOKED"); assert.equal(calls.factories.length, beforeDeniedAuthor);
    const grant = await post("/api/experience", "a", { inviteCode: "fixture-author-invite" }); assert.equal(grant.status, 200);
    const granted = grant.headers.get("set-cookie")?.split(";")[0]; assert.ok(granted); authorCookies.set("a", granted); await grant.body?.cancel();
    const authorIndex = calls.factories.length; complete(await run("a", author, target)); assert.deepEqual(calls.factories[authorIndex], AUTHOR);
    const beforeBorrow = calls.factories.length;
    assert.equal((await run("b", author, target, { borrowed: granted })).code, "EXPERIENCE_REVOKED"); assert.equal(calls.factories.length, beforeBorrow);

    // 同一生产实例中的私有与小组Run共用真实并发装饰器，跨凭据来源的实际活跃数均不超过1。
    llmBlock = newBlock(OWN.a.llmApiKey);
    const privateRun = await start("a", own("a"), target, { private: true }); await bounded(llmBlock.entered.promise);
    const groupRun = await start("b", own("b"), target); assert.equal(calls.activeLlm, 1); llmBlock.release.release();
    const privateResult = await privateRun.result; assert.ok(privateResult.events.some(value => value.type === "complete")); complete(await groupRun.result);
    searchBlock = newBlock(OWN.a.serpApiKey);
    const privateSearch = await start("a", own("a"), target, { private: true }); await bounded(searchBlock.entered.promise);
    const groupSearchRun = await start("b", own("b"), target); assert.equal(calls.activeSearch, 1); searchBlock.release.release();
    await privateSearch.result; complete(await groupSearchRun.result); assert.equal(calls.maxLlm, 1); assert.equal(calls.maxSearch, 1);

    const generated = complete(await run("a", own("a"), target)); assert.deepEqual(await current(target), initial);
    const tampered = { ...generated.receipt, signature: (generated.receipt.signature.startsWith("a") ? "b" : "a") + generated.receipt.signature.slice(1) };
    const badSignature = await application("a", target, generated, "replace", { receipt: tampered }); assert.equal(badSignature.response.status, 409);
    const borrowed = await application("b", target, generated, "replace"); assert.equal(borrowed.response.status >= 400, true);
    assert.deepEqual(await current(target), initial);
    const applied = await application("a", target, generated, "replace"); assert.equal(applied.response.status, 200); GroupGraphWriteResponseSchema.parse(applied.json);
    let shared = await current(target); assert.equal(shared.history.events.at(-1)?.actorUserId, identities.a.userId);
    assert.equal(shared.history.events.at(-1)?.kind, "graph.search");
    const appliedAgain = await application("a", target, generated, "replace", { confirmedRevision: shared.revision }); assert.equal(appliedAgain.response.status, 409);
    assert.equal((await current(target)).history.events.length, shared.history.events.length);
    const appended = complete(await run("b", own("b"), target, { node: true }));
    assert.equal((await application("b", target, appended, "append")).response.status, 200);
    shared = await current(target); assert.equal(shared.document.nodes[0]?.resources.length, 2);
    const replaced = complete(await run("b", own("b"), target, { node: true }));
    assert.equal((await application("b", target, replaced, "replace")).response.status, 200);
    assert.equal((await current(target)).document.nodes[0]?.resources.length, 1);

    // 生成期间共享版本变化不消灭预览，但旧基线不可应用；明确确认当前版本后才消费同一签名。
    llmBlock = newBlock(OWN.b.llmApiKey);
    const changing = await start("b", own("b"), target); await bounded(llmBlock.entered.promise);
    await edit("a", target, "生成期间另一成员改名"); llmBlock.release.release(); const changedPreview = complete(await changing.result);
    const latest = await current(target);
    assert.equal((await application("b", target, changedPreview, "replace", { expectedRevision: changedPreview.receipt.target.expectedRevision })).response.status, 409);
    assert.equal((await application("b", target, changedPreview, "replace")).response.status, 409);
    assert.deepEqual(await current(target), latest);
    assert.equal((await application("b", target, changedPreview, "replace", { confirmedRevision: latest.revision })).response.status, 200);

    // 正常同步续租不取消独立40秒Run；这里实测跨租期，精确40秒耗尽由确定性时钟单测负责。
    llmBlock = newBlock(OWN.a.llmApiKey);
    const renewing = await start("a", own("a"), target); await bounded(llmBlock.entered.promise); assert.ok(renewing.live);
    let renewed = false;
    while (!renewed) { const event = await renewing.live.next(); if (event.type === "renew") renewed = true; }
    assert.equal(llmBlock.signal?.aborted, false);
    const renewedLive = await open("a", target.groupId); await renewedLive.close(); llmBlock.release.release(); complete(await renewing.result);

    // 用户取消不能签发完成或自动重跑，同runId的claim也阻止再次消耗Provider。
    llmBlock = newBlock(OWN.b.llmApiKey); const cancel = new AbortController(); controllers.push(cancel);
    const cancelling = await start("b", own("b"), target, { signal: cancel.signal }); await bounded(llmBlock.entered.promise);
    cancel.abort(); const cancelled = await cancelling.result; assert.equal(cancelled.events.some(value => value.type === "complete"), false);
    const factoryAfterCancel = calls.factories.length; assert.equal((await run("b", own("b"), target, { runId: cancelling.runId })).code, "GROUP_CONFLICT");
    assert.equal(calls.factories.length, factoryAfterCancel);
    failPlanner = true; const failed = await run("a", own("a"), target); assert.equal(failed.events.some(value => value.type === "complete"), false);

    const oldSessionPreview = complete(await run("a", own("a"), target));
    sessions.set("a", { ...identities.a, sessionId: `changedSessionA_${id}` }); authorCookies.delete("a");
    assert.equal((await application("a", target, oldSessionPreview, "replace")).response.status, 401);
    const oldEpochPreview = complete(await run("b", own("b"), target));
    const leaving = await open("b", target.groupId); const left = await post("/api/groups", "b", { action: "leave", groupId: target.groupId, mutationId: mutation() }, leaving.proof);
    assert.equal(left.status, 200); await left.body?.cancel(); await leaving.close();
    const rejoin = await post("/api/groups", "b", { action: "join", invitationCode: target.invitationCode, mutationId: mutation() }); assert.equal(rejoin.status, 200); await rejoin.body?.cancel();
    assert.equal((await application("b", target, oldEpochPreview, "replace")).response.status, 403);

    // 解散期间仍在生成的Run失去成员资格，既不继续下游调用，也不能以迟到预览复活组图。
    const doomed = await makeGroup("解散中的搜索假组"), readyBeforeDissolve = complete(await run("a", own("a"), doomed));
    llmBlock = newBlock(OWN.b.llmApiKey); const duringDissolve = await start("b", own("b"), doomed); await bounded(llmBlock.entered.promise);
    const ownerLive = await open("a", doomed.groupId), details = await groups.read(identities.a.userId, doomed.groupId, operation());
    const dissolved = await post("/api/groups", "a", { action: "dissolve", groupId: doomed.groupId, expectedRevision: details.group.revision, mutationId: mutation() }, ownerLive.proof);
    assert.equal(dissolved.status, 200); await dissolved.body?.cancel(); await ownerLive.close(); llmBlock.release.release();
    assert.equal((await duringDissolve.result).events.some(value => value.type === "complete"), false);
    await assert.rejects(workspace.write(identities.a.userId, { action: "applySearch", groupId: doomed.groupId, graphId: doomed.graphId,
      expectedRevision: readyBeforeDissolve.receipt.target.expectedRevision, receipt: readyBeforeDissolve.receipt,
      result: readyBeforeDissolve.event.data.result, mode: "replace", mutationId: mutation() }, operation(), sessions.get("a")!.sessionId), { code: "GROUP_NOT_FOUND" });
    for (const call of calls.llm) for (const secret of secrets) assert.equal(call.prompt.includes(secret), false);
    assert.equal(calls.activeLlm, 0); assert.equal(calls.activeSearch, 0);
  } finally {
    for (const block of blocks) block.release.release(); for (const controller of controllers) controller.abort();
    await Promise.allSettled(closers.map(close => close())); sync.close(); await server.close();
    const cleanup = await Promise.allSettled([
      ...[...groupIds].map(groupId => db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [groupId])),
      ...Object.values(identities).map(person => db.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [person.userId])),
    ]); cleanupFailed = cleanup.some(value => value.status === "rejected");
  }
  if (cleanupFailed) throw new Error("小组搜索假数据未完全清理");
  console.info("小组搜索真实组合根＋假Provider：发起者own/cloud/author隔离／私有组内共享队列／完成HMAC与消费／节点追加替换／基线冲突再确认／正常续租保留Run／取消与重复claim／会话代际／退出再加入／解散迟到结果通过；精确40秒由时钟单测覆盖");
} catch {
  console.error("小组搜索隔离验证失败；核对假数据库与生产搜索边界，不输出原始异常或配置"); process.exitCode = 1;
} finally {
  for (const block of blocks) block.release.release(); for (const controller of controllers) controller.abort();
  await database?.close(); if (directory !== undefined) await fs.rm(directory, { recursive: true, force: true });
}
