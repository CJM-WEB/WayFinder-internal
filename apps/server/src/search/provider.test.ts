/**
 * 测试职责：冻结 WAY-44 SearchProvider Port（搜索提供方端口）的最小结构。
 *
 * 关键约束：端口只消费共享的规范化内部类型，搜索与批量抽取都显式暴露
 * AbortSignal（取消信号）；Tavily 私有响应不属于此边界。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { describe, expectTypeOf, it } from "vitest";

import type { SearchProvider } from "./provider.js";

describe("SearchProvider Port", () => {
  it("暴露能力、搜索、可选批量抽取与取消信号", () => {
    expectTypeOf<SearchProvider>().toEqualTypeOf<{
      id: string;
      capabilities: SearchCapability[];
      search: (
        request: ProviderSearchRequest,
        signal: AbortSignal,
      ) => Promise<NormalizedSearchHit[]>;
      extract?: (
        canonicalUrls: string[],
        signal: AbortSignal,
      ) => Promise<ExtractedPage[]>;
    }>();
  });
});
