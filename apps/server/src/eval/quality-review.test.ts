/**
 * 测试职责：冻结 WAY-88 人工评审工作表的评分字段、H1～H5 证据隔离与脱敏边界。
 *
 * 边界说明：只测试已校验 `quality-eval.v6` 投影的确定性渲染，不填写主观分数、
 * 不访问网络，也不把 Worksheet 变成第二份机器报告 Contract。
 */
import { describe, expect, it } from "vitest";

import {
  QUALITY_EVAL_DATASET_VERSION,
  QUALITY_EVAL_SCHEMA_VERSION,
  QualityEvalQueryResultSchema,
  type QualityEvalQueryResult,
} from "./quality-eval.js";
import { encodeMarkdownArtifactText } from "./markdown-artifact.js";
import {
  QUALITY_HUMAN_REVIEW_VERSION,
  renderQualityEvalHumanReview,
} from "./quality-review.js";

const MALICIOUS_TEXT =
  "# injected\n![x](https://evil.example/a) <img src=x> ``` [x](https://evil.example/b)?";

function createCompletedResult(): QualityEvalQueryResult {
  const resources = Array.from({ length: 3 }, (_, index) => ({
    id: index === 0 ? `resource-${MALICIOUS_TEXT}` : `resource-${index + 1}`,
    title: index === 0 ? MALICIOUS_TEXT : `Resource ${index + 1}`,
    url: `https://evil.example/resource-${index + 1}?private=value`,
    canonicalUrl: `https://evil.example/resource-${index + 1}?private=value`,
    domain: "evil.example",
    sourceType: "web",
    summary: index === 0 ? MALICIOUS_TEXT : `Summary ${index + 1}`,
    whySelected: index === 0 ? MALICIOUS_TEXT : `Reason ${index + 1}`,
    rank: index + 1,
    searchProvider: "tavily",
    publishedAt: index === 0 ? "2026-10-22T12:00:00.000Z" : null,
  }));
  const firstNodeId = `node-${MALICIOUS_TEXT}`;
  const planNodes = [
    {
      id: firstNodeId,
      title: MALICIOUS_TEXT,
      description: MALICIOUS_TEXT,
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: ["safe query"],
        maxResults: 20,
        rankingProfile: "general",
        providerHints: ["general"],
      },
    },
    {
      id: "failed-node",
      title: "Failed Node",
      description: "No resources",
      nodeType: "related",
      layer: 1,
      status: "planned",
      searchPlan: {
        queries: ["fallback query"],
        maxResults: 20,
        rankingProfile: "general",
        providerHints: ["general"],
      },
    },
  ] as const;

  return QualityEvalQueryResultSchema.parse({
    schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
    comparisonKey: `${QUALITY_EVAL_DATASET_VERSION}:wfq-009`,
    query: {
      id: "wfq-009",
      query: MALICIOUS_TEXT,
      category: "navigateDownload",
      rationale: "固定评审 Fixture。",
    },
    executionStatus: "completed",
    finalStatus: "partial",
    errorCode: null,
    freshnessReferenceAt: "2026-10-23T00:00:00.000Z",
    plan: {
      analysis: {
        intent: "navigate",
        topic: "download",
        freshnessSensitive: true,
        ambiguityLevel: "low",
        broadSearchQueries: [],
        strategy: "plan_first",
        presentationMode: "graph",
      },
      nodes: planNodes,
      edges: [
        {
          id: `edge-${MALICIOUS_TEXT}`,
          source: firstNodeId,
          target: "failed-node",
          type: "recommended_next",
        },
        {
          id: "related-edge",
          source: "failed-node",
          target: firstNodeId,
          type: "related_to",
        },
      ],
    },
    nodes: [
      {
        id: firstNodeId,
        status: "ready",
        warnings: [],
        errorCode: null,
        resourceCount: 4,
        topResources: resources,
        officialSource: { status: "notApplicable" },
        diversity: { distinctExactDomainCount: 1 },
        freshness: {
          status: "measured",
          buckets: {
            within1Day: 1,
            within7Days: 0,
            within30Days: 0,
            within365Days: 0,
            older: 0,
            future: 0,
          },
        },
      },
      {
        id: "failed-node",
        status: "failed",
        warnings: [],
        errorCode: "SEARCH_PROVIDER_FAILED",
        resourceCount: 0,
        topResources: [],
        officialSource: { status: "notApplicable" },
        diversity: { distinctExactDomainCount: 0 },
        freshness: {
          status: "unavailable",
          reason: "noResources",
        },
      },
    ],
    duplicateResources: [],
    metrics: {
      version: "quality-metrics.v2",
      schemaValidity: "valid",
      nodeCount: 2,
      resourceCount: 4,
      plannedRequestDuplication: {
        totalCount: 2,
        uniqueCount: 2,
        intraNodeDuplicateOccurrenceCount: 0,
        crossNodeSharedGroupCount: 0,
        crossNodeExtraNodeOccurrenceCount: 0,
      },
      duplicateRate: {
        status: "measured",
        duplicateOccurrences: 0,
        totalOccurrences: 4,
        value: 0,
      },
      officialSource: { status: "notApplicable" },
      deadlineCompliance: { status: "within" },
    },
    metricFailure: null,
    telemetry: {
      timingsMs: {
        planning: 10,
        nodeProcessing: 20,
        total: 30,
        provider: { search: 10, extract: 10, llm: 10 },
      },
      counts: {
        logicalSearchCalls: 2,
        logicalExtractCalls: 1,
        extractUrlCount: 4,
        logicalLlmCalls: 2,
        searchHttpAttempts: 2,
        extractHttpAttempts: 1,
      },
      versions: { rankFusion: "rank-fusion.v1" },
      ranking: {
        llmSuccess: {
          nodeCount: 1,
          finalCandidateCount: 4,
          providerTop1OverrideCount: 1,
          heuristicTop1OverrideCount: 0,
          providerTop3FinalOverlapCount: 2,
          heuristicTop3FinalOverlapCount: 3,
          top3ComparisonSlots: 3,
        },
        fallback: {
          nodeCount: 0,
          finalCandidateCount: 0,
          providerTop1OverrideCount: 0,
          heuristicTop1OverrideCount: 0,
          providerTop3FinalOverlapCount: 0,
          heuristicTop3FinalOverlapCount: 0,
          top3ComparisonSlots: 0,
        },
      },
      tokens: {
        status: "complete",
        observations: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    },
  });
}

function createFailedResult(
  executionStatus:
    | "run_failed"
    | "cancelled"
    | "unexpected_internal_error",
): QualityEvalQueryResult {
  const runFailed = executionStatus === "run_failed";
  return QualityEvalQueryResultSchema.parse({
    schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
    comparisonKey: MALICIOUS_TEXT,
    query: {
      id: "wfq-010",
      query: MALICIOUS_TEXT,
      category: "navigateDownload",
      rationale: MALICIOUS_TEXT,
    },
    executionStatus,
    finalStatus: null,
    errorCode: runFailed ? "PLANNER_FAILED" : null,
    freshnessReferenceAt: null,
    plan: null,
    nodes: [],
    duplicateResources: [],
    metrics: null,
    metricFailure: {
      queryId: "wfq-010",
      metric: "execution",
      stage: "pipeline",
      code: runFailed
        ? "PLANNER_FAILED"
        : executionStatus === "cancelled"
          ? "cancelled"
          : "unexpected_internal_error",
    },
    telemetry: null,
  });
}

function render(
  results: readonly QualityEvalQueryResult[] = [createCompletedResult()],
  datasetKind: "golden" | "full" = "golden",
): string {
  return renderQualityEvalHumanReview({
    evaluationRunId: "2026-10-23T00-00-00-000Z-review-run",
    gitCommit: "a".repeat(40),
    dataset: {
      kind: datasetKind,
      version: QUALITY_EVAL_DATASET_VERSION,
      fingerprint: "b".repeat(64),
    },
    results,
  });
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function sliceSection(
  value: string,
  start: string,
  next: string | undefined,
): string {
  const startIndex = value.indexOf(start);
  const endIndex = next === undefined ? value.length : value.indexOf(next);
  return value.slice(startIndex, endIndex);
}

describe("WAY-88 人工质量评审工作表", () => {
  it("为 Graph、每个 Node 和实际 Top 3 Resource 生成独立评分与证据字段", () => {
    const review = render();

    expect(review).toContain(`Review Version：${QUALITY_HUMAN_REVIEW_VERSION}`);
    expect(review).toContain("Node 覆盖完整性（1～5）：待填写");
    expect(review).toContain("缺失 Node 证据：待填写");
    expect(review).toContain("Node 精简性（1～5）：待填写");
    expect(review).toContain("冗余 Node 对证据：待填写");
    expect(count(review, "命名清晰度（1～5）：待填写")).toBe(2);
    expect(review).toContain("完整保留 Resource 数量：4");
    expect(review).toContain(
      `新鲜度参考时间：${encodeMarkdownArtifactText("2026-10-23T00:00:00.000Z")}`,
    );
    expect(review).toContain(
      "新鲜度事实：measured；Top 3 数量 3；有日期 1；缺失日期 2",
    );
    expect(review).toContain(
      "新鲜度日期桶：1 天内 1；7 天内 0；30 天内 0；365 天内 0；更旧 0；未来 0",
    );
    expect(review).toContain(
      "新鲜度事实：unavailable / noResources；Top 3 数量 0；缺失日期 0",
    );
    expect(count(review, "#### Resource ")).toBe(3);
    expect(review).not.toContain("#### Resource 4");
    expect(review).toContain(encodeMarkdownArtifactText("Resource 2"));
    expect(review).toContain(encodeMarkdownArtifactText("Resource 3"));
    expect(review).toContain("### Edge 证据");
    expect(count(review, "- Edge ")).toBe(2);
    for (const label of [
      "相关性",
      "可信度",
      "信息质量",
      "新鲜度",
      "whySelected 有用性与真实性",
      "值得打开",
      "排名合理性",
    ]) {
      expect(count(review, `${label}（1～5`)).toBe(3);
      expect(count(review, `${label}证据：待填写`)).toBe(3);
    }
    expect(review.toLowerCase()).not.toContain("overallscore");
    expect(review).not.toContain("平均分：");
    expect(review).not.toContain("加权分：");
  });

  it("H1 至 H5 各自保留独立证据字段和三态结论", () => {
    const review = render();
    const headings = ["H1", "H2", "H3", "H4", "H5"].map(
      hypothesis => `## ${hypothesis} —`,
    );

    headings.forEach((heading, index) => {
      expect(count(review, heading)).toBe(1);
      const section = sliceSection(review, heading, headings[index + 1]);
      expect(section).toContain(
        "结论（supported / notSupported / inconclusive）：待填写",
      );
      expect(section).toContain("支持证据：待填写");
      expect(section).toContain("反对证据：待填写");
      expect(section).toContain("证据限制 / 协议偏差：待填写");
      expect(section).toContain("脱敏证据引用：待填写");
      for (const otherHeading of headings.filter(item => item !== heading)) {
        expect(section).not.toContain(otherHeading);
      }
    });
    expect(sliceSection(review, headings[0]!, headings[1])).toContain(
      "只能引用同数据呈现实验",
    );
    expect(sliceSection(review, headings[1]!, headings[2])).toContain(
      "只能引用盲化的同界面检索实验",
    );
    expect(review).not.toContain("Evidence Kind");
    expect(review).not.toContain("证据状态（");
  });

  it("不要求人员身份，也不提供教学话术或诱导问句", () => {
    const review = render();

    for (const forbidden of [
      "participantId",
      "reviewerName",
      "email",
      "phone",
      "contact",
      "signature",
      "consent",
      "姓名：",
      "邮箱：",
      "手机号：",
      "联系方式：",
      "账号：",
      "签名：",
      "同意记录：",
      "Participant ID：",
      "你是否",
      "是不是",
      "你应该",
      "Graph 更好",
      "箭头只是推荐",
      "节点可随便点",
      "Node 可随便点，不必按箭头走",
    ]) {
      expect(review).not.toContain(forbidden);
    }
    expect(review).toContain("不得记录可识别个人身份的信息");
  });

  it("把所有动态字符串收敛为纯文本，不形成 Markdown、HTML 或外链", () => {
    const encoded = encodeMarkdownArtifactText(MALICIOUS_TEXT);
    const review = render();

    expect(encoded).toMatch(/^(?:&#\d+;)*$/u);
    expect(review).toContain(encoded);
    expect(review).toContain(encodeMarkdownArtifactText("evil.example"));
    expect(review).toContain(
      encodeMarkdownArtifactText(
        `${QUALITY_EVAL_DATASET_VERSION}:wfq-009`,
      ),
    );
    expect(review).toContain(
      encodeMarkdownArtifactText("navigateDownload"),
    );
    expect(review).toContain(encodeMarkdownArtifactText("related-edge"));
    expect(review).toContain(encodeMarkdownArtifactText("related_to"));
    for (const forbidden of [
      MALICIOUS_TEXT,
      "https://evil.example",
      "evil.example",
      "related-edge",
      "related_to",
      "navigateDownload",
      "![",
      "](",
      "<img",
      "<script",
      "```",
    ]) {
      expect(review).not.toContain(forbidden);
    }
  });

  it.each([
    "run_failed",
    "cancelled",
    "unexpected_internal_error",
  ] as const)("%s 只记录稳定失败定位，不伪造空评分", executionStatus => {
    const review = render([createFailedResult(executionStatus)]);
    const querySection = review.slice(
      review.indexOf("## Query 1"),
      review.indexOf("## H1 —"),
    );

    expect(querySection).toContain(`执行状态：${executionStatus}`);
    expect(querySection).toContain("Failure metric / stage / code：");
    expect(querySection).toContain("评分可用性：unavailable");
    expect(querySection).not.toContain("Comparison Key：");
    expect(querySection).not.toContain("Query：");
    expect(querySection).not.toContain("分类：");
    expect(querySection).not.toContain(MALICIOUS_TEXT);
    expect(querySection).not.toContain(
      encodeMarkdownArtifactText(MALICIOUS_TEXT),
    );
    expect(querySection).not.toContain("### Node");
    expect(querySection).not.toContain("#### Resource");
    expect(querySection).not.toContain("（1～5）");
    expect(querySection).not.toContain("0 Node");
    expect(querySection).not.toContain("0 Resource");
    expect(querySection).not.toContain("0 分");
  });

  it("Golden 与 Full 只改变数据集元数据，评分正文完全一致", () => {
    const golden = render([createCompletedResult()], "golden");
    const full = render([createCompletedResult()], "full");

    expect(golden).toContain(`Review Version：${QUALITY_HUMAN_REVIEW_VERSION}`);
    expect(full).toContain(`Review Version：${QUALITY_HUMAN_REVIEW_VERSION}`);
    expect(golden.replace("- Dataset：golden", "- Dataset：<kind>"))
      .toBe(full.replace("- Dataset：full", "- Dataset：<kind>"));
  });

  it("拒绝绕过 quality-eval.v6 的非法结果", () => {
    const invalidResult = {
      ...createCompletedResult(),
      schemaVersion: "quality-eval.v5",
    } as unknown as QualityEvalQueryResult;

    expect(() => render([invalidResult])).toThrow();
  });
});
