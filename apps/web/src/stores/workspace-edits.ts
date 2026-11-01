/**
 * 模块职责：用普通纯函数完成单张图的人工编辑；调用方以 replaceGraph 提交一次撤销快照。
 * 关键边界：所有 URL 使用生产规范化规则，全图去重；资源排序就是数组顺序，不调用模型。
 * 人工编辑清除过时搜索状态，删空是正常空态；节点删除同时处理连线与位置。
 */
import {
  canonicalizeHttpUrl, EditableGraphSchema, ResourceSchema,
  type EditableGraph, type EditableNode, type EditableResource, type GraphEdge,
} from "@wayfinder/contracts";

export class InvalidResourceUrlError extends Error {
  constructor() { super("资源 URL 无效"); }
}
export class DuplicateResourceUrlError extends Error {
  constructor(readonly nodeId: string, readonly nodeTitle: string) {
    super("资源 URL 已存在");
  }
}
export class InvalidGraphConnectionError extends Error {
  constructor() { super("连线端点无效或推荐顺序形成循环"); }
}

/** 不把同值保存记成一次编辑；Zod 校验并复制最终快照，输入保持不变。 */
function finish(previous: EditableGraph, next: EditableGraph): EditableGraph {
  if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
  return EditableGraphSchema.parse({ ...next, updatedAt: new Date().toISOString() });
}
function edited(node: EditableNode): EditableNode {
  const resources = node.resources;
  const next = { ...node };
  delete next.error;
  return {
    ...next, status: resources.length === 0 ? "empty" : "edited", warnings: [],
    resources: resources.map((resource, index) => ({ ...resource, rank: index + 1 })),
  };
}
function replaceNode(
  graph: EditableGraph, nodeId: string, change: (node: EditableNode) => EditableNode,
): EditableGraph {
  if (!graph.nodes.some(node => node.id === nodeId)) return graph;
  return finish(graph, { ...graph, nodes: graph.nodes.map(node => {
    if (node.id !== nodeId) return node;
    const next = change(node);
    // 原样保存或过期界面的无效操作不能清除真实搜索结论，也不增加撤销步骤。
    return JSON.stringify(next) === JSON.stringify(node) ? node : edited(next);
  }) });
}

function resolveUrl(graph: EditableGraph, input: string, exclude?: { nodeId: string; resourceId: string }) {
  const url = input.trim();
  if (!ResourceSchema.shape.url.safeParse(url).success) throw new InvalidResourceUrlError();
  const canonical = canonicalizeHttpUrl(url);
  if (canonical === null) throw new InvalidResourceUrlError();
  for (const node of graph.nodes) {
    if (node.resources.some(resource => resource.canonicalUrl === canonical.href &&
      !(exclude?.nodeId === node.id && exclude.resourceId === resource.id))) {
      throw new DuplicateResourceUrlError(node.id, node.title);
    }
  }
  return { url: new URL(url).href, canonicalUrl: canonical.href, domain: canonical.hostname.toLowerCase() };
}

export function addNode(graph: EditableGraph, title: string, description = "", id: string = crypto.randomUUID()): EditableGraph {
  // 新节点初放已有图右侧；空图从固定边距起，不重新计算已有人工位置。
  const positions = Object.values(graph.positions);
  const x = positions.length === 0 ? 32 : Math.max(...positions.map(position => position.x)) + 280;
  const node: EditableNode = { id, title: title.trim(), description, nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] };
  return finish(graph, { ...graph, nodes: [...graph.nodes, node], positions: { ...graph.positions, [id]: { x, y: 32 } } });
}
export function updateNode(graph: EditableGraph, nodeId: string, patch: Partial<Pick<EditableNode, "title" | "description">>): EditableGraph {
  return replaceNode(graph, nodeId, node => ({ ...node, ...patch }));
}
export function deleteNode(graph: EditableGraph, nodeId: string): EditableGraph {
  const positions = { ...graph.positions };
  delete positions[nodeId];
  return finish(graph, {
    ...graph, nodes: graph.nodes.filter(node => node.id !== nodeId), positions,
    edges: graph.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId),
  });
}
export function addResource(graph: EditableGraph, nodeId: string, input: string, id: string = crypto.randomUUID()): EditableGraph {
  const url = resolveUrl(graph, input);
  return replaceNode(graph, nodeId, node => ({ ...node, resources: [...node.resources, {
    ...url, id, title: url.domain, origin: "manual", sourceType: "user_added",
    summary: "", whySelected: "", rank: node.resources.length + 1,
  }] }));
}
export function updateResource(
  graph: EditableGraph, nodeId: string, resourceId: string,
  patch: Partial<Pick<EditableResource, "title" | "url" | "summary" | "whySelected">>,
): EditableGraph {
  return replaceNode(graph, nodeId, node => ({ ...node, resources: node.resources.map(resource => {
    if (resource.id !== resourceId) return resource;
    const url = patch.url === undefined || patch.url === resource.url
      ? { url: resource.url, canonicalUrl: resource.canonicalUrl, domain: resource.domain }
      : resolveUrl(graph, patch.url, { nodeId, resourceId });
    if (url.canonicalUrl === resource.canonicalUrl) return { ...resource, ...patch, ...url };
    // URL 换成另一页面后属于用户加入的资源，不继续声称由原搜索提供，也不保留旧网页日期或分数。
    return {
      ...url, id: resource.id, rank: resource.rank, origin: "manual", sourceType: "user_added",
      title: patch.title ?? resource.title, summary: patch.summary ?? resource.summary,
      whySelected: patch.whySelected ?? resource.whySelected,
    };
  }) }));
}
export function deleteResource(graph: EditableGraph, nodeId: string, resourceId: string): EditableGraph {
  return replaceNode(graph, nodeId, node => ({ ...node, resources: node.resources.filter(resource => resource.id !== resourceId) }));
}
export function moveResource(graph: EditableGraph, nodeId: string, sourceId: string, targetId: string): EditableGraph {
  return replaceNode(graph, nodeId, node => {
    const from = node.resources.findIndex(resource => resource.id === sourceId);
    const to = node.resources.findIndex(resource => resource.id === targetId);
    if (from < 0 || to < 0 || from === to) return node;
    const resources = [...node.resources];
    const resource = resources.splice(from, 1)[0];
    if (resource === undefined) return node;
    resources.splice(to, 0, resource);
    return { ...node, resources };
  });
}

/** 只提交拖动结束的位置；中间帧由画布维护，避免一次拖动耗尽会话历史。 */
export function moveNode(graph: EditableGraph, nodeId: string, position: { x: number; y: number }): EditableGraph {
  if (!graph.nodes.some(node => node.id === nodeId)) return graph;
  return finish(graph, { ...graph, positions: { ...graph.positions, [nodeId]: position } });
}

/** 连线规则直接复用编辑图协议：引用存在、推荐顺序无环，相关线不限制成环。 */
function replaceEdges(graph: EditableGraph, edges: GraphEdge[]): EditableGraph {
  const next = { ...graph, edges };
  if (!EditableGraphSchema.safeParse(next).success) throw new InvalidGraphConnectionError();
  return finish(graph, next);
}
export function addEdge(
  graph: EditableGraph, source: string, target: string, type: GraphEdge["type"], id: string = crypto.randomUUID(),
): EditableGraph {
  return replaceEdges(graph, [...graph.edges, { id, source, target, type }]);
}
export function updateEdge(
  graph: EditableGraph, edgeId: string, patch: Partial<Pick<GraphEdge, "source" | "target" | "type">>,
): EditableGraph {
  return replaceEdges(graph, graph.edges.map(edge => edge.id === edgeId ? { ...edge, ...patch } : edge));
}
export function deleteEdge(graph: EditableGraph, edgeId: string): EditableGraph {
  return finish(graph, { ...graph, edges: graph.edges.filter(edge => edge.id !== edgeId) });
}
