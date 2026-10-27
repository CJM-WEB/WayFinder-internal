/**
 * 测试职责：冻结 WAY-108 的三路 55/10/35、双路 11:2、集合身份、确定性决胜
 * 与融合后单次 Safety（安全层级）语义。
 */
import type { ResourceCandidate } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import type { OfficialSourceAssessment } from "./official-source.js";
import {
  applyTrustedRiskSafetyOrder,
  compareRankFusionTieBreak,
  FALLBACK_RANK_WEIGHTS,
  fuseFallbackCandidateRanks,
  fuseThreeWayCandidateRanks,
  rankUtility,
  THREE_WAY_RANK_WEIGHTS,
  type FusedCandidateRank,
} from "./rank-fusion.js";

function createCandidate(index: number): ResourceCandidate {
  const canonicalUrl = `https://example.com/${index}`;
  return {
    candidateId: `candidate_${index}`,
    hit: {
      provider: "serpapi_bing",
      query: "example query",
      title: `Example ${index}`,
      url: canonicalUrl,
      canonicalUrl,
      domain: "example.com",
      snippet: `Snippet ${index}`,
      // 原始 Provider Rank 可存在间隙；融合只使用当前数组投影出的连续序位。
      providerRank: index * 10,
    },
    heuristicScore: 1 - index / 10,
    heuristicSignals: {},
  };
}

function order(
  candidates: readonly ResourceCandidate[],
  indexes: readonly number[],
): ResourceCandidate[] {
  return indexes.map(index => candidates[index - 1]!);
}

function assessment(
  candidate: ResourceCandidate,
  classification: "unknown" | "risky",
  queryKind: OfficialSourceAssessment["queryKind"] = "download",
): OfficialSourceAssessment {
  return {
    candidate: candidate.hit,
    queryKind,
    classification,
    signals:
      classification === "risky" ? ["KNOWN_RISKY_DOWNLOAD_HOST"] : [],
  };
}

describe("Rank Fusion 数学语义", () => {
  it("冻结权重与 rankUtility 公式", () => {
    expect(THREE_WAY_RANK_WEIGHTS).toEqual({
      provider: 0.55,
      heuristic: 0.1,
      llm: 0.35,
    });
    expect(FALLBACK_RANK_WEIGHTS).toEqual({
      provider: 11 / 13,
      heuristic: 2 / 13,
    });
    expect(rankUtility(1)).toBe(1);
    expect(rankUtility(2)).toBeCloseTo(1 / Math.log2(3), 15);
    expect(rankUtility(6)).toBeCloseTo(1 / Math.log2(7), 15);
    expect(() => rankUtility(0)).toThrow("序位必须为正安全整数");
  });

  it("三路只舍入最终分，并允许非 Provider Top1 在证据足够时升至第一", () => {
    const candidates = [1, 2, 3].map(createCandidate);
    const result = fuseThreeWayCandidateRanks({
      providerOrder: order(candidates, [1, 2, 3]),
      heuristicOrder: order(candidates, [2, 3, 1]),
      llmOrder: order(candidates, [2, 3, 1]),
    });

    expect(result.candidates.map(item => item.candidateId)).toEqual([
      "candidate_2",
      "candidate_1",
      "candidate_3",
    ]);
    expect(result.ranks.map(item => ({
      id: item.candidate.candidateId,
      providerRank: item.providerRank,
      heuristicRank: item.heuristicRank,
      llmRank: item.llmRank,
      score: item.finalRankScore,
    }))).toEqual([
      {
        id: "candidate_2",
        providerRank: 2,
        heuristicRank: 1,
        llmRank: 1,
        score: 0.797011,
      },
      {
        id: "candidate_1",
        providerRank: 1,
        heuristicRank: 3,
        llmRank: 3,
        score: 0.775,
      },
      {
        id: "candidate_3",
        providerRank: 3,
        heuristicRank: 2,
        llmRank: 2,
        score: 0.558918,
      },
    ]);
  });

  it("双路 fallback 使用 11:2，并返回连续 Rank 与六位最终分", () => {
    const candidates = [1, 2, 3].map(createCandidate);
    const result = fuseFallbackCandidateRanks({
      providerOrder: order(candidates, [1, 2, 3]),
      heuristicOrder: order(candidates, [3, 2, 1]),
    });

    expect(result.ranks.map(item => ({
      id: item.candidate.candidateId,
      providerRank: item.providerRank,
      heuristicRank: item.heuristicRank,
      score: item.finalRankScore,
    }))).toEqual([
      {
        id: "candidate_1",
        providerRank: 1,
        heuristicRank: 3,
        score: 0.923077,
      },
      {
        id: "candidate_2",
        providerRank: 2,
        heuristicRank: 2,
        score: 0.63093,
      },
      {
        id: "candidate_3",
        providerRank: 3,
        heuristicRank: 1,
        score: 0.576923,
      },
    ]);
  });

  it("N=6 且原始 providerRank 有重复或缺口时仍按数组投影连续序位", () => {
    const candidates = [1, 2, 3, 4, 5, 6].map(createCandidate);
    candidates[1]!.hit.providerRank = 10;
    candidates[2]!.hit.providerRank = 10;
    const snapshot = structuredClone(candidates);
    const result = fuseFallbackCandidateRanks({
      providerOrder: candidates,
      heuristicOrder: [...candidates].reverse(),
    });

    expect(
      [...result.ranks]
        .sort((left, right) => left.providerRank - right.providerRank)
        .map(entry => entry.providerRank),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(result.candidates)).toEqual(new Set(candidates));
    expect(candidates).toEqual(snapshot);
  });

  it("同分依次按 Provider Rank、Heuristic Rank、canonicalUrl 决胜", () => {
    const [first, second, third] = [1, 2, 3].map(createCandidate) as [
      ResourceCandidate,
      ResourceCandidate,
      ResourceCandidate,
    ];
    const entry = (
      candidate: ResourceCandidate,
      providerRank: number,
      heuristicRank: number,
    ): FusedCandidateRank => ({
      candidate,
      providerRank,
      heuristicRank,
      finalRankScore: 0.5,
    });

    expect(
      compareRankFusionTieBreak(entry(first, 1, 3), entry(second, 2, 1)),
    ).toBeLessThan(0);
    expect(
      compareRankFusionTieBreak(entry(first, 1, 1), entry(second, 1, 2)),
    ).toBeLessThan(0);
    expect(
      compareRankFusionTieBreak(entry(third, 1, 1), entry(first, 1, 1)),
    ).toBeGreaterThan(0);
  });
});

describe("Rank Fusion 候选集合", () => {
  it("拒绝空集合或超过 Top6 上限的输入", () => {
    const sevenCandidates = Array.from({ length: 7 }, (_, index) =>
      createCandidate(index + 1),
    );

    expect(() =>
      fuseFallbackCandidateRanks({ providerOrder: [], heuristicOrder: [] }),
    ).toThrow("Candidate 数量必须为 1 到 6");
    expect(() =>
      fuseFallbackCandidateRanks({
        providerOrder: sevenCandidates,
        heuristicOrder: sevenCandidates,
      }),
    ).toThrow("Candidate 数量必须为 1 到 6");
  });

  it.each([
    ["缺项", [1, 2], [1]],
    ["重复 ID", [1, 2], [1, 1]],
    ["未知 Candidate", [1, 2], [1, 3]],
  ] as const)("拒绝%s或不一致集合", (_label, providerIndexes, llmIndexes) => {
    const candidates = [1, 2, 3].map(createCandidate);
    expect(() =>
      fuseThreeWayCandidateRanks({
        providerOrder: order(candidates, providerIndexes),
        heuristicOrder: order(candidates, providerIndexes),
        llmOrder: order(candidates, llmIndexes),
      }),
    ).toThrow(TypeError);
  });

  it("拒绝 Candidate ID 对应的 canonicalUrl 发生身份漂移", () => {
    const candidates = [1, 2].map(createCandidate);
    const replaced: ResourceCandidate = {
      ...candidates[0]!,
      hit: {
        ...candidates[0]!.hit,
        url: "https://replaced.example/item",
        canonicalUrl: "https://replaced.example/item",
        domain: "replaced.example",
      },
    };

    expect(() =>
      fuseThreeWayCandidateRanks({
        providerOrder: candidates,
        heuristicOrder: candidates,
        llmOrder: [replaced, candidates[1]!],
      }),
    ).toThrow("LLM Rank Candidate 集合不一致");
  });
});

describe("融合后可信风险层级", () => {
  it("只把 unknown 稳定移到 risky 前方，同层保持融合顺序且不删除", () => {
    const candidates = [1, 2, 3, 4].map(createCandidate);
    const fused = order(candidates, [2, 1, 4, 3]);
    const assessments = [
      assessment(candidates[0]!, "unknown"),
      assessment(candidates[1]!, "risky"),
      assessment(candidates[2]!, "unknown"),
      assessment(candidates[3]!, "risky"),
    ];

    expect(
      applyTrustedRiskSafetyOrder(fused, assessments).map(
        candidate => candidate.candidateId,
      ),
    ).toEqual(["candidate_1", "candidate_3", "candidate_2", "candidate_4"]);
    const safetyOrdered = applyTrustedRiskSafetyOrder(fused, assessments);
    expect(safetyOrdered).toHaveLength(fused.length);
    expect(new Set(safetyOrdered)).toEqual(new Set(fused));
  });

  it("普通任务不改变融合顺序，并拒绝 Assessment 缺项或重复", () => {
    const candidates = [1, 2].map(createCandidate);
    const fused = order(candidates, [2, 1]);
    const ordinary = candidates.map(candidate =>
      assessment(candidate, "risky", "other"),
    );
    expect(applyTrustedRiskSafetyOrder(fused, ordinary)).toEqual(fused);

    expect(() =>
      applyTrustedRiskSafetyOrder(fused, ordinary.slice(0, 1)),
    ).toThrow("Assessment 与融合候选集合不一致");
    expect(() =>
      applyTrustedRiskSafetyOrder(fused, [ordinary[0]!, ordinary[0]!]),
    ).toThrow("Assessment 与融合候选集合不一致");
  });
});
