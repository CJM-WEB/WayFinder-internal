/**
 * 昵称共享视图回归：使用假 profile（资料）响应验证读写顺序、取消与换号隔离。
 * 不请求真实后端；故意让旧请求忽略取消，以检查发布边界本身而非传输实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfileResponse } from "@wayfinder/contracts";
import { groupApi, GroupRequestError } from "../api/groups.js";
import { accountStore } from "./account.js";
import { accountProfileStore } from "./account-profile.js";

const identity = accountStore.getState(), initial = accountProfileStore.getState();
const a = { userId: "fixture-A", email: "a@example.test" };
const b = { userId: "fixture-B", email: "b@example.test" };
const result = (userId: string, nickname: string | null): AccountProfileResponse => ({ profile: { userId, nickname } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
beforeEach(() => accountStore.setState({ account: a, scopeUserId: a.userId, epoch: identity.epoch + 1 }));
afterEach(() => { accountStore.setState(identity); accountProfileStore.setState(initial); vi.restoreAllMocks(); });

describe("账号昵称异步发布", () => {
  it("保存的新昵称先确认时，忽略不遵守取消的旧读取", async () => {
    const old = deferred<AccountProfileResponse>();
    const api = vi.spyOn(groupApi, "profile").mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(result(a.userId, "新昵称"));
    const read = accountProfileStore.getState().refresh();
    await accountProfileStore.getState().save("新昵称");
    expect(accountProfileStore.getState()).toMatchObject({ userId: a.userId, nickname: "新昵称", loading: false });
    old.resolve(result(a.userId, "旧昵称")); await read;
    expect(accountProfileStore.getState().nickname).toBe("新昵称");
    expect(api.mock.calls[0]?.[1].aborted).toBe(true);
    expect(api.mock.calls[1]?.[2]).toEqual({ nickname: "新昵称" });
  });

  it("换号立即清空旧昵称，迟到保存不能覆盖新账号资料", async () => {
    const old = deferred<AccountProfileResponse>();
    vi.spyOn(groupApi, "profile").mockImplementationOnce(() => old.promise).mockResolvedValueOnce(result(b.userId, "小乙"));
    const save = accountProfileStore.getState().save("小甲");
    accountStore.setState({ account: b, scopeUserId: b.userId, epoch: accountStore.getState().epoch + 1 });
    expect(accountProfileStore.getState()).toMatchObject({ userId: null, nickname: null, loading: false, error: null });
    await accountProfileStore.getState().refresh();
    old.resolve(result(a.userId, "小甲")); await save;
    expect(accountProfileStore.getState()).toMatchObject({ userId: b.userId, nickname: "小乙", loading: false });
  });

  it("保存失败保留已确认昵称，并呈现固定错误码", async () => {
    vi.spyOn(groupApi, "profile").mockResolvedValueOnce(result(a.userId, "原昵称"))
      .mockRejectedValueOnce(new GroupRequestError("GROUP_UNAVAILABLE"));
    await accountProfileStore.getState().refresh();
    await expect(accountProfileStore.getState().save("未保存昵称")).rejects.toBeInstanceOf(GroupRequestError);
    expect(accountProfileStore.getState()).toMatchObject({ userId: a.userId, nickname: "原昵称", error: "GROUP_UNAVAILABLE", loading: false });
  });

  it("调用者取消后不发布迟到资料，且释放读取中状态", async () => {
    const old = deferred<AccountProfileResponse>();
    vi.spyOn(groupApi, "profile").mockImplementationOnce(() => old.promise);
    const controller = new AbortController(), read = accountProfileStore.getState().refresh(controller.signal);
    controller.abort(); old.resolve(result(a.userId, "已取消昵称")); await read;
    expect(accountProfileStore.getState()).toMatchObject({ nickname: null, loading: false, error: null });
  });

  it("访客不读取或写入账号资料", async () => {
    accountStore.setState({ account: null, scopeUserId: null, epoch: accountStore.getState().epoch + 1 });
    const api = vi.spyOn(groupApi, "profile");
    await accountProfileStore.getState().refresh(); await accountProfileStore.getState().save("不应保存");
    expect(api).not.toHaveBeenCalled();
    expect(accountProfileStore.getState()).toMatchObject({ userId: null, nickname: null, loading: false });
  });
});
