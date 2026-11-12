/**
 * 模块职责：在既有图历史算法上附加服务端作者和各人100步窗口，不复制局部差异重放逻辑。
 * 小组历史独立于个人history.v1；必要的窗口外因果事件保留，只有不可撤销连续前缀才能折入基线。
 */
import { GroupGraphHistorySchema, type EditableGraph, type GroupGraphHistory } from "@wayfinder/contracts";
import {
  appendHistory, createGraphHistory, onlyGraphLayoutChanged, restoreGraphHistory, sameGraphContent,
  storeGraphHistory, updateHistoryLayout, type GraphHistory, type WorkspaceHistoryDescription,
} from "@wayfinder/contracts/graph-history";

export type GroupHistoryMetadata = WorkspaceHistoryDescription & Readonly<{ id: string; occurredAt: string; actorUserId: string }>;

export function createGroupHistory(document: EditableGraph): GroupGraphHistory {
  const history = storeGraphHistory(createGraphHistory(document));
  return GroupGraphHistorySchema.parse({ version: "groupHistory.v1", base: history.base, events: [], redoIdsByUser: {} });
}

/** 全体活动事件共同重放当前图；个人重做分支由外层保存，不在原算法中伪装成全组统一队列。 */
export function restoreGroupHistory(value: GroupGraphHistory, document: EditableGraph): GraphHistory {
  const history = GroupGraphHistorySchema.parse(value);
  return restoreGraphHistory({ version: "history.v1", base: history.base, events: history.events, redoIds: [] },
    document, Number.MAX_SAFE_INTEGER);
}

export function appendGroupHistory(value: GroupGraphHistory, before: EditableGraph, after: EditableGraph,
  metadata: GroupHistoryMetadata): GroupGraphHistory {
  const history = GroupGraphHistorySchema.parse(value), restored = restoreGroupHistory(history, before);
  if (sameGraphContent(before, after)) return history;
  if (metadata.scope === undefined && onlyGraphLayoutChanged(before, after)) {
    // 布局仍不占撤销额度、不清个人重做；旧算法负责把当前生命期的位置写回保留快照。
    const moved = storeGraphHistory(updateHistoryLayout(restored, before, after));
    const authors = new Map(history.events.map(event => [event.id, event]));
    return GroupGraphHistorySchema.parse({ ...history, base: moved.base, events: moved.events.map(event => {
      const previous = authors.get(event.id);
      if (previous === undefined) throw new Error("布局历史缺少作者归属");
      return { ...event, actorUserId: previous.actorUserId, undoable: previous.undoable };
    }) });
  }
  const planned = [...history.events.map(event => ({ ...event,
    // 本人新编辑结束自己的重做分支，其他成员仍可保留自己的独立重做。
    undoable: event.actorUserId === metadata.actorUserId && !event.active ? false : event.undoable,
  })), { ...metadata, active: true, before, after, undoable: true }];
  const counts = new Map<string, number>();
  for (let index = planned.length - 1; index >= 0; index--) {
    const event = planned[index];
    if (event === undefined || !event.undoable) continue;
    const count = (counts.get(event.actorUserId) ?? 0) + 1;
    counts.set(event.actorUserId, count);
    if (count > 100) event.undoable = false;
  }
  let prefix = 0;
  while (planned[prefix] !== undefined && !planned[prefix]?.undoable) prefix++;
  // 先算出共同前缀，再由原算法在本次append内折入；绝不能跳过另一成员仍可撤销的事件。
  const appended = storeGraphHistory(appendHistory(restored, before, after, { ...metadata, active: true }, planned.length - prefix));
  const authors = new Map(planned.map(event => [event.id, event]));
  const retained = new Set(appended.events.map(event => event.id));
  const redoIdsByUser = Object.fromEntries(Object.entries(history.redoIdsByUser).map(([actor, ids]) =>
    [actor, actor === metadata.actorUserId ? [] : ids.filter(id => retained.has(id))]));
  const next = GroupGraphHistorySchema.parse({ version: "groupHistory.v1", base: appended.base,
    events: appended.events.map(event => {
      const author = authors.get(event.id);
      if (author === undefined) throw new Error("小组历史缺少作者归属");
      return { ...event, actorUserId: author.actorUserId, undoable: author.undoable };
    }), redoIdsByUser });
  restoreGroupHistory(next, after);
  return next;
}
