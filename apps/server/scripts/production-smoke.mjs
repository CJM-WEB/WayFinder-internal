/**
 * 脚本职责：从编译产物启动一个真实回环服务，证明单个 Fastify 实例同时提供 Web、API 与渐进 NDJSON。
 *
 * 安全边界：只注入代码内假Provider／账号存储，不读取Secret或访问公网，不增加生产假环境开关。
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  calculateSearchPlanMaxResults,
  AccountResponseSchema,
  AccountKeysResponseSchema,
  CloudWorkspaceResponseSchema,
  CLOUD_ACCOUNT_HEADER,
  GraphPlanSchema,
  SEARCH_CREDENTIALS_HEADER,
  StreamEventSchema,
} from "../../../packages/contracts/dist/index.js";
import { parseServerConfig } from "../dist/config.js";
import { buildProductionServer } from "../dist/production-server.js";

const webAssetsDirectory = fileURLToPath(
  new URL("../../web/dist/", import.meta.url),
);
const fetchFromLoopback = globalThis.fetch;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createDeferred() {
  let resolvePromise;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const plan = GraphPlanSchema.parse({
  analysis: {
    intent: "learn",
    topic: "TypeScript compiler guide",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  },
  nodes: [
    {
      id: "typescript-guide",
      title: "TypeScript compiler guide",
      description: "Learn the official TypeScript compiler options",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: ["TypeScript compiler guide"],
        maxResults: calculateSearchPlanMaxResults(1),
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    },
  ],
  edges: [],
});
const outline = {
  analysis: plan.analysis,
  nodes: plan.nodes.map(node => ({
    id: node.id,
    title: node.title,
    description: node.description,
    nodeType: node.nodeType,
    layer: node.layer,
    status: node.status,
  })),
  edges: plan.edges,
};
const searchPlanBundle = {
  plans: plan.nodes.map(node => ({
    nodeId: node.id,
    queries: node.searchPlan.queries,
    rankingProfile: node.searchPlan.rankingProfile,
  })),
};

const searchGate = createDeferred();
let searchResolved = false;
const searchProvider = {
  id: "fake-search",
  capabilities: ["general"],
  async search(request, signal) {
    signal.throwIfAborted();
    await searchGate.promise;
    signal.throwIfAborted();
    searchResolved = true;
    const url = "https://docs.example.com/typescript/compiler";
    return [
      {
        provider: "fake-search",
        query: request.query,
        title: "TypeScript compiler guide",
        url,
        canonicalUrl: url,
        domain: "docs.example.com",
        snippet: "Official compiler options and practical examples.",
        providerRank: 1,
        providerScore: 0.95,
        rawMetadata: {},
      },
    ];
  },
};

const llmProvider = {
  id: "fake-llm",
  async structured(input, options) {
    options.signal.throwIfAborted();
    // 按 Structured Output 角色返回固定夹具，避免调用顺序漂移掩盖阶段错误。
    if (input.schemaName === "graph_outline") return outline;
    if (input.schemaName === "search_plan_bundle") return searchPlanBundle;
    if (input.schemaName !== "resource_rerank") {
      throw new Error("生产 Smoke 收到未知 LLM Schema");
    }
    return {
      ranking: [
        {
          candidateId: "candidate_1",
          scores: {
            relevance: 0.95,
            authority: 0.95,
            clarity: 0.95,
            completeness: 0.95,
            trustSafety: 0.95,
            freshness: 0.95,
          },
          summary: "TypeScript 编译器选项的结构化摘要。",
          whySelected: "该文档与当前节点直接相关。",
        },
      ],
    };
  },
};

/** 从真实 ReadableStream 读取一条 LF 结束的事件，并保留同一块中的后续数据。 */
function createLineReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let ended = false;

  return {
    get ended() {
      return ended;
    },
    async readLine() {
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd >= 0) {
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          return line;
        }
        const next = await reader.read();
        if (next.done) {
          ended = true;
          buffer += decoder.decode();
          if (buffer.length === 0) return undefined;
          throw new Error("NDJSON 末行缺少 LF");
        }
        buffer += decoder.decode(next.value, { stream: true });
      }
    },
  };
}

const originalDirectory = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "wayfinder-production-smoke-"));
const config = parseServerConfig({
  LLM_PROVIDER: "deepseek",
  LLM_MODEL: "deepseek-flash",
  LLM_API_KEY: "fake-smoke-llm-key",
  SERPAPI_API_KEY: "fake-smoke-search-key",
});
// 仅验证编译产物的路由装配；真实认证／SQL持久化由显式隔离数据库检查承担。
const identity = { userId: "fixture_smoke_owner", sessionId: "fixture-private-session-id", email: "fixture@example.test" };
const cookie = "fixture_session=fixture-private-cookie", cloudKey = "fixture-private-cloud-key";
const calls = { auth: 0, workspace: 0, keys: 0 };
const account = { userId: identity.userId, email: identity.email };
const workspace = { userId: identity.userId, activeOrder: [], deletedIds: [], graphs: [] };
const keys = { userId: identity.userId, deepseek: { configured: true, mask: "••••tail", revision: "fixture_revision" },
  serpapi: { configured: false, mask: null, revision: null } };
const unexpected = async () => { throw new Error("Smoke意外调用未获准的账号副作用"); };
const accounts = {
  auth: { initialize: unexpected, migrate: unexpected, handle: unexpected,
    getIdentity: async headers => { calls.auth++; return headers.get("cookie") === cookie ? identity : null; } },
  database: { close: async () => {} },
  workspace: { read: async userId => { calls.workspace++; assert(userId === identity.userId, "工作区装配使用错误归属"); return workspace; },
    write: unexpected, importGuest: unexpected },
  keys: { read: async userId => { calls.keys++; assert(userId === identity.userId, "云Key装配使用错误归属"); return keys; },
    write: unexpected, resolve: unexpected, assertCurrent: unexpected },
};
let server;

try {
  // 构建实例前就切换目录，确保静态校验和监听均不隐式依赖 process.cwd()。
  process.chdir(temporaryRoot);
  server = await buildProductionServer({
    config,
    repositoryRoot: temporaryRoot,
    webAssetsDirectory,
    baseProviders: { searchProvider, llmProvider },
    accounts,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });

  const health = await fetchFromLoopback(`${address}/health`);
  assert(health.status === 200, "生产 Health 路由不可用");

  const index = await fetchFromLoopback(`${address}/`);
  const html = await index.text();
  assert(index.status === 200 && html.includes('id="root"'), "生产首页不可用");
  // 根入口必须交付已验收的新版，不能只因空 root 与某个脚本存在就把旧展示误报为迁移成功。
  assert(html.includes("<title>WAYFINDER — 墨迹漫游</title>"), "生产首页未使用墨迹漫游入口");
  const assetPaths = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu),
  ].map(match => match[1]);
  assert(assetPaths.length > 0, "生产首页没有引用 Vite Asset");
  for (const assetPath of assetPaths) {
    const asset = await fetchFromLoopback(`${address}${assetPath}`);
    const bytes = await asset.arrayBuffer();
    assert(asset.status === 200 && bytes.byteLength > 0, "Vite Asset 不可用");
    assert(
      /(?:javascript|css|image|font|octet-stream)/u.test(
        asset.headers.get("content-type") ?? "",
      ),
      "Vite Asset MIME 不合理",
    );
  }

  // 同一实例必须真的注册D11三类路由；浏览器Fixture拦截不能替代该装配检查。
  const accountHeaders = { Origin: address, Cookie: cookie, [CLOUD_ACCOUNT_HEADER]: identity.userId };
  for (const [path, schema, expected] of [["/api/account", AccountResponseSchema, { account }],
    ["/api/workspace", CloudWorkspaceResponseSchema, workspace], ["/api/account/keys", AccountKeysResponseSchema, keys]]) {
    const result = await fetchFromLoopback(`${address}${path}`, { headers: accountHeaders });
    const text = await result.text(), parsed = schema.safeParse(JSON.parse(text));
    assert(result.status === 200 && parsed.success && JSON.stringify(parsed.data) === JSON.stringify(expected), "D11路由装配或公共响应不正确");
    assert(result.headers.get("cache-control") === "no-store", "D11响应不得被缓存");
    for (const secret of [identity.sessionId, cookie, cloudKey]) assert(!text.includes(secret), "普通响应泄漏秘密");
  }
  const anonymous = await fetchFromLoopback(`${address}/api/account`, { headers: { Origin: address } });
  assert(JSON.stringify(await anonymous.json()) === '{"account":null}', "访客账号查询错误");
  for (const path of ["/api/workspace", "/api/account/keys"]) {
    const rejected = await fetchFromLoopback(`${address}${path}`, { headers: { ...accountHeaders, [CLOUD_ACCOUNT_HEADER]: "wrong_owner" } });
    assert(rejected.status === 401 && rejected.headers.get("cache-control") === "no-store", "错号数据请求未失败闭合");
    assert(JSON.stringify(await rejected.json()) === '{"code":"ACCOUNT_REQUIRED"}', "错号错误投影不正确");
  }
  assert(calls.workspace === 1 && calls.keys === 1, "错号请求不应进入存储");
  const beforeGuestSearch = JSON.stringify(calls);

  const response = await fetchFromLoopback(`${address}/api/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: address,
      [SEARCH_CREDENTIALS_HEADER]: JSON.stringify({
        deepseek: { source: "own", apiKey: "fake-smoke-llm-key" },
        serpapi: { source: "own", apiKey: "fake-smoke-search-key" },
      }),
    },
    body: JSON.stringify({
      runId: "run-production-smoke",
      query: "TypeScript compiler guide",
      language: "zh-CN",
    }),
  });
  assert(response.status === 200 && response.body !== null, "Search Stream 未建立");
  assert(
    response.headers.get("content-type") ===
      "application/x-ndjson; charset=utf-8",
    "NDJSON Content-Type 漂移",
  );
  assert(
    response.headers.get("cache-control") === "no-cache, no-transform",
    "NDJSON Cache-Control 漂移",
  );
  assert(
    response.headers.get("x-accel-buffering") === "no",
    "NDJSON X-Accel-Buffering 漂移",
  );
  assert(!response.headers.has("content-length"), "NDJSON 不得固定 Content-Length");

  const lines = createLineReader(response.body);
  const firstLine = await lines.readLine();
  assert(firstLine !== undefined, "NDJSON 缺少首事件");
  const events = [StreamEventSchema.parse(JSON.parse(firstLine))];
  assert(!searchResolved && !lines.ended, "首事件被缓冲到 Search 终态之后");

  searchGate.resolve();
  for (;;) {
    const line = await lines.readLine();
    if (line === undefined) break;
    events.push(StreamEventSchema.parse(JSON.parse(line)));
  }
  assert(events.at(-1)?.type === "complete", "NDJSON 未以 complete 结束");
  assert(searchResolved, "Fake Search 未完成");
  assert(JSON.stringify(calls) === beforeGuestSearch, "访客双自带搜索不应读取账号或云存储");

  // Run Log 默认关闭时，生产组合根不得创建任何日志目录。
  await access(join(temporaryRoot, "data")).then(
    () => {
      throw new Error("RUN_LOGGING=false 仍创建了 data 目录");
    },
    () => undefined,
  );
} finally {
  process.chdir(originalDirectory);
  if (server !== undefined) await server.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("WAY-94 / D11 production smoke passed\n");
