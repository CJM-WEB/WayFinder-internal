/**
 * 模块职责：把 Planner（规划器）给出的 Provider Hint（提供方能力提示）
 * 映射为本次搜索使用的 SearchProvider。
 *
 * V0 只有一个受控 Search 出口；保留显式 Selector（选择器）边界，是为了让业务
 * Pipeline 不直接依赖 SerpAPI，同时为以后替换 Provider 保留稳定注入点。
 */
import type { SearchCapability } from "@wayfinder/contracts";

import type { SearchProvider } from "./provider.js";

export type SelectSearchProviderInput = {
  /** 空数组不是“自动选择”的别名，调用方必须提供经过 Contract 校验的提示。 */
  providerHints: readonly SearchCapability[];
  /** 使用通用依赖表达 V0 的唯一选择，避免业务层绑定具体 Provider 名称。 */
  searchProvider: SearchProvider;
};

export function selectSearchProvider({
  providerHints,
  searchProvider,
}: SelectSearchProviderInput): SearchProvider {
  if (providerHints.length === 0) {
    throw new RangeError("providerHints 不能为空");
  }

  return searchProvider;
}
