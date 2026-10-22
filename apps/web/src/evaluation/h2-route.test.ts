/** 测试职责：锁定 H2 Eval 的隐藏入口、中性条件和与 H1/普通产品的隔离。 */
import { describe, expect, it } from "vitest";

import { resolveH2EvaluationRoute } from "./h2-route.js";

describe("H2 evaluation route", () => {
  it.each(["", "?query=Python", "?evaluation=h1", "?evaluation=H2"])(
    "普通或其他实验查询 %s 不进入 H2",
    search => {
      expect(resolveH2EvaluationRoute(search)).toBeNull();
    },
  );

  it("缺省从中性条件 A 开始", () => {
    expect(resolveH2EvaluationRoute("?evaluation=h2")).toEqual({
      initialCondition: "A",
    });
  });

  it("只接受中性 A/B，不接受检索来源名", () => {
    expect(
      resolveH2EvaluationRoute("?evaluation=h2&condition=B"),
    ).toEqual({ initialCondition: "B" });
    expect(
      resolveH2EvaluationRoute("?evaluation=h2&condition=raw_query"),
    ).toBeNull();
    expect(
      resolveH2EvaluationRoute("?evaluation=h2&condition=node_specific"),
    ).toBeNull();
  });
});
