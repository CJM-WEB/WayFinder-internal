/**
 * 模块职责：为生产 Ranking 与 Quality Eval 提供唯一的确定性日期桶定义。
 * 外部日期一律先按公共 Resource 的带时区 ISO datetime 规则校验；缺失、非法和
 * 未来时间不会获得正向新鲜度分数，调用方也不得从网页文本补写日期。
 */
import { ResourceSchema } from "@wayfinder/contracts";

export type FreshnessBucket =
  | "unavailable"
  | "future"
  | "within1Day"
  | "within7Days"
  | "within30Days"
  | "within365Days"
  | "older";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 只分类日期事实，不计算产品分数或质量结论。 */
export function classifyFreshness(
  publishedAt: string | null | undefined,
  referenceMs: number,
): FreshnessBucket {
  if (!Number.isFinite(referenceMs)) {
    throw new TypeError("referenceMs must be finite");
  }
  if (publishedAt == null) return "unavailable";

  // 复用公共 Resource Contract，禁止在业务层维护第二份日期格式 Schema。
  const parsedPublishedAt = ResourceSchema.shape.publishedAt.safeParse(
    publishedAt,
  );
  if (!parsedPublishedAt.success || parsedPublishedAt.data == null) {
    return "unavailable";
  }

  const ageMs = referenceMs - Date.parse(parsedPublishedAt.data);
  if (ageMs < 0) return "future";
  if (ageMs <= DAY_MS) return "within1Day";
  if (ageMs <= 7 * DAY_MS) return "within7Days";
  if (ageMs <= 30 * DAY_MS) return "within30Days";
  if (ageMs <= 365 * DAY_MS) return "within365Days";
  return "older";
}
