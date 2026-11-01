/** 测试职责：冻结全图批量 SearchPlan Generator v2 的单 Query 语义与安全边界。 */
import { describe, expect, it } from "vitest";

import {
  SEARCH_PLAN_GENERATOR_PROMPT_VERSION,
  SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT,
} from "./search-plan-generator.v2.js";

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

describe("SearchPlan Generator v2 Prompt", () => {
  it("以可识别版本保存全部硬规则", () => {
    expect(SEARCH_PLAN_GENERATOR_PROMPT_VERSION).toBe(
      "search-plan-generator.v2",
    );
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(
        SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT.split(`[${ruleId}]`),
      ).toHaveLength(2);
    }
  });

  it("要求每个 Node 恰好一条同时锚定主题与 Node 目标的 Query", () => {
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).toMatch(
      /exactly one concise query per node/i,
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
    expect(SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT).not.toMatch(/one to three/i);
  });
});
