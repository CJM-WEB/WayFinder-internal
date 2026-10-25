/**
 * 测试职责：冻结 WAY-59 Live Harness（真实调用执行器）的固定范围、调用预算、
 * Deadline（截止时间）分类与脱敏边界。全部 Provider 都是 Fake，不读取 Secret 或网络。
 */
import type { NormalizedSearchHit } from "@wayfinder/contracts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { SearchProvider } from "../search/provider.js";
import {
  assertSingleNodeSmokeArtifactSafety,
  assertSingleNodeSmokeCasesMatchGoldenQueries,
  assertSingleNodeSmokeGitStatus,
  assertSingleNodeSmokeLiveMode,
  createBoundedTavilyAttemptRecorder,
  createSingleNodeSmokePrivateOutputDirectory,
  encodeSingleNodeSmokeReviewText,
  evaluateSingleNodeSmokeCase,
  getSingleNodeSmokeCases,
  parseSingleNodeSmokeGoldenQueries,
  writeSingleNodeSmokePrivateJson,
} from "./run-single-node-smoke.js";

const KNOWLEDGE_SCORES = {
  relevance: 0.9,
  authority: 0.9,
  clarity: 0.9,
  completeness: 0.9,
  trustSafety: 0.9,
  freshness: 0.7,
} as const;

function createHit(input: {
  query: string;
  suffix: string;
  providerRank: number;
}): NormalizedSearchHit {
  return {
    provider: "fake-search",
    query: input.query,
    title: `Python official installation ${input.suffix}`,
    url: `https://docs-${input.suffix}.example/python`,
    canonicalUrl: `https://docs-${input.suffix}.example/python`,
    domain: `docs-${input.suffix}.example`,
    snippet: "Python 官方安装与开发环境说明。",
    publishedAt: null,
    providerRank: input.providerRank,
    providerScore: 0.9,
    rawMetadata: { privateSentinel: "RAW_PROVIDER_SENTINEL" },
  };
}

function createKnowledgeFixture(extractResponse?: Error) {
  const smokeCase = getSingleNodeSmokeCases()[0];
  if (smokeCase === undefined) {
    throw new Error("Knowledge Smoke Case 缺失");
  }
  const [firstQuery, secondQuery] = smokeCase.node.searchPlan.queries;
  if (firstQuery === undefined || secondQuery === undefined) {
    throw new Error("Knowledge Smoke Query 缺失");
  }
  const firstHit = createHit({
    query: firstQuery,
    suffix: "one",
    providerRank: 1,
  });
  const secondHit = createHit({
    query: secondQuery,
    suffix: "two",
    providerRank: 1,
  });
  const searchProvider = new FakeSearchProvider({
    searchResponses: {
      [firstQuery]: [firstHit],
      [secondQuery]: [secondHit],
    },
    extractResponse:
      extractResponse ??
      [
        {
          canonicalUrl: firstHit.canonicalUrl,
          content: "EXTRACT_BODY_SENTINEL_ONE",
        },
        {
          canonicalUrl: secondHit.canonicalUrl,
          content: "EXTRACT_BODY_SENTINEL_TWO",
        },
      ],
  });
  const rerankProvider = new FakeLLMProvider([
    {
      ranking: [
        {
          candidateId: "candidate_1",
          scores: KNOWLEDGE_SCORES,
          summary: "Python 官方安装资源摘要。",
          whySelected: "与安装和开发环境直接相关。",
        },
        {
          candidateId: "candidate_2",
          scores: KNOWLEDGE_SCORES,
          summary: "Python 多平台安装资源摘要。",
          whySelected: "补充 Windows 与 macOS 安装信息。",
        },
      ],
    },
  ]);
  return { smokeCase, searchProvider, rerankProvider };
}

describe("单 Node Smoke 安全闸门", () => {
  it("只接受唯一 --live 参数及 pnpm 转发形式", () => {
    expect(() => assertSingleNodeSmokeLiveMode(["--live"])).not.toThrow();
    expect(() =>
      assertSingleNodeSmokeLiveMode(["--", "--live"]),
    ).not.toThrow();

    for (const args of [[], ["--dry-run"], ["--live", "extra"]]) {
      expect(() => assertSingleNodeSmokeLiveMode(args)).toThrow(
        "默认禁止真实调用",
      );
    }
  });

  it("拒绝 tracked 或 untracked 文件造成的非干净基线", () => {
    expect(() => assertSingleNodeSmokeGitStatus("")).not.toThrow();
    expect(() =>
      assertSingleNodeSmokeGitStatus(" M apps/server/src/index.ts\n"),
    ).toThrow("工作区干净");
    expect(() =>
      assertSingleNodeSmokeGitStatus("?? local-smoke.ts\n"),
    ).toThrow("工作区干净");
  });

  it("拒绝敏感值与原始 Provider 字段进入工件", () => {
    expect(() =>
      assertSingleNodeSmokeArtifactSafety(
        { status: "completed", resources: [{ domain: "docs.example" }] },
        ["SECRET_SENTINEL"],
      ),
    ).not.toThrow();
    expect(() =>
      assertSingleNodeSmokeArtifactSafety(
        { note: "prefix-SECRET_SENTINEL-suffix" },
        ["SECRET_SENTINEL"],
      ),
    ).toThrow("敏感值");
    for (const key of [
      "authorization",
      "content",
      "prompt",
      "rawError",
      "rawMetadata",
      "rawResponse",
      "stack",
    ]) {
      expect(() =>
        assertSingleNodeSmokeArtifactSafety({ [key]: "x" }, []),
      ).toThrow("禁止字段");
    }
  });

  it("把全部不可信文本编码成不可执行的数字实体", () => {
    const malicious =
      '![tracking](https://attacker.example/pixel)<img src="https://attacker.example/x">`code`';
    const encoded = encodeSingleNodeSmokeReviewText(malicious);

    expect(encoded).toMatch(/^&#\d+;(?:&#\d+;)*$/u);
    expect(encoded).not.toContain("![");
    expect(encoded).not.toContain("https://");
    expect(encoded).not.toContain("<img");
    expect(encoded).not.toContain("`");
  });

  it("在超额 Tavily attempt 发出前同步拒绝", () => {
    const recorder = createBoundedTavilyAttemptRecorder({
      maximumSearchAttempts: 2,
      maximumExtractAttempts: 1,
    });
    recorder.record({ operation: "search", attempt: 1 });
    recorder.record({ operation: "search", attempt: 2 });
    recorder.record({ operation: "extract", attempt: 1 });

    expect(() =>
      recorder.record({ operation: "search", attempt: 2 }),
    ).toThrow("attempt 预算已耗尽");
    expect(recorder.read()).toHaveLength(4);
  });

  it("在 POSIX 上收紧私有输出目录和 JSON 文件权限", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wayfinder-way59-"));
    const resultRoot = join(temporaryRoot, "results");
    const outputDirectory = join(resultRoot, "run");
    const reportPath = join(outputDirectory, "report.json");
    try {
      await createSingleNodeSmokePrivateOutputDirectory(
        resultRoot,
        outputDirectory,
      );
      await writeSingleNodeSmokePrivateJson(reportPath, { status: "safe" });
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({
        status: "safe",
      });

      if (process.platform !== "win32") {
        expect((await stat(resultRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("单 Node Smoke 固定 Case", () => {
  it("只包含三个 Golden Query，并保持两 Query 的受控调用预算", () => {
    const cases = getSingleNodeSmokeCases();
    expect(cases).toHaveLength(3);
    expect(cases.map(smokeCase => smokeCase.id)).toEqual([
      "wfq-001",
      "wfq-013",
      "wfq-009",
    ]);
    expect(cases.map(smokeCase => smokeCase.category)).toEqual([
      "knowledge",
      "news",
      "software_download",
    ]);
    expect(
      cases.every(
        smokeCase =>
          smokeCase.node.searchPlan.queries.length === 2 &&
          smokeCase.node.searchPlan.maxResults === 10 &&
          smokeCase.node.searchPlan.providerHints.join(",") === "general",
      ),
    ).toBe(true);
    expect(cases[2]?.node.searchPlan.queries).toContain(
      "site:code.visualstudio.com download VS Code",
    );
    expect(cases[2]?.expectedTopDomain).toBe("code.visualstudio.com");
  });

  it("严格校验 Golden Query 文件和唯一 ID", async () => {
    const path = new URL(
      "../../../../tests/eval-queries.json",
      import.meta.url,
    );
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const parsed = parseSingleNodeSmokeGoldenQueries(value);
    expect(parsed).toHaveLength(6);
    expect(() =>
      assertSingleNodeSmokeCasesMatchGoldenQueries(parsed),
    ).not.toThrow();

    const duplicated = structuredClone([...parsed]);
    duplicated[1] = { ...duplicated[1]!, id: duplicated[0]!.id };
    expect(() => parseSingleNodeSmokeGoldenQueries(duplicated)).toThrow();
    expect(() =>
      parseSingleNodeSmokeGoldenQueries([
        ...parsed.slice(0, 5),
        { ...parsed[5]!, unknown: true },
      ]),
    ).toThrow();

    const validButDrifted = parsed.map(query =>
      query.id === "wfq-013"
        ? { ...query, query: "legally shaped but drifted query" }
        : query,
    );
    expect(() =>
      assertSingleNodeSmokeCasesMatchGoldenQueries(validButDrifted),
    ).toThrow("不一致");
  });
});

describe("单 Node Smoke 纯执行器", () => {
  it("返回通过 Contract 的 Resource，并只记录白名单遥测", async () => {
    const fixture = createKnowledgeFixture();
    const result = await evaluateSingleNodeSmokeCase({
      ...fixture,
      rerankTimeoutMs: 12_000,
      readAttemptObservations: () => [
        { operation: "search", attempt: 1 },
        { operation: "search", attempt: 1 },
        { operation: "extract", attempt: 1 },
      ],
      readTokenUsages: () => [
        { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      ],
    });

    expect(result).toMatchObject({
      executionStatus: "completed",
      nodeStatus: "ready",
      terminalEventType: "node.ready",
      terminalEventCount: 1,
      warnings: [],
      qualityChecks: {
        resultContractValid: true,
        resourceIdsUnique: true,
        canonicalUrlsUnique: true,
        ranksUniqueAndSequential: true,
        distinctDomainCount: 2,
        resourcesWithPublishedAt: 0,
        expectedTopDomainMatched: "notApplicable",
      },
      telemetry: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 1,
        extractUrlCount: 2,
        logicalLlmCalls: 1,
        searchHttpAttempts: 2,
        extractHttpAttempts: 1,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        },
        budgetWithinLimits: true,
      },
    });
    expect(result.resources).toHaveLength(2);
    expect(result.resources.map(resource => resource.rank)).toEqual([1, 2]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("RAW_PROVIDER_SENTINEL");
    expect(serialized).not.toContain("EXTRACT_BODY_SENTINEL");
  });

  it("精确记录 Extract 降级 Warning，仍保留可审核 Resource", async () => {
    const fixture = createKnowledgeFixture(new Error("private provider body"));
    const result = await evaluateSingleNodeSmokeCase({
      ...fixture,
      rerankTimeoutMs: 12_000,
    });

    expect(result).toMatchObject({
      executionStatus: "completed",
      nodeStatus: "partial",
      terminalEventType: "node.partial",
      terminalEventCount: 1,
      warnings: ["EXTRACTION_FAILED"],
      telemetry: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 1,
        logicalLlmCalls: 1,
      },
    });
    expect(result.resources).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("private provider body");
  });

  it("把安全截止分类为 deadline，不伪造 Warning 或终态", async () => {
    const smokeCase = getSingleNodeSmokeCases()[0];
    if (smokeCase === undefined) {
      throw new Error("Knowledge Smoke Case 缺失");
    }
    const [firstQuery, secondQuery] = smokeCase.node.searchPlan.queries;
    if (firstQuery === undefined || secondQuery === undefined) {
      throw new Error("Knowledge Smoke Query 缺失");
    }
    const never = new Promise<readonly NormalizedSearchHit[]>(() => {});
    const searchProvider = new FakeSearchProvider({
      searchResponses: {
        [firstQuery]: never,
        [secondQuery]: never,
      },
    });

    const result = await evaluateSingleNodeSmokeCase({
      smokeCase,
      searchProvider,
      rerankProvider: new FakeLLMProvider([]),
      rerankTimeoutMs: 12_000,
      runDeadlineMs: 5,
    });

    expect(result).toMatchObject({
      executionStatus: "deadline_exceeded",
      terminalEventCount: 0,
      warnings: [],
      resources: [],
      telemetry: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 0,
        logicalLlmCalls: 0,
      },
    });
    expect(result).not.toHaveProperty("terminalEventType");
    expect(result).not.toHaveProperty("errorCode");
  });

  it("在 LLM 真正开始时按 Run 剩余时间收窄 timeout", async () => {
    const fixture = createKnowledgeFixture();
    let currentTime = 0;
    const result = await evaluateSingleNodeSmokeCase({
      ...fixture,
      rerankTimeoutMs: 15_000,
      now: () => {
        const value = currentTime;
        currentTime += 1_000;
        return value;
      },
    });

    expect(result.executionStatus).toBe("completed");
    expect(fixture.rerankProvider.calls).toHaveLength(1);
    expect(fixture.rerankProvider.calls[0]?.options.timeoutMs).toBeLessThan(
      15_000,
    );
    expect(fixture.rerankProvider.calls[0]?.options.timeoutMs).toBeGreaterThan(
      0,
    );
  });

  it("墙钟已过绝对截止时同步终止，不等待 timer 才阻止 LLM", async () => {
    const fixture = createKnowledgeFixture();
    let currentTime = 0;
    const timeAdvancingSearchProvider: SearchProvider = {
      id: fixture.searchProvider.id,
      capabilities: [...fixture.searchProvider.capabilities],
      async search(request, signal) {
        const hits = await fixture.searchProvider.search(request, signal);
        currentTime += 2_000;
        return hits;
      },
      async extract(canonicalUrls, signal) {
        const pages = await fixture.searchProvider.extract(
          canonicalUrls,
          signal,
        );
        // 模拟同步处理占用事件循环，使 timer 尚未调度但绝对墙钟已经过期。
        currentTime += 17_000;
        return pages;
      },
    };

    const result = await evaluateSingleNodeSmokeCase({
      smokeCase: fixture.smokeCase,
      searchProvider: timeAdvancingSearchProvider,
      rerankProvider: fixture.rerankProvider,
      rerankTimeoutMs: 15_000,
      runDeadlineMs: 20_000,
      now: () => currentTime,
    });

    expect(result).toMatchObject({
      executionStatus: "deadline_exceeded",
      terminalEventCount: 0,
      warnings: [],
      telemetry: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 1,
        logicalLlmCalls: 0,
        budgetWithinLimits: true,
      },
    });
    expect(fixture.rerankProvider.calls).toHaveLength(0);
  });

  it("稳定分类 Node 失败与父 Signal 取消，并保留失败路径遥测", async () => {
    const smokeCase = getSingleNodeSmokeCases()[0];
    if (smokeCase === undefined) {
      throw new Error("Knowledge Smoke Case 缺失");
    }
    const [firstQuery, secondQuery] = smokeCase.node.searchPlan.queries;
    if (firstQuery === undefined || secondQuery === undefined) {
      throw new Error("Knowledge Smoke Query 缺失");
    }
    const failed = await evaluateSingleNodeSmokeCase({
      smokeCase,
      searchProvider: new FakeSearchProvider({
        searchResponses: {
          [firstQuery]: [],
          [secondQuery]: [],
        },
      }),
      rerankProvider: new FakeLLMProvider([]),
      rerankTimeoutMs: 12_000,
    });
    expect(failed).toMatchObject({
      executionStatus: "node_failed",
      terminalEventType: "node.failed",
      terminalEventCount: 1,
      errorCode: "SEARCH_PROVIDER_FAILED",
      telemetry: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 0,
        logicalLlmCalls: 0,
        budgetWithinLimits: true,
      },
    });

    const controller = new AbortController();
    controller.abort(new Error("人员取消"));
    const cancelled = await evaluateSingleNodeSmokeCase({
      smokeCase,
      searchProvider: new FakeSearchProvider({ searchResponses: {} }),
      rerankProvider: new FakeLLMProvider([]),
      rerankTimeoutMs: 12_000,
      parentSignal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      executionStatus: "cancelled",
      terminalEventCount: 0,
      telemetry: {
        logicalSearchCalls: 0,
        logicalExtractCalls: 0,
        logicalLlmCalls: 0,
        budgetWithinLimits: true,
      },
    });
  });
});
