/**
 * 模块职责：在每图最多 100 步的会话快照上，按稳定标识重放局部差异。
 * 选择性撤销只排除指定事件；后续独立字段继续生效，同字段后写覆盖先写。
 * 边界：不执行搜索、不持久化事件、不引入通用命令系统；缺失依赖或非法图一律拒绝。
 */
import {
  EditableGraphSchema, type EditableGraph, type EditableNode, type EditableResource, type GraphEdge,
} from "@wayfinder/contracts";

export type WorkspaceHistoryKind =
  | "graph.rename" | "graph.update" | "graph.search"
  | "node.add" | "node.edit" | "node.delete" | "node.move" | "node.search"
  | "resource.add" | "resource.edit" | "resource.delete" | "resource.move"
  | "edge.add" | "edge.edit" | "edge.delete" | "engine.change";
export type WorkspaceHistoryScope = Readonly<{ type: "graph.replace" }>
  | Readonly<{ type: "node.append" | "node.replace"; nodeId: string }>;
export type WorkspaceHistoryDescription = Readonly<{
  kind: WorkspaceHistoryKind; subject: string; scope?: WorkspaceHistoryScope;
}>;
export type WorkspaceHistoryBlockedReason = "dependency" | "constraint";
export type WorkspaceHistoryEvent = WorkspaceHistoryDescription & Readonly<{
  id: string;
  occurredAt: string;
  active: boolean;
}>;
export type WorkspaceHistoryEventView = WorkspaceHistoryEvent & Readonly<{
  blockedReason?: WorkspaceHistoryBlockedReason;
}>;
export type WorkspaceHistoryResult = Readonly<{ ok: true }> | Readonly<{
  ok: false;
  reason: "missing" | "inactive" | WorkspaceHistoryBlockedReason;
}>;

type HistoryEntry = WorkspaceHistoryEvent & Readonly<{ before: EditableGraph; after: EditableGraph }>;
type MissingEntity<T> = { initial: T; order?: string[]; ownedResourceIds?: string[] };
type Position = EditableGraph["positions"][string];
/** 暂存只服务一次重建；占位实体绝不进入文档或持久化。 */
type ReplayState = {
  graph: EditableGraph;
  nodes: Map<string, MissingEntity<EditableNode>>;
  resources: Map<string, Map<string, MissingEntity<EditableResource>>>;
  edges: Map<string, MissingEntity<GraphEdge>>;
  positions: Map<string, Position | undefined>;
  manualNodes: Set<string>;
};
export type GraphHistory = {
  /** 兼容原工具栏的顺序快照；事件及基线只存在当前页面会话。 */
  past: EditableGraph[];
  future: EditableGraph[];
  base: ReplayState;
  events: HistoryEntry[];
  redoIds: string[];
};
type HistoryChange = Readonly<{ ok: true; graph: EditableGraph; history: GraphHistory }>
  | Readonly<{ ok: false; reason: WorkspaceHistoryBlockedReason }>;

const same = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);

/** 文档更新时间不是内容操作；同值保存即使带新时间，也不能凭空新增事件。 */
export const sameGraphContent = (first: EditableGraph, second: EditableGraph): boolean =>
  same({ ...first, updatedAt: "" }, { ...second, updatedAt: "" });

export const createGraphHistory = (graph: EditableGraph): GraphHistory => ({
  past: [], future: [], base: { graph, nodes: new Map(), resources: new Map(), edges: new Map(), positions: new Map(), manualNodes: new Set() },
  events: [], redoIds: [],
});

class MissingHistoryDependency extends Error {}

/**
 * 仅覆盖本次确实修改的字段，不要求当前字段仍等于旧值。
 * 因此 A→B→C 中去掉 B 后，后续写入 C 仍然成立；可选字段删除也保持原语义。
 */
function changedFields<T extends object>(current: T, before: T, after: T, ignored: readonly string[] = []): T {
  const next = { ...current } as Record<string, unknown>;
  const previous = before as Record<string, unknown>, incoming = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    if (ignored.includes(key) || same(previous[key], incoming[key])) continue;
    if (Object.hasOwn(incoming, key)) next[key] = structuredClone(incoming[key]);
    else delete next[key];
  }
  return next as T;
}

/**
 * 节点、资源、边都按稳定 ID 合并，不使用会随增删移动的数组下标。
 * 新增按相邻实际对象定位；排序仅置换本事件涉及的公共对象，保留独立恢复的其他对象。
 */
function changedEntities<T extends { id: string }>(
  current: readonly T[], before: readonly T[], after: readonly T[],
  update: (current: T, before: T, after: T) => T, missing: Map<string, MissingEntity<T>>,
): T[] {
  let next = [...current];
  const oldById = new Map(before.map(item => [item.id, item]));
  const newById = new Map(after.map(item => [item.id, item]));
  next = next.filter(item => !oldById.has(item.id) || newById.has(item.id));
  for (const id of oldById.keys()) if (!newById.has(id)) missing.delete(id);
  for (const incoming of after) {
    const previous = oldById.get(incoming.id);
    let index = next.findIndex(item => item.id === incoming.id);
    if (previous === undefined) {
      if (index >= 0 && missing.has(incoming.id)) {
        // 后续明确新增拥有自己的完整实体，覆盖旧的临时占位。
        next[index] = structuredClone(incoming);
        missing.delete(incoming.id);
        continue;
      }
      const following = after.slice(after.indexOf(incoming) + 1).find(item => next.some(existing => existing.id === item.id));
      const preceding = after.slice(0, after.indexOf(incoming)).findLast(item => next.some(existing => existing.id === item.id));
      const insertion = following !== undefined ? next.findIndex(item => item.id === following.id)
        : preceding !== undefined ? next.findIndex(item => item.id === preceding.id) + 1 : next.length;
      next.splice(insertion, 0, structuredClone(incoming));
    } else if (!same(previous, incoming)) {
      if (index < 0) {
        missing.set(incoming.id, { initial: previous });
        next.push(structuredClone(previous));
        index = next.length - 1;
      }
      const existing = next[index];
      if (existing === undefined) throw new MissingHistoryDependency();
      next[index] = update(existing, previous, incoming);
    }
  }
  const commonBefore = before.filter(item => newById.has(item.id)).map(item => item.id);
  const commonAfter = after.filter(item => oldById.has(item.id)).map(item => item.id);
  if (!same(commonBefore, commonAfter)) {
    const reordered = commonAfter.map(id => {
      let item = next.find(existing => existing.id === id);
      if (item === undefined) {
        item = oldById.get(id);
        if (item === undefined) throw new MissingHistoryDependency();
        missing.set(id, { initial: item });
        next.push(structuredClone(item));
      }
      const placeholder = missing.get(id);
      if (placeholder !== undefined && placeholder.order === undefined) placeholder.order = before.map(existing => existing.id);
      return item;
    });
    const common = new Set(commonAfter);
    let index = 0;
    next = next.map(item => common.has(item.id) ? reordered[index++] ?? item : item);
  }
  return next;
}

function changedNode(state: ReplayState, current: EditableNode, before: EditableNode, after: EditableNode): EditableNode {
  const next = changedFields(current, before, after, ["resources"]);
  const missing = state.resources.get(current.id) ?? new Map<string, MissingEntity<EditableResource>>();
  state.resources.set(current.id, missing);
  next.resources = changedEntities(current.resources, before.resources, after.resources,
    (resource, previous, incoming) => changedFields(resource, previous, incoming, ["rank"]), missing)
    .map((resource, index) => ({ ...resource, rank: index + 1 }));
  // 人工内容变更的状态依赖最终资源数量；重放不能把恢复了资源的节点仍标成 empty。
  if ((after.status === "edited" || after.status === "empty") &&
      (before.title !== after.title || before.description !== after.description || !same(before.resources, after.resources))) {
    next.status = next.resources.length === 0 ? "empty" : "edited";
    next.warnings = [];
    delete next.error;
    state.manualNodes.add(current.id);
  } else if (after.status !== "edited" && after.status !== "empty" && !same(before.resources, after.resources)) {
    state.manualNodes.delete(current.id);
  }
  return next;
}

/** 完整替换表达写入意图，不能把结果中恰好没变的字段误认为仍属于先前事件。 */
function applySearchScope(state: ReplayState, event: HistoryEntry): void {
  const { scope, before, after } = event;
  if (scope === undefined) return;
  if (scope.type === "graph.replace") {
    const graph = structuredClone(after);
    graph.id = state.graph.id; graph.title = state.graph.title; graph.createdAt = state.graph.createdAt;
    if (state.graph.engine === undefined) delete graph.engine;
    else graph.engine = state.graph.engine;
    state.graph = graph;
    state.nodes.clear(); state.resources.clear(); state.edges.clear(); state.positions.clear(); state.manualNodes.clear();
    return;
  }
  const incoming = after.nodes.find(node => node.id === scope.nodeId);
  const previous = before.nodes.find(node => node.id === scope.nodeId);
  if (incoming === undefined || previous === undefined) throw new MissingHistoryDependency();
  let current = state.graph.nodes.find(node => node.id === scope.nodeId);
  if (current === undefined) {
    current = structuredClone(previous);
    state.nodes.set(scope.nodeId, { initial: previous });
    state.graph = { ...state.graph, nodes: [...state.graph.nodes, current] };
  }
  const resources = scope.type === "node.replace" ? structuredClone(incoming.resources)
    : [...current.resources, ...structuredClone(incoming.resources.filter(resource => !previous.resources.some(old => old.id === resource.id)))];
  const placeholder = state.nodes.get(scope.nodeId);
  if (placeholder !== undefined) {
    // 即使值与占位初值相同，仍有效的搜索应用也拥有这些资源的存在性。
    const owned = incoming.resources.filter(resource => scope.type === "node.replace" || !previous.resources.some(old => old.id === resource.id)).map(resource => resource.id);
    placeholder.ownedResourceIds = scope.type === "node.replace" ? owned : [...(placeholder.ownedResourceIds ?? []), ...owned];
  }
  const node = { ...current, resources: resources.map((resource, index) => ({ ...resource, rank: index + 1 })),
    status: incoming.status, warnings: structuredClone(incoming.warnings) };
  if (incoming.error === undefined) delete node.error;
  else node.error = structuredClone(incoming.error);
  if (incoming.searchPlan === undefined) delete node.searchPlan;
  else node.searchPlan = structuredClone(incoming.searchPlan);
  if (scope.type === "node.replace") state.resources.delete(scope.nodeId);
  state.manualNodes.delete(scope.nodeId);
  state.graph = { ...state.graph, lastRunId: after.lastRunId, updatedAt: after.updatedAt,
    nodes: state.graph.nodes.map(existing => existing.id === scope.nodeId ? node : existing) };
}

function applyDifference(state: ReplayState, event: HistoryEntry): void {
  if (event.scope !== undefined) { applySearchScope(state, event); return; }
  const graph = state.graph;
  const { before, after } = event;
  const next = changedFields(graph, before, after, ["nodes", "edges", "positions"]);
  next.nodes = changedEntities(graph.nodes, before.nodes, after.nodes,
    (current, previous, incoming) => changedNode(state, current, previous, incoming), state.nodes);
  for (const node of before.nodes) if (!after.nodes.some(incoming => incoming.id === node.id)) {
    state.resources.delete(node.id); state.manualNodes.delete(node.id);
  }
  next.edges = changedEntities(graph.edges, before.edges, after.edges,
    (edge, previous, incoming) => changedFields(edge, previous, incoming), state.edges);
  next.positions = { ...graph.positions };
  for (const id of new Set([...Object.keys(before.positions), ...Object.keys(after.positions)])) {
    const previous = before.positions[id], incoming = after.positions[id];
    if (same(previous, incoming)) continue;
    if (incoming === undefined) { delete next.positions[id]; state.positions.delete(id); }
    else {
      if (!next.nodes.some(node => node.id === id) || state.nodes.has(id)) {
        if (!state.positions.has(id)) state.positions.set(id, previous);
      } else state.positions.delete(id);
      next.positions[id] = previous === undefined || next.positions[id] === undefined
        ? { ...incoming } : changedFields(next.positions[id], previous, incoming);
    }
  }
  state.graph = next;
}

const without = (value: object, ignored: readonly string[]): object => Object.fromEntries(
  Object.entries(value).filter(([key]) => !ignored.includes(key)),
);
function orderStillRequired<T extends { id: string }>(missing: MissingEntity<T>, entities: readonly T[]): boolean {
  if (missing.order === undefined) return false;
  const current = entities.map(entity => entity.id), original = missing.order;
  return !same(original.filter(id => current.includes(id)), current.filter(id => original.includes(id)));
}
function nodeStillRequired(initial: EditableNode, current: EditableNode): boolean {
  if (!same(without(initial, ["resources", "status", "warnings", "error", "searchPlan"]), without(current, ["resources", "status", "warnings", "error", "searchPlan"]))) return true;
  // 删除本来属于缺失节点的内容不需要该节点继续存在；留下的新资源、编辑内容或顺序才是依赖。
  if (current.resources.some(resource => {
    const previous = initial.resources.find(old => old.id === resource.id);
    return previous === undefined || !same(without(previous, ["rank"]), without(resource, ["rank"]));
  })) return true;
  const ids = current.resources.map(resource => resource.id), oldIds = initial.resources.map(resource => resource.id);
  return !same(oldIds.filter(id => ids.includes(id)), ids.filter(id => oldIds.includes(id)));
}

/**
 * 只在最终候选图检查残留依赖与完整 Schema。
 * 缺失目标上的临时修改若后来被删除或还原则消解；仍存内容绝不静默丢弃。
 */
function finalGraph(state: ReplayState): EditableGraph {
  const next = { ...state.graph, positions: { ...state.graph.positions } };
  next.nodes = state.graph.nodes.map(node => {
    const missing = state.resources.get(node.id);
    const resources = node.resources.filter(resource => {
      const placeholder = missing?.get(resource.id);
      if (placeholder === undefined) return true;
      if (!same(without(placeholder.initial, ["rank"]), without(resource, ["rank"])) || orderStillRequired(placeholder, node.resources)) throw new MissingHistoryDependency();
      return false;
    }).map((resource, index) => ({ ...resource, rank: index + 1 }));
    const current = { ...node, resources };
    if (state.manualNodes.has(node.id)) {
      current.status = resources.length === 0 ? "empty" : "edited";
      current.warnings = []; delete current.error;
    }
    return current;
  }).filter(node => {
    const placeholder = state.nodes.get(node.id);
    if (placeholder === undefined) return true;
    if (nodeStillRequired(placeholder.initial, node) || orderStillRequired(placeholder, state.graph.nodes)
        || placeholder.ownedResourceIds?.some(id => node.resources.some(resource => resource.id === id))) throw new MissingHistoryDependency();
    return false;
  });
  next.edges = state.graph.edges.filter(edge => {
    const placeholder = state.edges.get(edge.id);
    if (placeholder === undefined) return true;
    if (!same(placeholder.initial, edge) || orderStillRequired(placeholder, state.graph.edges)) throw new MissingHistoryDependency();
    return false;
  });
  const nodeIds = new Set(next.nodes.map(node => node.id));
  for (const [id, position] of Object.entries(next.positions)) if (!nodeIds.has(id)) {
    if (!state.positions.has(id) || !same(state.positions.get(id), position)) throw new MissingHistoryDependency();
    delete next.positions[id];
  }
  if (next.edges.some(edge => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) throw new MissingHistoryDependency();
  const parsed = EditableGraphSchema.safeParse(next);
  if (!parsed.success) throw new Error("撤销后的图违反约束");
  return parsed.data;
}

function copyReplay(state: ReplayState): ReplayState {
  const copyMissing = <T>(values: Map<string, MissingEntity<T>>) => new Map([...values].map(([id, value]) => [id, { ...value }]));
  return { graph: state.graph, nodes: copyMissing(state.nodes), edges: copyMissing(state.edges),
    resources: new Map([...state.resources].map(([id, missing]) => [id, copyMissing(missing)])),
    positions: new Map(state.positions), manualNodes: new Set(state.manualNodes) };
}
function replay(base: ReplayState, events: readonly HistoryEntry[], collectPast = false): { graph: EditableGraph; past: EditableGraph[] } {
  const state = copyReplay(base);
  const validPrefix = (): EditableGraph | null => { try { return finalGraph(state); } catch { return null; } };
  const prefixes: Array<EditableGraph | null> = collectPast ? [validPrefix()] : [];
  for (const event of events) {
    if (!event.active) continue;
    applyDifference(state, event);
    if (collectPast) prefixes.push(validPrefix());
  }
  const graph = finalGraph(state), past: EditableGraph[] = [];
  // 原工具栏只能逐步撤销；在第一个非法前缀前停止，绝不把非法快照暴露给旧 UI。
  for (let index = prefixes.length - 2; index >= 0; index--) {
    const prefix = prefixes[index];
    if (prefix === null || prefix === undefined) break;
    past.unshift(prefix);
  }
  return { graph, past };
}

function rebuild(history: GraphHistory, events: HistoryEntry[], redoIds: string[]): HistoryChange {
  try {
    const { graph, past } = replay(history.base, events, true);
    const future: EditableGraph[] = [];
    let redone = events;
    for (const id of redoIds) {
      redone = redone.map(event => event.id === id ? { ...event, active: true } : event);
      future.push(replay(history.base, redone).graph);
    }
    return { ok: true, graph, history: { ...history, events, redoIds, past, future } };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof MissingHistoryDependency ? "dependency" : "constraint" };
  }
}

/** 当前事件集合重新重建，失败不返回半成品，调用方只能保留原图和原历史。 */
export function undoHistoryEvent(history: GraphHistory, id: string): HistoryChange {
  return rebuild(history, history.events.map(event => event.id === id ? { ...event, active: false } : event),
    [id, ...history.redoIds.filter(previous => previous !== id)]);
}

export function redoHistoryEvent(history: GraphHistory): HistoryChange | null {
  const id = history.redoIds[0];
  if (id === undefined) return null;
  return rebuild(history, history.events.map(event => event.id === id ? { ...event, active: true } : event), history.redoIds.slice(1));
}

/** 只向 UI 投影安全的动作元数据，旧快照不进入展示模型；阻断原因按最新集合计算。 */
export function describeHistory(history: GraphHistory): readonly WorkspaceHistoryEventView[] {
  return history.events.map(event => {
    let blockedReason: WorkspaceHistoryBlockedReason | undefined;
    if (event.active) {
      try {
        // 列表只需检查撤销后的图；不为每一行重复生成所有 Redo 快照。
        replay(history.base, history.events.map(item => item.id === event.id ? { ...item, active: false } : item));
      } catch (error: unknown) {
        blockedReason = error instanceof MissingHistoryDependency ? "dependency" : "constraint";
      }
    }
    return { id: event.id, occurredAt: event.occurredAt, kind: event.kind, subject: event.subject, active: event.active,
      ...(blockedReason === undefined ? {} : { blockedReason }) };
  });
}

/**
 * 新编辑清除重做分支，但保留已撤销事件的会话展示；超限时只把最早有效差异折入基线。
 * before/after 复用 Store 已校验快照，不额外保存第三份图或通用补丁协议。
 */
export function appendHistory(
  history: GraphHistory, before: EditableGraph, after: EditableGraph,
  metadata: WorkspaceHistoryEvent, limit: number,
): GraphHistory {
  const events: HistoryEntry[] = [...history.events, { ...metadata, before, after }];
  const base = copyReplay(history.base);
  while (events.length > limit) {
    const removed = events.shift();
    if (removed?.active) applyDifference(base, removed);
  }
  const rebuilt = rebuild({ ...history, base }, events, []);
  if (!rebuilt.ok) throw new Error("会话历史无法重建当前图");
  return rebuilt.history;
}

/** 旧调用不传动作说明时，有限地依据真实实体差异分类；复杂批量变更使用图更新。 */
export function inferHistoryDescription(before: EditableGraph, after: EditableGraph): WorkspaceHistoryDescription {
  const removed = before.nodes.find(node => !after.nodes.some(next => next.id === node.id));
  const added = after.nodes.find(node => !before.nodes.some(previous => previous.id === node.id));
  const changed = after.nodes.filter(node => !same(before.nodes.find(previous => previous.id === node.id), node));
  if (removed !== undefined && added === undefined) return { kind: "node.delete", subject: removed.title };
  if (added !== undefined && removed === undefined) return { kind: "node.add", subject: added.title };
  if (before.title !== after.title) return { kind: "graph.rename", subject: `${before.title} → ${after.title}` };
  if (changed.length === 1) {
    const node = changed[0];
    const previous = before.nodes.find(item => item.id === node?.id);
    if (node !== undefined && previous !== undefined) {
      if (previous.title !== node.title) return { kind: "node.edit", subject: `${previous.title} → ${node.title}` };
      const resourceAdded = node.resources.find(item => !previous.resources.some(old => old.id === item.id));
      const resourceRemoved = previous.resources.find(item => !node.resources.some(next => next.id === item.id));
      if (resourceAdded !== undefined) return { kind: "resource.add", subject: resourceAdded.title };
      if (resourceRemoved !== undefined) return { kind: "resource.delete", subject: resourceRemoved.title };
      if (!same(previous.resources.map(item => item.id), node.resources.map(item => item.id))) return { kind: "resource.move", subject: node.title };
      const resource = node.resources.find(item => !same(previous.resources.find(old => old.id === item.id), item));
      if (resource !== undefined) return { kind: "resource.edit", subject: resource.title };
      return { kind: previous.engine !== node.engine ? "engine.change" : "node.edit", subject: node.title };
    }
  }
  const edgeAdded = after.edges.find(edge => !before.edges.some(previous => previous.id === edge.id));
  const edgeRemoved = before.edges.find(edge => !after.edges.some(next => next.id === edge.id));
  const edgeChanged = after.edges.find(edge => !same(before.edges.find(previous => previous.id === edge.id), edge));
  const edge = edgeAdded ?? edgeRemoved ?? edgeChanged;
  if (edge !== undefined) {
    const nodes = [...after.nodes, ...before.nodes];
    return { kind: edgeAdded !== undefined ? "edge.add" : edgeRemoved !== undefined ? "edge.delete" : "edge.edit",
      subject: `${nodes.find(node => node.id === edge.source)?.title ?? edge.source} → ${nodes.find(node => node.id === edge.target)?.title ?? edge.target}` };
  }
  const moved = Object.keys(after.positions).find(id => !same(before.positions[id], after.positions[id]));
  if (moved !== undefined) return { kind: "node.move", subject: after.nodes.find(node => node.id === moved)?.title ?? after.title };
  return { kind: before.engine !== after.engine ? "engine.change" : "graph.update", subject: after.title };
}
