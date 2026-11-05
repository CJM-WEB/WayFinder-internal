/** 测试职责：编辑态允许人工空态与累计资源，同时保留全图身份、URL 和推荐顺序边界。 */
import { describe, expect, it } from "vitest";
import {
  EditableGraphSchema,
  type EditableGraph,
  type EditableNode,
  type EditableResource,
} from "./index.js";

const manualResource = (id: string, rank = 1): EditableResource => ({
  id, origin: "manual", title: id, url: `https://example.com/${id}`,
  canonicalUrl: `https://example.com/${id}`, domain: "example.com", sourceType: "user_added",
  summary: "", whySelected: "", rank,
});
const emptyNode = (id: string): EditableNode => ({
  id, title: id, description: "", nodeType: "primary", layer: 0,
  status: "empty", resources: [], warnings: [],
});
const emptyGraph = (): EditableGraph => ({
  version: "workspace.v1", id: "图一", title: "新搜索", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  lastRunId: null, nodes: [], edges: [], positions: {},
});

const expectRejected = (graph: unknown): void => {
  expect(EditableGraphSchema.safeParse(graph).success).toBe(false);
};

describe("可编辑图协议", () => {
  it("旧记录可缺少分析，手动图可明确记录未知分析", () => {
    const legacy = emptyGraph();
    expect(EditableGraphSchema.parse(legacy)).toEqual(legacy);
    expect(EditableGraphSchema.parse({ ...legacy, analysis: null }).analysis).toBeNull();
    const analysis = {
      intent: "learn", topic: "主题", freshnessSensitive: false, ambiguityLevel: "low",
      strategy: "plan_first", broadSearchQueries: [], presentationMode: "graph",
    };
    expect(EditableGraphSchema.parse({ ...legacy, analysis }).analysis).toEqual(analysis);
  });

  it("图与节点保存下一次引擎偏好，不改写既有资源来源", () => {
    const resource = { ...manualResource("资源"), origin: "search" as const, searchProvider: "serpapi_bing", engine: "google" as const };
    const graph = EditableGraphSchema.parse({
      ...emptyGraph(), engine: "baidu",
      nodes: [{ ...emptyNode("节点"), engine: "google", status: "edited", resources: [resource] }],
    });
    expect(graph.engine).toBe("baidu");
    expect(graph.nodes[0]?.engine).toBe("google");
    expect(graph.nodes[0]?.resources[0]).toMatchObject({ origin: "search", engine: "google" });
  });

  it("允许空图、空节点及超过 AI 初稿上限的节点和资源", () => {
    const graph = emptyGraph();
    expect(EditableGraphSchema.parse(graph)).toEqual(graph);
    graph.nodes = Array.from({ length: 12 }, (_, index) => emptyNode(`节点${index}`));
    const first = graph.nodes[0];
    if (first === undefined) throw new Error("缺少测试节点");
    first.status = "edited";
    first.resources = Array.from({ length: 12 }, (_, index) => manualResource(`资源${index}`, index + 1));
    expect(EditableGraphSchema.parse(graph).nodes[0]?.resources).toHaveLength(12);
  });

  it("手动资源允许空说明但拒绝伪造搜索来源，搜索资源必须保存来源", () => {
    const graph = { ...emptyGraph(), nodes: [{ ...emptyNode("节点"), status: "edited" as const, resources: [manualResource("资源")] }] };
    expect(EditableGraphSchema.safeParse(graph).success).toBe(true);
    const resource = graph.nodes[0]?.resources[0];
    if (resource === undefined) throw new Error("缺少测试资源");
    expectRejected({ ...graph, nodes: [{ ...graph.nodes[0], resources: [{ ...resource, searchProvider: "伪造" }] }] });
    expectRejected({ ...graph, nodes: [{ ...graph.nodes[0], resources: [{ ...resource, origin: "search" }] }] });
    expect(EditableGraphSchema.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], resources: [{ ...resource, origin: "search", searchProvider: "serpapi_bing" }] }] }).success).toBe(true);
  });

  it("拒绝重复节点和资源标识、全图重复 URL 与不连续序位", () => {
    const graph = emptyGraph();
    graph.nodes = [emptyNode("节点一"), emptyNode("节点二")];
    expectRejected({ ...graph, nodes: [emptyNode("重复"), emptyNode("重复")] });
    expectRejected({ ...graph, nodes: [{ ...emptyNode("节点一"), status: "edited", resources: [manualResource("资源一"), { ...manualResource("资源二", 2), id: "资源一" }] }] });
    expectRejected({ ...graph, nodes: graph.nodes.map(node => ({ ...node, status: "edited", resources: [manualResource("相同地址")] })) });
    expectRejected({ ...graph, nodes: [{ ...emptyNode("节点一"), status: "edited", resources: [manualResource("资源一", 2)] }] });
  });

  it("拒绝悬空连线、重复边标识与悬空坐标", () => {
    const graph = { ...emptyGraph(), nodes: [emptyNode("节点一"), emptyNode("节点二")] };
    const edge = { id: "边", source: "节点一", target: "节点二", type: "related_to" as const };
    expectRejected({ ...graph, edges: [{ ...edge, target: "不存在" }] });
    expectRejected({ ...graph, edges: [edge, edge] });
    expectRejected({ ...graph, positions: { 不存在: { x: 0, y: 0 } } });
    expectRejected({ ...graph, positions: { 节点一: { x: Infinity, y: 0 } } });
  });

  it("相关线允许成环，推荐下一步禁止成环；人工图不要求连通", () => {
    const graph = { ...emptyGraph(), nodes: [emptyNode("甲"), emptyNode("乙"), emptyNode("独立节点")] };
    const edges = [
      { id: "一", source: "甲", target: "乙", type: "related_to" as const },
      { id: "二", source: "乙", target: "甲", type: "related_to" as const },
    ];
    expect(EditableGraphSchema.safeParse({ ...graph, edges }).success).toBe(true);
    expectRejected({ ...graph, edges: edges.map(edge => ({ ...edge, type: "recommended_next" })) });
    expectRejected({ ...graph, edges: [{ id: "自环", source: "甲", target: "甲", type: "recommended_next" }] });
  });

  it("不把用户删空包装为搜索失败，也不接受伪造的搜索成功", () => {
    const node = emptyNode("节点");
    for (const status of ["ready", "partial", "failed"] as const) {
      expectRejected({ ...emptyGraph(), nodes: [{ ...node, status }] });
    }
    expect(EditableGraphSchema.safeParse({ ...emptyGraph(), nodes: [{ ...node, status: "edited" }] }).success).toBe(true);
    expect(EditableGraphSchema.safeParse({ ...emptyGraph(), nodes: [{ ...node, status: "failed", error: { code: "SEARCH_PROVIDER_FAILED", retryable: true } }] }).success).toBe(true);
  });
});
