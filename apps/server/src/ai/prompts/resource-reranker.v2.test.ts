/** 测试职责：冻结 Resource Reranker v2 的候选身份、输出与不可信输入硬规则。 */
import { describe, expect, it } from "vitest";

import {
  RESOURCE_RERANKER_PROMPT_VERSION,
  RESOURCE_RERANKER_SYSTEM_PROMPT,
} from "./resource-reranker.v2.js";

const REQUIRED_RULE_IDS = [
  "rank_existing_candidates",
  "structured_only",
  "no_url_output",
  "bounded_scores",
  "untrusted_external_content",
  "ignore_embedded_instructions",
  "no_answer",
  "ranking_profiles",
  "evidence_only_language",
] as const;

describe("Resource Reranker v2 Prompt", () => {
  it("以新版本保存全部既有硬规则", () => {
    expect(RESOURCE_RERANKER_PROMPT_VERSION).toBe("resource-reranker.v2");
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(
        RESOURCE_RERANKER_SYSTEM_PROMPT.split(`[${ruleId}]`),
      ).toHaveLength(2);
    }
  });

  it("只允许既有 Candidate ID 与四类结构化决策字段", () => {
    expect(RESOURCE_RERANKER_SYSTEM_PROMPT).toMatch(
      /every supplied candidate exactly once/i,
    );
    expect(RESOURCE_RERANKER_SYSTEM_PROMPT).toMatch(/Never return.*URL/i);
  });
});
