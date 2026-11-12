/** 回归真实 MySQL JSON 解码差异：驱动对象与原始 JSON 文本均须恢复同一个本人昵称。 */
import { describe, expect, it, vi } from "vitest";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "./database.js";
import { createAccountProfileStorage } from "./profile-storage.js";

describe("昵称持久化", () => {
  it.each([{ nickname: "小明" }, '{"nickname":"小明"}'])("读取驱动返回的JSON对象或JSON文本：%s", async payload => {
    const database = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_d12_test_profile"));
    const query = vi.spyOn(database, "query").mockResolvedValue([{ payload }]);
    try {
      const storage = createAccountProfileStorage(database), operation = databaseOperation(new AbortController().signal);
      expect(await storage.read("fixture_user", operation)).toEqual({ userId: "fixture_user", nickname: "小明" });
      await storage.write("fixture_user", "  小明  ", operation);
      expect(query.mock.calls[1]?.[2]).toEqual(["fixture_user", "profile", '{"nickname":"小明"}', '{"nickname":"小明"}']);
    } finally { query.mockRestore(); await database.close(); }
  });
});
