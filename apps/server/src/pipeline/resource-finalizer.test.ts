/**
 * 测试职责：冻结 WAY-56 唯一 Resource Finalizer 的数量、身份与 fallback 字段语义。
 *
 * 关键约束：输出只来自输入稳定前缀，不补 Top 3；ID、canonicalUrl、rank 在当前
 * Node 内唯一；正常 Rerank 与 Heuristic fallback 最终都通过同一 ResourceSchema。
 */
import { createHash } from "node:crypto";

import {
  MAX_RETAINED_RESOURCES_PER_NODE,
  ResourceSchema,
  type ResourceCandidate,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { finalizeResources } from "./resource-finalizer.js";

function createCandidate(
  index: number,
  overrides: Partial<ResourceCandidate> = {},
): ResourceCandidate {
  const domain = `source-${index}.example`;
  return {
    candidateId: `candidate_${index}`,
    hit: {
      provider: "test-search",
      query: "resource finalizer",
      title: `Resource ${index}`,
      url: `https://${domain}/item?utm_source=provider`,
      canonicalUrl: `https://${domain}/item`,
      domain,
      snippet: `Snippet ${index}`,
      providerRank: index,
    },
    heuristicScore: 1 - index / 100,
    heuristicSignals: { providerQuality: 1 - index / 100 },
    ...overrides,
  };
}

function expectedResourceId(canonicalUrl: string): string {
  return `resource_${createHash("sha256").update(canonicalUrl).digest("hex")}`;
}

describe("finalizeResources 数量与稳定顺序", () => {
  it.each([0, 1, 2, 3])("输入 %i 项时原样保留数量，不为 Top 3 补位", count => {
    const candidates = Array.from({ length: count }, (_, index) =>
      createCandidate(index + 1),
    );

    const resources = finalizeResources(candidates, "zh-CN");

    expect(resources).toHaveLength(count);
    expect(resources.map(resource => resource.title)).toEqual(
      candidates.map(candidate => candidate.hit.title),
    );
  });

  it("稳定保留前八项并丢弃第九项，不修改输入", () => {
    const candidates = Array.from({ length: 9 }, (_, index) =>
      createCandidate(index + 1),
    );
    const snapshot = structuredClone(candidates);

    const resources = finalizeResources(candidates, "zh-CN");

    expect(MAX_RETAINED_RESOURCES_PER_NODE).toBe(8);
    expect(resources).toHaveLength(8);
    expect(resources.map(resource => resource.title)).toEqual(
      candidates.slice(0, 8).map(candidate => candidate.hit.title),
    );
    expect(candidates).toEqual(snapshot);
  });
});

describe("finalizeResources 公共字段", () => {
  it("保留正常 Rerank 字段并确定性生成 ID、domain 与连续 rank", () => {
    const first = createCandidate(1, {
      scores: { relevance: 0.9, authority: 0.8 },
      summary: "  Validated summary  ",
      whySelected: "  Validated selection reason  ",
      sourceType: "  official_docs  ",
    });
    const second = createCandidate(2, {
      hit: {
        ...createCandidate(2).hit,
        publishedAt: "2026-10-22T01:00:00Z",
      },
    });

    const resources = finalizeResources([first, second], "zh-CN");

    expect(resources[0]).toEqual({
      id: expectedResourceId(first.hit.canonicalUrl),
      title: first.hit.title,
      url: first.hit.url,
      canonicalUrl: first.hit.canonicalUrl,
      domain: first.hit.domain,
      sourceType: "official_docs",
      summary: "Validated summary",
      whySelected: "Validated selection reason",
      rank: 1,
      scores: { relevance: 0.9, authority: 0.8 },
      searchProvider: "test-search",
    });
    expect(resources[1]?.rank).toBe(2);
    expect(resources[1]?.publishedAt).toBe("2026-10-22T01:00:00Z");
    expect(resources.every(resource => ResourceSchema.safeParse(resource).success)).toBe(
      true,
    );
  });

  it("Heuristic fallback 只用 snippet、通用 sourceType 与确定性选择说明补齐", () => {
    const candidate = createCandidate(1, {
      summary: "   ",
      whySelected: "   ",
      sourceType: "   ",
    });

    const [resource] = finalizeResources([candidate], "zh-CN");

    expect(resource).toMatchObject({
      sourceType: "web",
      summary: "Snippet 1",
      whySelected:
        "该结果由搜索提供方返回，并按当前确定性排序保留。",
    });
    expect(resource).not.toHaveProperty("scores");
  });

  it("同一 canonicalUrl 在不同调用中产生相同 ID，Candidate 临时 ID 不参与身份", () => {
    const candidate = createCandidate(1);
    const renamed = { ...candidate, candidateId: "another_batch_id" };

    expect(finalizeResources([candidate], "zh-CN")[0]?.id).toBe(
      finalizeResources([renamed], "zh-CN")[0]?.id,
    );
  });

  it("只保留可靠 publishedAt，非法弱元数据不会拖垮 Resource", () => {
    const invalidDate = createCandidate(1, {
      hit: { ...createCandidate(1).hit, publishedAt: "today" },
    });
    const explicitNull = createCandidate(2, {
      hit: { ...createCandidate(2).hit, publishedAt: null },
    });

    const resources = finalizeResources(
      [invalidDate, explicitNull],
      "zh-CN",
    );

    expect(resources[0]).not.toHaveProperty("publishedAt");
    expect(resources[1]).toHaveProperty("publishedAt", null);
  });
});

describe("finalizeResources 防御性校验", () => {
  it("拒绝 retained 范围内重复 canonicalUrl", () => {
    const first = createCandidate(1);
    const duplicate = createCandidate(2, { hit: { ...first.hit } });

    expect(() => finalizeResources([first, duplicate], "zh-CN")).toThrow(
      "重复的 Resource 身份",
    );
  });

  it.each([
    ["非法 canonicalUrl", { canonicalUrl: "not-a-url" }],
    ["非 HTTP(S) canonicalUrl", { canonicalUrl: "ftp://source-1.example/item" }],
    ["canonicalUrl/domain 冲突", { domain: "other.example" }],
  ])("拒绝%s", (_name, hitOverride) => {
    const candidate = createCandidate(1);
    const invalid = {
      ...candidate,
      hit: { ...candidate.hit, ...hitOverride },
    };

    expect(() => finalizeResources([invalid], "zh-CN")).toThrow(TypeError);
  });

  it.each([
    ["非法原始 URL", { url: "javascript:alert(1)" }, {}],
    ["空 Provider", { provider: "" }, {}],
    ["越界 scores", {}, { scores: { relevance: 1.1 } }],
  ])("拒绝%s", (_name, hitOverride, candidateOverride) => {
    const candidate = createCandidate(1);
    const invalid: ResourceCandidate = {
      ...candidate,
      ...candidateOverride,
      hit: { ...candidate.hit, ...hitOverride },
    };

    expect(() => finalizeResources([invalid], "zh-CN")).toThrow();
  });

  it("空 snippet 与缺失模型摘要时使用固定中性文本", () => {
    const candidate = createCandidate(1, {
      hit: { ...createCandidate(1).hit, snippet: "" },
    });

    expect(finalizeResources([candidate], "zh-CN")[0]?.summary).toBe(
      "该搜索结果未提供可用摘要，请打开页面查看。",
    );
  });

  it("英文 Run 使用英文 fallback 且不写死具体搜索引擎", () => {
    const candidate = createCandidate(1, {
      hit: { ...createCandidate(1).hit, snippet: "" },
      whySelected: "   ",
    });

    expect(finalizeResources([candidate], "en-US")[0]).toMatchObject({
      summary:
        "This search result does not provide a usable summary. Open the page to view it.",
      whySelected:
        "This result was returned by the search provider and retained by the current deterministic ranking.",
    });
  });

  it("英文 Run 仍原样保留 Provider 的标题与摘要", () => {
    const candidate = createCandidate(1, {
      hit: {
        ...createCandidate(1).hit,
        title: "Provider 原始中文标题",
        snippet: "Provider 原始中文摘要。",
      },
    });

    expect(finalizeResources([candidate], "en-US")[0]).toMatchObject({
      title: "Provider 原始中文标题",
      summary: "Provider 原始中文摘要。",
    });
  });
});
