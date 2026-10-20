/**
 * 测试职责：冻结不可信 Planner 输出的 Schema 收窄、错误脱敏和任务边界。
 *
 * 测试不锁定 Zod 英文文案或完整 issue 顺序，也不调用真实 LLM；这些内容既脆弱，
 * 也不能替代后续 Graph Validator 与 Golden Eval。
 */
import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";
import type { GraphPlan } from "@wayfinder/contracts";

import {
  GraphPlanValidationError,
  MAX_GRAPH_PLAN_VALIDATION_ISSUES,
  MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH,
  MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS,
  parseGraphPlanOutput,
} from "./graph-plan-parser.js";

const fixtureUrl = new URL(
  "../../../../tests/fixtures/contracts/graph-plan.valid.json",
  import.meta.url,
);

async function readValidGraphPlanFixture(): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function captureValidationError(input: unknown): GraphPlanValidationError {
  try {
    parseGraphPlanOutput(input);
  } catch (error: unknown) {
    if (error instanceof GraphPlanValidationError) {
      return error;
    }

    throw error;
  }

  throw new Error("测试输入应触发 GraphPlanValidationError");
}

describe("GraphPlan Provider 输出解析", () => {
  it("通过 GraphPlanSchema 将 unknown 收窄为 GraphPlan", async () => {
    const fixture = await readValidGraphPlanFixture();

    expect(parseGraphPlanOutput(fixture)).toEqual(fixture);
    expectTypeOf(parseGraphPlanOutput).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(parseGraphPlanOutput).returns.toEqualTypeOf<GraphPlan>();
  });

  it.each([
    '{"analysis":{},"nodes":[],"edges":[]}',
    '```json\n{"analysis":{},"nodes":[],"edges":[]}\n```',
    'Planner result: {"analysis":{},"nodes":[],"edges":[]}',
  ])("拒绝字符串并且不尝试提取 JSON：%s", input => {
    expect(() => parseGraphPlanOutput(input)).toThrow(
      GraphPlanValidationError,
    );
  });

  it("拒绝未经校验的嵌套 SearchPlan", async () => {
    const validPlan = parseGraphPlanOutput(await readValidGraphPlanFixture());
    const input = {
      ...validPlan,
      nodes: [
        {
          ...validPlan.nodes[0],
          searchPlan: {
            ...validPlan.nodes[0]?.searchPlan,
            queries: [],
          },
        },
      ],
    };

    expect(() => parseGraphPlanOutput(input)).toThrow(
      GraphPlanValidationError,
    );
  });

  it("只公开有界、脱敏且可序列化的验证诊断", async () => {
    const sensitiveValue = `private-value-${"v".repeat(200)}`;
    const sensitiveKey = `private-key-${"k".repeat(200)}`;
    const validPlan = parseGraphPlanOutput(await readValidGraphPlanFixture());
    const input = {
      ...validPlan,
      analysis: { ...validPlan.analysis, intent: sensitiveValue },
      [sensitiveKey]: sensitiveValue,
    };

    const error = captureValidationError(input);
    const serialized = JSON.stringify(error);

    expect(error).toMatchObject({
      name: "GraphPlanValidationError",
      message: "GraphPlan 输出未通过结构校验",
      kind: "schema_validation_failed",
      diagnostic: {
        stage: "graph_plan_schema_validation",
      },
    });
    expect(error.diagnostic.issueCount).toBeGreaterThan(0);
    expect(error.diagnostic.issues.length).toBeLessThanOrEqual(
      MAX_GRAPH_PLAN_VALIDATION_ISSUES,
    );
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain(sensitiveKey);
    expect(String(error)).not.toContain(sensitiveValue);
    expect("cause" in error).toBe(false);
    expect("input" in error).toBe(false);
  });

  it("截断大量 issue，并限制每条诊断公开的路径与段长度", async () => {
    const validPlan = parseGraphPlanOutput(await readValidGraphPlanFixture());
    const error = captureValidationError({
      analysis: validPlan.analysis,
      nodes: Array.from({ length: 8 }, () => ({})),
      edges: [],
    });

    expect(error.diagnostic.issueCount).toBeGreaterThan(
      error.diagnostic.issues.length,
    );
    expect(error.diagnostic.issues).toHaveLength(
      MAX_GRAPH_PLAN_VALIDATION_ISSUES,
    );
    expect(error.diagnostic.truncated).toBe(true);

    for (const issue of error.diagnostic.issues) {
      expect(issue.path.length).toBeLessThanOrEqual(
        MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS,
      );
      for (const segment of issue.path) {
        expect(segment.length).toBeLessThanOrEqual(
          MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH,
        );
      }
    }
  });

  it("不抢做 Graph 语义修复，Schema 合法的重复 ID 与悬空 Edge 原样通过", async () => {
    const validPlan = parseGraphPlanOutput(await readValidGraphPlanFixture());
    const firstNode = validPlan.nodes[0];
    expect(firstNode).toBeDefined();
    if (firstNode === undefined) {
      return;
    }

    const structurallyValidPlan = {
      ...validPlan,
      nodes: [firstNode, { ...firstNode }],
      edges: [
        {
          id: "dangling-edge",
          source: firstNode.id,
          target: "missing-node",
          type: "recommended_next" as const,
        },
      ],
    };

    expect(parseGraphPlanOutput(structurallyValidPlan)).toEqual(
      structurallyValidPlan,
    );
  });
});
