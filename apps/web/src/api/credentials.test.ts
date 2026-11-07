/** 测试职责：用固定假响应验证凭据前置检查、资格投影、取消和原始错误脱敏，无上游调用。 */
import { describe, expect, it, vi } from "vitest";

import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { createCredentialSettingsStore, type CredentialSettingsStore } from "../stores/credential-settings.js";
import { createCredentialsApi, CredentialsConfigurationError } from "./credentials.js";

function fixture() {
  let value: string | null = null;
  const storage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
  };
  return { store: createCredentialSettingsStore(() => storage), storage };
}
function own(store: CredentialSettingsStore) {
  store.getState().saveService("deepseek", { source: "own", apiKey: "fake-own-llm" });
  store.getState().saveService("serpapi", { source: "own", apiKey: "fake-own-search" });
}
function author(store: CredentialSettingsStore) {
  store.getState().saveService("deepseek", { source: "author", apiKey: "fake-retained-own-llm" });
  store.getState().saveService("serpapi", { source: "author", apiKey: "fake-retained-own-search" });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("凭据API与搜索前置检查", () => {
  it("缺自带Key零请求且指定服务；混合模式也先检查所有自带配置", async () => {
    const { store } = fixture();
    const fetcher = vi.fn<typeof fetch>();
    const api = createCredentialsApi(store, fetcher);
    await expect(api.prepareSearchCredentials()).rejects.toMatchObject({ problem: { code: "CREDENTIALS_REQUIRED", service: "deepseek" } });
    expect(store.getState().notice).toEqual({ code: "CREDENTIALS_REQUIRED", service: "deepseek" });
    store.getState().saveService("deepseek", { source: "author", apiKey: "" });
    await expect(api.prepareSearchCredentials()).rejects.toMatchObject({ problem: { code: "CREDENTIALS_REQUIRED", service: "serpapi" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("双自带成功不查询资格，清旧notice且不改变已保存偏好", async () => {
    const { store } = fixture();
    own(store);
    store.getState().setNotice({ code: "CREDENTIALS_REQUIRED" });
    const previous = store.getState().preferences;
    const fetcher = vi.fn<typeof fetch>();
    const result = await createCredentialsApi(store, fetcher).prepareSearchCredentials();
    expect(result).toEqual({ deepseek: { source: "own", apiKey: "fake-own-llm" }, serpapi: { source: "own", apiKey: "fake-own-search" } });
    expect(store.getState().preferences).toBe(previous);
    expect(store.getState().notice).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("体验资格每次读取，不使用本地布尔值或回退保留的own Key", async () => {
    const { store } = fixture();
    author(store);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ authorized: true })).mockResolvedValueOnce(json({ authorized: false }));
    const api = createCredentialsApi(store, fetcher);
    expect(await api.prepareSearchCredentials()).toEqual({ deepseek: { source: "author" }, serpapi: { source: "author" } });
    await expect(api.prepareSearchCredentials()).rejects.toMatchObject({ problem: { code: "EXPERIENCE_REVOKED" } });
    expect(store.getState().notice).toEqual({ code: "EXPERIENCE_REVOKED" });
    expect(store.getState().preferences.deepseek.apiKey).toBe("fake-retained-own-llm");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/experience/status", "/api/experience/status"]);
  });

  it("资格等待前冻结选择，后续保存不串改当前wire且author分支strip保留Key", async () => {
    const { store } = fixture();
    own(store);
    store.getState().saveService("serpapi", { source: "author", apiKey: "fake-retained-search" });
    const response = createDeferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => response.promise);
    const api = createCredentialsApi(store, fetcher);
    const prepared = api.prepareSearchCredentials();
    store.getState().saveService("deepseek", { source: "own", apiKey: "fake-next-llm" });
    store.getState().saveService("serpapi", { source: "own", apiKey: "fake-next-search" });
    response.resolve(json({ authorized: true }));
    expect(await prepared).toEqual({ deepseek: { source: "own", apiKey: "fake-own-llm" }, serpapi: { source: "author" } });
    expect(await api.prepareSearchCredentials()).toEqual({ deepseek: { source: "own", apiKey: "fake-next-llm" }, serpapi: { source: "own", apiKey: "fake-next-search" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("三路同源Cookie且no-store；邀请码只在验证POST正文，验证不保存偏好或资格", async () => {
    const { store, storage } = fixture();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ announcement: "作者公告\n第二行", experienceAvailable: true }))
      .mockResolvedValueOnce(json({ authorized: false }))
      .mockResolvedValueOnce(json({ authorized: true }));
    const api = createCredentialsApi(store, fetcher);
    const signal = new AbortController().signal;
    expect(await api.fetchSettings(signal)).toEqual({ announcement: "作者公告\n第二行", experienceAvailable: true });
    expect(await api.readExperienceStatus(signal)).toBe(false);
    await api.verifyExperience("  假邀请码  ", signal);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/settings", "/api/experience/status", "/api/experience"]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", signal });
      expect(String(url)).not.toContain("假邀请码");
    }
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inviteCode: "假邀请码" }) });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.getState().notice).toBeNull();
  });

  it("无效邀请码零请求；fetch/status/verify错误仅供弹窗，不设置全局notice", async () => {
    const { store } = fixture();
    const previous = { code: "CREDENTIALS_REQUIRED" as const, service: "deepseek" as const };
    store.getState().setNotice(previous);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ code: "INVITE_CODE_INVALID" }, 403));
    const api = createCredentialsApi(store, fetcher);
    await expect(api.verifyExperience("\n假码")).rejects.toMatchObject({ problem: { code: "INVITE_CODE_INVALID" } });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.verifyExperience("假码")).rejects.toMatchObject({ problem: { code: "INVITE_CODE_INVALID" } });
    await expect(api.fetchSettings()).rejects.toBeInstanceOf(CredentialsConfigurationError);
    await expect(api.readExperienceStatus()).rejects.toBeInstanceOf(CredentialsConfigurationError);
    expect(store.getState().notice).toEqual(previous);
  });

  it("网络、坏JSON及未知响应字段只抛安全错误，不保留原body/cause/秘密", async () => {
    const { store } = fixture();
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("fake-private-key-error")),
      vi.fn<typeof fetch>().mockResolvedValue(new Response("fake-private-key-error", { status: 503 })),
      vi.fn<typeof fetch>().mockResolvedValue(json({ code: "EXPERIENCE_REVOKED", message: "fake-private-key-error" }, 403)),
      vi.fn<typeof fetch>().mockResolvedValue(json({ announcement: "公告", experienceAvailable: true, signingSecret: "fake-private-key-error" })),
    ]) {
      let error: unknown;
      try { await createCredentialsApi(store, fetcher).fetchSettings(); } catch (caught: unknown) { error = caught; }
      expect(error).toBeInstanceOf(CredentialsConfigurationError);
      expect(String(error)).not.toContain("fake-private-key-error");
      expect(JSON.stringify(error)).not.toContain("fake-private-key-error");
      expect(error).not.toHaveProperty("cause");
      expect(store.getState().notice).toBeNull();
    }
  });

  it("读存储失败阻止prepare；保存失败仍可使用上次真正保存的配置", async () => {
    const failedRead = createCredentialSettingsStore(() => ({ getItem: () => "{broken", setItem: () => {} }));
    const fetcher = vi.fn<typeof fetch>();
    await expect(createCredentialsApi(failedRead, fetcher).prepareSearchCredentials()).rejects.toMatchObject({ problem: { code: "CREDENTIALS_INVALID" } });
    expect(failedRead.getState().notice).toEqual({ code: "CREDENTIALS_INVALID" });
    const { store, storage } = fixture();
    own(store);
    storage.setItem.mockImplementationOnce(() => { throw new Error("fake-quota-error"); });
    store.getState().saveService("deepseek", { source: "own", apiKey: "fake-unsaved" });
    expect((await createCredentialsApi(store, fetcher).prepareSearchCredentials()).deepseek).toEqual({ source: "own", apiKey: "fake-own-llm" });
    expect(store.getState().error).toBe("save");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("预先取消不发请求或改notice；等待资格时取消也原样及时传播", async () => {
    const { store } = fixture();
    author(store);
    store.getState().setNotice({ code: "CREDENTIALS_REQUIRED" });
    const previous = store.getState().notice;
    const response = createDeferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => response.promise);
    const api = createCredentialsApi(store, fetcher);
    const preAborted = new AbortController();
    const reason = new Error("fake-user-cancel");
    preAborted.abort(reason);
    await expect(api.prepareSearchCredentials(preAborted.signal)).rejects.toBe(reason);
    await expect(api.verifyExperience("假码", preAborted.signal)).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const prepared = api.prepareSearchCredentials(controller.signal);
    controller.abort(reason);
    await expect(prepared).rejects.toBe(reason);
    response.resolve(json({ authorized: true }));
    expect(store.getState().notice).toBe(previous);
  });

  it("正文读取期间取消仍传播原reason，不把JSON读取错误变成配置错误", async () => {
    const { store } = fixture();
    author(store);
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const started = createDeferred<void>();
    const stream = new ReadableStream<Uint8Array>({ pull: controller => { body = controller; started.resolve(); } }, { highWaterMark: 0 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const controller = new AbortController();
    const reason = new Error("fake-close-modal");
    const prepared = createCredentialsApi(store, fetcher).prepareSearchCredentials(controller.signal);
    await started.promise;
    controller.abort(reason);
    await expect(prepared).rejects.toBe(reason);
    body?.error(new Error("fake-private-body"));
    expect(store.getState().notice).toBeNull();
  });
});
