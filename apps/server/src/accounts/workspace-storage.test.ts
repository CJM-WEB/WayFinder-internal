/** 普通CI验证图／历史不一致和取消在数据库连接前失败，不把假实现当实际SQL证据。 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, type CloudGraphWriteRequest } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "./database.js";
import { createWorkspaceStorage } from "./workspace-storage.js";

describe("云图数据拒绝边界", () => {
  it("损坏或重放不一致的历史不能开启连接，取消也不连接", async () => {
    const database = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_d11_test_fixture"));
    const storage = createWorkspaceStorage(database);
    const document = EditableGraphSchema.parse({ version: "workspace.v1", id: "fixture_graph", title: "原标题", query: "",
      language: "zh-CN", presentationMode: "graph", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
      lastRunId: null, nodes: [], edges: [], positions: {} });
    const input: CloudGraphWriteRequest = { action: "save", document, history: storeGraphHistory(createGraphHistory(document)), expectedRevision: 0, mutationId: "fixture_mutation" };
    try {
      await expect(storage.write("fixture_user", { ...input, document: { ...document, title: "另一标题" } }, databaseOperation(new AbortController().signal)))
        .rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
      const controller = new AbortController(); controller.abort();
      await expect(storage.write("fixture_user", input, databaseOperation(controller.signal))).rejects.toMatchObject({ code: "DATABASE_CANCELLED" });
      await expect(storage.read("fixture_user", databaseOperation(controller.signal))).rejects.toMatchObject({ code: "DATABASE_CANCELLED" });
    } finally { await database.close(); }
  });
});
