/** 测试职责：冻结匿名 Top1 override、Top3 集合重叠、分母与身份保护。 */
import type { ResourceCandidate } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { createRankingObservation } from "./ranking-observation.js";

function createCandidate(index: number): ResourceCandidate {
  const canonicalUrl = `https://private.example/${index}`;
  return {
    candidateId: `private_candidate_${index}`,
    hit: {
      provider: "serpapi_bing",
      query: "private query",
      title: `Private ${index}`,
      url: canonicalUrl,
      canonicalUrl,
      domain: "private.example",
      snippet: "private snippet",
      providerRank: index,
    },
    heuristicScore: 1,
    heuristicSignals: {},
  };
}

describe("Ranking Observation 匿名投影", () => {
  it.each([1, 2, 3, 6])("N=%i 时使用 min(3,N) 作为 Top3 分母", candidateCount => {
    const candidates = Array.from({ length: candidateCount }, (_, index) =>
      createCandidate(index + 1),
    );
    const reversed = [...candidates].reverse();
    const observation = createRankingObservation({
      fusionMode: "llm_success",
      providerOrder: candidates,
      heuristicOrder: reversed,
      finalOrder: reversed,
    });

    expect(observation.top3ComparisonSlots).toBe(Math.min(3, candidateCount));
    expect(observation.heuristicTop1Overridden).toBe(false);
  });

  it("只输出匿名比较事实，不携带候选身份或内容", () => {
    const candidates = [1, 2, 3, 4].map(createCandidate);
    const observation = createRankingObservation({
      fusionMode: "fallback",
      providerOrder: candidates,
      heuristicOrder: [candidates[1]!, candidates[2]!, candidates[0]!, candidates[3]!],
      finalOrder: [candidates[2]!, candidates[3]!, candidates[1]!, candidates[0]!],
    });

    expect(observation).toEqual({
      fusionMode: "fallback",
      candidateCount: 4,
      providerTop1Overridden: true,
      heuristicTop1Overridden: true,
      providerTop3FinalOverlap: 2,
      heuristicTop3FinalOverlap: 2,
      top3ComparisonSlots: 3,
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("private_candidate");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("private query");
  });

  it("拒绝空顺序或 Candidate 身份不一致", () => {
    const candidates = [createCandidate(1), createCandidate(2)];
    const replaced = {
      ...candidates[1]!,
      hit: {
        ...candidates[1]!.hit,
        canonicalUrl: "https://private.example/replaced",
      },
    };

    expect(() =>
      createRankingObservation({
        fusionMode: "fallback",
        providerOrder: [],
        heuristicOrder: [],
        finalOrder: [],
      }),
    ).toThrow("要求非空");
    expect(() =>
      createRankingObservation({
        fusionMode: "fallback",
        providerOrder: candidates,
        heuristicOrder: candidates,
        finalOrder: [candidates[0]!, replaced],
      }),
    ).toThrow("Candidate 集合不一致");
  });
});
