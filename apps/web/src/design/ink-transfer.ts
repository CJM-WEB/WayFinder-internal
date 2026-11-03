/**
 * 模块职责：仅为颜料搬动建立稳定的一对一配对，不改变图 ID、节点、边或持久化位置。
 * 配对顺序：共享 ID 优先，剩余候选按屏幕像素距离排序；每个源/目标只消费一次。
 * 数量差：未配对实体交由呈现层分裂/融合，禁止复用同一源冒充多个已存在的墨团。
 */
export type InkTransferPoint = Readonly<{ id: string; x: number; y: number }>;
export type InkNodeTransferPair = Readonly<{ sourceId: string; targetId: string }>;

export function pairInkNodes(sources: readonly InkTransferPoint[], targets: readonly InkTransferPoint[]): readonly InkNodeTransferPair[] {
  const usedSources = new Set<string>(), usedTargets = new Set<string>();
  const pairs: InkNodeTransferPair[] = [];
  const consume = (sourceId: string, targetId: string): void => {
    usedSources.add(sourceId); usedTargets.add(targetId); pairs.push({ sourceId,targetId });
  };
  const sourceIds = new Set(sources.map(source => source.id));
  for (const target of targets) if (sourceIds.has(target.id)) consume(target.id,target.id);
  const candidates = sources.filter(source => !usedSources.has(source.id)).flatMap(source =>
    targets.filter(target => !usedTargets.has(target.id)).map(target => ({ source,target,
      distance: (source.x-target.x)**2+(source.y-target.y)**2 })));
  const compare = (left: string, right: string): number => left<right ? -1 : left>right ? 1 : 0;
  candidates.sort((left,right) => left.distance-right.distance || compare(left.source.id,right.source.id) || compare(left.target.id,right.target.id));
  for (const { source,target } of candidates) {
    if (!usedSources.has(source.id) && !usedTargets.has(target.id)) consume(source.id,target.id);
  }
  const order = new Map(targets.map((target,index) => [target.id,index]));
  return pairs.sort((left,right) => (order.get(left.targetId) ?? 0)-(order.get(right.targetId) ?? 0));
}

/** 首页与节点尾迹共用同一跟随链；即使调度时基倒退也不能产生负阻尼。 */
export function followInkTrail(points: { x: number; y: number }[], target: Readonly<{ x: number; y: number }>, delta: number): void {
  const dt = Math.max(0,Math.min(0.05,delta));
  const head = points[0];
  if (head!==undefined) {
    const amount = 1-Math.exp(-dt*10);
    head.x += (target.x-head.x)*amount;
    head.y += (target.y-head.y)*amount;
  }
  for (let index=points.length-1; index>0; index--) {
    const point = points[index], ahead = points[index-1];
    if (point===undefined || ahead===undefined) continue;
    const amount = 1-Math.exp(-dt*9);
    point.x += (ahead.x-point.x)*amount;
    point.y += (ahead.y-point.y)*amount;
  }
}
