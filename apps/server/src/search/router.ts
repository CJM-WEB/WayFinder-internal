/**
 * 模块职责：把 Planner（规划器）给出的 Provider Hint（提供方能力提示）
 * 映射为本次搜索使用的 SearchProvider。
 *
 * V0 只有 Tavily 一个受控出口；保留显式 Selector（选择器）边界，是为了让业务
 * Pipeline 不直接依赖 Tavily，同时避免提前实现多 Provider Router（多提供方路由器）。
 */
import type { SearchCapability } from "@wayfinder/contracts";

import type { SearchProvider } from "./provider.js";

export type SelectSearchProviderInput = {
  /** 空数组不是“自动选择”的别名，调用方必须提供经过 Contract 校验的提示。 */
  providerHints: readonly SearchCapability[];
  /** 使用具名依赖表达 V0 的唯一选择，避免依赖数组顺序或 Provider 私有字段。 */
  tavilyProvider: SearchProvider;
};

export function selectSearchProvider({
  providerHints,
  tavilyProvider,
}: SelectSearchProviderInput): SearchProvider {
  if (providerHints.length === 0) {
    throw new RangeError("providerHints 不能为空");
  }

  return tavilyProvider;
}
