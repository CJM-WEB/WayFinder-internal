/**
 * 测试职责：冻结 Candidate Guard（候选门禁）的最小边界与 Provider-first Top 6 语义。
 */
import type { CandidateSearchHit } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  guardAndShortlistCandidates,
  MAX_RERANK_CANDIDATES_PER_NODE,
} from "./candidate-guard.js";

function createCandidate(index: number): CandidateSearchHit {
  const domain = `site-${index}.example`;
  const url = `https://${domain}/resource`;
  return {
    provider: "serpapi_bing",
    query: "候选门禁",
    title: `候选 ${index}`,
    url,
    canonicalUrl: url,
    domain,
    snippet: "",
    providerRank: index,
  };
}

describe("guardAndShortlistCandidates", () => {
  it("按 Provider 原顺序保留前六条有效候选", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      createCandidate(index + 1),
    );

    expect(MAX_RERANK_CANDIDATES_PER_NODE).toBe(6);
    expect(
      guardAndShortlistCandidates(candidates).accepted.map(candidate =>
        candidate.providerRank,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("只拒绝非法协议、不可解析 URL 与域名不一致项", () => {
    const validEmptySnippet = createCandidate(4);
    const candidates = [
      { ...createCandidate(1), canonicalUrl: "javascript:alert(1)" },
      { ...createCandidate(2), canonicalUrl: "not-a-url" },
      { ...createCandidate(3), domain: "different.example" },
      validEmptySnippet,
    ];

    expect(guardAndShortlistCandidates(candidates)).toEqual({
      accepted: [validEmptySnippet],
      rejected: candidates.slice(0, 3).map(candidate => ({
        candidate,
        reason: "ILLEGAL_URL",
      })),
    });
  });

  it("不因同域、标题重复、空摘要或可疑路径删除候选", () => {
    const candidates = [1, 2, 3].map(index => ({
      ...createCandidate(index),
      title: "相同标题",
      canonicalUrl: `https://same.example/download/${index}`,
      domain: "same.example",
      snippet: "",
    }));

    expect(guardAndShortlistCandidates(candidates)).toEqual({
      accepted: candidates,
      rejected: [],
    });
  });

  it("不会用本地别名或词面规则拒绝 B站与菜鸟教程候选", () => {
    const candidates = [
      {
        ...createCandidate(1),
        title: "哔哩哔哩 (゜-゜)つロ 干杯~-bilibili",
        url: "https://www.bilibili.com/",
        canonicalUrl: "https://www.bilibili.com/",
        domain: "www.bilibili.com",
        snippet: "",
      },
      {
        ...createCandidate(2),
        title: "菜鸟教程",
        url: "https://www.runoob.com/",
        canonicalUrl: "https://www.runoob.com/",
        domain: "www.runoob.com",
        snippet: "",
      },
    ];

    expect(guardAndShortlistCandidates(candidates).accepted).toEqual(
      candidates,
    );
  });
});
