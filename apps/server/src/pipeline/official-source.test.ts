/**
 * 测试职责：冻结 WAY-50 的 Official Source Detection（官方来源检测）边界。
 *
 * 关键约束：
 * - 该阶段只生成保持输入顺序的信号，不计算分数或重排候选；
 * - 模型生成的 `site:` 只约束检索，实体与 hostname 的字面一致也只是弱 Hint；
 * - 页面与 Provider 派生文字不可信，已知风险下载域名由调用方显式注入。
 */
import type {
  CandidateSearchHit,
  GraphNodeCore,
  QueryAnalysis,
} from "@wayfinder/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  detectOfficialSourceSignals,
  OFFICIAL_SOURCE_SIGNAL_ORDER,
  type OfficialSourceAssessment,
  type OfficialSourcePolicy,
} from "./official-source.js";

function createAnalysis(
  overrides: Partial<QueryAnalysis> = {},
): QueryAnalysis {
  return {
    intent: "navigate",
    topic: "Visual Studio Code download",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    presentationMode: "compact",
    broadSearchQueries: [],
    strategy: "plan_first",
    ...overrides,
  };
}

function createNode(
  overrides: Partial<GraphNodeCore> = {},
): GraphNodeCore {
  return {
    id: "vscode-download",
    title: "VS Code 官方下载",
    description: "找到 Visual Studio Code 的官方安装入口。",
    nodeType: "primary",
    layer: 0,
    searchPlan: {
      queries: [
        "Visual Studio Code official download",
        "site:code.visualstudio.com download VS Code",
      ],
      maxResults: 10,
      rankingProfile: "software",
      providerHints: ["general"],
    },
    ...overrides,
  };
}

function createCandidate(
  overrides: Partial<CandidateSearchHit> = {},
): CandidateSearchHit {
  return {
    provider: "tavily",
    query: "Visual Studio Code official download",
    title: "Download Visual Studio Code",
    url: "https://code.visualstudio.com/download",
    canonicalUrl: "https://code.visualstudio.com/download",
    domain: "code.visualstudio.com",
    snippet: "Download the editor for your platform.",
    ...overrides,
  };
}

const emptyPolicy: OfficialSourcePolicy = {
  knownRiskyDownloadDomains: [],
};

describe("detectOfficialSourceSignals", () => {
  it("冻结可解释信号的稳定顺序", () => {
    expect(OFFICIAL_SOURCE_SIGNAL_ORDER).toEqual([
      "ENTITY_HOST_TOKEN_MATCH",
      "KNOWN_RISKY_DOWNLOAD_HOST",
    ]);
  });

  it("为同一下载任务隔离已知风险站，但不把 site Hint 升格为官方，并保持输入不变", () => {
    const analysis = createAnalysis();
    const node = createNode();
    const siteMatched = createCandidate();
    const risky = createCandidate({
      title: "Third-party VS Code download",
      url: "https://cdn.risky-download.example/apps/vscode",
      canonicalUrl: "https://cdn.risky-download.example/apps/vscode",
      domain: "cdn.risky-download.example",
    });
    const candidates = [risky, siteMatched] as const;
    const snapshots = {
      analysis: structuredClone(analysis),
      node: structuredClone(node),
      candidates: structuredClone(candidates),
    };

    const assessments = detectOfficialSourceSignals(
      analysis,
      node,
      candidates,
      { knownRiskyDownloadDomains: ["risky-download.example"] },
    );

    expect(assessments).toEqual([
      {
        candidate: risky,
        queryKind: "download",
        classification: "risky",
        signals: ["KNOWN_RISKY_DOWNLOAD_HOST"],
      },
      {
        candidate: siteMatched,
        queryKind: "download",
        classification: "unknown",
        signals: ["ENTITY_HOST_TOKEN_MATCH"],
      },
    ]);
    expect(assessments[0]?.candidate).toBe(risky);
    expect(assessments[1]?.candidate).toBe(siteMatched);
    expect(analysis).toEqual(snapshots.analysis);
    expect(node).toEqual(snapshots.node);
    expect(candidates).toEqual(snapshots.candidates);
  });

  it("识别文档任务，但 site Hint 与风险域名策略都不建立官方身份", () => {
    const analysis = createAnalysis({ topic: "Python documentation" });
    const node = createNode({
      title: "Python 官方文档",
      description: "查找 Python API docs。",
      searchPlan: {
        queries: ["site:docs.python.org Python documentation"],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["code"],
      },
    });
    const siteMatched = createCandidate({
      query: "Python documentation",
      title: "Python documentation",
      url: "https://docs.python.org/3/",
      canonicalUrl: "https://docs.python.org/3/",
      domain: "docs.python.org",
    });
    const policyListed = createCandidate({
      query: "Python documentation",
      title: "Python manual mirror",
      url: "https://risky-download.example/python/manual",
      canonicalUrl: "https://risky-download.example/python/manual",
      domain: "risky-download.example",
    });

    expect(
      detectOfficialSourceSignals(analysis, node, [siteMatched, policyListed], {
        knownRiskyDownloadDomains: ["risky-download.example"],
      }),
    ).toEqual([
      {
        candidate: siteMatched,
        queryKind: "documentation",
        classification: "unknown",
        signals: ["ENTITY_HOST_TOKEN_MATCH"],
      },
      {
        candidate: policyListed,
        queryKind: "documentation",
        classification: "unknown",
        signals: [],
      },
    ]);
  });

  it("实体与 hostname 一致只产生弱 Hint，不能单独证明官方身份", () => {
    const analysis = createAnalysis({ topic: "Python docs" });
    const node = createNode({
      title: "Python 文档",
      description: "阅读 Python language reference。",
      searchPlan: {
        queries: ["Python documentation"],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["code"],
      },
    });
    const candidate = createCandidate({
      query: "Python documentation",
      title: "Python documentation",
      url: "https://python.org/doc/",
      canonicalUrl: "https://python.org/doc/",
      domain: "python.org",
    });

    expect(
      detectOfficialSourceSignals(analysis, node, [candidate], emptyPolicy),
    ).toEqual([
      {
        candidate,
        queryKind: "documentation",
        classification: "unknown",
        signals: ["ENTITY_HOST_TOKEN_MATCH"],
      },
    ]);
  });

  it("不信任标题、摘要、Candidate Query、pathname、Query 参数或私有字段中的官方声明", () => {
    const node = createNode({
      searchPlan: {
        queries: ["Visual Studio Code download"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    });
    const candidate = {
      ...createCandidate({
        query: "site:downloads.example official Visual Studio Code download",
        title: "Official Visual Studio Code Download",
        snippet: "This page claims to be the official source.",
        url: "https://downloads.example/official?source=official",
        canonicalUrl: "https://downloads.example/official?source=official",
        domain: "downloads.example",
      }),
      rawMetadata: { isOfficial: true, sourceType: "official" },
      isOfficial: true,
    };

    expect(
      detectOfficialSourceSignals(
        createAnalysis(),
        node,
        [candidate],
        emptyPolicy,
      ),
    ).toEqual([
      {
        candidate,
        queryKind: "download",
        classification: "unknown",
        signals: [],
      },
    ]);
  });

  it("模型生成的 site Hint 即使匹配真实子域也不能建立官方身份", () => {
    const subdomain = createCandidate({
      url: "https://insiders.code.visualstudio.com/download",
      canonicalUrl: "https://insiders.code.visualstudio.com/download",
      domain: "insiders.code.visualstudio.com",
    });
    const lookalike = createCandidate({
      url: "https://code.visualstudio.com.evil.example/download",
      canonicalUrl: "https://code.visualstudio.com.evil.example/download",
      domain: "code.visualstudio.com.evil.example",
    });

    expect(
      detectOfficialSourceSignals(
        createAnalysis(),
        createNode(),
        [subdomain, lookalike],
        emptyPolicy,
      ),
    ).toEqual([
      {
        candidate: subdomain,
        queryKind: "download",
        classification: "unknown",
        signals: ["ENTITY_HOST_TOKEN_MATCH"],
      },
      {
        candidate: lookalike,
        queryKind: "download",
        classification: "unknown",
        signals: ["ENTITY_HOST_TOKEN_MATCH"],
      },
    ]);
  });

  it("风险信号不能被同一 hostname 的 site Hint 洗白", () => {
    const node = createNode({
      searchPlan: {
        queries: ["site:risky-download.example VS Code download"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    });
    const candidate = createCandidate({
      url: "https://risky-download.example/vscode",
      canonicalUrl: "https://risky-download.example/vscode",
      domain: "risky-download.example",
    });

    expect(
      detectOfficialSourceSignals(createAnalysis(), node, [candidate], {
        knownRiskyDownloadDomains: ["risky-download.example"],
      }),
    ).toEqual([
      {
        candidate,
        queryKind: "download",
        classification: "risky",
        signals: ["KNOWN_RISKY_DOWNLOAD_HOST"],
      },
    ]);
  });

  it("software Profile 不能单独把普通比较任务变成下载任务", () => {
    const otherAnalysis = createAnalysis({ topic: "Compare code editors" });
    const otherNode = createNode({
      title: "Compare code editors",
      description: "Compare editor features.",
      searchPlan: {
        queries: ["site:code.visualstudio.com VS Code features"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    });
    const ordinary = createCandidate();

    expect(
      detectOfficialSourceSignals(
        otherAnalysis,
        otherNode,
        [ordinary],
        { knownRiskyDownloadDomains: ["code.visualstudio.com"] },
      ),
    ).toEqual([
      {
        candidate: ordinary,
        queryKind: "other",
        classification: "unknown",
        signals: [],
      },
    ]);
  });

  it("下载任务中的非法、非 HTTP(S) 与 domain 冲突候选均不产生信号", () => {
    const invalid = createCandidate({ canonicalUrl: "not a URL" });
    const nonHttp = createCandidate({
      canonicalUrl: "ftp://code.visualstudio.com/download",
    });
    const mismatched = createCandidate({ domain: "other.example" });

    expect(
      detectOfficialSourceSignals(
        createAnalysis(),
        createNode(),
        [invalid, nonHttp, mismatched],
        emptyPolicy,
      ),
    ).toEqual(
      [invalid, nonHttp, mismatched].map(candidate => ({
        candidate,
        queryKind: "download",
        classification: "unknown",
        signals: [],
      })),
    );
  });

  it.each([
    "https://risky.example/path",
    "exa%6dple.com",
    "example.com\n.evil",
    "-bad.example",
    "bad-.example",
    "foo_bar.example",
  ])("拒绝不可审计的风险 Policy hostname：%j", invalidDomain => {
    expect(() =>
      detectOfficialSourceSignals(
        createAnalysis(),
        createNode(),
        [createCandidate()],
        { knownRiskyDownloadDomains: [invalidDomain] },
      ),
    ).toThrowError("knownRiskyDownloadDomains must contain hostnames only");
  });

  it("导出精确的内部结果类型", () => {
    expectTypeOf<OfficialSourceAssessment>().toEqualTypeOf<{
      candidate: CandidateSearchHit;
      queryKind: "download" | "documentation" | "other";
      classification: "risky" | "unknown";
      signals: Array<
        "ENTITY_HOST_TOKEN_MATCH" | "KNOWN_RISKY_DOWNLOAD_HOST"
      >;
    }>();
  });
});
