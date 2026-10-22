/**
 * 测试职责：冻结 WAY-65 从 Node Job Outcome 到最终 Node 的精确错误投影。
 * 本文件只测试单 Node，不提前实现 WAY-66 的整图匹配、Edge 或 ResultGraph 校验。
 */
import {
  GraphPlanNodeSchema,
  ResultGraphNodeSchema,
  type NodeJobOutcome,
  type ResultGraphNode,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { NodeJobError } from "../pipeline/process-node.js";
import { outcomeToResultNode } from "./outcome-to-result-node.js";

const PLAN_NODE = GraphPlanNodeSchema.parse({
  id: "node-1",
  title: "错误投影测试",
  description: "验证最终 Node 保留真实错误语义",
  nodeType: "primary",
  layer: 0,
  searchPlan: {
    queries: ["WayFinder Node error projection"],
    maxResults: 20,
    rankingProfile: "general",
    providerHints: ["general"],
  },
  status: "planned",
});

function createSuccessfulNode(
  status: "ready" | "partial",
): ResultGraphNode {
  return ResultGraphNodeSchema.parse({
    ...PLAN_NODE,
    status,
    resources: [
      {
        id: "resource-1",
        title: "WayFinder 资源",
        url: "https://example.com/wayfinder",
        canonicalUrl: "https://example.com/wayfinder",
        domain: "example.com",
        sourceType: "documentation",
        summary: "用于验证 fulfilled 分支。",
        whySelected: "与当前 Node 直接相关。",
        rank: 1,
        searchProvider: "general",
      },
    ],
    warnings: status === "partial" ? ["RERANK_FAILED"] : [],
  });
}

describe("outcomeToResultNode", () => {
  it.each(["ready", "partial"] as const)(
    "fulfilled 直接保留已经完成的 %s Node",
    status => {
      const value = createSuccessfulNode(status);
      const outcome: NodeJobOutcome = {
        status: "fulfilled",
        nodeId: PLAN_NODE.id,
        value,
      };

      expect(outcomeToResultNode(PLAN_NODE, outcome)).toBe(value);
      expect(ResultGraphNodeSchema.parse(value)).toEqual(value);
    },
  );

  it.each([
    ["SEARCH_PROVIDER_FAILED", true],
    ["SEARCH_PROVIDER_FAILED", false],
    ["EXTRACTION_FAILED", false],
    ["RERANK_FAILED", true],
    ["RERANK_FAILED", false],
    ["PLANNER_FAILED", false],
    ["INVALID_GRAPH", false],
    ["UNKNOWN", false],
  ] as const)(
    "rejected 精确保留 %s 与 retryable=%s",
    (code, retryable) => {
      const sensitiveSentinel = "不得进入最终 Node";
      const sourceError = Object.assign(new NodeJobError(code, retryable), {
        privateProviderMessage: sensitiveSentinel,
      });
      sourceError.message = sensitiveSentinel;
      sourceError.stack = sensitiveSentinel;
      const outcome: NodeJobOutcome = {
        status: "rejected",
        nodeId: PLAN_NODE.id,
        error: sourceError,
      };

      const result = outcomeToResultNode(PLAN_NODE, outcome);

      expect(result).toEqual({
        ...PLAN_NODE,
        status: "failed",
        resources: [],
        warnings: [],
        error: { code, retryable },
      });
      expect(ResultGraphNodeSchema.parse(result)).toEqual(result);
      if (result.status !== "failed") {
        throw new TypeError("rejected Outcome 必须生成 failed Node");
      }
      expect(result.error).not.toBe(sourceError);
      expect(Reflect.ownKeys(result.error)).toEqual(["code", "retryable"]);
      expect(Object.values(result.error)).not.toContain(sensitiveSentinel);
      expect(result).not.toHaveProperty("error.privateProviderMessage");
      expect(result).not.toHaveProperty("error.message");
      expect(result).not.toHaveProperty("error.stack");
      expect(result).not.toHaveProperty("error.cause");
    },
  );

  it("只有 timed_out 生成 RUN_DEADLINE_EXCEEDED，并固定为可重试", () => {
    const outcome: NodeJobOutcome = {
      status: "timed_out",
      nodeId: PLAN_NODE.id,
      error: {
        code: "RUN_DEADLINE_EXCEEDED",
        retryable: true,
      },
    };

    const result = outcomeToResultNode(PLAN_NODE, outcome);

    expect(result).toEqual({
      ...PLAN_NODE,
      status: "failed",
      resources: [],
      warnings: [],
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
    expect(ResultGraphNodeSchema.parse(result)).toEqual(result);
  });

  it("拒绝用 fulfilled 包装 failed Node 绕过失败分支", () => {
    const failedValue = ResultGraphNodeSchema.parse({
      ...PLAN_NODE,
      status: "failed",
      resources: [],
      warnings: [],
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
    const outcome: NodeJobOutcome = {
      status: "fulfilled",
      nodeId: PLAN_NODE.id,
      value: failedValue,
    };

    expect(() => outcomeToResultNode(PLAN_NODE, outcome)).toThrow(
      new TypeError("fulfilled Node job 不能携带 failed Node"),
    );
  });
});
