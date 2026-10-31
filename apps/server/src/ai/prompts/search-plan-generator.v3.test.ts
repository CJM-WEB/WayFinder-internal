/** 测试职责：冻结 SearchPlan Generator v3 的单 Query 语义与安全边界。 */
import { describe, expect, it } from "vitest";

import {
  SEARCH_PLAN_GENERATOR_PROMPT_VERSION,
  SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT,
} from "./search-plan-generator.v3.js";

const REQUIRED_RULE_IDS = [
  "single_batch",
  "bundle_fields_only",
  "structured_only",
  "untrusted_input",
  "no_answer",
  "original_anchor",
  "node_goal",
  "single_query",
  "cross_node_diversity",
  "language_context",
] as const;

describe("SearchPlan Generator v3 Prompt", () => {
  it("以新版本保存全部既有硬规则", () => {
    expect(SEARCH_PLAN_GENERATOR_PROMPT_VERSION).toBe(
      "search-plan-generator.v3",
    );
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(
        SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT.split(`[${ruleId}]`),
      ).toHaveLength(2);
    }
  });

  it("每个 Node 恰好生成一条同时锚定主题与目标的 Query", () => {
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /exactly one concise query per node/i,
    );
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).not.toMatch(/one to three/i);
  });
});
