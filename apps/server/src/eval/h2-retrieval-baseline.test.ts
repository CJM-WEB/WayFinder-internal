/**
 * 测试职责：证明 H2 两个条件复用同一单节点管线，且唯一受控输入差异是 Search Query 来源。
 * 所有 Provider 均为 Fake（测试替身），普通 CI 不读取 Secret 或访问网络。
 */
import type { NormalizedSearchHit } from "@wayfinder/contracts";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import {
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { SearchProvider } from "../search/provider.js";
import {
  createH2RawQuerySmokeCase,
  evaluateH2RetrievalBaseline,
} from "./h2-retrieval-baseline.js";
import { getSingleNodeSmokeCases } from "./run-single-node-smoke.js";
import {
  createH2PrivateOutputDirectory,
  parseH2BaselineCliArgs,
} from "./run-h2-retrieval-baseline.js";

const SCORES = {
  relevance: 0.9,
  authority: 0.9,
  clarity: 0.9,
  completeness: 0.9,
  trustSafety: 0.9,
  freshness: 0.7,
} as const;
const VALID_RUN_ID =
  "2026-10-22T00-00-00-000Z-00000000-0000-4000-8000-000000000001";
const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wayfinder-h2-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function getKnowledgeCase() {
  const smokeCase = getSingleNodeSmokeCases()[0];
  if (smokeCase === undefined) {
    throw new Error("Knowledge Smoke Case 缺失");
  }
  return smokeCase;
}

function createHit(query: string, suffix: string): NormalizedSearchHit {
  return {
    provider: "fake-search",
    query,
    title: `Python resource ${suffix}`,
    url: `https://${suffix}.example/python`,
    canonicalUrl: `https://${suffix}.example/python`,
    domain: `${suffix}.example`,
    snippet: "Python 学习资源。",
    publishedAt: null,
    providerRank: 1,
    providerScore: 0.9,
    rawMetadata: {},
  };
}

function createSuccessfulFixture() {
  const smokeCase = getKnowledgeCase();
  const [firstQuery, secondQuery] = smokeCase.node.searchPlan.queries;
  if (firstQuery === undefined || secondQuery === undefined) {
    throw new Error("Knowledge Smoke Query 缺失");
  }
  const firstHit = createHit(firstQuery, "node-one");
  const secondHit = createHit(secondQuery, "node-two");
  const rawHit = createHit(smokeCase.originalQuery, "raw-one");
  const scriptedSearchProvider = new FakeSearchProvider({
    searchResponses: {
      [firstQuery]: [firstHit],
      [secondQuery]: [secondHit],
      [smokeCase.originalQuery]: [rawHit],
    },
  });
  const pages = [firstHit, secondHit, rawHit].map(hit => ({
      canonicalUrl: hit.canonicalUrl,
      content: `正文 ${hit.domain}`,
    }));
  const searchProvider: SearchProvider = {
    id: scriptedSearchProvider.id,
    capabilities: [...scriptedSearchProvider.capabilities],
    search: (request, signal) =>
      scriptedSearchProvider.search(request, signal),
    async extract(canonicalUrls, signal) {
      signal.throwIfAborted();
      return pages.filter(page => canonicalUrls.includes(page.canonicalUrl));
    },
  };
  const rerankProvider = new FakeLLMProvider([
    {
      ranking: [firstHit, secondHit].map((_hit, index) => ({
        candidateId: `candidate_${index + 1}`,
        scores: SCORES,
        summary: `Node-specific 资源 ${index + 1}。`,
        whySelected: "与节点目标直接相关。",
      })),
    },
    {
      ranking: [
        {
          candidateId: "candidate_1",
          scores: SCORES,
          summary: "Raw Query 资源。",
          whySelected: "与原始查询相关。",
        },
      ],
    },
  ]);
  return {
    smokeCase,
    searchProvider,
    searchCalls: scriptedSearchProvider.searchCalls,
    rerankProvider,
  };
}

describe("H2 Raw Query 条件", () => {
  it("只替换 queries 与派生 maxResults，且不修改原 Case", () => {
    const smokeCase = getKnowledgeCase();
    const snapshot = structuredClone(smokeCase);
    const raw = createH2RawQuerySmokeCase(smokeCase);

    expect(raw).toEqual({
      ...smokeCase,
      node: {
        ...smokeCase.node,
        searchPlan: {
          ...smokeCase.node.searchPlan,
          queries: [smokeCase.originalQuery],
          maxResults: 20,
        },
      },
    });
    expect(smokeCase).toEqual(snapshot);
    expect(raw.node.searchPlan.rankingProfile).toBe(
      smokeCase.node.searchPlan.rankingProfile,
    );
    expect(raw.node.searchPlan.providerHints).toEqual(
      smokeCase.node.searchPlan.providerHints,
    );
  });
});

describe("H2 Baseline Live 闸门", () => {
  it("只接受显式 Live、固定 Case 与条件顺序", () => {
    expect(
      parseH2BaselineCliArgs([
        "--live",
        "--case=wfq-001",
        "--first=node-specific",
      ]),
    ).toEqual({
      caseId: "wfq-001",
      conditionOrder: ["node_specific", "raw_query"],
    });
    expect(
      parseH2BaselineCliArgs([
        "--",
        "--first=raw-query",
        "--case=wfq-013",
        "--live",
      ]),
    ).toEqual({
      caseId: "wfq-013",
      conditionOrder: ["raw_query", "node_specific"],
    });

    for (const args of [
      ["--case=wfq-001", "--first=node-specific"],
      ["--live", "--case=wfq-999", "--first=node-specific"],
      ["--live", "--case=wfq-001", "--first=unknown"],
      ["--live", "--case=wfq-001", "--first=node-specific", "extra"],
    ]) {
      expect(() => parseH2BaselineCliArgs(args)).toThrow();
    }
  });
});

describe("H2 Baseline 私有输出目录", () => {
  it("只在固定 WAY-107 H2 目录创建内部 Run 目录", async () => {
    const root = await createTemporaryRoot();
    const outputDirectory = await createH2PrivateOutputDirectory(
      root,
      VALID_RUN_ID,
    );

    expect(outputDirectory).toBe(
      join(root, "data", "eval-results", "way-107", "h2", VALID_RUN_ID),
    );
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it.each(["data", "eval-results", "way-107", "h2"] as const)(
    "拒绝 %s 符号链接，不能写入仓库外目录",
    async linkedLevel => {
      if (process.platform === "win32") return;
      const root = await createTemporaryRoot();
      const outside = await createTemporaryRoot();
      const dataDirectory = join(root, "data");
      const evalDirectory = join(dataDirectory, "eval-results");
      const way107Directory = join(evalDirectory, "way-107");
      const resultRoot = join(way107Directory, "h2");

      if (linkedLevel === "data") {
        await symlink(outside, dataDirectory, "dir");
      } else if (linkedLevel === "eval-results") {
        await mkdir(dataDirectory);
        await symlink(outside, evalDirectory, "dir");
      } else if (linkedLevel === "way-107") {
        await mkdir(evalDirectory, { recursive: true });
        await symlink(outside, way107Directory, "dir");
      } else {
        await mkdir(way107Directory, { recursive: true });
        await symlink(outside, resultRoot, "dir");
      }

      await expect(
        createH2PrivateOutputDirectory(root, VALID_RUN_ID),
      ).rejects.toThrow("仓库内真实目录");
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("拒绝调用方提供任意目录名", async () => {
    const root = await createTemporaryRoot();
    await expect(
      createH2PrivateOutputDirectory(root, "../../outside"),
    ).rejects.toThrow("Run ID 格式无效");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("H2 Retrieval Baseline 执行器", () => {
  it("用同一 Provider 管线生成中性 A/B，并保持每条件 20 个候选总预算", async () => {
    const fixture = createSuccessfulFixture();
    const artifact = await evaluateH2RetrievalBaseline({
      ...fixture,
      rerankTimeoutMs: 12_000,
      referenceTime: "2026-10-22T00:00:00Z",
    });

    expect(artifact).toMatchObject({
      version: "h2-evaluation.v1",
      query: fixture.smokeCase.originalQuery,
      conditions: [
        { id: "A", source: "node_specific", node: { status: "ready" } },
        { id: "B", source: "raw_query", node: { status: "ready" } },
      ],
    });
    expect(artifact.conditions[0].node.id).toBe(
      artifact.conditions[1].node.id,
    );
    expect(
      fixture.searchCalls.map(call => ({
        query: call.request.query,
        maxResults: call.request.maxResults,
      })),
    ).toEqual([
      ...fixture.smokeCase.node.searchPlan.queries.map(query => ({
        query,
        maxResults: 10,
      })),
      { query: fixture.smokeCase.originalQuery, maxResults: 20 },
    ]);
    expect(
      fixture.searchCalls
        .slice(0, 2)
        .reduce((total, call) => total + call.request.maxResults, 0),
    ).toBe(20);
    expect(fixture.searchCalls[2]?.request.maxResults).toBe(20);
    expect(fixture.rerankProvider.calls).toHaveLength(2);
  });

  it("允许交叉条件顺序，但仍只使用中性 A/B 标识", async () => {
    const fixture = createSuccessfulFixture();
    // Fake Rerank 响应必须与反向执行顺序匹配候选数量。
    fixture.rerankProvider = new FakeLLMProvider([
      {
        ranking: [
          {
            candidateId: "candidate_1",
            scores: SCORES,
            summary: "Raw Query 资源。",
            whySelected: "与原始查询相关。",
          },
        ],
      },
      {
        ranking: [1, 2].map(index => ({
          candidateId: `candidate_${index}`,
          scores: SCORES,
          summary: `Node-specific 资源 ${index}。`,
          whySelected: "与节点目标直接相关。",
        })),
      },
    ]);

    const artifact = await evaluateH2RetrievalBaseline({
      ...fixture,
      rerankTimeoutMs: 12_000,
      conditionOrder: ["raw_query", "node_specific"],
    });

    expect(artifact.conditions.map(condition => condition.id)).toEqual([
      "A",
      "B",
    ]);
    expect(artifact.conditions.map(condition => condition.source)).toEqual([
      "raw_query",
      "node_specific",
    ]);
    expect(fixture.searchCalls[0]?.request.query).toBe(
      fixture.smokeCase.originalQuery,
    );
  });

  it("前一条件消耗时间后，后一条件仍获得相同的独立 Deadline 预算", async () => {
    const fixture = createSuccessfulFixture();
    let currentTime = 0;
    const scriptedReranker = fixture.rerankProvider;
    const advancingReranker = {
      id: scriptedReranker.id,
      async structured(
        input: Parameters<typeof scriptedReranker.structured>[0],
        options: Parameters<typeof scriptedReranker.structured>[1],
      ) {
        const response = await scriptedReranker.structured(input, options);
        // 模拟第一个完整条件占用 10 秒；第二个条件必须从新的 20 秒 Run 窗口开始。
        currentTime += 10_000;
        return response;
      },
    };

    await evaluateH2RetrievalBaseline({
      smokeCase: fixture.smokeCase,
      searchProvider: fixture.searchProvider,
      rerankProvider: advancingReranker,
      rerankTimeoutMs: 15_000,
      runDeadlineMs: 20_000,
      now: () => currentTime,
    });

    expect(
      scriptedReranker.calls.map(call => call.options.timeoutMs),
    ).toEqual([15_000, 15_000]);
  });

  it("任一条件失败时拒绝整个工件，不伪造空资源条件", async () => {
    const fixture = createSuccessfulFixture();
    const rawFailureProvider = new FakeSearchProvider({
      searchResponses: {
        ...Object.fromEntries(
          fixture.smokeCase.node.searchPlan.queries.map(query => [
            query,
            [createHit(query, query.endsWith("overview") ? "one" : "two")],
          ]),
        ),
        [fixture.smokeCase.originalQuery]: [],
      },
      extractResponse: [],
    });

    await expect(
      evaluateH2RetrievalBaseline({
        smokeCase: fixture.smokeCase,
        searchProvider: rawFailureProvider,
        rerankProvider: fixture.rerankProvider,
        rerankTimeoutMs: 12_000,
      }),
    ).rejects.toMatchObject({
      name: "H2EvaluationError",
      conditionId: "B",
      executionStatus: "node_failed",
    });
  });

  it("父级取消立即终止，且不发起 Provider 调用", async () => {
    const fixture = createSuccessfulFixture();
    const controller = new AbortController();
    const reason = new Error("评估已取消");
    controller.abort(reason);

    await expect(
      evaluateH2RetrievalBaseline({
        ...fixture,
        rerankTimeoutMs: 12_000,
        parentSignal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(fixture.searchCalls).toHaveLength(0);
  });

  it("拒绝重复来源顺序和超过全局上限的 Deadline", async () => {
    const fixture = createSuccessfulFixture();
    await expect(
      evaluateH2RetrievalBaseline({
        ...fixture,
        rerankTimeoutMs: 12_000,
        conditionOrder: ["raw_query", "raw_query"],
      }),
    ).rejects.toThrow("各包含一种检索来源");
    await expect(
      evaluateH2RetrievalBaseline({
        ...fixture,
        rerankTimeoutMs: 12_000,
        runDeadlineMs: 20_001,
      }),
    ).rejects.toThrow("runDeadlineMs");
  });
});
