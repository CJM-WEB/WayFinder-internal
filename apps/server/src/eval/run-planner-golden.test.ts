/** 测试职责：证明真实 Golden 入口缺少明确 `--live` 时会在任何外部调用前拒绝。 */
import { describe, expect, it } from "vitest";

import {
  assertPlannerGoldenLiveMode,
  encodeMarkdownText,
} from "./run-planner-golden.js";

describe("Planner Golden live guard", () => {
  it.each([
    { args: [] },
    { args: ["--dry-run"] },
    { args: ["--live", "--extra"] },
    { args: ["--", "--dry-run"] },
  ])(
    "拒绝参数 $args",
    ({ args }) => {
      expect(() => assertPlannerGoldenLiveMode(args)).toThrow(
        "Golden Eval 默认禁止真实调用",
      );
    },
  );

  it("只接受唯一 --live 参数", () => {
    expect(() => assertPlannerGoldenLiveMode(["--live"])).not.toThrow();
    expect(() =>
      assertPlannerGoldenLiveMode(["--", "--live"]),
    ).not.toThrow();
  });

  it("把模型 Markdown、HTML 与 URL 全部编码为不可执行纯文本", () => {
    const encoded = encodeMarkdownText(
      '![tracking](https://private.example)<img src="https://private.example">',
    );

    expect(encoded).not.toContain("![");
    expect(encoded).not.toContain("<img");
    expect(encoded).not.toContain("https://");
    expect(encoded).toMatch(/^&#\d+;/u);
  });
});
