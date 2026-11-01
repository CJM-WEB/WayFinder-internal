/**
 * 测试职责：冻结内部 GraphOutline 的严格形状，并证明第一阶段不会接受 searchPlan。
 */
import { describe, expect, it } from "vitest";

import {
  GraphOutlineSchema,
  GraphOutlineValidationError,
  parseGraphOutlineOutput,
} from "./graph-outline.js";

function makeOutline() {
  return {
    analysis: {
      intent: "learn",
      topic: "MySQL",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      presentationMode: "compact",
      broadSearchQueries: [],
      strategy: "plan_first",
    },
    nodes: [
      {
        id: "mysql-overview",
        title: "MySQL 概览",
        description: "解释 MySQL 的定位与核心概念。",
        nodeType: "primary",
        layer: 0,
        status: "planned",
      },
    ],
    edges: [],
  };
}

describe("GraphOutlineSchema", () => {
  it("接受不含 searchPlan 的严格 Outline", () => {
    expect(GraphOutlineSchema.parse(makeOutline())).toEqual(makeOutline());
  });

  it("拒绝模型提前生成 searchPlan 或根级未知字段", () => {
    const withSearchPlan = structuredClone(makeOutline()) as {
      nodes: Record<string, unknown>[];
    };
    withSearchPlan.nodes[0] = {
      ...withSearchPlan.nodes[0],
      searchPlan: {
        queries: ["MySQL"],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    };

    expect(GraphOutlineSchema.safeParse(withSearchPlan).success).toBe(false);
    expect(
      GraphOutlineSchema.safeParse({ ...makeOutline(), unexpected: true })
        .success,
    ).toBe(false);
  });

  it("解析失败只公开脱敏 Schema 诊断", () => {
    const sentinel = "private-unknown-field";
    let received: unknown;

    try {
      parseGraphOutlineOutput({ [sentinel]: true });
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toBeInstanceOf(GraphOutlineValidationError);
    expect(received).toMatchObject({
      diagnostic: {
        stage: "graph_outline_schema_validation",
        issueCount: expect.any(Number),
      },
    });
    expect(JSON.stringify(received)).not.toContain(sentinel);
  });
});
