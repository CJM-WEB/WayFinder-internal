/**
 * 模块职责：在既有图历史算法上附加服务端作者和各人100步窗口，不复制局部差异重放逻辑。
 * 小组历史独立于个人history.v1；必要的窗口外因果事件保留，只有不可撤销连续前缀才能折入基线。
 */
import { GroupGraphHistorySchema, type EditableGraph, type GroupGraphHistory } from "@wayfinder/contracts";
import {
  appendHistory, createGraphHistory, onlyGraphLayoutChanged, restoreGraphHistory, sameGraphContent,
  redoHistoryEvent, storeGraphHistory, undoHistoryEvent, updateHistoryLayout, type GraphHistory, type WorkspaceHistoryDescription,
} from "@wayfinder/contracts/graph-history";
import { GroupAccessError } from "./errors.js";

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
  if (metadata.scope === undefined && sameGraphContent(before, after)) return history;
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

export type GroupHistoryChange = Readonly<{ document: EditableGraph; history: GroupGraphHistory }>;

/** 重放只改变活动标识；作者、本人窗口和其他人的重做队列不能在原算法序列化时丢失。 */
function changedHistory(previous: GroupGraphHistory, rebuilt: GraphHistory, document: EditableGraph,
  redoIdsByUser: GroupGraphHistory["redoIdsByUser"]): GroupHistoryChange {
  const stored = storeGraphHistory(rebuilt), authors = new Map(previous.events.map(event => [event.id, event]));
  const history = GroupGraphHistorySchema.parse({ ...previous, base: stored.base, redoIdsByUser,
    events: stored.events.map(event => {
      const author = authors.get(event.id);
      if (author === undefined) throw new Error("撤销历史缺少作者归属");
      return { ...event, actorUserId: author.actorUserId, undoable: author.undoable };
    }) });
  restoreGroupHistory(history, document);
  return { document, history };
}

/** 只撤销本人的活动事件；移除早期修改仍须保留后写，实体依赖或图约束冲突则整次拒绝。 */
export function undoGroupHistory(value: GroupGraphHistory, document: EditableGraph, userId: string, eventId: string): GroupHistoryChange {
  const history = GroupGraphHistorySchema.parse(value), event = history.events.find(item => item.id === eventId);
  if (event === undefined) throw new GroupAccessError("GROUP_CONFLICT");
  if (event.actorUserId !== userId) throw new GroupAccessError("GROUP_FORBIDDEN");
  if (!event.undoable || !event.active) throw new GroupAccessError("GROUP_CONFLICT");
  const restored = restoreGroupHistory(history, document), result = undoHistoryEvent(restored, eventId);
  if (!result.ok) throw new GroupAccessError(result.reason === "dependency" ? "GROUP_DEPENDENCY" : "GROUP_CONSTRAINT");
  const redoIdsByUser = { ...history.redoIdsByUser,
    [userId]: [eventId, ...(history.redoIdsByUser[userId] ?? []).filter(id => id !== eventId)] };
  return changedHistory(history, result.history, result.graph, redoIdsByUser);
}

/**
 * 个人队首逐次重做，不能让另一人的队列或本人之后尚未选择的步骤提前阻断当前步骤。
 * 仍调用原重放和Validator（约束校验），不强制复活被后续操作删除的实体或清空他人事件。
 */
export function redoGroupHistory(value: GroupGraphHistory, document: EditableGraph, userId: string): GroupHistoryChange {
  const history = GroupGraphHistorySchema.parse(value), ids = history.redoIdsByUser[userId] ?? [], eventId = ids[0];
  const event = history.events.find(item => item.id === eventId);
  if (eventId === undefined || event === undefined || !event.undoable || event.active) throw new GroupAccessError("GROUP_CONFLICT");
  if (event.actorUserId !== userId) throw new GroupAccessError("GROUP_FORBIDDEN");
  const restored = restoreGroupHistory(history, document);
  const result = redoHistoryEvent({ ...restored, redoIds: [eventId] });
  if (result === null) throw new GroupAccessError("GROUP_CONFLICT");
  if (!result.ok) throw new GroupAccessError(result.reason === "dependency" ? "GROUP_DEPENDENCY" : "GROUP_CONSTRAINT");
  return changedHistory(history, result.history, result.graph, { ...history.redoIdsByUser, [userId]: ids.slice(1) });
}
