/** 假流覆盖组搜索归属、冲突预览及收据应用；无真实Provider或认证请求。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, GROUP_SEARCH_TARGET_HEADER, GroupGraphActionSchema,
  ResultGraphSchema, type GroupSearchTarget, type GroupSyncEvent } from "@wayfinder/contracts";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { createEmptyGraph } from "../stores/workspace-store.js";
import { createGraphStore } from "../stores/graph-store.js";
import { createStartStreamingSearch } from "./search.js";
import { createGroupSync } from "../stores/group-sync.js";
import { syncFixture } from "../testing/group-fixture.js";
import { prepareTestCredentials } from "../testing/test-credentials.js";
import { awaitGroupOperation, createGroupApi } from "./groups.js";
import { createGroupSearchController } from "./group-search.js";
const target: GroupSearchTarget = { groupId: "group-fixture", graphId: "graph-fixture", expectedRevision: 1 };
const input = { query: "Python", language: "zh-CN" as const };
const base = createEmptyGraph(target.graphId, "共享图", "zh-CN");
const stored = storeGraphHistory(createGraphHistory(base));
const result = ResultGraphSchema.parse({ ...pythonResultGraphFixture, runId: "group-run" });
const receipt = { version: "groupSearch.v1" as const, target, runId: result.runId, signature: "a".repeat(64) };
const complete = (withReceipt = true) => new Response(`${JSON.stringify({ type: "complete", runId: result.runId,
  sequence: 1, timestamp: "2026-11-12T00:00:00Z", protocolVersion: "0.1", data: { finalStatus: "partial", result,
    ...(withReceipt ? { groupSearchReceipt: receipt } : {}) } })}\n`);
function setup(fetcher = vi.fn<typeof fetch>().mockResolvedValue(complete())) {
  let emit: (event: GroupSyncEvent) => void = () => {};
  const api = { ...createGroupApi(), stream: vi.fn<ReturnType<typeof createGroupApi>["stream"]>((_user, _group, signal, onEvent) => {
    emit = onEvent; return awaitGroupOperation(new Promise<void>(() => {}), signal);
  }), write: vi.fn<ReturnType<typeof createGroupApi>["write"]>() };
  const sync = createGroupSync(api);
  const snapshot = (revision = 1, title = base.title) => {
    const document = { ...base, title };
    const value = syncFixture(revision - 1, revision);
    value.workspace = { ...value.workspace, activeOrder: [base.id], graphs: [{ document, revision,
      status: "active", originalIndex: null, history: { version: "groupHistory.v1", base: { ...stored.base, graph: document }, events: [], redoIdsByUser: {} } }] };
    emit(value); return value;
  };
  sync.connect("user-fixture", target.groupId); const value = snapshot(); api.write.mockResolvedValue({ workspace: value.workspace });
  const search = createGroupSearchController(sync, { fetchImplementation: fetcher, prepareCredentials: prepareTestCredentials, createRunId: () => result.runId });
  return { sync, api, search, snapshot, fetcher, dispose: () => { search.dispose(); sync.disconnect(); } };
}
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
describe("小组搜索可信应用", () => {
  it("own凭据也带账号／连接／目标；完成预览不写图，显式应用只发送真实收据", async () => {
    const f = setup(); disposals.push(f.dispose); await f.search.start(target, input);
    const headers = new Headers(f.fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get(CLOUD_ACCOUNT_HEADER)).toBe("user-fixture"); expect(headers.get(GROUP_CONNECTION_HEADER)).toBe("connection-fixture");
    expect(JSON.parse(headers.get(GROUP_SEARCH_TARGET_HEADER)!)).toEqual(target);
    expect(f.api.write).not.toHaveBeenCalled(); expect(f.search.store.getState().preview?.status).toBe("ready");
    expect(await f.search.apply("replace")).toBe(true);
    const action = f.api.write.mock.calls[0]?.[1]; expect(GroupGraphActionSchema.safeParse(action).success).toBe(true);
    expect(action).toMatchObject({ action: "applySearch", graphId: base.id, expectedRevision: 1, receipt, result });
    expect(action).not.toHaveProperty("before"); expect(f.search.store.getState().preview).toBeNull();
  });
  it("成员编辑后保留新搜索预览；再次明确确认当前版本才提交，不自动重搜", async () => {
    let finish: (value: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; })), f = setup(fetcher); disposals.push(f.dispose);
    const pending = f.search.start(target, input, true); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    f.snapshot(2, "成员修改后"); finish(complete()); await pending;
    expect(f.search.store.getState()).toMatchObject({ error: "GROUP_CONFLICT", preview: { status: "ready" } });
    expect(f.api.write).not.toHaveBeenCalled(); expect(await f.search.apply("replace", true)).toBe(true);
    expect(f.api.write.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 2, confirmedRevision: 2, receipt: { target: { expectedRevision: 1 } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("取消后的迟到结果不应用；缺失小组收据不能把完成响应当可信搜索", async () => {
    let finish: (value: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; })), f = setup(fetcher); disposals.push(f.dispose);
    const pending = f.search.start(target, input, true); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    f.search.cancel(); finish(complete()); await pending; expect(f.search.store.getState().preview).toBeNull(); expect(f.api.write).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(complete(false)); await expect(f.search.start(target, input)).rejects.toMatchObject({ code: "GROUP_INVALID" });
    expect(f.api.write).not.toHaveBeenCalled();
  });
  it("新搜索在合法完成后立即应用，Unicode节点目标可通过HTTP字节头传输", async () => {
    const f = setup(); disposals.push(f.dispose); await f.search.start(target, input, true);
    await vi.waitFor(() => expect(f.api.write).toHaveBeenCalledTimes(1)); expect(f.search.store.getState().preview).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(""));
    const unicode = { ...target, nodeId: "节点-学习" };
    const search = createStartStreamingSearch({ store: createGraphStore(), prepareCredentials: prepareTestCredentials, fetchImplementation: fetcher,
      groupContext: () => ({ userId: "user-fixture", connectionId: "connection-fixture", target: unicode }) });
    await search(input); const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    const value = headers.get(GROUP_SEARCH_TARGET_HEADER)!; expect([...value].every(character => character.charCodeAt(0) < 128)).toBe(true); expect(JSON.parse(value)).toEqual(unicode);
  });
  it("搜索前置明确拒绝旧连接后，画布也立即禁写", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "GROUP_OFFLINE" }, { status: 503 }));
    const f = setup(fetcher); disposals.push(f.dispose);
    await expect(f.search.start(target, input)).rejects.toMatchObject({ code: "GROUP_OFFLINE" });
    expect(f.sync.store.getState()).toMatchObject({ state: "offline", connectionId: null });
    await expect(f.sync.write({ action: "delete", groupId: target.groupId, graphId: target.graphId, expectedRevision: 1, mutationId: "no-write" }))
      .rejects.toMatchObject({ code: "GROUP_OFFLINE" });
    expect(f.api.write).not.toHaveBeenCalled();
  });
  it("同组重新连接保留已完成预览，换号及组失效清除", async () => {
    const f = setup(); disposals.push(f.dispose); await f.search.start(target, input);
    f.sync.setNetworkOnline(false); expect(f.search.store.getState().preview?.status).toBe("ready");
    f.sync.connect("user-fixture", target.groupId); f.snapshot(); expect(f.search.store.getState().preview?.status).toBe("ready");
    f.sync.connect("another-user", "another-group"); expect(f.search.store.getState().preview).toBeNull();
  });
});
