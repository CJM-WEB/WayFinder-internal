/**
 * 测试职责：冻结生产 Ranking 与 Quality Eval 共用的日期桶边界。
 * 失败路径覆盖缺失、非法和未来时间，防止异常 Provider 日期获得正分。
 */
import { describe, expect, it } from "vitest";

import { classifyFreshness } from "./freshness.js";

const REFERENCE_MS = Date.parse("2026-10-21T00:00:00.000Z");

describe("classifyFreshness", () => {
  it.each([
    ["2026-10-20T00:00:00.000Z", "within1Day"],
    ["2026-10-19T23:59:59.999Z", "within7Days"],
    ["2026-10-14T00:00:00.000Z", "within7Days"],
    ["2026-10-13T23:59:59.999Z", "within30Days"],
    ["2026-09-21T00:00:00.000Z", "within30Days"],
    ["2026-09-20T23:59:59.999Z", "within365Days"],
    ["2025-10-21T00:00:00.000Z", "within365Days"],
    ["2025-10-20T23:59:59.999Z", "older"],
    ["2026-10-21T08:00:00+08:00", "within1Day"],
    ["2026-10-14T00:00:00", "unavailable"],
    ["2026-02-30T00:00:00Z", "unavailable"],
    ["invalid", "unavailable"],
    ["2026-10-22T00:00:00.000Z", "future"],
    [null, "unavailable"],
  ] as const)("把 %s 归入 %s", (publishedAt, expected) => {
    expect(classifyFreshness(publishedAt, REFERENCE_MS)).toBe(expected);
  });

  it("拒绝非有限参考时间，避免静默生成不可复现的日期事实", () => {
    expect(() => classifyFreshness(null, Number.NaN)).toThrowError(
      "referenceMs must be finite",
    );
  });
});
