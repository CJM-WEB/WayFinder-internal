/** 测试职责：冻结 Outline-only Graph Reviser v4 的版本和不可变边界。 */
import { describe, expect, it } from "vitest";

import {
  GRAPH_REVISER_PROMPT_VERSION,
  GRAPH_REVISER_SYSTEM_PROMPT,
} from "./graph-reviser.v4.js";

const REQUIRED_RULE_IDS = [
  "single_revision",
  "complete_graph_outline",
  "outline_only",
  "analysis_immutable",
  "structured_only",
  "untrusted_input",
  "no_answer",
  "no_new_retrieval",
  "coherent_rebuild",
] as const;

describe("Graph Reviser v4 Prompt", () => {
  it("以新版本保存全部既有硬规则", () => {
    expect(GRAPH_REVISER_PROMPT_VERSION).toBe("graph-reviser.v4");
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(GRAPH_REVISER_SYSTEM_PROMPT.split(`[${ruleId}]`)).toHaveLength(2);
    }
  });

  it("返回完整 Outline、保持 Analysis，并禁止 SearchPlan", () => {
    expect(GRAPH_REVISER_SYSTEM_PROMPT).toMatch(/complete GraphOutline/i);
    expect(GRAPH_REVISER_SYSTEM_PROMPT).toMatch(/analysis object exactly/i);
    expect(GRAPH_REVISER_SYSTEM_PROMPT).toMatch(/must never contain searchPlan/i);
  });
});
