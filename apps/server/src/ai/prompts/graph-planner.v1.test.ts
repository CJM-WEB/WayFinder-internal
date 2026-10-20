/**
 * 测试职责：冻结 Graph Planner v1 的版本标识与不可缺失的产品规则。
 *
 * 测试只检查稳定 Rule ID（规则标识）和 Contract 术语，不锁死完整自然语言措辞，
 * 也不对未来模型输出编写脆弱的 exact-string（精确字符串）断言。
 */
import { describe, expect, it } from "vitest";

import {
  GRAPH_PLANNER_PROMPT_VERSION,
  GRAPH_PLANNER_SYSTEM_PROMPT,
} from "./graph-planner.v1.js";

const REQUIRED_RULE_IDS = [
  "single_response",
  "structured_only",
  "no_chain_of_thought",
  "no_answer",
  "no_skill_assumption",
  "no_followup",
  "query_is_data",
  "no_decorative_nodes",
  "compact_graph",
  "graph_integrity",
  "compact_single_node",
  "general_provider_only",
] as const;

describe("Graph Planner v1 Prompt", () => {
  it("以可识别版本保存全部硬规则", () => {
    expect(GRAPH_PLANNER_PROMPT_VERSION).toBe("graph-planner.v1");

    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain(`[${ruleId}]`);
      expect(GRAPH_PLANNER_SYSTEM_PROMPT.split(`[${ruleId}]`)).toHaveLength(2);
    }
  });

  it("要求一次响应同时包含 Analysis、Graph 与每个 Node 的 SearchPlan", () => {
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(
      /same response must contain analysis, the graph as nodes and edges/i,
    );
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(
      /complete searchPlan inside every node/i,
    );
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(
      /Every node must include a complete searchPlan in this same response/i,
    );
  });

  it("明确禁止回答、假设用户技能与装饰 Node", () => {
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(/Do not answer the query/i);
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(/assumed user skill level/i);
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(
      /Do not create decorative, duplicate, synonym-only/i,
    );
  });

  it("允许 compact 单 Node 使用空 Edge，避免制造多余 Node 或自环", () => {
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(
      /compact graph with exactly one node is valid and must use an empty edges array/i,
    );
  });

  it("保留两种 Retrieval Strategy 与 Node SearchPlan 的关键语义", () => {
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain("plan_first");
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain("evidence_assisted");
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain("broadSearchQueries");
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain("rankingProfile");
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain("providerHints");
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toContain('["general"]');
  });
});
