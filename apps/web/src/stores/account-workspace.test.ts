/** 真实身份协调回归：延迟读取不能把过渡空状态当成旧账号存档，更不能污染新账号。 */
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ loads: new Map<string | null, () => Promise<unknown>>() }));
vi.mock("./workspace-persistence.js", async importOriginal => ({
  ...await importOriginal<typeof import("./workspace-persistence.js")>(),
  accountWorkspaceStorage: (id: string | null) => ({ load: () => fixture.loads.get(id)?.() ?? Promise.resolve(null), save: async () => {} }),
}));

import { accountStore } from "./account.js";
import { initializeAccountWorkspace } from "./account-workspace.js";
import { createEmptyGraph, workspaceStore } from "./workspace-store.js";
import { startWorkspaceSearch } from "../api/workspace-search.js";
import { researchStore } from "../api/research.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("A加载未完成切B，迟到A不污染B；再次进入A恢复原存档而非空过渡缓存", async () => {
  const a = { userId: "fixture-A", email: "a@example.test" }, b = { userId: "fixture-B", email: "b@example.test" };
  const document = createEmptyGraph("graph-A", "A原存档", "zh-CN");
  const original = { documents: [document], currentId: null };
  let resolve!: (value: unknown) => void;
  let loads = 0;
  fixture.loads.set(a.userId, () => ++loads === 1 ? new Promise(value => { resolve = value; }) : Promise.resolve(original));
  fixture.loads.set(b.userId, async () => null);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ account: loads === 0 ? a : b }))));
  const cancel = vi.spyOn(startWorkspaceSearch, "cancel"), cancelResearch = vi.spyOn(researchStore.getState(), "dismiss");
  initializeAccountWorkspace();
  const pending = accountStore.getState().refresh();
  await vi.waitFor(() => expect(loads).toBe(1));
  await accountStore.getState().refresh();
  workspaceStore.getState().addGraph(createEmptyGraph("graph-B", "B原存档", "zh-CN"));
  resolve(original); await pending;
  expect(workspaceStore.getState().documents.map(value => value.id)).toEqual(["graph-B"]);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ account: a }))));
  await accountStore.getState().refresh();
  expect(workspaceStore.getState().documents.map(value => value.id)).toEqual(["graph-A"]);
  expect(loads).toBe(2); expect(cancel).toHaveBeenCalled(); expect(cancelResearch).toHaveBeenCalled();
  // 已加载账号的尚未持久化删除恢复队列，换号后仍只在本账号恢复。
  workspaceStore.getState().deleteGraph("graph-A");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ account: b }))));
  await accountStore.getState().refresh();
  expect(workspaceStore.getState().deletedGraphs).toHaveLength(0);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ account: a }))));
  await accountStore.getState().refresh();
  workspaceStore.getState().restoreDeletedGraph();
  expect(workspaceStore.getState().documents.map(value => value.id)).toEqual(["graph-A"]);
});
