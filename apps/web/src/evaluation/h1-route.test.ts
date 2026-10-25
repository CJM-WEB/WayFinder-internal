/** 测试职责：锁定 H1 Eval 的隐藏入口，防止普通或非法 URL 暴露实验模式。 */
import { describe, expect, it } from "vitest";

import { resolveH1EvaluationRoute } from "./h1-route.js";

describe("H1 evaluation route", () => {
  it.each(["", "?query=Python", "?evaluation=h2", "?evaluation=H1"])(
    "普通查询 %s 不进入 H1",
    search => {
      expect(resolveH1EvaluationRoute(search)).toBeNull();
    },
  );

  it("缺省从 Graph 条件开始", () => {
    expect(resolveH1EvaluationRoute("?evaluation=h1")).toEqual({
      initialCondition: "graph",
    });
  });

  it("只接受两个冻结的呈现条件", () => {
    expect(
      resolveH1EvaluationRoute(
        "?evaluation=h1&condition=structured-flat-list",
      ),
    ).toEqual({ initialCondition: "structured-flat-list" });
    expect(
      resolveH1EvaluationRoute("?evaluation=h1&condition=raw-query"),
    ).toBeNull();
  });
});
