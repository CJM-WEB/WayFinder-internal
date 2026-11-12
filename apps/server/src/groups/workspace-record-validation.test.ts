/**
 * 重放证明回归：缓存只省去相同正文的重复因果校验，SQL、结构、身份与当前列表仍每次重新检查。
 * 全部使用内存查询边界，不连接数据库；特别覆盖事务回滚后同版本不同正文和损坏存档。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableGraphSchema, type GroupGraphRecord, type GroupSummary } from "@wayfinder/contracts";
import { createGroupHistory, restoreGroupHistory } from "./history.js";
import type { GroupQuery } from "./storage.js";
import { readActiveGroupGraph, readGroupWorkspaceSnapshot } from "./workspace-storage.js";

vi.mock("./history.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./history.js")>();
  return { ...actual, restoreGroupHistory: vi.fn(actual.restoreGroupHistory) };
});
let sequence = 0;
function fixture() {
  const id = `proof_graph_${++sequence}`, group: GroupSummary = { groupId: `proof_group_${sequence}`,
    ownerUserId: "owner", name: "固定小组", description: "", revision: 1 };
  const document = EditableGraphSchema.parse({ version: "workspace.v1", id, title: "资料", query: "", language: "zh-CN",
    presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z",
    lastRunId: null, nodes: [], edges: [], positions: {} });
  let record: GroupGraphRecord = { document, history: createGroupHistory(document), revision: 2, status: "active", originalIndex: null };
  let missing = false;
  const query = vi.fn<GroupQuery>(async sql => {
    if (sql.includes("recordId = ?")) return [{ payload: JSON.stringify({ kind: "workspace", activeOrder: [id], deletedIds: [] }) }];
    return missing ? [] : [{ payload: JSON.stringify({ kind: "graph", recordJson: JSON.stringify(record) }) }];
  });
  return { id, group, query, read: () => readGroupWorkspaceSnapshot(query, group),
    record: () => record, setRecord: (next: GroupGraphRecord) => { record = next; }, remove: () => { missing = true; } };
}
afterEach(() => { vi.clearAllMocks(); });

describe("小组历史重放成功证明", () => {
  it("相同正文跨查询复用纯校验，但每次仍读当前事务并产生独立结果", async () => {
    const f = fixture(), first = await f.read();
    first.graphs[0]!.document.title = "调用方修改不得污染下次读取";
    const second = await f.read();
    expect(second.graphs[0]?.document.title).toBe("资料");
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(restoreGroupHistory).toHaveBeenCalledTimes(1);
    // 另一数据库的查询函数读取完全相同字节，也只复用纯校验事实，不复用该数据库的任何权限。
    const otherQuery = vi.fn<GroupQuery>((sql, values) => f.query(sql, values));
    await readGroupWorkspaceSnapshot(otherQuery, f.group);
    expect(otherQuery).toHaveBeenCalledTimes(2); expect(restoreGroupHistory).toHaveBeenCalledTimes(1);
  });

  it("回滚后同一revision换正文仍重新验证，不返回未提交的旧内容", async () => {
    const f = fixture(), original = structuredClone(f.record()); await f.read();
    const document = { ...original.document, title: "回滚后重新提交的内容" };
    f.setRecord({ ...original, document, history: createGroupHistory(document) });
    expect((await f.read()).graphs[0]?.document.title).toBe(document.title);
    expect(restoreGroupHistory).toHaveBeenCalledTimes(2);
    f.setRecord(original); await f.read();
    expect(restoreGroupHistory).toHaveBeenCalledTimes(3);
  });

  it("同版本损坏历史不能被已有证明遮蔽，失败不替换原证明", async () => {
    const f = fixture(), original = structuredClone(f.record()); await f.read();
    const damaged = structuredClone(original); damaged.history.base.graph.title = "不能重放为当前图";
    f.setRecord(damaged); await expect(f.read()).rejects.toThrow();
    f.setRecord(original); expect((await f.read()).graphs[0]?.document.title).toBe("资料");
    expect(restoreGroupHistory).toHaveBeenCalledTimes(2);
  });

  it("缺失行或错误身份仍拒绝，证明不能补回数据库里不存在的图", async () => {
    const f = fixture(); await f.read(); f.remove(); await expect(f.read()).rejects.toThrow("小组图列表与存档不一致");
    const query: GroupQuery = async () => [{ payload: { kind: "graph", recordJson: JSON.stringify(f.record()) } }];
    await expect(readActiveGroupGraph(query, f.group.groupId, "wrong_graph")).rejects.toThrow("小组图存档身份不一致");
  });

  it("跨组相同图身份不混用证明，持续增长后按上限淘汰且重新校验", async () => {
    const f = fixture(); await f.read();
    await readGroupWorkspaceSnapshot(f.query, { ...f.group, groupId: "another_proof_group" });
    expect(restoreGroupHistory).toHaveBeenCalledTimes(2);
    vi.mocked(restoreGroupHistory).mockClear();
    for (let index = 0; index < 256; index++) await fixture().read();
    await f.read(); expect(restoreGroupHistory).toHaveBeenCalledTimes(257);
  });
});
