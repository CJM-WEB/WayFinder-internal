/**
 * 测试职责：冻结 WAY-55 的精确 Domain Cap、稳定子序列与“不为凑数补齐”语义。
 *
 * 关键约束：Diversity 不得修改既有质量/安全顺序，不得猜测组织归属或 sourceType，
 * 也不得让非法 URL/domain 绕过分组边界。
 */
import type { ResourceCandidate } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  applySourceDiversity,
  MAX_CANDIDATES_PER_DOMAIN,
} from "./diversity.js";

function createCandidate(
  id: string,
  domain: string,
  overrides: Partial<ResourceCandidate> = {},
): ResourceCandidate {
  return {
    candidateId: id,
    hit: {
      provider: "test-search",
      query: "diversity query",
      title: `Resource ${id}`,
      url: `https://${domain}/${id}`,
      canonicalUrl: `https://${domain}/${id}`,
      domain,
      snippet: `Snippet ${id}`,
      providerRank: Number.parseInt(id.replace(/\D/gu, ""), 10) || 1,
    },
    heuristicScore: 0.9,
    heuristicSignals: { providerQuality: 0.9 },
    ...overrides,
  };
}

describe("applySourceDiversity Domain Cap", () => {
  it("每个精确 domain 最多保留两个，并保持幸存者相对顺序", () => {
    const candidates = [
      createCandidate("a1", "a.example"),
      createCandidate("a2", "a.example"),
      createCandidate("a3", "a.example"),
      createCandidate("b1", "b.example"),
      createCandidate("a4", "a.example"),
      createCandidate("c1", "c.example"),
    ];

    const result = applySourceDiversity(candidates);

    expect(MAX_CANDIDATES_PER_DOMAIN).toBe(2);
    expect(result.map(candidate => candidate.candidateId)).toEqual([
      "a1",
      "a2",
      "b1",
      "c1",
    ]);
    expect(result).toEqual([
      candidates[0],
      candidates[1],
      candidates[3],
      candidates[5],
    ]);
  });

  it("全部同域时只返回前两个，不为 Top 3 回捞或生成占位项", () => {
    const candidates = [
      createCandidate("a1", "a.example"),
      createCandidate("a2", "a.example"),
      createCandidate("a3", "a.example"),
    ];

    expect(
      applySourceDiversity(candidates).map(candidate => candidate.candidateId),
    ).toEqual(["a1", "a2"]);
  });

  it("News 顺序存在其他域时，过滤第三个同域结果而保留多域候选", () => {
    const candidates = [
      createCandidate("a1", "news-a.example"),
      createCandidate("a2", "news-a.example"),
      createCandidate("a3", "news-a.example"),
      createCandidate("b1", "news-b.example"),
      createCandidate("c1", "news-c.example"),
    ];
    const result = applySourceDiversity(candidates);
    const leadingDomains = new Set(
      result.slice(0, 3).map(candidate => candidate.hit.domain),
    );

    expect(result.map(candidate => candidate.candidateId)).toEqual([
      "a1",
      "a2",
      "b1",
      "c1",
    ]);
    expect(leadingDomains.size).toBeGreaterThanOrEqual(2);
  });

  it("完整 hostname 精确分组，不猜测子域或组织归属", () => {
    const candidates = [
      createCandidate("root1", "example.com"),
      createCandidate("root2", "example.com"),
      createCandidate("root3", "example.com"),
      createCandidate("news1", "news.example.com"),
      createCandidate("www1", "www.example.com"),
    ];

    expect(
      applySourceDiversity(candidates).map(candidate => candidate.candidateId),
    ).toEqual(["root1", "root2", "news1", "www1"]);
  });
});

describe("applySourceDiversity 数据边界", () => {
  it("Knowledge/Shopping 已有 sourceType 原样保留，缺失时不推断", () => {
    const candidates = [
      createCandidate("knowledge1", "docs.example", {
        sourceType: "official_docs",
      }),
      createCandidate("shopping1", "review.example", {
        sourceType: "professional_review",
      }),
      createCandidate("unknown1", "community.example"),
    ];

    const result = applySourceDiversity(candidates);

    expect(result[0]).toBe(candidates[0]);
    expect(result[1]).toBe(candidates[1]);
    expect(result[2]).toBe(candidates[2]);
    expect(result.map(candidate => candidate.sourceType)).toEqual([
      "official_docs",
      "professional_review",
      undefined,
    ]);
    expect(result[2]).not.toHaveProperty("sourceType");
  });

  it("同时适用于 Rerank 成功与 Heuristic fallback 形状且不修改输入", () => {
    const reranked = createCandidate("ranked1", "a.example", {
      scores: { relevance: 0.9 },
      summary: "Validated summary",
      whySelected: "Validated selection reason",
    });
    const fallback = createCandidate("fallback1", "b.example");
    const candidates = [reranked, fallback];
    const snapshot = structuredClone(candidates);

    const first = applySourceDiversity(candidates);
    const second = applySourceDiversity(candidates);

    expect(first).toEqual(candidates);
    expect(second).toEqual(first);
    expect(first[0]).toBe(reranked);
    expect(first[1]).toBe(fallback);
    expect(candidates).toEqual(snapshot);
  });

  it("空数组与单 Candidate 保持自然数量", () => {
    const single = createCandidate("single1", "single.example");

    expect(applySourceDiversity([])).toEqual([]);
    expect(applySourceDiversity([single])).toEqual([single]);
  });

  it.each([
    ["非法 URL", { canonicalUrl: "not-a-url" }],
    ["非 HTTP(S)", { canonicalUrl: "ftp://example.com/file" }],
    ["domain 冲突", { canonicalUrl: "https://other.example/item" }],
    ["非规范小写 domain", { domain: "EXAMPLE.COM" }],
  ])("拒绝%s，不能让不可信字段操纵分组", (_name, hitOverride) => {
    const candidate = createCandidate("invalid1", "example.com");
    const invalid: ResourceCandidate = {
      ...candidate,
      hit: { ...candidate.hit, ...hitOverride },
    };

    expect(() => applySourceDiversity([invalid])).toThrow(TypeError);
  });
});
