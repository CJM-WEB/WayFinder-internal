/**
 * 身份状态只来自同源会话接口，不保存身份 Cookie 或本地“已登录”标记。
 * 每次请求绑定递增意图；旧登录/查询响应不能覆盖新身份或重新载入旧账号资料。
 */
import { createStore } from "zustand/vanilla";
import type { Account, AccountAction } from "@wayfinder/contracts";
import { accountApi, AccountRequestError, type createAccountApi } from "../api/account.js";
import { credentialSettingsStore } from "./credential-settings.js";

type IdentitySwitch = (userId: string | null) => Promise<void>;
export type AccountState = {
  account: Account | null; scopeUserId: string | null; epoch: number; busy: boolean; error: string | null;
  refresh: (signal?: AbortSignal) => Promise<void>;
  submit: (action: AccountAction) => Promise<"accepted" | "account">;
};

export function createAccountStore(api: ReturnType<typeof createAccountApi> = accountApi, initialIdentityHandler: IdentitySwitch = async () => {}) {
  let intent = 0, request: AbortController | undefined;
  let switchIdentity: IdentitySwitch = initialIdentityHandler;
  let initialized = false;
  let identityUserId: string | null = null;
  let identityReady = Promise.resolve();
  const store = createStore<AccountState>()((set, get) => {
    const apply = async (account: Account | null, current: number): Promise<void> => {
      if (current !== intent) return;
      if (!initialized || identityUserId !== (account?.userId ?? null)) {
        const changed = identityUserId !== (account?.userId ?? null);
        initialized = true;
        identityUserId = account?.userId ?? null;
        // 初次确认同一访客仍初始化存储，但不是换号，不撤销正在做身份预检的首次搜索。
        set({ account: null, scopeUserId: identityUserId, epoch: get().epoch + (changed ? 1 : 0) });
        identityReady = switchIdentity(identityUserId);
      }
      await identityReady;
      if (current !== intent) return;
      set({ account });
    };
    return {
      account: null, scopeUserId: null, epoch: 0, busy: false, error: null,
      refresh: async signal => {
        const current = ++intent;
        request?.abort(); request = new AbortController();
        const bounded = signal === undefined ? request.signal : AbortSignal.any([signal, request.signal]);
        try {
          const result = await api(undefined, bounded);
          if (!("account" in result)) throw new AccountRequestError();
          await apply(result.account, current);
        } catch (error: unknown) {
          if (current === intent && !bounded.aborted) await apply(null, current);
          throw error;
        } finally { if (current === intent) set({ busy: false }); }
      },
      submit: async action => {
        const current = ++intent;
        request?.abort(); request = new AbortController();
        set({ busy: true, error: null });
        try {
          const result = await api(action, request.signal);
          if (current !== intent) throw new AccountRequestError();
          if (action.action === "logout") await apply(null, current);
          else if ("account" in result) await apply(result.account, current);
          return "accepted" in result ? "accepted" : "account";
        } catch (error: unknown) {
          if (current === intent) set({ error: error instanceof AccountRequestError ? error.code : "ACCOUNT_UNAVAILABLE" });
          throw error;
        } finally { if (current === intent) set({ busy: false }); }
      },
    };
  });
  return { store, configureIdentity: (handler: IdentitySwitch): void => { switchIdentity = handler; } };
}
// 内部评估不读取个人图；仍按真实身份分区Key，不能把访客Key当作账号Key继续使用。
const accountState = createAccountStore(accountApi, async userId => { credentialSettingsStore.getState().setIdentity(userId); });
export const accountStore = accountState.store;
export const configureAccountIdentity = accountState.configureIdentity;
