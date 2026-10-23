/**
 * 模块职责：解析仅供内部评估使用的 H1 页面入口。
 *
 * 边界：该入口只存在于 URL Query，不进入正常产品导航，也不扩张公共 PresentationMode。
 */
export type H1EvaluationCondition = "graph" | "structured-flat-list";

export type H1EvaluationRoute = Readonly<{
  initialCondition: H1EvaluationCondition;
}>;

/** 未提供 condition 时从 Graph 条件开始；非法值直接回到正常产品，避免猜测实验条件。 */
export function resolveH1EvaluationRoute(
  search: string,
): H1EvaluationRoute | null {
  const parameters = new URLSearchParams(search);
  if (parameters.get("evaluation") !== "h1") return null;

  const condition = parameters.get("condition");
  if (condition === null || condition === "graph") {
    return { initialCondition: "graph" };
  }
  if (condition === "structured-flat-list") {
    return { initialCondition: condition };
  }

  return null;
}
