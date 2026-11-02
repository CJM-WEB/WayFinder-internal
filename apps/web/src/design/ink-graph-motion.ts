/**
 * 模块职责：把真实图结构转换为墨迹生长的呈现时间表，不改变 Node、Edge 或搜索生命周期。
 * 传播规则：首个根节点先成形，邻接分支同时出发；相关边按无向传播，正式边保留原始语义。
 * 非连通图：分别播种，绝不为了动画制造业务连线；环与汇合只揭示一次节点。
 */
import type { GraphEdge, GraphNodeCore } from "@wayfinder/contracts";

export const INK_SEED_ARRIVAL = 980;
export const INK_NODE_FORM = 560;
export const INK_BRANCH_TRAVEL = 860;
export const INK_BRANCH_DETACH = 360;

export type InkBirth = Readonly<{ id: string; bornAt: number; seed: boolean }>;
export type InkBranch = Readonly<{
  id: string; source: string; target: string; startAt: number; arriveAt: number; detachAt: number;
}>;
export type InkGraphMotion = Readonly<{ nodes: readonly InkBirth[]; branches: readonly InkBranch[] }>;
export type InkScene = Readonly<{ kind: "pointer" }>
  | Readonly<{ kind: "loading"; startedAt: number }>
  | Readonly<{ kind: "graph"; startedAt: number } & InkGraphMotion>;

/** 与 CSS 的 cubic-bezier(0.6, 0, 0.4, 1) 共用 S 曲线，GPU 飞行与 DOM 过渡同速。 */
export function inkEase(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  let low = 0, high = 1;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    const x = 1.8 * (1 - middle) ** 2 * middle + 1.2 * (1 - middle) * middle ** 2 + middle ** 3;
    if (x < value) low = middle; else high = middle;
  }
  const t = (low + high) / 2;
  return 3 * t * t - 2 * t * t * t;
}

export function planInkGraph(nodes: readonly Pick<GraphNodeCore, "id" | "nodeType">[], edges: readonly GraphEdge[]): InkGraphMotion {
  if (nodes.length === 0) return { nodes: [], branches: [] };
  const arrivals = new Map<string, InkBirth>();
  const ids = new Set(nodes.map(node => node.id));
  const neighbours = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) {
    // 输入来自既有校验层；此处仅不为未知端点制造可见实体，不修复公共图数据。
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    neighbours.get(edge.source)?.push(edge.target);
    if (edge.type === "related_to") neighbours.get(edge.target)?.push(edge.source);
  }
  const roots = nodes.filter(node => node.nodeType !== "related" &&
    !edges.some(edge => edge.type === "recommended_next" && edge.target === node.id));
  const rootIds = new Set(roots.map(node => node.id));
  const ordered = [...roots, ...nodes.filter(node => !rootIds.has(node.id))];
  let component = 0;
  for (const root of ordered) {
    if (arrivals.has(root.id)) continue;
    arrivals.set(root.id, { id: root.id, bornAt: INK_SEED_ARRIVAL + component++ * 700, seed: true });
    const queue = [root.id];
    for (let index = 0; index < queue.length; index++) {
      const current = arrivals.get(queue[index] ?? "");
      if (current === undefined) continue;
      for (const next of neighbours.get(current.id) ?? []) {
        if (arrivals.has(next)) continue;
        arrivals.set(next, { id: next, bornAt: current.bornAt + INK_NODE_FORM + INK_BRANCH_TRAVEL, seed: false });
        queue.push(next);
      }
    }
  }
  // 多根汇合可能有更短的后到路径；对所有源做最早到达松弛，避免边已抵达而目标仍隐藏。
  // 每条传播耗时为正，节点数轮内必收敛；相关环也不会产生无限递归或重复实体。
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const from of arrivals.values()) {
      for (const targetId of neighbours.get(from.id) ?? []) {
        const target = arrivals.get(targetId);
        const earliest = from.bornAt + INK_NODE_FORM + INK_BRANCH_TRAVEL;
        if (target !== undefined && target.bornAt > earliest) {
          arrivals.set(targetId, { ...target, bornAt: earliest });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return {
    nodes: nodes.flatMap(node => { const birth = arrivals.get(node.id); return birth === undefined ? [] : [birth]; }),
    branches: edges.flatMap(edge => {
      const source = arrivals.get(edge.source), target = arrivals.get(edge.target);
      if (source === undefined || target === undefined) return [];
      // 推荐必须沿原箭头方向生长；只有相关边允许从先到达的一端出发。
      const from = edge.type === "recommended_next" || source.bornAt <= target.bornAt ? source : target;
      const to = from === source ? target : source;
      const startAt = from.bornAt + INK_NODE_FORM;
      const arriveAt = startAt + INK_BRANCH_TRAVEL;
      return [{ id: edge.id, source: from.id, target: to.id, startAt, arriveAt, detachAt: arriveAt + INK_BRANCH_DETACH }];
    }),
  };
}
