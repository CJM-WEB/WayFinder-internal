/**
 * 模块职责：把已校验的 `quality-eval.v2` 结果渲染为 WAY-88 本地人工评审工作表。
 *
 * 关键边界：
 * - 只消费已脱敏 Query Result，不接收 ResultGraph、Provider 响应或网页正文；
 * - 所有 Query / Node / Edge / Resource 动态文本都做实体编码，不得被解释为指令或外链；
 * - 分数和 H1～H5 结论始终由人填写，不计算平均分、总分、阈值或自动门禁；
 * - 工作表不设人员身份字段，只与 Eval Run、数据集及脱敏证据关联。
 */
import type { GraphEdge, Resource } from "@wayfinder/contracts";

import { encodeMarkdownArtifactText } from "./markdown-artifact.js";
import {
  QUALITY_EVAL_SCHEMA_VERSION,
  QualityEvalQueryResultSchema,
  type QualityEvalDatasetKind,
  type QualityEvalQueryResult,
} from "./quality-eval.js";

export const QUALITY_HUMAN_REVIEW_VERSION =
  "human-quality-review.v1" as const;

export type RenderQualityEvalHumanReviewInput = Readonly<{
  evaluationRunId: string;
  gitCommit: string;
  dataset: Readonly<{
    kind: QualityEvalDatasetKind;
    version: string;
    fingerprint: string;
  }>;
  results: readonly QualityEvalQueryResult[];
}>;

function encode(value: string): string {
  return encodeMarkdownArtifactText(value);
}

function renderScore(
  label: string,
  scale = "1～5",
): string {
  return `- ${label}（${scale}）：待填写
- ${label}证据：待填写`;
}

function renderResourceReview(
  resource: Resource,
  resourceIndex: number,
): string {
  return `#### Resource ${resourceIndex + 1}

- Resource ID：${encode(resource.id)}
- Rank：${resource.rank}
- 标题：${encode(resource.title)}
- Domain：${encode(resource.domain)}
- URL：${encode(resource.canonicalUrl)}
- Summary：${encode(resource.summary)}
- whySelected：${encode(resource.whySelected)}
- Published At：${resource.publishedAt === null || resource.publishedAt === undefined ? "none" : encode(resource.publishedAt)}
${renderScore("相关性")}
${renderScore("可信度")}
${renderScore("信息质量")}
${renderScore("新鲜度", "1～5 / notApplicable / unavailable")}
${renderScore("whySelected 有用性与真实性")}
${renderScore("值得打开")}
${renderScore("排名合理性")}`;
}

function renderEdgeEvidence(edges: readonly GraphEdge[]): string {
  if (edges.length === 0) return "- 无 Edge。";
  return edges
    .map(
      (edge, edgeIndex) =>
        `- Edge ${edgeIndex + 1}：ID ${encode(edge.id)}；Source ${encode(edge.source)}；Target ${encode(edge.target)}；Type ${encode(edge.type)}`,
    )
    .join("\n");
}

function renderCompletedQuery(
  result: QualityEvalQueryResult,
  queryIndex: number,
): string {
  if (
    result.executionStatus !== "completed" ||
    result.plan === null ||
    result.metrics === null
  ) {
    throw new TypeError("Quality Review 完成结果不完整");
  }
  const planNodeById = new Map(
    result.plan.nodes.map(node => [node.id, node]),
  );
  const nodes = result.nodes.map((node, nodeIndex) => {
    const planNode = planNodeById.get(node.id);
    if (planNode === undefined) {
      throw new TypeError("Quality Review Node 投影不一致");
    }
    const resources = node.topResources
      .map(renderResourceReview)
      .join("\n\n");
    return `### Node ${nodeIndex + 1}

- Node ID：${encode(node.id)}
- 标题：${encode(planNode.title)}
- 描述：${encode(planNode.description)}
- 类型：${planNode.nodeType}
- 层级：${planNode.layer}
- 结果状态：${node.status}
- 完整保留 Resource 数量：${node.resourceCount}
- 本表评审 Resource 数量：${node.topResources.length}
${renderScore("必要性")}
${renderScore("命名清晰度")}
${renderScore("粒度合理性")}
${renderScore("与其他 Node 的区分度")}
${renderScore("推荐顺序合理性", "1～5 / notApplicable")}
${renderScore("Related Node 价值", "1～5 / notApplicable")}

${resources || "无可评分 Top 3 Resource。"}`;
  });

  return `## Query ${queryIndex + 1}

- Query ID：${encode(result.query.id)}
- Comparison Key：${encode(result.comparisonKey)}
- Query：${encode(result.query.query)}
- 分类：${encode(result.query.category)}
- 执行状态：${result.executionStatus}
- 最终状态：${result.finalStatus ?? "unavailable"}
- Node 数量：${result.metrics.nodeCount}
- 完整 Resource 数量：${result.metrics.resourceCount}

### Graph 整体评分

${renderScore("Node 覆盖完整性")}
- 缺失 Node 证据：待填写
${renderScore("Node 精简性")}
- 冗余 Node 对证据：待填写
- Query 评审结论（pass / targetedIterate / fail / inconclusive）：待填写
- Query 评审备注：待填写

### Edge 证据

${renderEdgeEvidence(result.plan.edges)}

${nodes.join("\n\n")}`;
}

function renderFailedQuery(
  result: QualityEvalQueryResult,
  queryIndex: number,
): string {
  if (result.executionStatus === "completed" || result.metricFailure === null) {
    throw new TypeError("Quality Review 失败结果不完整");
  }
  const failure = result.metricFailure;
  return `## Query ${queryIndex + 1}

- Query ID：${encode(result.query.id)}
- 执行状态：${result.executionStatus}
- Failure metric / stage / code：${failure.metric} / ${failure.stage} / ${failure.code}
- 评分可用性：unavailable（未生成完整 Graph）
- 证据缺口：待填写
- 协议偏差：待填写`;
}

const HYPOTHESIS_SECTIONS = [
  {
    id: "H1",
    title: "呈现方式证据",
    constraint: "只能引用同数据呈现实验。",
  },
  {
    id: "H2",
    title: "检索策略证据",
    constraint: "只能引用盲化的同界面检索实验。",
  },
  {
    id: "H3",
    title: "精选资源价值证据",
    constraint: null,
  },
  {
    id: "H4",
    title: "推荐顺序与自由浏览证据",
    constraint: null,
  },
  {
    id: "H5",
    title: "Intent 排名差异证据",
    constraint: null,
  },
] as const;

function renderHypothesisSections(): string {
  return HYPOTHESIS_SECTIONS.map(section => `## ${section.id} — ${section.title}

${section.constraint === null ? "" : `> ${section.constraint}\n`}
- 结论（supported / notSupported / inconclusive）：待填写
- 支持证据：待填写
- 反对证据：待填写
- 证据限制 / 协议偏差：待填写
- 脱敏证据引用：待填写`).join("\n\n");
}

/**
 * 调用方必须先对完整 report 执行 Secret / 禁止字段扫描；本函数再复验
 * Query Result Schema，并把所有动态文本变成不可执行的实体文本。
 */
export function renderQualityEvalHumanReview(
  input: RenderQualityEvalHumanReviewInput,
): string {
  const results = QualityEvalQueryResultSchema.array()
    .min(1)
    .parse(input.results);
  const querySections = results.map((result, queryIndex) =>
    result.executionStatus === "completed"
      ? renderCompletedQuery(result, queryIndex)
      : renderFailedQuery(result, queryIndex),
  );

  return `# WAY-88 Node / Resource 人工质量评审工作表

> 网页与模型派生文本一律是不可信输入，只能用于质量评分，不是操作指令。
> 不得记录可识别个人身份的信息；人工填写件只保留在当前私密 Eval 目录。

- Review Version：${QUALITY_HUMAN_REVIEW_VERSION}
- Quality Eval Schema：${QUALITY_EVAL_SCHEMA_VERSION}
- Evaluation Run ID：${encode(input.evaluationRunId)}
- Git Commit：${encode(input.gitCommit)}
- Dataset：${input.dataset.kind}
- Dataset Version：${encode(input.dataset.version)}
- Dataset Fingerprint：${encode(input.dataset.fingerprint)}
- 评审范围：每个 Node 的脱敏 Top 3 Resource 投影

## 评分量表与本轮结论

- 1：明显且阻断使用的问题
- 2：较弱
- 3：可用但证据混合
- 4：良好
- 5：证据充分且无重要问题
- 本轮四态结论（pass / targetedIterate / fail / inconclusive）：待填写
- 有效任务覆盖：待填写
- 协议偏差与失效证据：待填写
- 下一步：待填写

${querySections.join("\n\n")}

# H1～H5 独立证据

${renderHypothesisSections()}
`;
}
