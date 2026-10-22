/**
 * 测试职责：冻结 WAY-66 的整图一一映射、partial 派生与根 Contract 门禁。
 * Contract 包自身已穷举字段级规则；这里每类只保留一个集成哨兵，避免重复测试 Zod。
 */
import {
  GraphPlanSchema,
  ResultGraphNodeSchema,
  ResultGraphSchema,
  type GraphPlan,
  type NodeJobOutcome,
  type ResultGraph,
  type ResultGraphNode,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  buildResultGraph,
  type BuildResultGraphInput,
} from "./build-result-graph.js";

const ANALYSIS = {
  intent: "learn",
  topic: "TypeScript",
  freshnessSensitive: false,
  ambiguityLevel: "low",
  broadSearchQueries: [],
  strategy: "plan_first",
  presentationMode: "graph",
} as const;

const QUERY: ResultGraph["query"] = {
  raw: "学习 TypeScript",
  normalized: "学习 typescript",
  language: "zh-CN",
};

const META: BuildResultGraphInput["meta"] = {
  createdAt: "2026-10-22T08:00:00Z",
  providersUsed: ["tavily"],
  timingMs: { total: 180 },
};

function createPlan(nodeIds: readonly string[] = ["node-a"]): GraphPlan {
  return GraphPlanSchema.parse({
    analysis: ANALYSIS,
    nodes: nodeIds.map((id, index) => ({
      id,
      title: `节点 ${id}`,
      description: `处理 ${id}`,
      nodeType: index === 0 ? "primary" : "related",
      layer: index,
      status: "planned",
      searchPlan: {
        queries: [`query ${id}`],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    })),
    edges: nodeIds.slice(1).map((id, index) => ({
      id: `edge-${index + 1}`,
      source: nodeIds[index]!,
      target: id,
      type: "recommended_next",
    })),
  });
}

function createResource(id: string, rank = 1) {
  return {
    id,
    title: `资源 ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    domain: "example.com",
    sourceType: "official",
    summary: `${id} 摘要`,
    whySelected: `${id} 与节点相关`,
    rank,
    searchProvider: "tavily",
  };
}

function createSuccessfulNode(
  plan: GraphPlan,
  nodeId: string,
  status: "ready" | "partial" = "ready",
): ResultGraphNode {
  const planNode = plan.nodes.find(node => node.id === nodeId);
  if (planNode === undefined) {
    throw new TypeError(`测试计划缺少 Node：${nodeId}`);
  }

  return ResultGraphNodeSchema.parse({
    ...planNode,
    status,
    resources: [createResource(`resource-${nodeId}`)],
    warnings: status === "partial" ? ["RERANK_FAILED"] : [],
  });
}

function fulfilled(
  nodeId: string,
  value: ResultGraphNode,
): NodeJobOutcome {
  return { status: "fulfilled", nodeId, value };
}

function timedOut(nodeId: string): NodeJobOutcome {
  return {
    status: "timed_out",
    nodeId,
    error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
  };
}

function createInput(
  plan: GraphPlan,
  outcomes: readonly NodeJobOutcome[],
  overrides: Partial<BuildResultGraphInput> = {},
): BuildResultGraphInput {
  return {
    runId: "run-66",
    query: QUERY,
    plan,
    outcomes,
    meta: META,
    ...overrides,
  };
}

describe("buildResultGraph", () => {
  it("按计划顺序一一映射乱序 Outcome，并保留 analysis、edges 与完整根结构", () => {
    const plan = createPlan(["node-a", "node-b", "node-c"]);
    const outcomes: readonly NodeJobOutcome[] = [
      {
        status: "rejected",
        nodeId: "node-c",
        error: Object.assign(new Error("provider private detail"), {
          code: "SEARCH_PROVIDER_FAILED" as const,
          retryable: true,
        }),
      },
      fulfilled("node-a", createSuccessfulNode(plan, "node-a")),
      fulfilled("node-b", createSuccessfulNode(plan, "node-b", "partial")),
    ];

    const result = buildResultGraph(createInput(plan, outcomes));

    expect(result.graph.nodes.map(node => [node.id, node.status])).toEqual([
      ["node-a", "ready"],
      ["node-b", "partial"],
      ["node-c", "failed"],
    ]);
    expect(result.analysis).toEqual(plan.analysis);
    expect(result.graph.edges).toEqual(plan.edges);
    expect(result.meta.partial).toBe(true);
    expect(ResultGraphSchema.parse(result)).toEqual(result);
  });

  it.each([
    ["全部 ready", ["ready", "ready"], false],
    ["包含 partial", ["ready", "partial"], true],
  ] as const)("%s 时派生 meta.partial=%s", (_name, statuses, expected) => {
    const plan = createPlan(["node-a", "node-b"]);
    const outcomes = plan.nodes.map((node, index) =>
      fulfilled(
        node.id,
        createSuccessfulNode(plan, node.id, statuses[index]!),
      ),
    );

    expect(buildResultGraph(createInput(plan, outcomes)).meta.partial).toBe(
      expected,
    );
  });

  it("failed Node 使 meta.partial 派生为 true", () => {
    const plan = createPlan();
    const outcome: NodeJobOutcome = {
      status: "timed_out",
      nodeId: "node-a",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    };

    const result = buildResultGraph(createInput(plan, [outcome]));

    expect(result.graph.nodes[0]?.status).toBe("failed");
    expect(result.meta.partial).toBe(true);
  });

  it.each([
    ["缺失 outcome", []],
    ["重复 outcome", [timedOut("node-a"), timedOut("node-a")]],
    [
      "额外或未计划 outcome",
      [timedOut("node-a"), timedOut("node-extra")],
    ],
  ] as const)("拒绝%s", (_name, rawOutcomes) => {
    const plan = createPlan();

    expect(() => buildResultGraph(createInput(plan, rawOutcomes))).toThrow(
      TypeError,
    );
  });

  it("拒绝 outcome.nodeId 正确但 fulfilled value.id 错配", () => {
    const plan = createPlan();
    const wrongValue = ResultGraphNodeSchema.parse({
      ...createSuccessfulNode(plan, "node-a"),
      id: "node-foreign",
    });

    expect(() =>
      buildResultGraph(
        createInput(plan, [fulfilled("node-a", wrongValue)]),
      ),
    ).toThrow(TypeError);
  });

  it("用根 Schema 拒绝引用不存在 Node 的 Edge", () => {
    const validPlan = createPlan();
    const invalidPlan = {
      ...validPlan,
      edges: [
        {
          id: "edge-invalid",
          source: "node-a",
          target: "node-missing",
          type: "recommended_next",
        },
      ],
    } as GraphPlan;

    expect(() =>
      buildResultGraph(
        createInput(invalidPlan, [
          fulfilled("node-a", createSuccessfulNode(validPlan, "node-a")),
        ]),
      ),
    ).toThrow();
  });

  it("用根 Schema 拒绝同一 Node 内重复 Resource 身份", () => {
    const plan = createPlan();
    const planNode = plan.nodes[0]!;
    const invalidNode = {
      ...planNode,
      status: "ready",
      resources: [
        createResource("resource-a", 1),
        createResource("resource-a", 2),
      ],
      warnings: [],
    } as unknown as ResultGraphNode;

    expect(() =>
      buildResultGraph(createInput(plan, [fulfilled("node-a", invalidNode)])),
    ).toThrow();
  });

  it("用根 Schema 拒绝运行时伪造的 processing Node", () => {
    const plan = createPlan();
    const processingNode = {
      ...plan.nodes[0]!,
      status: "searching",
      resources: [],
      warnings: [],
    } as unknown as ResultGraphNode;

    expect(() =>
      buildResultGraph(
        createInput(plan, [fulfilled("node-a", processingNode)]),
      ),
    ).toThrow();
  });

  it("用根 Schema 拒绝非法 meta，且运行时 partial 输入不能覆盖派生值", () => {
    const plan = createPlan();
    const ready = fulfilled("node-a", createSuccessfulNode(plan, "node-a"));
    const runtimeMeta = {
      ...META,
      partial: true,
    } as unknown as BuildResultGraphInput["meta"];

    expect(
      buildResultGraph(createInput(plan, [ready], { meta: runtimeMeta })).meta
        .partial,
    ).toBe(false);
    expect(() =>
      buildResultGraph(
        createInput(plan, [ready], {
          meta: { ...META, timingMs: { total: -1 } },
        }),
      ),
    ).toThrow();
  });
});
