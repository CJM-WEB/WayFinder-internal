/** 假传输验证同源边界、分块协议与取消；不触发真实认证、搜索或邮件。 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, type GroupSyncEvent } from "@wayfinder/contracts";
import { createGroupApi, GroupRequestError } from "./groups.js";

import { syncFixture } from "../testing/group-fixture.js";
const signal = () => new AbortController().signal;
describe("小组API边界", () => {
  it("写入立即带连接证明且不重试；未知确认按原标识查询", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("private-fixture"))
      .mockResolvedValueOnce(Response.json({ mutationId: "mutation-fixture", applied: false, groupId: null, graphId: null, personalGraphId: null }));
    const api = createGroupApi(fetcher), action = { action: "delete" as const, groupId: "group-fixture", graphId: "graph-fixture", expectedRevision: 1, mutationId: "mutation-fixture" };
    await expect(api.write("user-fixture", action, "connection-fixture", signal())).rejects.toThrow("GROUP_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toMatchObject(["/api/group-workspace", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { [CLOUD_ACCOUNT_HEADER]: "user-fixture", [GROUP_CONNECTION_HEADER]: "connection-fixture" }, body: JSON.stringify(action) }]);
    await api.receipt("user-fixture", action.mutationId, signal());
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/group-receipt?mutationId=mutation-fixture");
    await expect(api.write("user-fixture", action, "", signal())).rejects.toThrow("GROUP_OFFLINE"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("中文UTF8逐字节分块仍读到完整快照；跨组和跨账号内容拒绝", async () => {
    for (const event of [syncFixture(), { ...syncFixture(), workspace: { ...syncFixture().workspace, groupId: "another-group" } }]) {
      const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`), events: GroupSyncEvent[] = [];
      const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
      const api = createGroupApi(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
      const pending = api.stream("user-fixture", "group-fixture", signal(), value => events.push(value));
      if (event.workspace.groupId === "group-fixture") { await pending; expect(events).toEqual([syncFixture()]); }
      else await expect(pending).rejects.toBeInstanceOf(GroupRequestError);
    }
    const api = createGroupApi(vi.fn<typeof fetch>().mockResolvedValue(new Response(`${JSON.stringify(syncFixture())}\n`)));
    await expect(api.stream("other-user", "group-fixture", signal(), () => {})).rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
  });
  it("编辑确认仍完整校验组正文并拒绝跨组，不因减少重复解析而放宽边界", async () => {
    const action = { action: "delete" as const, groupId: "group-fixture", graphId: "graph-fixture", expectedRevision: 1, mutationId: "mutation-fixture" };
    const workspace = syncFixture().workspace;
    for (const [value, code] of [[workspace, null], [{ ...workspace, groupId: "other-group" }, "GROUP_FORBIDDEN"],
      [{ ...workspace, activeOrder: ["missing-graph"] }, "GROUP_UNAVAILABLE"]] as const) {
      const api = createGroupApi(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ workspace: value })));
      const result = api.write("user-fixture", action, "connection-fixture", signal());
      if (code === null) await expect(result).resolves.toEqual({ workspace });
      else await expect(result).rejects.toMatchObject({ code });
    }
  });
  it("忽略Signal的fetch或流读取仍可取消，不泄漏异常正文", async () => {
    for (const streaming of [false, true]) {
      const controller = new AbortController(), fetcher = vi.fn<typeof fetch>(() => streaming
        ? Promise.resolve(new Response(new ReadableStream<Uint8Array>())) : new Promise<Response>(() => {}));
      const pending = createGroupApi(fetcher).stream("user-fixture", "group-fixture", controller.signal, () => {});
      const failure = expect(pending).rejects.toBeInstanceOf(GroupRequestError); await Promise.resolve(); controller.abort(); await failure;
    }
  });
});
