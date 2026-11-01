/**
 * 测试职责：冻结 WAY-48 的 URL 规范化、候选白名单投影与确定性去重语义。
 *
 * 关键约束：
 * - 只接受可解析的绝对 HTTP(S)，单项失败不能拖垮整批；
 * - canonicalUrl 与 domain 必须从原始 url 重新派生，且 rawMetadata 不得进入业务 Pipeline；
 * - canonical URL 重复时保留 first-seen，输出顺序保持稳定。
 */
import type {
  CandidateSearchHit,
  NormalizedSearchHit,
} from "@wayfinder/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import { canonicalizeAndDeduplicateCandidates } from "./canonicalize-candidates.js";

function createHit(
  overrides: Partial<NormalizedSearchHit> = {},
): NormalizedSearchHit {
  return {
    provider: "tavily",
    query: "wayfinder",
    title: "WayFinder",
    url: "https://example.com/resource",
    canonicalUrl: "https://provider.invalid/untrusted",
    domain: "provider.invalid",
    snippet: "候选摘要",
    rawMetadata: { requestId: "private" },
    ...overrides,
  };
}

describe("canonicalizeAndDeduplicateCandidates", () => {
  it("从原始 url 重新派生 canonicalUrl 和 domain，并投影白名单字段", () => {
    const input = createHit({
      url: "https://Docs.Example.COM:443/a/../docs?z=2&utm_source=x&a=1&gclid=id#section",
      publishedAt: null,
      providerRank: 2,
      providerScore: 0,
    });
    const snapshot = structuredClone(input);

    const result = canonicalizeAndDeduplicateCandidates([input]);

    expect(result).toEqual([
      {
        provider: "tavily",
        query: "wayfinder",
        title: "WayFinder",
        url: input.url,
        canonicalUrl: "https://docs.example.com/docs?a=1&z=2",
        domain: "docs.example.com",
        snippet: "候选摘要",
        publishedAt: null,
        providerRank: 2,
        providerScore: 0,
      },
    ]);
    expect(result[0]).not.toHaveProperty("rawMetadata");
    expect(input).toEqual(snapshot);
  });

  it("只删除确认的精确小写 tracking 参数并保留其他参数", () => {
    const [candidate] = canonicalizeAndDeduplicateCandidates([
      createHit({
        url: "https://example.com/page?utm_source=drop&utm_medium=drop&utm_campaign=drop&utm_term=drop&utm_content=drop&gclid=drop&UTM_SOURCE=keep&fbclid=keep",
      }),
    ]);

    expect(candidate?.canonicalUrl).toBe(
      "https://example.com/page?UTM_SOURCE=keep&fbclid=keep",
    );
  });

  it("逐项过滤相对、畸形及非 HTTP(S) URL", () => {
    const inputs = [
      createHit({ url: "/relative", title: "relative" }),
      createHit({ url: "not a url", title: "malformed" }),
      createHit({ url: "ftp://example.com/file", title: "ftp" }),
      createHit({ url: "data:text/plain,hello", title: "data" }),
      createHit({ url: "http://example.com/valid", title: "valid" }),
    ];

    expect(canonicalizeAndDeduplicateCandidates(inputs)).toEqual([
      expect.objectContaining({
        title: "valid",
        canonicalUrl: "http://example.com/valid",
      }),
    ]);
  });

  it("使用原生 URL 归一默认端口，但不合并有无尾斜杠的路径", () => {
    const result = canonicalizeAndDeduplicateCandidates([
      createHit({
        title: "without slash",
        url: "http://EXAMPLE.com:80/path",
      }),
      createHit({
        title: "with slash",
        url: "http://example.com/path/",
      }),
    ]);

    expect(result.map(candidate => candidate.canonicalUrl)).toEqual([
      "http://example.com/path",
      "http://example.com/path/",
    ]);
  });

  it("canonical URL 重复时保留首次候选且不合并后续字段", () => {
    const first = createHit({
      title: "First",
      url: "https://example.com/page?b=2&a=1&utm_campaign=first#top",
      snippet: "first snippet",
    });
    const duplicate = createHit({
      provider: "another-provider",
      title: "Second",
      url: "https://EXAMPLE.com:443/page?a=1&b=2#other",
      snippet: "longer duplicate snippet",
    });

    const result = canonicalizeAndDeduplicateCandidates([first, duplicate]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "tavily",
      title: "First",
      snippet: "first snippet",
      canonicalUrl: "https://example.com/page?a=1&b=2",
    });
  });

  it("跨域标题相同也保留全部不同 URL", () => {
    const result = canonicalizeAndDeduplicateCandidates([
      createHit({
        title: "  Same\n  Title  ",
        url: "https://first.example/article",
      }),
      createHit({
        title: "same title",
        url: "https://second.example/report",
      }),
      createHit({
        title: "Same Title!",
        url: "https://third.example/report",
      }),
    ]);

    expect(result.map(candidate => candidate.url)).toEqual([
      "https://first.example/article",
      "https://second.example/report",
      "https://third.example/report",
    ]);
  });

  it("混合非法项与重复项时保持首次保留顺序", () => {
    const result = canonicalizeAndDeduplicateCandidates([
      createHit({ title: "invalid", url: "javascript:alert(1)" }),
      createHit({ title: "Alpha", url: "https://a.example/item" }),
      createHit({
        title: "Alpha canonical duplicate",
        url: "https://a.example/item#details",
      }),
      createHit({ title: "Beta", url: "https://b.example/item" }),
      createHit({ title: " beta ", url: "https://c.example/item" }),
      createHit({ title: "Gamma", url: "https://d.example/item" }),
    ]);

    expect(result.map(candidate => candidate.title)).toEqual([
      "Alpha",
      "Beta",
      " beta ",
      "Gamma",
    ]);
  });

  it("对已经规范化的候选再次执行时保持幂等", () => {
    const once = canonicalizeAndDeduplicateCandidates([
      createHit({
        url: "https://example.com/page?z=2&utm_term=drop&a=1#fragment",
      }),
    ]);
    const normalizedInputs: NormalizedSearchHit[] = once.map(candidate => ({
      ...candidate,
      rawMetadata: {},
    }));

    expect(canonicalizeAndDeduplicateCandidates(normalizedInputs)).toEqual(
      once,
    );
  });

  it("返回共享 Contract 的 CandidateSearchHit 类型", () => {
    expectTypeOf(canonicalizeAndDeduplicateCandidates([])).toEqualTypeOf<
      CandidateSearchHit[]
    >();
  });
});
