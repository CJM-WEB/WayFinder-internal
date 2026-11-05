/**
 * 模块职责：把已完成的重搜结果明确应用到当前最新编辑图，预览与网络生命周期由界面协调。
 * 边界：本轮每节点最多接纳 6 项，不补位；按应用范围重新去重；失败或目标消失保留原图。
 * 返回新快照后由 replaceGraph 一次提交，完整替换也只有一个撤销步骤。
 */
import {
  EditableGraphSchema, ResultGraphSchema,
  type EditableGraph, type EditableNode, type EditableResource, type ResultGraph,
} from "@wayfinder/contracts";
import { buildGraphFlowElements } from "../components/Graph/graph-layout.js";
import { fromResultGraph } from "./workspace-store.js";

const MAX_NEW_RESOURCES_PER_NODE = 6;

export function applyNodeSearchResult(
  graph: EditableGraph, nodeId: string, input: ResultGraph, mode: "append" | "replace",
): EditableGraph {
  const result = ResultGraphSchema.parse(input);
  const previous = graph.nodes.find(node => node.id === nodeId);
  const incoming = result.graph.nodes.find(node => node.id === nodeId);
  if (previous === undefined || incoming === undefined || incoming.status === "failed") return graph;

  // 追加检查全图；替换排除即将覆盖的本节点，但仍尊重其他节点现有 URL 所有权。
  const occupied = new Set(graph.nodes
    .filter(node => mode === "append" || node.id !== nodeId)
    .flatMap(node => node.resources.map(resource => resource.canonicalUrl)));
  const kept = mode === "append" ? previous.resources : [];
  const ids = new Set(kept.map(resource => resource.id));
  const additions: EditableResource[] = [];
  for (const resource of incoming.resources.slice(0, MAX_NEW_RESOURCES_PER_NODE)) {
    if (occupied.has(resource.canonicalUrl)) continue;
    occupied.add(resource.canonicalUrl);
    // 不同搜索运行可能重用候选 ID；新资源拥有独立身份，旧资源 ID 保持不变。
    const prefix = `${result.runId}:${resource.id}`;
    let id = prefix;
    let suffix = 1;
    while (ids.has(id)) id = `${prefix}:${suffix++}`;
    ids.add(id);
    additions.push({ ...resource, id, origin: "search" });
  }
  if (additions.length === 0) return graph;

  const node: EditableNode = {
    ...previous, status: incoming.status, warnings: incoming.warnings,
    searchPlan: incoming.searchPlan,
    resources: [...kept, ...additions].map((resource, index) => ({ ...resource, rank: index + 1 })),
  };
  delete node.error;
  return EditableGraphSchema.parse({
    ...graph, lastRunId: result.runId, updatedAt: new Date().toISOString(),
    nodes: graph.nodes.map(current => current.id === nodeId ? node : current),
  });
}

export function applyGraphSearchResult(graph: EditableGraph, input: ResultGraph): EditableGraph {
  const result = ResultGraphSchema.parse(input);
  if (!result.graph.nodes.some(node => node.resources.length > 0)) return graph;
  const generated = fromResultGraph(result, graph.id);
  // 全图只在新结果内校验去重；旧图同 URL 不影响明确替换，不混入旧节点或连线。
  const nodes = generated.nodes.map(node => ({
    ...node, resources: node.resources.slice(0, MAX_NEW_RESOURCES_PER_NODE),
  }));
  const elements = buildGraphFlowElements(nodes, generated.edges, generated.language);
  return EditableGraphSchema.parse({
    ...generated, id: graph.id, title: graph.title, createdAt: graph.createdAt,
    ...(graph.engine === undefined ? {} : { engine: graph.engine }),
    nodes, positions: Object.fromEntries(elements.nodes.map(node => [node.id, node.position])),
    updatedAt: new Date().toISOString(),
  });
}
