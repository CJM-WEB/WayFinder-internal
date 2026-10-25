/**
 * 模块职责：定义 Graph Engine（图引擎）与具体搜索服务之间的 SearchProvider Port。
 *
 * 边界约束：
 * - Provider 原始响应必须在 Adapter（适配器）内完成校验与规范化；
 * - 业务层只接收共享 Contract 定义的 NormalizedSearchHit 与 ExtractedPage；
 * - 每个外部调用都显式接收 AbortSignal，便于后续 Timeout 与全局 Deadline 统一取消。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";

export interface SearchProvider {
  id: string;
  capabilities: SearchCapability[];

  search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]>;

  extract?(
    canonicalUrls: string[],
    signal: AbortSignal,
  ): Promise<ExtractedPage[]>;
}
