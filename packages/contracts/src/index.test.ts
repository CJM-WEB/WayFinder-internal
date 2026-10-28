/**
 * 测试职责：冻结 WAY-17 的共享协议词表，并验证状态与错误对象的边界。
 *
 * 关键约束：
 * - 测试中的取值来自已确认的 Product Spec（产品规格）与 Technical Architecture（技术架构）。
 * - 枚举值可能使用既有的 snake_case；camelCase 约束针对公共字段名，不能借机改写冻结值。
 * - Provider（提供方）私有错误字段不得穿透严格的 AppError 公共结构。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

// NodeNext 要求源码写运行时会存在的 .js 扩展名；Vitest 开发时会解析到 index.ts。
import {
  AppErrorCodeSchema,
  AppErrorSchema,
  EdgeTypeSchema,
  IntentSchema,
  NodeTypeSchema,
  NodeWarningCodeSchema,
  PresentationModeSchema,
  ProcessingNodeStatusSchema,
  RankingProfileSchema,
  ResultNodeStatusSchema,
  RetrievalStrategySchema,
  SearchCapabilitySchema,
  StreamNodeStatusSchema,
} from "./index.js";
import type {
  AppError,
  AppErrorCode,
  EdgeType,
  Intent,
  NodeType,
  NodeWarningCode,
  PresentationMode,
  ProcessingNodeStatus,
  RankingProfile,
  ResultNodeStatus,
  RetrievalStrategy,
  SearchCapability,
  StreamNodeStatus,
} from "./index.js";

/**
 * 协议枚举表：同时检查名称、完整集合与顺序，防止模块各自扩展出第二套词表。
 */
const enumContractCases = [
  [
    "IntentSchema",
    IntentSchema,
    [
      "learn",
      "understand",
      "news",
      "compare",
      "shop",
      "navigate",
      "how_to",
      "mixed",
    ],
  ],
  [
    "RetrievalStrategySchema",
    RetrievalStrategySchema,
    ["plan_first", "evidence_assisted"],
  ],
  ["PresentationModeSchema", PresentationModeSchema, ["graph", "compact"]],
  [
    "NodeTypeSchema",
    NodeTypeSchema,
    ["primary", "related", "disambiguation"],
  ],
  ["EdgeTypeSchema", EdgeTypeSchema, ["recommended_next", "related_to"]],
  [
    "RankingProfileSchema",
    RankingProfileSchema,
    ["knowledge", "news", "shopping", "software", "general"],
  ],
  [
    "SearchCapabilitySchema",
    SearchCapabilitySchema,
    [
      "general",
      "news",
      "shopping",
      "academic",
      "code",
      "community",
      "finance",
      "images",
    ],
  ],
  [
    "ProcessingNodeStatusSchema",
    ProcessingNodeStatusSchema,
    ["planned", "searching", "filtering"],
  ],
  [
    "ResultNodeStatusSchema",
    ResultNodeStatusSchema,
    ["ready", "partial", "failed"],
  ],
  [
    "StreamNodeStatusSchema",
    StreamNodeStatusSchema,
    ["planned", "searching", "filtering", "ready", "partial", "failed"],
  ],
  [
    "NodeWarningCodeSchema",
    NodeWarningCodeSchema,
    ["SEARCH_PROVIDER_PARTIAL", "EXTRACTION_FAILED", "RERANK_FAILED"],
  ],
  [
    "AppErrorCodeSchema",
    AppErrorCodeSchema,
    [
      "PLANNER_FAILED",
      "INVALID_GRAPH",
      "SEARCH_PROVIDER_FAILED",
      "NO_UNIQUE_RESOURCE_AVAILABLE",
      "EXTRACTION_FAILED",
      "RERANK_FAILED",
      "RUN_DEADLINE_EXCEEDED",
      "REQUEST_ABORTED",
      "UNKNOWN",
    ],
  ],
] as const;

describe("共享协议枚举", () => {
  it.each(enumContractCases)("%s 仅暴露冻结取值", (_name, schema, values) => {
    expect(schema.options).toEqual(values);
    expect(values.every(value => schema.safeParse(value).success)).toBe(true);
    expect(schema.safeParse("__unknown_protocol_value__").success).toBe(false);
  });

  it("区分 Query 检索策略、Provider 融合策略和展示模式", () => {
    expect(RetrievalStrategySchema.safeParse("parallel_merge").success).toBe(false);
    expect(PresentationModeSchema.safeParse("direct").success).toBe(false);
  });
});

describe("Node 状态边界", () => {
  it("处理中状态不接受任何终态", () => {
    for (const status of ResultNodeStatusSchema.options) {
      expect(ProcessingNodeStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("结果状态不接受任何处理中状态", () => {
    for (const status of ProcessingNodeStatusSchema.options) {
      expect(ResultNodeStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("流式状态覆盖处理中状态与结果状态", () => {
    const expectedStatuses = [
      ...ProcessingNodeStatusSchema.options,
      ...ResultNodeStatusSchema.options,
    ];

    expect(StreamNodeStatusSchema.options).toEqual(expectedStatuses);
  });
});

describe("AppError 公共结构", () => {
  it("接受严格的错误码与 retryable 标记", () => {
    const error = {
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    } as const;

    expect(AppErrorSchema.parse(error)).toEqual(error);
  });

  it.each([
    { code: "PROVIDER_RATE_LIMITED", retryable: true },
    { code: "UNKNOWN" },
    { code: "UNKNOWN", retryable: "yes" },
    { code: "UNKNOWN", retryable: false, providerCode: "429" },
  ])("拒绝未知、缺失、错误类型或 Provider 私有字段：%o", value => {
    expect(AppErrorSchema.safeParse(value).success).toBe(false);
  });
});

describe("Schema 推断类型", () => {
  it("所有公共类型都直接来自对应 Zod Schema", () => {
    type ExportedTypes = {
      intent: Intent;
      retrievalStrategy: RetrievalStrategy;
      presentationMode: PresentationMode;
      nodeType: NodeType;
      edgeType: EdgeType;
      rankingProfile: RankingProfile;
      searchCapability: SearchCapability;
      processingNodeStatus: ProcessingNodeStatus;
      resultNodeStatus: ResultNodeStatus;
      streamNodeStatus: StreamNodeStatus;
      nodeWarningCode: NodeWarningCode;
      appErrorCode: AppErrorCode;
      appError: AppError;
    };

    type InferredTypes = {
      intent: z.infer<typeof IntentSchema>;
      retrievalStrategy: z.infer<typeof RetrievalStrategySchema>;
      presentationMode: z.infer<typeof PresentationModeSchema>;
      nodeType: z.infer<typeof NodeTypeSchema>;
      edgeType: z.infer<typeof EdgeTypeSchema>;
      rankingProfile: z.infer<typeof RankingProfileSchema>;
      searchCapability: z.infer<typeof SearchCapabilitySchema>;
      processingNodeStatus: z.infer<typeof ProcessingNodeStatusSchema>;
      resultNodeStatus: z.infer<typeof ResultNodeStatusSchema>;
      streamNodeStatus: z.infer<typeof StreamNodeStatusSchema>;
      nodeWarningCode: z.infer<typeof NodeWarningCodeSchema>;
      appErrorCode: z.infer<typeof AppErrorCodeSchema>;
      appError: z.infer<typeof AppErrorSchema>;
    };

    expectTypeOf<ExportedTypes>().toEqualTypeOf<InferredTypes>();
  });
});
