/**
 * 测试职责：冻结 WAY-52 Selective Extract（选择性抽取）的预算、回退与取消边界。
 *
 * 关键约束：只调用粗排前五个 canonicalUrl；普通失败保留 Candidate/snippet 并给出
 * EXTRACTION_FAILED；用户取消和 Run Deadline 的 reason 必须原样向上传播。
 */
import type {
  ExtractedPage,
  ResourceCandidate,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SearchProvider } from "../search/provider.js";
import {
  extractCandidatesSelectively,
  MAX_EXTRACT_CANDIDATES_PER_NODE,
} from "./selective-extract.js";

function createCandidate(index: number): ResourceCandidate {
  return {
    candidateId: `candidate_${index}`,
    hit: {
      provider: "test-provider",
      query: "TypeScript documentation",
      title: `Candidate ${index}`,
      url: `https://example.com/${index}`,
      canonicalUrl: `https://example.com/${index}`,
      domain: "example.com",
      snippet: `Safe search snippet ${index}`,
      providerRank: index,
    },
    heuristicScore: 1 - index / 10,
    heuristicSignals: { providerQuality: 1 - index / 10 },
  };
}

function createProvider(
  extract: NonNullable<SearchProvider["extract"]>,
): SearchProvider {
  return {
    id: "test-provider",
    capabilities: ["general"],
    search: vi.fn(),
    extract,
  };
}

function createPages(canonicalUrls: readonly string[]): ExtractedPage[] {
  return canonicalUrls.map(canonicalUrl => ({
    canonicalUrl,
    content: `Extracted content for ${canonicalUrl}`,
  }));
}

describe("extractCandidatesSelectively", () => {
  it("只按粗排顺序抽取前五个 URL，并传递同一个 Run Signal", async () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(index + 1),
    );
    const candidatesSnapshot = structuredClone(candidates);
    const controller = new AbortController();
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => createPages([...canonicalUrls].reverse()),
    );

    const outcome = await extractCandidatesSelectively({
      candidates,
      provider: createProvider(extract),
      signal: controller.signal,
    });

    const expectedUrls = candidates
      .slice(0, MAX_EXTRACT_CANDIDATES_PER_NODE)
      .map(candidate => candidate.hit.canonicalUrl);
    expect(MAX_EXTRACT_CANDIDATES_PER_NODE).toBe(5);
    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(expectedUrls, controller.signal);
    expect(outcome).toEqual({
      pages: createPages(expectedUrls),
      warnings: [],
    });
    expect(candidates).toEqual(candidatesSnapshot);
  });

  it("候选不足三项时只抽取现有 URL，不用低质量结果补齐", async () => {
    const candidates = [createCandidate(1), createCandidate(2)];
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => createPages(canonicalUrls),
    );

    const outcome = await extractCandidatesSelectively({
      candidates,
      provider: createProvider(extract),
      signal: new AbortController().signal,
    });

    expect(extract.mock.calls[0]?.[0]).toEqual(
      candidates.map(candidate => candidate.hit.canonicalUrl),
    );
    expect(outcome.warnings).toEqual([]);
  });

  it("缺失项和空正文保留其他成功页面，并标记 EXTRACTION_FAILED", async () => {
    const candidates = [
      createCandidate(1),
      createCandidate(2),
      createCandidate(3),
    ];
    const candidatesSnapshot = structuredClone(candidates);
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async () => [
        {
          canonicalUrl: candidates[2]!.hit.canonicalUrl,
          content: "Useful page content",
        },
        {
          canonicalUrl: candidates[1]!.hit.canonicalUrl,
          content: "   ",
        },
      ],
    );

    const outcome = await extractCandidatesSelectively({
      candidates,
      provider: createProvider(extract),
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      pages: [
        {
          canonicalUrl: candidates[2]!.hit.canonicalUrl,
          content: "Useful page content",
        },
      ],
      warnings: ["EXTRACTION_FAILED"],
    });
    expect(candidates).toEqual(candidatesSnapshot);
    expect(candidates.map(candidate => candidate.hit.snippet)).toEqual([
      "Safe search snippet 1",
      "Safe search snippet 2",
      "Safe search snippet 3",
    ]);
  });

  it("普通整批失败或 Provider 不支持 Extract 时保留候选并返回 Warning", async () => {
    const candidates = [createCandidate(1)];
    const failingProvider = createProvider(async () => {
      throw new Error("provider detail must not escape");
    });
    const providerWithoutExtract: SearchProvider = {
      id: "search-only",
      capabilities: ["general"],
      search: vi.fn(),
    };

    await expect(
      extractCandidatesSelectively({
        candidates,
        provider: failingProvider,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      pages: [],
      warnings: ["EXTRACTION_FAILED"],
    });
    await expect(
      extractCandidatesSelectively({
        candidates,
        provider: providerWithoutExtract,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      pages: [],
      warnings: ["EXTRACTION_FAILED"],
    });
  });

  it("未知、重复或空白后重复的 URL 不做猜测，整批降级并返回 Warning", async () => {
    const candidates = [createCandidate(1), createCandidate(2)];

    for (const pages of [
      [
        {
          canonicalUrl: "https://unrequested.example/page",
          content: "Unexpected",
        },
      ],
      [
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "First",
        },
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "Duplicate",
        },
      ],
      [
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "   ",
        },
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "Must not replace the blank duplicate",
        },
      ],
      [
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "   ",
        },
        {
          canonicalUrl: candidates[0]!.hit.canonicalUrl,
          content: "\n",
        },
      ],
    ]) {
      await expect(
        extractCandidatesSelectively({
          candidates,
          provider: createProvider(async () => pages),
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        pages: [],
        warnings: ["EXTRACTION_FAILED"],
      });
    }
  });

  it("没有候选时不调用 Provider，也不伪造 partial Warning", async () => {
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>();

    await expect(
      extractCandidatesSelectively({
        candidates: [],
        provider: createProvider(extract),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ pages: [], warnings: [] });
    expect(extract).not.toHaveBeenCalled();
  });

  it.each(["用户取消", "Run Deadline"])(
    "%s reason 在调用前原样传播",
    async label => {
      const reason = new Error(label);
      const controller = new AbortController();
      controller.abort(reason);
      const extract = vi.fn<NonNullable<SearchProvider["extract"]>>();

      await expect(
        extractCandidatesSelectively({
          candidates: [createCandidate(1)],
          provider: createProvider(extract),
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(extract).not.toHaveBeenCalled();
    },
  );

  it.each(["用户取消", "Run Deadline"])(
    "%s reason 在 Extract 进行中原样传播",
    async label => {
      const reason = new Error(label);
      const controller = new AbortController();
      const provider = createProvider((_canonicalUrls, signal) =>
        new Promise<ExtractedPage[]>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      );
      const pending = extractCandidatesSelectively({
        candidates: [createCandidate(1)],
        provider,
        signal: controller.signal,
      });

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    },
  );

  it("Provider 忽略取消并返回成功时仍传播 Run reason", async () => {
    const reason = new Error("RUN_DEADLINE_EXCEEDED");
    const controller = new AbortController();
    const provider = createProvider(async canonicalUrls => {
      controller.abort(reason);
      return createPages(canonicalUrls);
    });

    await expect(
      extractCandidatesSelectively({
        candidates: [createCandidate(1)],
        provider,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
