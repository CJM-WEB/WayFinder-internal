/**
 * 测试职责：冻结 WAY-44 V0 Provider Selector（提供方选择器）的确定性行为。
 *
 * V0 只有一个受控 Search 出口；providerHints 仍必须显式传入且不能为空，
 * 防止调用方把缺失提示静默解释为自动选择。
 */
import type {
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import type { SearchProvider } from "./provider.js";
import { selectSearchProvider } from "./router.js";

function createSearchProvider(): SearchProvider {
  return {
    id: "serpapi_bing",
    capabilities: ["general"],
    async search(
      _request: ProviderSearchRequest,
      signal: AbortSignal,
    ): Promise<NormalizedSearchHit[]> {
      signal.throwIfAborted();
      return [];
    },
  };
}

describe("selectSearchProvider", () => {
  it("将显式 providerHints 确定性解析到唯一 Search Provider", () => {
    const searchProvider = createSearchProvider();

    const selected = selectSearchProvider({
      providerHints: ["general"],
      searchProvider,
    });

    expect(selected).toBe(searchProvider);
  });

  it("拒绝空 providerHints，避免产生隐式默认语义", () => {
    expect(() =>
      selectSearchProvider({
        providerHints: [],
        searchProvider: createSearchProvider(),
      }),
    ).toThrow("providerHints 不能为空");
  });

  it("在类型层要求调用方提供 providerHints", () => {
    const searchProvider = createSearchProvider();

    // @ts-expect-error WAY-44 要求 providerHints 必填，不能只依赖隐式默认 Provider。
    const invalidInput: Parameters<typeof selectSearchProvider>[0] = {
      searchProvider,
    };

    expect(invalidInput).toEqual({ searchProvider });
  });

  it("只接受共享 Contract 中定义的能力提示", () => {
    const hints: SearchCapability[] = ["general", "code"];

    expect(
      selectSearchProvider({
        providerHints: hints,
        searchProvider: createSearchProvider(),
      }).id,
    ).toBe("serpapi_bing");
  });
});
