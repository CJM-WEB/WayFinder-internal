/** 确定性拒绝路径不租用连接，不读取真实数据库或主密钥；实际事务另由显式隔离SQL检查覆盖。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase, databaseOperation } from "./database.js";
import { createAccountKeyStorage } from "./key-storage.js";

const databases: AccountDatabase[] = [];
function fixture() {
  const database = new AccountDatabase({ host: "127.0.0.1", port: 3306, user: "fixture", password: "fake", database: "wf_d11_test_unused", connectionLimit: 1, timeoutMs: 100 }); databases.push(database);
  const connection = vi.spyOn(database.pool, "getConnection").mockRejectedValue(new Error("不应租用测试连接"));
  const storage = createAccountKeyStorage(database, Buffer.alloc(32, 73).toString("base64")); if (storage === null) throw new Error("无效假主密钥");
  return { database, storage, connection };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); vi.restoreAllMocks(); });
describe("托管Key存储拒绝边界", () => {
  it("缺失或非法主密钥只关闭该功能，不租用SQL连接", () => {
    const { database, connection } = fixture();
    expect(createAccountKeyStorage(database, undefined)).toBeNull(); expect(createAccountKeyStorage(database, "fixture-invalid-private-master")).toBeNull();
    expect(connection).not.toHaveBeenCalled();
  });
  it("坏请求在数据库之前固定拒绝且不携带原始Key", async () => {
    const { storage, connection } = fixture();
    const raw = { action: "save" as const, service: "deepseek" as const, expectedRevision: null, mutationId: "fixture", apiKey: "fixture-private\ninvalid" };
    await expect(storage.write("fixture_user", raw, databaseOperation(new AbortController().signal))).rejects.toMatchObject({ code: "KEY_INVALID" });
    expect(connection).not.toHaveBeenCalled();
  });
  it("预先取消或过期不发SQL，仍只暴露固定不可用", async () => {
    const { storage, connection } = fixture(), controller = new AbortController(); controller.abort(new Error("fixture-private-reason"));
    await expect(storage.read("fixture_user", databaseOperation(controller.signal))).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    await expect(storage.read("fixture_user", { signal: new AbortController().signal, deadline: Date.now() - 1 })).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    expect(connection).not.toHaveBeenCalled();
  });
});
