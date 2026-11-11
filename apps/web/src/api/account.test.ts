/** 账号HTTP不记录原始异常，fetch和正文共用同一取消/截止边界。 */
import { describe, expect, it, vi } from "vitest";
import { createAccountApi, AccountRequestError } from "./account.js";

describe("账号同源接口", () => {
  it("验证请求和响应，明确禁止缓存且不将秘密放入URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ accepted: true })));
    await createAccountApi(fetcher)({ action: "register", email: "fixture@example.test", password: "fixture-password" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/account");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store", method: "POST" });
  });
  it("取消能结束不响应Signal的正文读取", async () => {
    const controller = new AbortController();
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const promise = createAccountApi(vi.fn<typeof fetch>().mockResolvedValue(response))(undefined, controller.signal);
    await Promise.resolve(); await Promise.resolve(); controller.abort();
    await expect(promise).rejects.toBeDefined();
  });
  it("原始网络错误和额外响应字段不泄漏秘密", async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture-private-value")),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ account: null, cookie: "fixture-private-value" })))]) {
      try { await createAccountApi(fetcher)(); throw new Error("预期拒绝"); }
      catch (error: unknown) { expect(error).toBeInstanceOf(AccountRequestError); expect(String(error)).not.toContain("fixture-private-value"); }
    }
  });
});
