/** 并发合并回归使用固定人工图，覆盖独立字段、冲突、集合排序及合并后系统硬约束。 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, EditableResourceSchema, type EditableGraph } from "@wayfinder/contracts";
import { assertGroupResourceUrls, mergeGroupEdit, normalizeGroupCreate } from "./merge.js";

function resource(id: string, url = `https://fixture.example/${id}`, rank = 1) {
  return EditableResourceSchema.parse({ id, title: id, url, canonicalUrl: url, domain: "fixture.example",
    summary: "", whySelected: "", sourceType: "user_added", rank, origin: "manual" });
}
function graph(): EditableGraph {
  return EditableGraphSchema.parse({ version: "workspace.v1", id: "fixture_graph", title: "资料", query: "", language: "zh-CN",
    presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastRunId: null,
    nodes: [{ id: "n1", title: "节点1", description: "", nodeType: "primary", layer: 0, status: "edited", resources: [resource("r1")], warnings: [] },
      { id: "n2", title: "节点2", description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] }],
    edges: [], positions: { n1: { x: 0, y: 0 }, n2: { x: 200, y: 0 } } });
}
function changed(input: EditableGraph, action: (copy: EditableGraph) => void): EditableGraph {
  const copy = structuredClone(input); action(copy); return EditableGraphSchema.parse(copy);
}
const rejected = (action: () => unknown, code: string): void => {
  try { action(); throw new Error("预期拒绝但操作成功"); }
  catch (error: unknown) { expect(error).toMatchObject({ code }); }
};

describe("共享图确定性差异合并", () => {
  it.each([
    { url: "https://fixture.example", status: "ready", warnings: [] },
    { url: "https://Fixture.Example", status: "partial", warnings: ["RERANK_FAILED"] },
  ] as const)("改图名或其他节点保留未触碰搜索资源表示与状态：$status", sample => {
    const before = changed(graph(), copy => {
      copy.nodes[0]!.resources[0] = { ...resource("r1", sample.url), canonicalUrl: "https://fixture.example/",
        origin: "search", searchProvider: "fixture-search" };
      copy.nodes[0]!.status = sample.status; copy.nodes[0]!.warnings = [...sample.warnings];
    });
    assertGroupResourceUrls(before);
    const renamed = mergeGroupEdit(before, before, { ...before, title: "新图名" });
    expect(renamed.nodes[0]).toEqual(before.nodes[0]);
    const other = changed(before, copy => { copy.nodes[1]!.title = "另一节点"; });
    expect(mergeGroupEdit(before, before, other).nodes[0]).toEqual(before.nodes[0]);
  });

  it("客户端只改派生状态不能把人工节点伪造成ready", () => {
    const before = graph();
    const after = changed(before, copy => { copy.nodes[0]!.status = "ready"; });
    expect(mergeGroupEdit(before, before, after)).toEqual(before);
  });

  it("手工修改不能伪造运行身份、AI分析或搜索计划，原可信元数据保持", () => {
    const analysis = { intent: "learn" as const, topic: "学习", freshnessSensitive: false, ambiguityLevel: "low" as const,
      broadSearchQueries: [], strategy: "plan_first" as const, presentationMode: "graph" as const };
    const plan = { queries: ["固定检索"], maxResults: 20, rankingProfile: "software" as const, providerHints: ["code" as const] };
    const before = graph();
    const forged = changed(before, copy => { copy.lastRunId = "fake-run"; copy.analysis = analysis; copy.nodes[0]!.searchPlan = plan; });
    expect(mergeGroupEdit(before, before, forged)).toEqual(before);
    const trusted = changed(before, copy => { copy.lastRunId = "real-run"; copy.analysis = analysis; copy.nodes[0]!.searchPlan = plan; });
    const edited = changed(trusted, copy => { copy.title = "手工改名"; copy.lastRunId = "fake-run";
      copy.analysis = { ...analysis, topic: "伪造" }; copy.nodes[0]!.searchPlan = { ...plan, queries: ["伪造检索"] }; });
    const result = mergeGroupEdit(trusted, trusted, edited);
    expect(result.lastRunId).toBe("real-run"); expect(result.analysis).toEqual(analysis); expect(result.nodes[0]?.searchPlan).toEqual(plan);
  });

  it("普通新建规范实际URL并剥离伪造搜索来源，复制只校验不改写来源", () => {
    const source = changed(graph(), copy => {
      copy.nodes[0]!.resources[0] = { ...resource("r1"), origin: "search", searchProvider: "fixture-search" };
      copy.nodes[0]!.status = "ready";
    });
    const created = normalizeGroupCreate(source);
    expect(created.nodes[0]?.status).toBe("edited");
    expect(created.nodes[0]?.resources[0]?.origin).toBe("manual");
    expect(created.nodes[0]?.resources[0]).not.toHaveProperty("searchProvider");
    assertGroupResourceUrls(source);
    expect(source.nodes[0]?.resources[0]?.origin).toBe("search");
    const duplicate = changed(source, copy => {
      copy.nodes[0]!.resources.push({ ...resource("second", "https://fixture.example/r1", 2), canonicalUrl: "https://fixture.example/forged" });
    });
    rejected(() => normalizeGroupCreate(duplicate), "GROUP_CONSTRAINT");
    rejected(() => assertGroupResourceUrls(duplicate), "GROUP_CONSTRAINT");
  });

  it("同一节点不同字段和不同对象的操作保留双方贡献", () => {
    const before = graph();
    const current = changed(before, copy => { copy.nodes[0]!.title = "甲的标题"; copy.title = "甲的图名"; });
    const after = changed(before, copy => { copy.nodes[0]!.description = "乙的说明"; copy.nodes[1]!.title = "乙的节点"; });
    const merged = mergeGroupEdit(current, before, after);
    expect(merged.title).toBe("甲的图名");
    expect(merged.nodes[0]).toMatchObject({ title: "甲的标题", description: "乙的说明" });
    expect(merged.nodes[1]?.title).toBe("乙的节点");
    expect(current.nodes[0]?.description).toBe(""); expect(before.title).toBe("资料");
  });

  it("同字段不同值冲突，相同值收敛且不覆盖其他字段", () => {
    const before = graph(), current = { ...before, title: "甲" };
    rejected(() => mergeGroupEdit(current, before, { ...before, title: "乙" }), "GROUP_CONFLICT");
    expect(mergeGroupEdit(current, before, { ...before, title: "甲" }).title).toBe("甲");
  });

  it("独立新增资源按既有相邻锚点合并并重新连续编号", () => {
    const before = graph();
    const current = changed(before, copy => { copy.nodes[0]!.resources.push(resource("a", undefined, 2)); });
    const after = changed(before, copy => { copy.nodes[0]!.resources.push(resource("b", undefined, 2)); });
    const merged = mergeGroupEdit(current, before, after);
    // 乙看见的最后一个相邻资源是r1；复用原重放规则将b放在该锚点后，仍保留甲的a。
    expect(merged.nodes[0]?.resources.map(value => [value.id, value.rank])).toEqual([["r1", 1], ["b", 2], ["a", 3]]);
  });

  it("服务端规范真实URL，伪造canonicalUrl不能绕过全图去重", () => {
    const before = graph();
    const current = changed(before, copy => { copy.nodes[0]!.resources.push(resource("a", "https://fixture.example/same", 2)); });
    const after = changed(before, copy => {
      const incoming = resource("b", "https://fixture.example/same?utm_source=fixture#section", 2);
      incoming.canonicalUrl = "https://fixture.example/forged";
      copy.nodes[0]!.resources.push(incoming);
    });
    rejected(() => mergeGroupEdit(current, before, after), "GROUP_CONSTRAINT");
    expect(current.nodes[0]?.resources).toHaveLength(2);
  });

  it("两条各自合法的推荐边合并成环时拒绝整次操作", () => {
    const before = graph();
    const current = changed(before, copy => { copy.edges.push({ id: "a", source: "n1", target: "n2", type: "recommended_next" }); });
    const after = changed(before, copy => { copy.edges.push({ id: "b", source: "n2", target: "n1", type: "recommended_next" }); });
    rejected(() => mergeGroupEdit(current, before, after), "GROUP_CONSTRAINT");
    expect(current.edges.map(value => value.id)).toEqual(["a"]);
  });

  it("删除对象不能丢弃别人的新编辑或新连线", () => {
    const before = graph();
    const after = changed(before, copy => { copy.nodes = copy.nodes.filter(node => node.id !== "n1"); delete copy.positions.n1; });
    const edited = changed(before, copy => { copy.nodes[0]!.description = "其他人的内容"; });
    rejected(() => mergeGroupEdit(edited, before, after), "GROUP_CONFLICT");
    const connected = changed(before, copy => { copy.edges.push({ id: "new_edge", source: "n1", target: "n2", type: "related_to" }); });
    rejected(() => mergeGroupEdit(connected, before, after), "GROUP_DEPENDENCY");
  });

  it("资源排序与另人的追加兼容，两个不同排序意图冲突", () => {
    const before = changed(graph(), copy => { copy.nodes[0]!.resources = [resource("r1"), resource("r2", undefined, 2), resource("r3", undefined, 3)]; });
    const after = changed(before, copy => { copy.nodes[0]!.resources = [resource("r1"), resource("r3", undefined, 2), resource("r2", undefined, 3)]; });
    const appended = changed(before, copy => { copy.nodes[0]!.resources.push(resource("a", undefined, 4)); });
    expect(mergeGroupEdit(appended, before, after).nodes[0]?.resources.map(value => value.id)).toEqual(["r1", "r3", "r2", "a"]);
    const reordered = changed(before, copy => { copy.nodes[0]!.resources = [resource("r2"), resource("r1", undefined, 2), resource("r3", undefined, 3)]; });
    rejected(() => mergeGroupEdit(reordered, before, after), "GROUP_CONFLICT");
  });

  it("不同节点移动可合并，同一节点不同位置冲突", () => {
    const before = graph();
    const current = changed(before, copy => { copy.positions.n1 = { x: 20, y: 10 }; });
    const after = changed(before, copy => { copy.positions.n2 = { x: 220, y: 10 }; });
    expect(mergeGroupEdit(current, before, after).positions).toEqual({ n1: { x: 20, y: 10 }, n2: { x: 220, y: 10 } });
    rejected(() => mergeGroupEdit(current, before, changed(before, copy => { copy.positions.n1 = { x: 30, y: 20 }; })), "GROUP_CONFLICT");
  });

  it("换资源URL去掉旧搜索来源，输入不能修改图身份和创建时间", () => {
    const before = changed(graph(), copy => {
      copy.nodes[0]!.resources[0] = { ...resource("r1"), origin: "search", searchProvider: "fixture-search" };
    });
    const after = changed(before, copy => {
      copy.createdAt = "2020-01-01T00:00:00.000Z"; copy.nodes[0]!.resources[0]!.url = "https://fixture.example/changed?utm_source=test#part";
    });
    const merged = mergeGroupEdit(before, before, after);
    expect(merged.createdAt).toBe(before.createdAt);
    expect(merged.nodes[0]?.resources[0]).toMatchObject({ origin: "manual", sourceType: "user_added", canonicalUrl: "https://fixture.example/changed" });
    expect(merged.nodes[0]?.resources[0]).not.toHaveProperty("searchProvider");
    rejected(() => mergeGroupEdit(before, before, { ...after, id: "other_graph" }), "GROUP_CONFLICT");
  });
});
