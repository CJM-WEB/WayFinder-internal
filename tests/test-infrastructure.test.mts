/**
 * 测试职责：冻结 WAY-33 可复用测试基础设施的确定性、取消语义与零网络边界。
 *
 * 关键约束：Fake 只返回预先配置的数据，不读取环境变量、不调用真实 Provider，
 * 且 AbortSignal 必须能取消仍处于 pending（等待中）的脚本响应。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "../packages/contracts/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAbortFixture,
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
} from "./support/test-infrastructure.mjs";

const searchRequest: ProviderSearchRequest = {
  nodeId: "python-introduction",
  query: "Python official overview",
  maxResults: 3,
  capability: "general",
  freshnessSensitive: false,
  language: "en",
};

const searchHit: NormalizedSearchHit = {
  provider: "fake-search",
  query: searchRequest.query,
  title: "Python Programming Language",
  url: "https://www.python.org/",
  canonicalUrl: "https://www.python.org/",
  domain: "www.python.org",
  snippet: "Python 官方网站。",
  providerRank: 1,
  providerScore: 1,
  rawMetadata: {},
};

const extractedPage: ExtractedPage = {
  canonicalUrl: searchHit.canonicalUrl,
  content: "Python is a programming language.",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FixedClock", () => {
  it("只按显式 advanceBy 推进，不读取真实时间", () => {
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");

    expect(clock.now()).toBe(1_767_225_600_000);
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");

    clock.advanceBy(250);

    expect(clock.now()).toBe(1_767_225_600_250);
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.250Z");
  });

  it.each(["not-a-date", Number.NaN, -1])("拒绝非法初始时间或推进量：%o", value => {
    if (typeof value === "string") {
      expect(() => createFixedClock(value)).toThrow("固定时钟时间无效");
      return;
    }

    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    expect(() => clock.advanceBy(value)).toThrow("固定时钟推进量无效");
  });
});

describe("Abort fixture", () => {
  it("为每个测试创建独立 signal，并保留稳定 AbortError 原因", () => {
    const first = createAbortFixture("取消第一次调用");
    const second = createAbortFixture("取消第二次调用");

    first.abort();

    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toMatchObject({
      name: "AbortError",
      message: "取消第一次调用",
    });
    expect(second.signal.aborted).toBe(false);
  });
});

describe("FakeLLMProvider", () => {
  it("按顺序返回固定副本、记录调用并明确报告脚本耗尽", async () => {
    const provider = new FakeLLMProvider([
      { topic: "Python" },
      new Error("脚本化 LLM 失败"),
    ]);
    const input = {
      system: "system",
      user: "Python",
      schema: { type: "object" },
    };

    const first = await provider.structured<{ topic: string }>(input);
    first.topic = "mutated";
    input.user = "mutated";

    expect(provider.id).toBe("fake-llm");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.input.user).toBe("Python");
    await expect(provider.structured(input)).rejects.toThrow("脚本化 LLM 失败");
    await expect(provider.structured(input)).rejects.toThrow(
      "FakeLLMProvider 脚本已耗尽",
    );
  });

  it("signal 已取消时不消费响应，pending 响应也能被取消", async () => {
    const deferred = createDeferred<{ topic: string }>();
    const provider = new FakeLLMProvider([
      { topic: "仍应保留" },
      deferred.promise,
    ]);
    const preAborted = createAbortFixture("调用前取消");
    preAborted.abort();

    await expect(
      provider.structured(
        { system: "system", user: "Python", schema: {} },
        preAborted.signal,
      ),
    ).rejects.toBe(preAborted.signal.reason);
    await expect(
      provider.structured<{ topic: string }>({
        system: "system",
        user: "Python",
        schema: {},
      }),
    ).resolves.toEqual({ topic: "仍应保留" });

    const duringCall = createAbortFixture("调用中取消");
    const pending = provider.structured(
      { system: "system", user: "Python", schema: {} },
      duringCall.signal,
    );
    duringCall.abort();

    await expect(pending).rejects.toBe(duringCall.signal.reason);
    deferred.resolve({ topic: "迟到结果" });
  });
});

describe("FakeSearchProvider", () => {
  it("返回隔离副本并分别记录 search 与 extract 调用", async () => {
    const provider = new FakeSearchProvider({
      searchResponses: { [searchRequest.query]: [searchHit] },
      extractResponse: [extractedPage],
    });
    const abortFixture = createAbortFixture();

    const hits = await provider.search(searchRequest, abortFixture.signal);
    const pages = await provider.extract(
      [searchHit.canonicalUrl],
      abortFixture.signal,
    );
    const firstHit = hits[0];
    if (firstHit !== undefined) {
      firstHit.rawMetadata.changed = true;
    }

    expect(provider.id).toBe("fake-search");
    expect(provider.capabilities).toEqual(["general"]);
    expect(provider.searchCalls).toEqual([
      { request: searchRequest, signal: abortFixture.signal },
    ]);
    expect(provider.extractCalls).toEqual([
      {
        canonicalUrls: [searchHit.canonicalUrl],
        signal: abortFixture.signal,
      },
    ]);
    await expect(provider.search(searchRequest)).resolves.toEqual([searchHit]);
    expect(pages).toEqual([extractedPage]);
  });

  it("拒绝未配置 Query，且取消 pending 搜索不触发网络", async () => {
    const deferred = createDeferred<readonly NormalizedSearchHit[]>();
    const provider = new FakeSearchProvider({
      searchResponses: { [searchRequest.query]: deferred.promise },
    });
    const abortFixture = createAbortFixture("取消 Search");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("测试禁止访问网络");
    });
    const pending = provider.search(searchRequest, abortFixture.signal);

    abortFixture.abort();

    await expect(pending).rejects.toBe(abortFixture.signal.reason);
    await expect(
      provider.search({ ...searchRequest, query: "未配置 Query" }),
    ).rejects.toThrow("FakeSearchProvider 未配置 Query");
    expect(fetchSpy).not.toHaveBeenCalled();
    deferred.resolve([searchHit]);
  });
});
