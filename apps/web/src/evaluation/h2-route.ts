/**
 * 模块职责：解析只供本地 H2 Retrieval（检索）评估使用的隐藏页面入口。
 *
 * 边界：条件只使用中性 A/B；非法参数回到普通产品，且不扩张公开路由或 PresentationMode。
 */
import type { H2EvaluationConditionId } from "@wayfinder/contracts";

export type H2EvaluationRoute = Readonly<{
  initialCondition: H2EvaluationConditionId;
}>;

export function resolveH2EvaluationRoute(
  search: string,
): H2EvaluationRoute | null {
  const parameters = new URLSearchParams(search);
  if (parameters.get("evaluation") !== "h2") return null;

  const condition = parameters.get("condition");
  if (condition === null || condition === "A") {
    return { initialCondition: "A" };
  }
  if (condition === "B") {
    return { initialCondition: "B" };
  }

  return null;
}
