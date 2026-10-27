/**
 * 脚本职责：从编译产物启动一个真实回环服务，证明单个 Fastify 实例同时提供 Web、API 与渐进 NDJSON。
 *
 * 安全边界：只注入代码内 Fake Provider，不读取 Secret、不访问公网，也不增加生产可启用的 Fake 开关。
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  calculateSearchPlanMaxResults,
  GraphPlanSchema,
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

let llmCall = 0;
const llmProvider = {
  id: "fake-llm",
  async structured(_input, options) {
    options.signal.throwIfAborted();
    llmCall += 1;
    if (llmCall === 1) return plan;
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
let server;

try {
  // 构建实例前就切换目录，确保静态校验和监听均不隐式依赖 process.cwd()。
  process.chdir(temporaryRoot);
  server = await buildProductionServer({
    config,
    repositoryRoot: temporaryRoot,
    webAssetsDirectory,
    baseProviders: { searchProvider, llmProvider },
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });

  const health = await fetchFromLoopback(`${address}/health`);
  assert(health.status === 200, "生产 Health 路由不可用");

  const index = await fetchFromLoopback(`${address}/`);
  const html = await index.text();
  assert(index.status === 200 && html.includes('id="root"'), "生产首页不可用");
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

  const response = await fetchFromLoopback(`${address}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "run-production-smoke",
      query: "TypeScript compiler guide",
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

process.stdout.write("WAY-94 production smoke passed\n");
