/**
 * 测试职责：验证 WAY-29 Python Mock ResultGraph（模拟结果图）的协议合法性与演示覆盖面。
 *
 * 关键约束：
 * - 只使用固定本地数据，不读取环境变量，也不调用真实 AI 或 Search Provider。
 * - 覆盖断言锁定产品演示所需语义，不复制 ResultGraphSchema 的内部校验实现。
 */
import { ResultGraphSchema } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { pythonResultGraphFixture } from "./python-result-graph.js";

const completeResourceFields = [
  "id",
  "title",
  "url",
  "canonicalUrl",
  "domain",
  "sourceType",
  "summary",
  "whySelected",
  "rank",
  "scores",
  "searchProvider",
  "publishedAt",
] as const;

describe("Python Mock ResultGraph fixture", () => {
  it("通过官方 ResultGraph Schema", () => {
    expect(ResultGraphSchema.parse(pythonResultGraphFixture)).toEqual(
      pythonResultGraphFixture,
    );
  });

  it("覆盖主节点、相关节点、两种边与三个最终状态", () => {
    const nodeTypes = new Set(
      pythonResultGraphFixture.graph.nodes.map(node => node.nodeType),
    );
    const edgeTypes = new Set(
      pythonResultGraphFixture.graph.edges.map(edge => edge.type),
    );
    const statuses = new Set(
      pythonResultGraphFixture.graph.nodes.map(node => node.status),
    );

    expect(nodeTypes).toEqual(new Set(["primary", "related"]));
    expect(edgeTypes).toEqual(
      new Set(["recommended_next", "related_to"]),
    );
    expect(statuses).toEqual(new Set(["ready", "partial", "failed"]));
  });

  it("为每个可交付 Resource 提供完整字段", () => {
    const resources = pythonResultGraphFixture.graph.nodes.flatMap(
      node => node.resources,
    );

    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(Object.keys(resource).sort()).toEqual(
        [...completeResourceFields].sort(),
      );
      expect(resource.domain).toBe(
        new URL(resource.canonicalUrl).hostname.toLowerCase(),
      );
    }
  });

  it("保持固定输出且不携带 Secret 字段或真实 Provider 标识", () => {
    const serializedFixture = JSON.stringify(pythonResultGraphFixture);
    const resourceProviders = pythonResultGraphFixture.graph.nodes.flatMap(
      node => node.resources.map(resource => resource.searchProvider),
    );

    expect(pythonResultGraphFixture.runId).toBe("run-mock-python");
    expect(pythonResultGraphFixture.meta.createdAt).toBe(
      "2026-01-01T00:00:00Z",
    );
    expect(pythonResultGraphFixture.meta.providersUsed).toEqual(["mock"]);
    expect(new Set(resourceProviders)).toEqual(new Set(["mock"]));
    for (const node of pythonResultGraphFixture.graph.nodes) {
      expect(node.searchPlan.queries).toHaveLength(2);
      expect(node.searchPlan.providerHints).toEqual(["general"]);
    }
    expect(serializedFixture).not.toMatch(
      /api[_-]?key|authorization|bearer\s|cookie|client[_-]?secret/i,
    );
  });
});
