/** 专用Key通道回归：明文仅在明确写请求体，状态/异常/错号/取消均不泄漏。 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER } from "@wayfinder/contracts";
import { AccountKeysError, createAccountKeysApi } from "./account-keys.js";

const response = () => ({ userId: "fixture-A", deepseek: { configured: true, mask: "••••abcd", revision: "revision-A" }, serpapi: { configured: false, mask: null, revision: null } });
describe("账号Key API", () => {
  it("同源无缓存并冻结预期账号，保存体之外无明文", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(response())));
    const api = createAccountKeysApi(fetcher), signal = new AbortController().signal;
    await api.read("fixture-A", signal);
    await api.write("fixture-A", { action: "save", service: "deepseek", expectedRevision: "revision-A", mutationId: "fixture-mutation", apiKey: "fixture-private-plaintext" }, signal);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("/api/account/keys"); expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", headers: { [CLOUD_ACCOUNT_HEADER]: "fixture-A" } });
      expect(JSON.stringify(init?.headers)).not.toContain("fixture-private-plaintext");
    }
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined(); expect(fetcher.mock.calls[1]?.[1]?.body).toContain("fixture-private-plaintext");
  });
  it("错账号和带明文额外字段的成功响应均固定拒绝", async () => {
    for (const raw of [{ ...response(), userId: "fixture-B" }, { ...response(), apiKey: "fixture-private-plaintext" }, { ...response(), deepseek: { ...response().deepseek, apiKey: "fixture-private-plaintext" } }]) {
      const api = createAccountKeysApi(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(raw))));
      try { await api.read("fixture-A", new AbortController().signal); throw new Error("预期拒绝"); }
      catch (error: unknown) { expect(error).toBeInstanceOf(AccountKeysError); expect(String(error)).not.toContain("fixture-private-plaintext"); expect(error).not.toHaveProperty("cause"); }
    }
  });
  it("取消能结束忽略Signal的正文，错误JSON不会泄漏正文", async () => {
    const controller = new AbortController(), response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const pending = createAccountKeysApi(vi.fn<typeof fetch>().mockResolvedValue(response)).read("fixture-A", controller.signal);
    await Promise.resolve(); await Promise.resolve(); controller.abort(); await expect(pending).rejects.toBeDefined();
    const api = createAccountKeysApi(vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture-private-plaintext", { status: 500 })));
    await expect(api.read("fixture-A", new AbortController().signal)).rejects.toMatchObject({ message: "KEY_UNAVAILABLE" });
  });
});
