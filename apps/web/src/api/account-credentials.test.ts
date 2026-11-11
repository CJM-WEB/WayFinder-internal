/** 访客BYOK不能被身份服务故障阻断，但旧账号Key绝不能降级后发送给另一个身份。 */
import { afterEach, expect, it, vi } from "vitest";
import type { SearchCredentials } from "@wayfinder/contracts";
import { checkSearchIdentity } from "./credentials.js";
import { accountStore } from "../stores/account.js";
import { AccountRequestError } from "./account.js";

const initial = accountStore.getState();
afterEach(() => { accountStore.setState(initial); vi.restoreAllMocks(); });
const own: SearchCredentials = { deepseek: { source: "own", apiKey: "fixture-guest-llm" }, serpapi: { source: "own", apiKey: "fixture-guest-search" } };
it("原访客空间双自带Key可在身份接口不可用时继续，作者选择仍拒绝", async () => {
  accountStore.setState({ account: null, scopeUserId: null, epoch: 1 });
  vi.spyOn(accountStore.getState(), "refresh").mockRejectedValue(new AccountRequestError());
  await expect(checkSearchIdentity(undefined, own)).resolves.toBeUndefined();
  await expect(checkSearchIdentity(undefined, { ...own, deepseek: { source: "author" } })).rejects.toBeInstanceOf(AccountRequestError);
});
it("A账号身份故障退回访客后拒绝旧冻结Key，不能当成访客降级", async () => {
  accountStore.setState({ account: { userId: "fixture-A", email: "a@example.test" }, scopeUserId: "fixture-A", epoch: 1 });
  vi.spyOn(accountStore.getState(), "refresh").mockImplementation(async () => {
    accountStore.setState({ account: null, scopeUserId: null, epoch: 2 }); throw new AccountRequestError();
  });
  await expect(checkSearchIdentity(undefined, own)).rejects.toBeInstanceOf(AccountRequestError);
});
it("正在加载的账号空间即使account暂为null，也不能冒充原访客", async () => {
  accountStore.setState({ account: null, scopeUserId: "fixture-A", epoch: 1 });
  vi.spyOn(accountStore.getState(), "refresh").mockRejectedValue(new AccountRequestError());
  await expect(checkSearchIdentity(undefined, own)).rejects.toBeInstanceOf(AccountRequestError);
});
