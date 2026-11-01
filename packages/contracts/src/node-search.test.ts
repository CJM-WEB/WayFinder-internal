/** 测试职责：节点重搜仅接受当前目标，不把人工全图或旧记录强行套入搜索计划协议。 */
import { describe, expect, it } from "vitest";
import { NodeSearchContextSchema, SearchRequestSchema } from "./index.js";

const context = {
  node: { id: "8094ac90-75b6-4a8d-badf-74c294b37a22", title: "新节点", description: "" },
  analysis: null,
};

describe("单节点重搜协议", () => {
  it("接受手动节点 UUID、空说明和未知分析，并保留普通旧请求形状", () => {
    expect(NodeSearchContextSchema.parse(context)).toEqual(context);
    const request = { runId: "run", query: "原图主题", language: "zh-CN" };
    expect(SearchRequestSchema.parse(request)).toEqual(request);
    expect(SearchRequestSchema.parse({ ...request, nodeSearch: context }).nodeSearch).toEqual(context);
  });

  it("拒绝空目标、错误分析以及携带整图或资源的上下文", () => {
    for (const invalid of [
      { ...context, node: { ...context.node, title: "  " } },
      { ...context, node: { ...context.node, id: "" } },
      { ...context, analysis: {} },
      { ...context, nodes: Array.from({ length: 12 }, () => context.node) },
      { ...context, node: { ...context.node, resources: [] } },
    ]) expect(NodeSearchContextSchema.safeParse(invalid).success).toBe(false);
  });
});
