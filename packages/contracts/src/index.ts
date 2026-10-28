/**
 * 模块职责：提供 WayFinder 公共 Wire Contract，以及 Provider Search、
 * Resource Candidate 与 Node Job 使用的进程内 TypeScript 边界。
 *
 * 关键约束：
 * - 公共 Wire Contract 的 Zod Schema 是运行时校验与类型推导的单一事实来源。
 * - WAY-24 内部对象不跨 Wire，不为了形式统一额外增加共享 Zod Schema。
 * - 第三方原始数据必须以 unknown 进入 Adapter 私有 Schema；Provider 私有字段不能泄漏到业务层。
 */
import { z } from "zod";

/** V0.1 只开放已完整贯穿前后端、Provider 与去重门禁的简体中文。 */
export const SearchLanguageSchema = z.literal("zh-CN");
export type SearchLanguage = z.infer<typeof SearchLanguageSchema>;

/**
 * SearchRequest（搜索请求）描述一次 Run（运行）的入口身份、有效查询和已校验语言。
 * Query（查询）先 trim，再按 Unicode code point（码点）校验长度。
 * runId 只要求非空并保留原值；严格对象使未知字段明确失败，防止未声明参数被误认为已生效。
 */
export const SearchRequestSchema = z.strictObject({
  runId: z.string().min(1),
  query: z.string().trim().min(1).max(2000),
  language: SearchLanguageSchema,
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** Query（查询）分析阶段使用的稳定分类。 */
export const IntentSchema = z.enum([
  "learn",
  "understand",
  "news",
  "compare",
  "shop",
  "navigate",
  "how_to",
  "mixed",
]);
export type Intent = z.infer<typeof IntentSchema>;

/** Retrieval Strategy（检索策略）只描述 Graph 规划前是否需要证据辅助。 */
export const RetrievalStrategySchema = z.enum([
  "plan_first",
  "evidence_assisted",
]);
export type RetrievalStrategy = z.infer<typeof RetrievalStrategySchema>;

/** Presentation Mode（展示模式）决定结果采用 Graph 或紧凑布局。 */
export const PresentationModeSchema = z.enum(["graph", "compact"]);
export type PresentationMode = z.infer<typeof PresentationModeSchema>;

/** QueryAnalysis（查询分析）的两个 Strategy（策略）分支共享相同基础字段。 */
const queryAnalysisCommonShape = {
  intent: IntentSchema,
  topic: z.string().min(1),
  freshnessSensitive: z.boolean(),
  ambiguityLevel: z.enum(["low", "medium", "high"]),
  presentationMode: PresentationModeSchema,
} as const;

/** Broad Search Query（广泛搜索查询）当前只冻结非空与数量边界，不擅自增加 trim 或去重。 */
const broadSearchQuerySchema = z.string().min(1);

/**
 * Strategy（策略）直接决定 Broad Query（广泛查询）数量；严格分支阻止未知字段被静默剥离。
 * 使用判别联合而非自定义 refine（细化校验），使未来 JSON Schema 能保留相同数量约束。
 */
export const QueryAnalysisSchema = z.discriminatedUnion("strategy", [
  z.strictObject({
    ...queryAnalysisCommonShape,
    broadSearchQueries: z.array(broadSearchQuerySchema).max(0),
    strategy: z.literal(RetrievalStrategySchema.enum.plan_first),
  }),
  z.strictObject({
    ...queryAnalysisCommonShape,
    broadSearchQueries: z.array(broadSearchQuerySchema).min(1).max(3),
    strategy: z.literal(RetrievalStrategySchema.enum.evidence_assisted),
  }),
]);
export type QueryAnalysis = z.infer<typeof QueryAnalysisSchema>;

/** Graph（图）结构词表由计划图与最终结果图共同使用。 */
export const NodeTypeSchema = z.enum([
  "primary",
  "related",
  "disambiguation",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.enum(["recommended_next", "related_to"]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/** Ranking Profile（排序配置）描述不同检索意图采用的排序侧重点。 */
export const RankingProfileSchema = z.enum([
  "knowledge",
  "news",
  "shopping",
  "software",
  "general",
]);
export type RankingProfile = z.infer<typeof RankingProfileSchema>;

/** Search Capability（搜索能力）供 Planner（规划器）与 Provider Router（提供方路由器）共享。 */
export const SearchCapabilitySchema = z.enum([
  "general",
  "news",
  "shopping",
  "academic",
  "code",
  "community",
  "finance",
  "images",
]);
export type SearchCapability = z.infer<typeof SearchCapabilitySchema>;

/** Provider 调用的共享字段；不包含 Graph 生命周期或 Run 身份。 */
type ProviderSearchRequestCommon = {
  query: string;
  maxResults: number;
  capability: SearchCapability;
  freshnessSensitive: boolean;
  language: SearchLanguage;
};

/**
 * Provider Search Request（提供方搜索请求）区分 Node Search 与 Revision 前的 Broad Discovery。
 * Node 分支必须携带真实 Graph Node ID；Broad Discovery 发生在修订前，不能伪造 Node ID。
 * runId 与 deadlineAt 属于整次搜索生命周期，不能泄漏到 Provider interface。
 */
export type ProviderSearchRequest =
  | (ProviderSearchRequestCommon & {
      kind: "node";
      nodeId: string;
    })
  | (ProviderSearchRequestCommon & {
      kind: "broad_discovery";
    });

/**
 * Normalized Search Hit（标准化搜索命中）是 Adapter 校验外部响应后的统一结果。
 * rawMetadata 仅允许透传已校验的 Provider 私有 metadata，业务逻辑不得读取其 key。
 */
export type NormalizedSearchHit = {
  provider: string;
  query: string;
  title: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  snippet: string;
  publishedAt?: string | null;
  providerRank?: number;
  providerScore?: number;
  rawMetadata: Record<string, unknown>;
};

/**
 * Extracted Page（抽取页面）只保存 Candidate canonicalUrl 与网页正文。
 * content 的类型已由 Adapter 校验，但其语义仍是不可信网页输入。
 */
export type ExtractedPage = {
  canonicalUrl: string;
  content: string;
};

/**
 * Candidate 只接收标准化 Hit 的正向白名单。
 * Pick 只提供静态限制；后续构造代码仍必须逐项复制，不能直接塞入完整 Hit。
 */
export type CandidateSearchHit = Pick<
  NormalizedSearchHit,
  | "provider"
  | "query"
  | "title"
  | "url"
  | "canonicalUrl"
  | "domain"
  | "snippet"
  | "publishedAt"
  | "providerRank"
  | "providerScore"
>;

/**
 * Resource Candidate（资源候选）连接确定性粗排、Extract、Reranker 与 Finalizer。
 * candidateId 只在当前 Node/Rerank 批次内使用，不等于最终 Resource.id。
 */
export type ResourceCandidate = {
  candidateId: string;
  hit: CandidateSearchHit;
  heuristicScore: number;
  heuristicSignals: Record<string, number>;
  scores?: Record<string, number>;
  summary?: string;
  whySelected?: string;
  // 只能来自可信确定性分类或由 Finalizer 保守生成。
  sourceType?: string;
};

/**
 * Node（节点）状态按生命周期分层：处理中事件不能伪装成最终结果，最终快照也不能残留处理中状态。
 */
export const ProcessingNodeStatusSchema = z.enum([
  "planned",
  "searching",
  "filtering",
]);
export type ProcessingNodeStatus = z.infer<typeof ProcessingNodeStatusSchema>;

export const ResultNodeStatusSchema = z.enum(["ready", "partial", "failed"]);
export type ResultNodeStatus = z.infer<typeof ResultNodeStatusSchema>;

// 完整流式状态从两组基础状态组合，避免第三次手写同一批协议值。
export const StreamNodeStatusSchema = z.enum([
  ...ProcessingNodeStatusSchema.options,
  ...ResultNodeStatusSchema.options,
]);
export type StreamNodeStatus = z.infer<typeof StreamNodeStatusSchema>;

/**
 * Warning（警告）表示“已有可交付结果，但发生局部回退”；不得把无结果的失败包装成 Warning。
 */
export const NodeWarningCodeSchema = z.enum([
  "SEARCH_PROVIDER_PARTIAL",
  "EXTRACTION_FAILED",
  "RERANK_FAILED",
]);
export type NodeWarningCode = z.infer<typeof NodeWarningCodeSchema>;

/**
 * Query Search Outcome（查询搜索结果）按原 Query 顺序保留局部结算，
 * 使调用方能定位具体失败，而不必从 Node 级 Warning 反向猜测。
 */
export type QuerySearchOutcome = {
  query: string;
  hits: NormalizedSearchHit[];
  warnings: NodeWarningCode[];
};

/**
 * Node Search Outcome（节点搜索结果）同时保留 Node 汇总与逐 Query 明细。
 * 没有可交付 Hit 的 Provider 失败必须抛错，不能伪装成 Warning。
 */
export type NodeSearchOutcome = {
  hits: NormalizedSearchHit[];
  warnings: NodeWarningCode[];
  queryOutcomes: QuerySearchOutcome[];
};

/** Error（错误）表示对应 Node 或 Run 没有可交付结果。 */
export const AppErrorCodeSchema = z.enum([
  "PLANNER_FAILED",
  "INVALID_GRAPH",
  "SEARCH_PROVIDER_FAILED",
  "NO_UNIQUE_RESOURCE_AVAILABLE",
  "EXTRACTION_FAILED",
  "RERANK_FAILED",
  "RUN_DEADLINE_EXCEEDED",
  "REQUEST_ABORTED",
  "UNKNOWN",
]);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

/**
 * 公共错误对象刻意保持最小且严格：详细诊断进入脱敏 Run Log，不得把 Provider 原始错误暴露给业务层。
 */
export const AppErrorSchema = z.strictObject({
  code: AppErrorCodeSchema,
  retryable: z.boolean(),
});
export type AppError = z.infer<typeof AppErrorSchema>;

/**
 * 每个 Node 最多保留 8 个 Resource；同一常量同时约束单项 rank，
 * ResultGraphNodeSchema 复用它约束最终结果数组，禁止维护第二个数字 8。
 */
export const MAX_RETAINED_RESOURCES_PER_NODE = 8;

/**
 * Resource URL 来自不可信外部输入：既要是合法绝对 URL，也只允许 HTTP(S)。
 * URL scheme 不区分大小写；显式 pattern 使 WAY-25 可导出相同 JSON Schema 规则。
 * 在同一字符串 Schema 上组合检查，避免 intersection 因 URL 规范化结果不同而抛异常。
 */
const httpResourceUrlSchema = z
  .string()
  .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//)
  .check(z.url());

/**
 * Resource 是进入最终 Graph 的规范化互联网资源，不承载 Provider 私有字段。
 * domain 与 searchProvider 的派生责任属于后续确定性 Pipeline，本层冻结字段形状。
 */
export const ResourceSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  url: httpResourceUrlSchema,
  canonicalUrl: httpResourceUrlSchema,
  domain: z.string().min(1),
  sourceType: z.string().min(1),
  summary: z.string().min(1),
  whySelected: z.string().min(1),
  rank: z.number().int().min(1).max(MAX_RETAINED_RESOURCES_PER_NODE),
  scores: z
    .record(z.string(), z.number().min(0).max(1))
    .optional(),
  searchProvider: z.string().min(1),
  publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

/**
 * Provider Hint（提供方能力提示）必须有 1～3 个且唯一。
 * refine 负责运行时唯一性；meta 让 WAY-25 从同一 Schema 导出 uniqueItems。
 */
const providerHintsSchema = z
  .array(SearchCapabilitySchema)
  .min(1)
  .max(3)
  .refine(values => new Set(values).size === values.length, {
    message: "providerHints must be unique",
  })
  .meta({ uniqueItems: true });

/** 每个 Node 的 Provider 原始候选总预算；多 Query 只切分预算，不扩大总量。 */
export const MAX_PROVIDER_RESULTS_PER_NODE = 20;

/**
 * 按 Query 数量确定性切分 Provider 配额，避免 Planner 或调用方自由选择执行预算。
 * 向下取整使 3 条 Query 的总上限为 18，不会突破每 Node 的 20 条总预算。
 */
export function calculateSearchPlanMaxResults(queryCount: number): number {
  if (!Number.isInteger(queryCount) || queryCount < 1 || queryCount > 3) {
    throw new RangeError("queryCount 必须为 1-3 的整数");
  }

  return Math.floor(MAX_PROVIDER_RESULTS_PER_NODE / queryCount);
}

/**
 * SearchPlan 冻结单个 Node 的查询、确定性执行配额、排序侧重点与 Provider 能力提示。
 * 跨字段检查保证 maxResults 只能取 20 / 10 / 6，不能由 Planner 任意改写。
 */
export const SearchPlanSchema = z
  .strictObject({
    queries: z.array(z.string().min(1)).min(1).max(3),
    maxResults: z.number().int().min(6).max(MAX_PROVIDER_RESULTS_PER_NODE),
    rankingProfile: RankingProfileSchema,
    providerHints: providerHintsSchema,
  })
  .superRefine((plan, context) => {
    // 基础数组检查失败时不重复计算，确保 safeParse 对非法数量仍返回结构化 Issue。
    if (plan.queries.length < 1 || plan.queries.length > 3) {
      return;
    }

    if (
      plan.maxResults !== calculateSearchPlanMaxResults(plan.queries.length)
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxResults"],
        message: "maxResults 必须由 Query 数量确定性计算",
      });
    }
  });
export type SearchPlan = z.infer<typeof SearchPlanSchema>;

/**
 * GraphNodeCore 是计划节点与最终节点共享的稳定结构。
 * status、resources、warnings 与 error 由 WAY-20～21 的严格分支扩展，不能提前混入。
 */
export const GraphNodeCoreSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  nodeType: NodeTypeSchema,
  layer: z.number().int().min(0),
  searchPlan: SearchPlanSchema,
});
export type GraphNodeCore = z.infer<typeof GraphNodeCoreSchema>;

/**
 * GraphPlan Node（图计划节点）只描述待执行计划；planned 是唯一合法状态，
 * Resource、Warning 与 Error 等结果字段由后续 ResultGraph 分支负责。
 */
export const GraphPlanNodeSchema = GraphNodeCoreSchema.extend({
  status: z.literal("planned"),
});
export type GraphPlanNode = z.infer<typeof GraphPlanNodeSchema>;

/**
 * Graph Edge（图边）是计划图与最终结果图共享的结构，并复用统一 Edge 类型词表。
 * source 与 target 的存在性、唯一性和 DAG 等跨对象规则不属于局部 Schema。
 */
export const GraphEdgeSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: EdgeTypeSchema,
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * GraphPlan（图计划）根对象只组合一次 Query 分析、计划节点和图边。
 * Node 数量属于确定性 Contract；ID 唯一、Edge 端点存在、连通性与 DAG 由 Validator 负责。
 */
export const GraphPlanSchema = z
  .object({
    analysis: QueryAnalysisSchema,
    nodes: z.array(GraphPlanNodeSchema).min(1).max(8),
    edges: z.array(GraphEdgeSchema),
  })
  .strict();
export type GraphPlan = z.infer<typeof GraphPlanSchema>;

/**
 * 最终节点必须保留 1～8 个已通过 ResourceSchema 校验的资源。
 * 复用统一上限，避免 Resource.rank 与最终数组分别维护数字 8。
 */
const retainedResultResourcesSchema = z
  .array(ResourceSchema)
  .min(1)
  .max(MAX_RETAINED_RESOURCES_PER_NODE);

/** 无 Resource 或 Warning 使用必填空数组表达，不能用缺失字段代替。 */
const emptyResultResourcesSchema = z.array(ResourceSchema).max(0);
const emptyNodeWarningsSchema = z.array(NodeWarningCodeSchema).max(0);

/**
 * partial 至少说明一个局部回退原因；运行时与 JSON Schema 都保留唯一性。
 */
const partialNodeWarningsSchema = z
  .array(NodeWarningCodeSchema)
  .min(1)
  .max(NodeWarningCodeSchema.options.length)
  .refine(values => new Set(values).size === values.length, {
    message: "warnings must be unique",
  })
  .meta({ uniqueItems: true });

const ReadyResultNodeSchema = GraphNodeCoreSchema.extend({
  status: z.literal(ResultNodeStatusSchema.enum.ready),
  resources: retainedResultResourcesSchema,
  warnings: emptyNodeWarningsSchema,
});

const PartialResultNodeSchema = GraphNodeCoreSchema.extend({
  status: z.literal(ResultNodeStatusSchema.enum.partial),
  resources: retainedResultResourcesSchema,
  warnings: partialNodeWarningsSchema,
});

const FailedResultNodeSchema = GraphNodeCoreSchema.extend({
  status: z.literal(ResultNodeStatusSchema.enum.failed),
  resources: emptyResultResourcesSchema,
  warnings: emptyNodeWarningsSchema,
  error: AppErrorSchema,
});

/**
 * ResultGraphNode 只接受最终状态；status 同时决定 Resource、Warning 与 Error 的合法组合。
 * 独立解析 Node 时只校验局部形状；Resource 数组关系由根 ResultGraphSchema 校验。
 */
export const ResultGraphNodeSchema = z.discriminatedUnion("status", [
  ReadyResultNodeSchema,
  PartialResultNodeSchema,
  FailedResultNodeSchema,
]);
export type ResultGraphNode = z.infer<typeof ResultGraphNodeSchema>;

/** H2 Retrieval（检索）实验只使用两个中性条件标识，页面不得展示真实检索来源。 */
export const H2EvaluationConditionIdSchema = z.enum(["A", "B"]);
export type H2EvaluationConditionId = z.infer<
  typeof H2EvaluationConditionIdSchema
>;

/** 来源字段只供受控实验编排与复核使用，不属于普通产品导航或展示信息。 */
export const H2RetrievalSourceSchema = z.enum([
  "node_specific",
  "raw_query",
]);
export type H2RetrievalSource = z.infer<typeof H2RetrievalSourceSchema>;

/**
 * H2 工件只接受可交付的 ready / partial Node；任一条件失败时不能用空结果伪造可比较样本。
 * 继续复用生产 Node 分支，保证两个条件进入完全相同的 Resource Panel（资源面板）边界。
 */
const H2EvaluationNodeSchema = z.discriminatedUnion("status", [
  ReadyResultNodeSchema,
  PartialResultNodeSchema,
]);

const H2EvaluationConditionSchema = z.strictObject({
  id: H2EvaluationConditionIdSchema,
  source: H2RetrievalSourceSchema,
  node: H2EvaluationNodeSchema,
});

/**
 * H2 Evaluation Artifact（H2 评估工件）是本地 Server Runner 与隐藏 Web Eval 页之间的
 * 严格传输协议。它固定为两个条件，并校验 A/B、两种来源和同一 Node 身份各出现一次。
 */
export const H2EvaluationArtifactSchema = z
  .strictObject({
    version: z.literal("h2-evaluation.v1"),
    query: SearchRequestSchema.shape.query,
    conditions: z.tuple([
      H2EvaluationConditionSchema,
      H2EvaluationConditionSchema,
    ]),
  })
  .superRefine((artifact, context) => {
    for (const field of ["id", "source"] as const) {
      if (
        new Set(artifact.conditions.map(condition => condition[field])).size !==
        artifact.conditions.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["conditions"],
          message: `H2 conditions must contain unique ${field}`,
        });
      }
    }

    if (
      artifact.conditions[0].node.id !== artifact.conditions[1].node.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["conditions", 1, "node", "id"],
        message: "H2 conditions must compare the same node",
      });
    }

    const [first, second] = artifact.conditions;
    for (const field of [
      "title",
      "description",
      "nodeType",
      "layer",
    ] as const) {
      if (first.node[field] !== second.node[field]) {
        context.addIssue({
          code: "custom",
          path: ["conditions", 1, "node", field],
          message: `H2 conditions must keep node ${field} identical`,
        });
      }
    }

    if (
      first.node.searchPlan.rankingProfile !==
      second.node.searchPlan.rankingProfile
    ) {
      context.addIssue({
        code: "custom",
        path: ["conditions", 1, "node", "searchPlan", "rankingProfile"],
        message: "H2 conditions must keep rankingProfile identical",
      });
    }
    if (
      first.node.searchPlan.providerHints.join("\u0000") !==
      second.node.searchPlan.providerHints.join("\u0000")
    ) {
      context.addIssue({
        code: "custom",
        path: ["conditions", 1, "node", "searchPlan", "providerHints"],
        message: "H2 conditions must keep providerHints identical",
      });
    }
    const firstCandidateBudget =
      first.node.searchPlan.queries.length *
      first.node.searchPlan.maxResults;
    const secondCandidateBudget =
      second.node.searchPlan.queries.length *
      second.node.searchPlan.maxResults;
    if (firstCandidateBudget !== secondCandidateBudget) {
      context.addIssue({
        code: "custom",
        path: ["conditions", 1, "node", "searchPlan", "maxResults"],
        message: "H2 conditions must keep total candidate budget identical",
      });
    }

    artifact.conditions.forEach((condition, conditionIndex) => {
      for (const field of ["id", "canonicalUrl", "rank"] as const) {
        const values = condition.node.resources.map(resource => resource[field]);
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            path: ["conditions", conditionIndex, "node", "resources"],
            message: `H2 condition resources must contain unique ${field}`,
          });
        }
      }
      if (
        condition.node.resources.some(
          (resource, resourceIndex) => resource.rank !== resourceIndex + 1,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["conditions", conditionIndex, "node", "resources"],
          message: "H2 condition resource ranks must be sequential",
        });
      }
    });

    const rawCondition = artifact.conditions.find(
      condition => condition.source === "raw_query",
    );
    const nodeSpecificCondition = artifact.conditions.find(
      condition => condition.source === "node_specific",
    );
    // 来源唯一性失败时避免追加误导性的二级诊断。
    if (rawCondition !== undefined && nodeSpecificCondition !== undefined) {
      if (
        rawCondition.node.searchPlan.queries.length !== 1 ||
        rawCondition.node.searchPlan.queries[0] !== artifact.query
      ) {
        context.addIssue({
          code: "custom",
          path: ["conditions"],
          message: "H2 raw_query condition must use only the artifact query",
        });
      }
      if (
        nodeSpecificCondition.node.searchPlan.queries.length === 1 &&
        nodeSpecificCondition.node.searchPlan.queries[0] === artifact.query
      ) {
        context.addIssue({
          code: "custom",
          path: ["conditions"],
          message: "H2 node_specific condition must differ from raw query",
        });
      }
    }
  });
export type H2EvaluationArtifact = z.infer<
  typeof H2EvaluationArtifactSchema
>;

/** 普通 Node Job 失败明确排除 Deadline 与用户取消控制流。 */
type NodeJobRejectedCode = Exclude<
  AppErrorCode,
  "RUN_DEADLINE_EXCEEDED" | "REQUEST_ABORTED"
>;

/**
 * 服务端 NodeJobError 可结构化满足该类型，同时保留 Error stack/cause；
 * 公共事件与最终结果只投影 code/retryable。
 */
type NodeJobFailure = Error & {
  code: NodeJobRejectedCode;
  retryable: boolean;
};

/**
 * Node Job Outcome（节点任务结算）用判别字段隔离完整结果、普通失败和绝对超时。
 * 用户取消不属于任何分支，必须由 Orchestrator 向上抛出。
 */
export type NodeJobOutcome =
  | {
      status: "fulfilled";
      nodeId: string;
      settlementOrdinal: number;
      value: ResultGraphNode;
    }
  | {
      status: "rejected";
      nodeId: string;
      settlementOrdinal: number;
      error: NodeJobFailure;
    }
  | {
      status: "timed_out";
      nodeId: string;
      settlementOrdinal: number;
      error: {
        code: "RUN_DEADLINE_EXCEEDED";
        retryable: true;
      };
    };

/** ResultGraph 记录原始 Query、规范化结果与最小语言标识。 */
const resultGraphQuerySchema = z.strictObject({
  raw: z.string().min(1).max(2000),
  normalized: z.string().min(1).max(2000),
  language: SearchLanguageSchema,
});

/** 最终图复用最终节点与共享 Edge；根 Schema 统一校验跨对象引用关系。 */
const resultGraphDataSchema = z.strictObject({
  nodes: z.array(ResultGraphNodeSchema).min(1).max(8),
  edges: z.array(GraphEdgeSchema),
});

/** Provider ID 在运行时与后续 JSON Schema 中都必须唯一。 */
const resultGraphProvidersUsedSchema = z
  .array(z.string().min(1))
  .refine(values => new Set(values).size === values.length, {
    message: "providersUsed must be unique",
  })
  .meta({ uniqueItems: true });

const resultGraphMetaSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  providersUsed: resultGraphProvidersUsedSchema,
  // 局部 Schema 只校验 boolean 形状；根 Schema 从所有 Node 最终状态派生校验。
  partial: z.boolean(),
  // V0 暂不冻结阶段名；所有已记录耗时都必须是非负毫秒值。
  timingMs: z.record(z.string(), z.number().min(0)),
  warnings: z.array(z.string()).optional(),
});

/**
 * 返回第二次及后续出现的索引，保留首项作为合法基准。
 * 该函数只辅助生成精确 Zod issue，不修改或修复调用方输入。
 */
const duplicateValueIndexes = (
  values: readonly (string | number)[],
): number[] => {
  const seen = new Set<string | number>();
  const duplicateIndexes: number[] = [];

  values.forEach((value, index) => {
    if (seen.has(value)) {
      duplicateIndexes.push(index);
      return;
    }

    seen.add(value);
  });

  return duplicateIndexes;
};

/**
 * ResultGraph 是搜索结果页的完整公共快照。
 * 根级校验同时观察 Node、Edge、Resource 与 meta；只拒绝非法关系，不自动修复输入。
 */
export const ResultGraphSchema = z
  .strictObject({
    version: z.literal("0.1"),
    runId: z.string().min(1),
    query: resultGraphQuerySchema,
    analysis: QueryAnalysisSchema,
    graph: resultGraphDataSchema,
    meta: resultGraphMetaSchema,
  })
  .superRefine((result, context) => {
    // 1. 全图 Node 与 Edge 标识必须稳定唯一，错误定位到第二个及后续重复项。
    for (const nodeIndex of duplicateValueIndexes(
      result.graph.nodes.map(node => node.id),
    )) {
      context.addIssue({
        code: "custom",
        path: ["graph", "nodes", nodeIndex, "id"],
        message: "Node id must be unique",
      });
    }

    for (const edgeIndex of duplicateValueIndexes(
      result.graph.edges.map(edge => edge.id),
    )) {
      context.addIssue({
        code: "custom",
        path: ["graph", "edges", edgeIndex, "id"],
        message: "Edge id must be unique",
      });
    }

    // 2. Edge 两端必须引用当前最终图中真实存在的 Node。
    const nodeIds = new Set(result.graph.nodes.map(node => node.id));
    result.graph.edges.forEach((edge, edgeIndex) => {
      for (const endpoint of ["source", "target"] as const) {
        if (!nodeIds.has(edge[endpoint])) {
          context.addIssue({
            code: "custom",
            path: ["graph", "edges", edgeIndex, endpoint],
            message: `Edge ${endpoint} must reference an existing node`,
          });
        }
      }
    });

    // 3. 先保留既有 Node 内身份门禁，再单独定位跨 Node 的 canonicalUrl 重复。
    const canonicalOwnerNodeIndex = new Map<string, number>();
    result.graph.nodes.forEach((node, nodeIndex) => {
      for (const field of ["id", "canonicalUrl", "rank"] as const) {
        for (const resourceIndex of duplicateValueIndexes(
          node.resources.map(resource => resource[field]),
        )) {
          context.addIssue({
            code: "custom",
            path: [
              "graph",
              "nodes",
              nodeIndex,
              "resources",
              resourceIndex,
              field,
            ],
            message: `Resource ${field} must be unique within its node`,
          });
        }
      }

      node.resources.forEach((resource, resourceIndex) => {
        const ownerNodeIndex = canonicalOwnerNodeIndex.get(
          resource.canonicalUrl,
        );
        if (ownerNodeIndex !== undefined && ownerNodeIndex !== nodeIndex) {
          context.addIssue({
            code: "custom",
            path: [
              "graph",
              "nodes",
              nodeIndex,
              "resources",
              resourceIndex,
              "canonicalUrl",
            ],
            message: "Resource canonicalUrl must be unique across the graph",
          });
          return;
        }
        canonicalOwnerNodeIndex.set(resource.canonicalUrl, nodeIndex);
      });
    });

    // 4. partial 是最终 Node 状态的派生值，调用方不能独立覆盖。
    const expectedPartial = result.graph.nodes.some(
      node => node.status !== "ready",
    );
    if (result.meta.partial !== expectedPartial) {
      context.addIssue({
        code: "custom",
        path: ["meta", "partial"],
        message: "meta.partial must match final node statuses",
      });
    }
  });
export type ResultGraph = z.infer<typeof ResultGraphSchema>;

/** 单条完整事件统一携带严格 Envelope；跨事件顺序由后续状态机负责。 */
const streamEventEnvelopeShape = {
  runId: z.string().min(1),
  sequence: z.number().int().min(1),
  protocolVersion: z.literal("0.1"),
  timestamp: z.iso.datetime({ offset: true }),
} as const;

/** 计划阶段事件直接复用已冻结的查询分析与图计划 Contract。 */
const QueryAnalysisStreamEventPayloadSchema = z.strictObject({
  type: z.literal("query.analysis"),
  data: QueryAnalysisSchema,
});

const GraphPlanStreamEventPayloadSchema = z.strictObject({
  type: z.literal("graph.plan"),
  data: GraphPlanSchema,
});

/** 处理中状态与三个 Node 终态分离，避免临时状态伪装成已交付结果。 */
const NodeStatusStreamEventPayloadSchema = z.strictObject({
  type: z.literal("node.status"),
  nodeId: z.string().min(1),
  status: ProcessingNodeStatusSchema,
});

const NodeReadyStreamEventPayloadSchema = z.strictObject({
  type: z.literal("node.ready"),
  nodeId: z.string().min(1),
  resources: retainedResultResourcesSchema,
  warnings: emptyNodeWarningsSchema,
});

const NodePartialStreamEventPayloadSchema = z.strictObject({
  type: z.literal("node.partial"),
  nodeId: z.string().min(1),
  resources: retainedResultResourcesSchema,
  warnings: partialNodeWarningsSchema,
});

const NodeFailedStreamEventPayloadSchema = z.strictObject({
  type: z.literal("node.failed"),
  nodeId: z.string().min(1),
  error: AppErrorSchema,
});

/**
 * complete 的关系规则放在 Payload 与完整 Event 共享的 data Schema，
 * 避免两个公共入口对最终状态产生不同判定。
 */
const completeStreamEventDataSchema = z
  .strictObject({
    finalStatus: z.enum(["complete", "partial"]),
    result: ResultGraphSchema,
  })
  .superRefine((data, context) => {
    const expectedStatus = data.result.meta.partial
      ? "partial"
      : "complete";

    if (data.finalStatus !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["finalStatus"],
        message: "finalStatus must match result.meta.partial",
      });
    }
  });

const CompleteStreamEventPayloadSchema = z.strictObject({
  type: z.literal("complete"),
  data: completeStreamEventDataSchema,
});

const RunFailedStreamEventPayloadSchema = z.strictObject({
  type: z.literal("run.failed"),
  error: AppErrorSchema,
});

/** Payload 只描述业务事件，调用方不能预填 Envelope。 */
export const StreamEventPayloadSchema = z.discriminatedUnion("type", [
  QueryAnalysisStreamEventPayloadSchema,
  GraphPlanStreamEventPayloadSchema,
  NodeStatusStreamEventPayloadSchema,
  NodeReadyStreamEventPayloadSchema,
  NodePartialStreamEventPayloadSchema,
  NodeFailedStreamEventPayloadSchema,
  CompleteStreamEventPayloadSchema,
  RunFailedStreamEventPayloadSchema,
]);
export type StreamEventPayload = z.infer<typeof StreamEventPayloadSchema>;

/** 完整 Event 在同一批严格 Payload 上统一增加受信 Envelope。 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  QueryAnalysisStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  GraphPlanStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  NodeStatusStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  NodeReadyStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  NodePartialStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  NodeFailedStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  CompleteStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
  RunFailedStreamEventPayloadSchema.extend(streamEventEnvelopeShape),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
