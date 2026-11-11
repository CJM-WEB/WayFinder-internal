/** 身份回归：会话响应是唯一来源，退出/换号/网络失败不能复活迟到身份。 */
import { describe, expect, it, vi } from "vitest";
import type { AccountResponse } from "@wayfinder/contracts";
import { AccountRequestError, type createAccountApi } from "../api/account.js";
import { createAccountStore } from "./account.js";

const a = { userId: "fixture-A", email: "a@example.test" };
const b = { userId: "fixture-B", email: "b@example.test" };
describe("账号身份代际", () => {
  it("首次同访客确认仍初始化身份处理器，但不误判换号；真实登录退出继续推进代际", async () => {
    const api = vi.fn<ReturnType<typeof createAccountApi>>().mockResolvedValueOnce({ account: null })
      .mockResolvedValueOnce({ account: a }).mockResolvedValueOnce({ accepted: true });
    const initialized = vi.fn(async () => {});
    const { store } = createAccountStore(api, initialized);
    await store.getState().refresh();
    expect(initialized).toHaveBeenCalledWith(null); expect(store.getState().epoch).toBe(0);
    await store.getState().submit({ action: "login", email: a.email, password: "fixture-password" });
    expect(store.getState().epoch).toBe(1);
    await store.getState().submit({ action: "logout" });
    expect(store.getState().epoch).toBe(2);
  });
  it("退出即使返回accepted也切回访客，重复同身份读取不重载空间", async () => {
    const api = vi.fn<ReturnType<typeof createAccountApi>>()
      .mockResolvedValueOnce({ account: a }).mockResolvedValueOnce({ account: a }).mockResolvedValueOnce({ accepted: true });
    const { store, configureIdentity } = createAccountStore(api);
    const switchIdentity = vi.fn(async () => {}); configureIdentity(switchIdentity);
    await store.getState().refresh(); await store.getState().refresh();
    expect(switchIdentity).toHaveBeenCalledTimes(1);
    await store.getState().submit({ action: "logout" });
    expect(store.getState().account).toBeNull();
    expect(switchIdentity.mock.calls).toEqual([["fixture-A"], [null]]);
  });

  it("新身份确认后，忽略不遵守取消的旧登录响应", async () => {
    let resolve!: (value: AccountResponse) => void;
    const api = vi.fn<ReturnType<typeof createAccountApi>>()
      .mockImplementationOnce(() => new Promise(value => { resolve = value; }))
      .mockResolvedValueOnce({ account: b });
    const { store } = createAccountStore(api);
    const pending = store.getState().submit({ action: "login", email: a.email, password: "fixture-password" });
    const rejected = expect(pending).rejects.toBeInstanceOf(AccountRequestError);
    await store.getState().refresh(); resolve({ account: a }); await rejected;
    expect(store.getState().account).toEqual(b);
  });

  it("会话查询失败清空旧身份并退回访客空间，不悄悄沿用旧账号", async () => {
    const api = vi.fn<ReturnType<typeof createAccountApi>>().mockResolvedValueOnce({ account: a }).mockRejectedValueOnce(new AccountRequestError());
    const { store, configureIdentity } = createAccountStore(api);
    const switchIdentity = vi.fn(async () => {}); configureIdentity(switchIdentity);
    await store.getState().refresh();
    await expect(store.getState().refresh()).rejects.toBeInstanceOf(AccountRequestError);
    expect(store.getState().account).toBeNull(); expect(switchIdentity).toHaveBeenLastCalledWith(null);
  });
});
