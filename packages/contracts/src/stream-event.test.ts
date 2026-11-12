/**
 * 测试职责：冻结 WAY-23 单条 StreamEvent 的严格 Envelope 与八个判别分支。
 *
 * 关键约束：
 * - Payload 只含业务字段，完整 Event 统一补齐四个 Envelope 字段。
 * - node.status 只表达处理状态，Node 终态使用三个专用 type。
 * - 单条 Schema 不承担跨事件顺序、去重或终态恰好一次状态机。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  StreamEventPayloadSchema,
  StreamEventSchema,
} from "./index.js";
import type { StreamEvent, StreamEventPayload } from "./index.js";

const validAnalysis = {
  intent: "learn",
  topic: "TypeScript",
  freshnessSensitive: false,
  ambiguityLevel: "low",
  broadSearchQueries: [],
  strategy: "plan_first",
  presentationMode: "graph",
} as const;

const validSearchPlan = {
  queries: ["typescript strict mode"],
  maxResults: 20,
  rankingProfile: "software",
  providerHints: ["code"],
} as const;

const validGraphPlanNode = {
  id: "node-001",
  title: "TypeScript 学习入口",
  description: "组织官方文档和高质量教程。",
  nodeType: "primary",
  layer: 0,
  searchPlan: validSearchPlan,
  status: "planned",
} as const;

const validGraphPlan = {
  analysis: validAnalysis,
  nodes: [validGraphPlanNode],
  edges: [],
} as const;

const validEnvelope = {
  runId: "run-001",
  sequence: 1,
  protocolVersion: "0.1",
  timestamp: "2026-10-17T08:00:00Z",
} as const;

const validQueryAnalysisPayload = {
  type: "query.analysis",
  data: validAnalysis,
} as const;

const validGraphPlanPayload = {
  type: "graph.plan",
  data: validGraphPlan,
} as const;

const toEvent = (payload: Record<string, unknown>) => ({
  ...payload,
  ...validEnvelope,
});

const createResource = (index: number) => ({
  id: `resource-${index}`,
  title: `资源 ${index}`,
  url: `https://example.com/source-${index}`,
  canonicalUrl: `https://example.com/source-${index}`,
  domain: "example.com",
  sourceType: "documentation",
  summary: "经过规范化的资源摘要。",
  whySelected: "与节点主题直接相关。",
  rank: ((index - 1) % 8) + 1,
  searchProvider: "general",
});

const createResources = (count: number) =>
  Array.from({ length: count }, (_, index) => createResource(index + 1));

const validNodeStatusPayload = {
  type: "node.status",
  nodeId: "node-001",
  status: "searching",
} as const;

const validNodeReadyPayload = {
  type: "node.ready",
  nodeId: "node-001",
  resources: createResources(1),
  warnings: [],
} as const;

const validNodePartialPayload = {
  type: "node.partial",
  nodeId: "node-001",
  resources: createResources(1),
  warnings: ["SEARCH_PROVIDER_PARTIAL"],
} as const;

const validNodeFailedPayload = {
  type: "node.failed",
  nodeId: "node-001",
  error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
} as const;

const validReadyResultNode = {
  id: "node-001",
  title: "TypeScript 学习入口",
  description: "组织官方文档和高质量教程。",
  nodeType: "primary",
  layer: 0,
  searchPlan: validSearchPlan,
  status: "ready",
  resources: createResources(1),
  warnings: [],
} as const;

const validResultGraph = {
  version: "0.1",
  runId: "run-001",
  query: {
    raw: "学习 TypeScript strict mode",
    normalized: "学习 typescript strict mode",
    language: "zh-CN",
  },
  analysis: validAnalysis,
  graph: { nodes: [validReadyResultNode], edges: [] },
  meta: {
    createdAt: "2026-10-17T08:00:00Z",
    providersUsed: ["general"],
    partial: false,
    timingMs: { total: 18 },
  },
} as const;

const validPartialResultGraph = {
  ...validResultGraph,
  graph: {
    nodes: [
      {
        ...validReadyResultNode,
        status: "partial",
        warnings: ["SEARCH_PROVIDER_PARTIAL"],
      },
    ],
    edges: [],
  },
  meta: { ...validResultGraph.meta, partial: true },
} as const;

const validCompletePayload = {
  type: "complete",
  data: { finalStatus: "complete", result: validResultGraph },
} as const;

const validRunFailedPayload = {
  type: "run.failed",
  error: { code: "PLANNER_FAILED", retryable: true },
} as const;

const validPayloads = [
  validQueryAnalysisPayload,
  validGraphPlanPayload,
  validNodeStatusPayload,
  validNodeReadyPayload,
  validNodePartialPayload,
  validNodeFailedPayload,
  validCompletePayload,
  validRunFailedPayload,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const hasStrictCompleteData = (value: unknown): boolean => {
  if (!isRecord(value)) return false;

  const properties = value.properties;
  if (isRecord(properties)) {
    const type = properties.type;
    const data = properties.data;
    if (
      isRecord(type) &&
      type.const === "complete" &&
      isRecord(data) &&
      data.additionalProperties === false
    ) {
      return true;
    }
  }

  return Object.values(value).some(hasStrictCompleteData);
};

describe("StreamEvent Envelope 与计划阶段事件", () => {
  it("QueryAnalysis 与 GraphPlan payload 补齐 Envelope 后均合法", () => {
    for (const payload of [
      validQueryAnalysisPayload,
      validGraphPlanPayload,
    ]) {
      expect(StreamEventPayloadSchema.safeParse(payload).success).toBe(true);
      expect(StreamEventSchema.safeParse(toEvent(payload)).success).toBe(true);
    }
  });

  it("拒绝非法 Envelope 值", () => {
    for (const envelope of [
      { ...validEnvelope, runId: "" },
      { ...validEnvelope, sequence: 0 },
      { ...validEnvelope, sequence: -1 },
      { ...validEnvelope, sequence: 1.5 },
      { ...validEnvelope, sequence: "1" },
      { ...validEnvelope, protocolVersion: "0.2" },
      { ...validEnvelope, timestamp: "2026-10-17T08:00:00" },
      { ...validEnvelope, timestamp: "today" },
    ]) {
      expect(
        StreamEventSchema.safeParse({
          ...envelope,
          ...validQueryAnalysisPayload,
        }).success,
      ).toBe(false);
    }
  });

  it("两个首批 Event 分支都要求完整 Envelope", () => {
    for (const payload of [
      validQueryAnalysisPayload,
      validGraphPlanPayload,
    ]) {
      for (const field of [
        "runId",
        "sequence",
        "protocolVersion",
        "timestamp",
      ] as const) {
        const input: Record<string, unknown> = { ...toEvent(payload) };
        delete input[field];
        expect(StreamEventSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  it("Payload 与 Event 都严格拒绝未知字段", () => {
    for (const payload of validPayloads) {
      expect(
        StreamEventPayloadSchema.safeParse({
          ...payload,
          debug: true,
        }).success,
      ).toBe(false);
      expect(
        StreamEventSchema.safeParse({
          ...toEvent(payload),
          debug: true,
        }).success,
      ).toBe(false);
    }
  });

  it("复用 QueryAnalysis 与 GraphPlan 的嵌套约束", () => {
    expect(
      StreamEventPayloadSchema.safeParse({
        ...validQueryAnalysisPayload,
        data: { ...validAnalysis, broadSearchQueries: ["typescript"] },
      }).success,
    ).toBe(false);
    expect(
      StreamEventPayloadSchema.safeParse({
        ...validGraphPlanPayload,
        data: { ...validGraphPlan, nodes: [] },
      }).success,
    ).toBe(false);
  });
});

describe("StreamEvent Node 处理状态与终态", () => {
  it("node.status 只接受三个 processing 状态", () => {
    for (const status of ["planned", "searching", "filtering"]) {
      expect(
        StreamEventPayloadSchema.safeParse({
          ...validNodeStatusPayload,
          status,
        }).success,
      ).toBe(true);
    }
    for (const status of ["ready", "partial", "failed"]) {
      expect(
        StreamEventPayloadSchema.safeParse({
          ...validNodeStatusPayload,
          status,
        }).success,
      ).toBe(false);
    }
  });

  it("node.ready 复用 1～8 Resource 与必填空 warnings", () => {
    for (const count of [1, 8]) {
      expect(
        StreamEventPayloadSchema.safeParse({
          ...validNodeReadyPayload,
          resources: createResources(count),
        }).success,
      ).toBe(true);
    }
    for (const input of [
      { ...validNodeReadyPayload, resources: [] },
      { ...validNodeReadyPayload, resources: createResources(9) },
      {
        ...validNodeReadyPayload,
        resources: [
          { ...createResource(1), url: "ftp://example.com/source" },
        ],
      },
      { ...validNodeReadyPayload, warnings: ["RERANK_FAILED"] },
      {
        ...validNodeReadyPayload,
        error: { code: "UNKNOWN", retryable: false },
      },
    ]) {
      expect(StreamEventPayloadSchema.safeParse(input).success).toBe(false);
    }
  });

  it("node.partial 复用 Resource 与非空唯一 Warning 约束", () => {
    expect(StreamEventPayloadSchema.safeParse(validNodePartialPayload).success)
      .toBe(true);
    expect(
      StreamEventPayloadSchema.safeParse({
        ...validNodePartialPayload,
        resources: createResources(8),
        warnings: [
          "SEARCH_PROVIDER_PARTIAL",
          "EXTRACTION_FAILED",
          "RERANK_FAILED",
        ],
      }).success,
    ).toBe(true);

    for (const input of [
      { ...validNodePartialPayload, resources: [] },
      { ...validNodePartialPayload, resources: createResources(9) },
      { ...validNodePartialPayload, warnings: [] },
      { ...validNodePartialPayload, warnings: ["RERANK_FAILED", "RERANK_FAILED"] },
      { ...validNodePartialPayload, warnings: ["UNKNOWN_WARNING"] },
      {
        ...validNodePartialPayload,
        error: { code: "EXTRACTION_FAILED", retryable: true },
      },
    ]) {
      expect(StreamEventPayloadSchema.safeParse(input).success).toBe(false);
    }
  });

  it("node.failed 只接受 nodeId 与严格 AppError", () => {
    expect(StreamEventPayloadSchema.safeParse(validNodeFailedPayload).success)
      .toBe(true);
    for (const input of [
      { ...validNodeFailedPayload, resources: [] },
      { ...validNodeFailedPayload, warnings: [] },
      { ...validNodeFailedPayload, status: "failed" },
      {
        ...validNodeFailedPayload,
        error: {
          ...validNodeFailedPayload.error,
          providerMessage: "secret",
        },
      },
    ]) {
      expect(StreamEventPayloadSchema.safeParse(input).success).toBe(false);
    }
  });

  it("四个 Node 分支都拒绝空 nodeId", () => {
    for (const payload of [
      validNodeStatusPayload,
      validNodeReadyPayload,
      validNodePartialPayload,
      validNodeFailedPayload,
    ]) {
      expect(
        StreamEventPayloadSchema.safeParse({ ...payload, nodeId: "" }).success,
      ).toBe(false);
    }
  });

  it("终态 payload 不复制 WAY-22 Resource 唯一性 refine", () => {
    expect(
      StreamEventPayloadSchema.safeParse({
        ...validNodeReadyPayload,
        resources: [
          createResource(1),
          { ...createResource(1), title: "同值 Resource 的另一个展示项" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("StreamEvent Run 结束事件与双入口一致性", () => {
  it("complete 接受与 ResultGraph.meta.partial 一致的两个最终状态", () => {
    for (const payload of [
      validCompletePayload,
      {
        type: "complete",
        data: { finalStatus: "partial", result: validPartialResultGraph },
      },
    ]) {
      expect(StreamEventPayloadSchema.safeParse(payload).success).toBe(true);
      expect(StreamEventSchema.safeParse(toEvent(payload)).success).toBe(true);
    }
  });

  it("小组完成收据绑定唯一Run，普通完成事件仍无需收据", () => {
    const receipt = { version: "groupSearch.v1", target: { groupId: "group", graphId: "graph", expectedRevision: 1 },
      runId: validResultGraph.runId, signature: "a".repeat(64) };
    const data = { ...validCompletePayload.data, groupSearchReceipt: receipt };
    expect(StreamEventPayloadSchema.safeParse({ ...validCompletePayload, data }).success).toBe(true);
    for (const bad of [{ ...receipt, runId: "another-run" }, { ...receipt, signature: "private-data" }]) {
      expect(StreamEventPayloadSchema.safeParse({ ...validCompletePayload, data: { ...data, groupSearchReceipt: bad } }).success).toBe(false);
    }
  });

  it("complete 复用严格 ResultGraph 与严格 data 形状", () => {
    for (const input of [
      {
        ...validCompletePayload,
        data: {
          ...validCompletePayload.data,
          result: { ...validResultGraph, version: "0.2" },
        },
      },
      {
        ...validCompletePayload,
        data: { ...validCompletePayload.data, finalStatus: "failed" },
      },
      {
        ...validCompletePayload,
        data: { ...validCompletePayload.data, debug: true },
      },
    ]) {
      expect(StreamEventPayloadSchema.safeParse(input).success).toBe(false);
    }
  });

  it("Payload 与 Event 都拒绝两个方向的 complete 最终状态矛盾", () => {
    for (const payload of [
      {
        type: "complete",
        data: { finalStatus: "complete", result: validPartialResultGraph },
      },
      {
        type: "complete",
        data: { finalStatus: "partial", result: validResultGraph },
      },
    ]) {
      for (const input of [payload, toEvent(payload)]) {
        const schema = "runId" in input
          ? StreamEventSchema
          : StreamEventPayloadSchema;
        const result = schema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "custom",
                path: ["data", "finalStatus"],
              }),
            ]),
          );
        }
      }
    }
  });

  it("run.failed 只接受严格 AppError", () => {
    expect(StreamEventPayloadSchema.safeParse(validRunFailedPayload).success)
      .toBe(true);
    for (const error of [
      { code: "NOT_A_PUBLIC_CODE", retryable: false },
      { code: "PLANNER_FAILED", retryable: true, message: "secret" },
    ]) {
      expect(
        StreamEventPayloadSchema.safeParse({
          ...validRunFailedPayload,
          error,
        }).success,
      ).toBe(false);
    }
  });

  it("八个 payload 与补齐 Envelope 的八个 Event 对称通过", () => {
    for (const payload of validPayloads) {
      expect(StreamEventPayloadSchema.safeParse(payload).success).toBe(true);
      expect(StreamEventSchema.safeParse(toEvent(payload)).success).toBe(true);
    }
  });

  it("八个 Payload 分支都拒绝调用方预填 Envelope", () => {
    for (const payload of validPayloads) {
      for (const [field, value] of Object.entries(validEnvelope)) {
        expect(
          StreamEventPayloadSchema.safeParse({
            ...payload,
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
  });

  it("八个 Event 分支都要求四个 Envelope 字段", () => {
    for (const payload of validPayloads) {
      for (const field of Object.keys(validEnvelope)) {
        const input: Record<string, unknown> = { ...toEvent(payload) };
        delete input[field];
        expect(StreamEventSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  it("拒绝缺失、未知 type 与跨分支字段", () => {
    for (const input of [
      { ...validEnvelope, data: validAnalysis },
      { ...toEvent(validQueryAnalysisPayload), type: "unknown.event" },
      { ...validNodeStatusPayload, resources: createResources(1) },
    ]) {
      const schema = "runId" in input
        ? StreamEventSchema
        : StreamEventPayloadSchema;
      expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it("两个公共 Schema 都导出八个严格 JSON Schema 分支", () => {
    for (const schema of [StreamEventPayloadSchema, StreamEventSchema]) {
      const jsonSchema = z.toJSONSchema(schema);
      expect(jsonSchema.oneOf).toHaveLength(8);
      expect(
        jsonSchema.oneOf?.every(
          branch =>
            isRecord(branch) && branch.additionalProperties === false,
        ),
      ).toBe(true);
      expect(hasStrictCompleteData(jsonSchema)).toBe(true);
    }
  });

  it("两个公共 TypeScript 类型都直接来自对应 Schema", () => {
    expectTypeOf<StreamEventPayload>().toEqualTypeOf<
      z.infer<typeof StreamEventPayloadSchema>
    >();
    expectTypeOf<StreamEvent>().toEqualTypeOf<
      z.infer<typeof StreamEventSchema>
    >();
  });
});
