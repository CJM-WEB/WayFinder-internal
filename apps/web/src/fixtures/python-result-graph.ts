/**
 * 模块职责：提供 D1 Mock Product（模拟产品）唯一的 Python ResultGraph 固定数据。
 *
 * 关键约束：
 * - 数据只描述产品展示，不调用 AI、Search Provider（搜索提供方）或读取环境变量。
 * - 固定 runId、时间与排序分数，确保测试、演示和后续 Graph 渲染结果可复现。
 * - 生产模块只依赖共享 ResultGraph 类型；官方 Schema 运行时校验保留在同目录测试中。
 */
import type { ResultGraph } from "@wayfinder/contracts";

export const pythonResultGraphFixture: ResultGraph = {
  version: "0.1",
  runId: "run-mock-python",
  query: {
    raw: "Python",
    normalized: "Python",
    language: "zh-CN",
  },
  analysis: {
    intent: "learn",
    topic: "Python",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "graph",
  },
  graph: {
    nodes: [
      {
        id: "python-introduction",
        title: "Python 简介",
        description: "了解 Python 的定位、核心特性与常见使用场景。",
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: [
            "Python language official overview",
            "Python features and use cases official",
          ],
          maxResults: 10,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
        status: "ready",
        resources: [
          {
            id: "resource-python-home",
            title: "Python Programming Language",
            url: "https://www.python.org/",
            canonicalUrl: "https://www.python.org/",
            domain: "www.python.org",
            sourceType: "official_website",
            summary: "Python 官方网站，集中提供语言介绍、文档与社区入口。",
            whySelected: "官方一手来源，适合作为理解 Python 的起点。",
            rank: 1,
            scores: {
              relevance: 1,
              authority: 1,
            },
            searchProvider: "mock",
            publishedAt: null,
          },
        ],
        warnings: [],
      },
      {
        id: "python-installation",
        title: "安装与开发环境",
        description: "选择 Python 版本并完成基础开发环境配置。",
        nodeType: "primary",
        layer: 1,
        searchPlan: {
          queries: [
            "Python official installation guide",
            "install Python Windows macOS official",
          ],
          maxResults: 10,
          rankingProfile: "software",
          providerHints: ["general"],
        },
        status: "partial",
        resources: [
          {
            id: "resource-python-downloads",
            title: "Download Python",
            url: "https://www.python.org/downloads/",
            canonicalUrl: "https://www.python.org/downloads/",
            domain: "www.python.org",
            sourceType: "official_download",
            summary: "Python 官方下载入口，提供主流平台的安装包。",
            whySelected: "直接满足安装需求，且来源由 Python 官方维护。",
            rank: 1,
            scores: {
              relevance: 1,
              authority: 1,
            },
            searchProvider: "mock",
            publishedAt: null,
          },
        ],
        // 模拟 Extract（正文抽取）局部失败，但保留仍可交付的官方下载资源。
        warnings: ["EXTRACTION_FAILED"],
      },
      {
        id: "python-basics",
        title: "基础语法",
        description: "学习 Python 的基础语法、控制流与核心数据结构。",
        nodeType: "primary",
        layer: 2,
        searchPlan: {
          queries: [
            "Python official tutorial syntax",
            "Python beginner syntax tutorial",
          ],
          maxResults: 10,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
        status: "ready",
        resources: [
          {
            id: "resource-python-tutorial",
            title: "The Python Tutorial",
            url: "https://docs.python.org/3/tutorial/",
            canonicalUrl: "https://docs.python.org/3/tutorial/",
            domain: "docs.python.org",
            sourceType: "official_documentation",
            summary: "Python 官方教程，覆盖语言基础、控制流、函数与数据结构。",
            whySelected: "官方内容结构完整，能够支撑基础语法节点的主要学习需求。",
            rank: 1,
            scores: {
              relevance: 0.99,
              authority: 1,
            },
            searchProvider: "mock",
            publishedAt: null,
          },
        ],
        warnings: [],
      },
      {
        id: "python-third-party-libraries",
        title: "第三方库",
        description: "探索 Python 生态中的常用第三方库与应用方向。",
        nodeType: "related",
        layer: 3,
        searchPlan: {
          queries: [
            "Python third-party library ecosystem",
            "Python package ecosystem overview",
          ],
          maxResults: 10,
          rankingProfile: "software",
          providerHints: ["general"],
        },
        status: "failed",
        resources: [],
        warnings: [],
        // 模拟单 Node 搜索失败，验证 Graph 仍能保留其他可交付节点。
        error: {
          code: "SEARCH_PROVIDER_FAILED",
          retryable: true,
        },
      },
    ],
    edges: [
      {
        id: "edge-introduction-installation",
        source: "python-introduction",
        target: "python-installation",
        type: "recommended_next",
      },
      {
        id: "edge-installation-basics",
        source: "python-installation",
        target: "python-basics",
        type: "recommended_next",
      },
      {
        id: "edge-basics-third-party-libraries",
        source: "python-basics",
        target: "python-third-party-libraries",
        type: "related_to",
      },
    ],
  },
  meta: {
    createdAt: "2026-01-01T00:00:00Z",
    providersUsed: ["mock"],
    partial: true,
    timingMs: {
      total: 320,
      planning: 40,
      search: 220,
      finalization: 60,
    },
    warnings: ["第三方库节点使用固定失败样例，以演示单节点失败隔离。"],
  },
};
