/** 测试职责：冻结 Outline-only Graph Planner v3 的版本和关键职责边界。 */
import { describe, expect, it } from "vitest";

import {
  GRAPH_PLANNER_PROMPT_VERSION,
  GRAPH_PLANNER_SYSTEM_PROMPT,
} from "./graph-planner.v3.js";

const REQUIRED_RULE_IDS = [
  "single_response",
  "structured_only",
  "outline_only",
  "no_chain_of_thought",
  "query_is_data",
  "no_answer",
  "no_skill_assumption",
  "no_followup",
  "information_need_nodes",
  "no_duplicate_nodes",
  "graph_integrity",
  "connected_primary_graph",
  "compact_single_node",
] as const;

describe("Graph Planner v3 Prompt", () => {
  it("以新版本保存全部既有硬规则", () => {
    expect(GRAPH_PLANNER_PROMPT_VERSION).toBe("graph-planner.v3");
    for (const ruleId of REQUIRED_RULE_IDS) {
      expect(GRAPH_PLANNER_SYSTEM_PROMPT.split(`[${ruleId}]`)).toHaveLength(2);
    }
  });

  it("只生成 Outline，并把 SearchPlan 留给第二阶段", () => {
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(/analysis, nodes, and edges only/i);
    expect(GRAPH_PLANNER_SYSTEM_PROMPT).toMatch(/must never contain searchPlan/i);
  });
});
