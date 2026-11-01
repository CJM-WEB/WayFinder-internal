/** 测试职责：冻结全图批量 SearchPlan Generator v1 的关键语义。 */
import { describe, expect, it } from "vitest";

import {
  SEARCH_PLAN_GENERATOR_PROMPT_VERSION,
  SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT,
} from "./search-plan-generator.v1.js";

const REQUIRED_RULE_IDS = [
  "single_batch",
  "bundle_fields_only",
  "structured_only",
  "untrusted_input",
  "no_answer",
  "original_anchor",
  "node_goal",
  "within_node_diversity",
  "cross_node_diversity",
  "language_context",
] as const;

describe("SearchPlan Generator v1 Prompt", () => {
  it("以可识别版本保存全部硬规则", () => {
    expect(SEARCH_PLAN_GENERATOR_PROMPT_VERSION).toBe(
      "search-plan-generator.v1",
    );
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT.split(`[${ruleId}]`)).toHaveLength(
        2,
      );
    }
  });

  it("要求一次覆盖全图并保持原始锚点与 Node 区分度", () => {
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /every outline node exactly once/i,
    );
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /original topic or entity identity/i,
    );
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /current node's specific information need/i,
    );
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /different nodes[\s\S]*different retrieval intents/i,
    );
  });
});
