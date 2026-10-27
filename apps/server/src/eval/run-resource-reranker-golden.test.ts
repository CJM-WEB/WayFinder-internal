/**
 * 测试职责：冻结 Reranker + WAY-55 Diversity Golden 的 live guard、固定 Case 数据
 * 与脱敏报告。测试只使用 Fake LLM，不读取 Secret、不访问网络或创建真实结果目录。
 */
import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "../../../../tests/support/test-infrastructure.mjs";
import {
  assertResourceRerankerGoldenGitStatus,
  assertResourceRerankerGoldenLiveMode,
  evaluateResourceRerankerGoldenCase,
  readResourceRerankerGoldenCases,
  readResourceRerankerGoldenQueries,
} from "./run-resource-reranker-golden.js";

function createProfileScores(profile: string): Record<string, number> {
  switch (profile) {
    case "knowledge":
      return {
        relevance: 0.9,
        authority: 0.9,
        clarity: 0.9,
        completeness: 0.9,
        trustSafety: 0.9,
        freshness: 0.9,
      };
    case "news":
      return {
        freshness: 0.9,
        authority: 0.9,
        relevance: 0.9,
        primarySource: 0.9,
        sourceDiversity: 0.9,
        trustSafety: 0.9,
      };
    case "shopping":
      return {
        relevance: 0.9,
        productFit: 0.9,
        authority: 0.9,
        evidence: 0.9,
        freshness: 0.9,
        userExperience: 0.9,
        trustSafety: 0.9,
      };
    case "software":
      return {
        officialness: 0.9,
        trustSafety: 0.9,
        relevance: 0.9,
        freshness: 0.9,
        clarity: 0.9,
      };
    default:
      return { relevance: 0.9 };
  }
}

describe("Reranker Golden live guard", () => {
  it("只接受唯一 --live 参数及 pnpm 转发形式", () => {
    expect(() => assertResourceRerankerGoldenLiveMode(["--live"])).not.toThrow();
    expect(() =>
      assertResourceRerankerGoldenLiveMode(["--", "--live"]),
    ).not.toThrow();

    for (const args of [[], ["--dry-run"], ["--live", "extra"]]) {
      expect(() => assertResourceRerankerGoldenLiveMode(args)).toThrow(
        "默认禁止真实调用",
      );
    }
  });

  it("拒绝 tracked 或 untracked 文件造成的非干净基线", () => {
    expect(() => assertResourceRerankerGoldenGitStatus("")).not.toThrow();
    expect(() =>
      assertResourceRerankerGoldenGitStatus(" M apps/server/src/index.ts\n"),
    ).toThrow("工作区干净");
    expect(() =>
      assertResourceRerankerGoldenGitStatus("?? untracked-source.ts\n"),
    ).toThrow("工作区干净");
  });
});

describe("Reranker Golden 固定 Case", () => {
  it("与六条固定 Query 逐项对齐，并保持 Fixture 唯一且脱敏", async () => {
    const [cases, queries] = await Promise.all([
      readResourceRerankerGoldenCases(),
      readResourceRerankerGoldenQueries(),
    ]);

    expect(cases).toHaveLength(6);
    expect(new Set(cases.map(goldenCase => goldenCase.id)).size).toBe(6);
    expect(
      cases.map(({ id, query, category, rationale }) => ({
        id,
        query,
        category,
        rationale,
      })),
    ).toEqual(queries);
    expect(cases.map(goldenCase => goldenCase.rankingProfile)).toEqual([
      "knowledge",
      "general",
      "software",
      "shopping",
      "news",
      "general",
    ]);
    expect(JSON.stringify(cases)).not.toContain("localhost");
    expect(
      cases.every(goldenCase =>
        goldenCase.candidates.every(candidate =>
          candidate.canonicalUrl.includes(".example/"),
        ),
      ),
    ).toBe(true);
    expect(
      cases.some(goldenCase => {
        const domainCounts = new Map<string, number>();
        for (const candidate of goldenCase.candidates) {
          domainCounts.set(
            candidate.domain,
            (domainCounts.get(candidate.domain) ?? 0) + 1,
          );
        }
        return [...domainCounts.values()].some(count => count > 2);
      }),
    ).toBe(true);
  });

  it("记录排序、质量、延迟与 Token，但不保存输入正文或 URL", async () => {
    const [goldenCase] = await readResourceRerankerGoldenCases();
    expect(goldenCase).toBeDefined();
    const ranking = goldenCase!.candidates.map(candidate => ({
      candidateId: candidate.candidateId,
      scores: createProfileScores(goldenCase!.rankingProfile),
      summary: "Concise evidence-grounded summary.",
      whySelected: "Matches the node with stronger supplied evidence.",
    }));
    const provider = new FakeLLMProvider([{ ranking }]);

    const result = await evaluateResourceRerankerGoldenCase({
      goldenCase: goldenCase!,
      provider,
      timeoutMs: 12_000,
      readTokenUsages: () => [
        { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ],
    });

    expect(result).toMatchObject({
      status: "completed",
      preDiversityOrder: goldenCase!.candidates.map(
        candidate => candidate.candidateId,
      ),
      actualOrder: goldenCase!.candidates.map(
        candidate => candidate.candidateId,
      ),
      diversityRemovedCandidateIds: [],
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(JSON.stringify(result)).not.toContain(
      goldenCase!.candidates[0]!.content,
    );
  });

  it("在 News Case 中保留完整模型顺序且不做破坏性 Diversity 删除", async () => {
    const cases = await readResourceRerankerGoldenCases();
    const newsCase = cases.find(goldenCase => goldenCase.id === "wfq-013");
    expect(newsCase).toBeDefined();
    const ranking = newsCase!.candidates.map(candidate => ({
      candidateId: candidate.candidateId,
      scores: createProfileScores(newsCase!.rankingProfile),
      summary: "Evidence-grounded news summary.",
      whySelected: "Ordered from the supplied news evidence.",
    }));

    const result = await evaluateResourceRerankerGoldenCase({
      goldenCase: newsCase!,
      provider: new FakeLLMProvider([{ ranking }]),
      timeoutMs: 12_000,
    });

    expect(result).toMatchObject({
      status: "completed",
      preDiversityOrder: [
        "candidate_1",
        "candidate_2",
        "candidate_3",
        "candidate_4",
        "candidate_5",
      ],
      actualOrder: [
        "candidate_1",
        "candidate_2",
        "candidate_3",
        "candidate_4",
        "candidate_5",
      ],
      diversityRemovedCandidateIds: [],
    });
  });
});
