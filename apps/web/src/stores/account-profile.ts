/**
 * 账号昵称的内存视图：头像、设置和小组共用既有 profile（资料）接口，不另存身份或邮箱。
 * 异步边界：换号立即清空；读取与保存按最新意图发布，迟到读取不能覆盖新昵称。
 */
import { createStore } from "zustand/vanilla";
import { groupApi, GroupRequestError } from "../api/groups.js";
import { accountStore } from "./account.js";

type ProfileState = {
  userId: string | null; nickname: string | null; loading: boolean; error: string | null;
  refresh: (signal?: AbortSignal) => Promise<void>;
  save: (nickname: string, signal?: AbortSignal) => Promise<void>;
};
let intent = 0;
let request: AbortController | null = null;
export const accountProfileStore = createStore<ProfileState>((set) => {
  const load = async (nickname?: string, signal?: AbortSignal): Promise<void> => {
    const identity = accountStore.getState();
    if (identity.account === null) return;
    const { userId } = identity.account, epoch = identity.epoch, current = ++intent;
    request?.abort(); request = new AbortController();
    const bounded = signal === undefined ? request.signal : AbortSignal.any([signal, request.signal]);
    set(state => ({ userId, nickname: state.userId === userId ? state.nickname : null, loading: true, error: null }));
    const active = (): boolean => current === intent && !bounded.aborted && accountStore.getState().epoch === epoch
      && accountStore.getState().account?.userId === userId;
    try {
      const result = await groupApi.profile(userId, bounded, nickname === undefined ? undefined : { nickname });
      if (active()) set({ userId, nickname: result.profile.nickname, error: null });
    } catch (error: unknown) {
      if (active()) set({ error: error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE" });
      throw error;
    } finally { if (current === intent) set({ loading: false }); }
  };
  return { userId: null, nickname: null, loading: false, error: null,
    refresh: signal => load(undefined, signal), save: (nickname, signal) => load(nickname, signal) };
});

accountStore.subscribe((next, previous) => {
  if (next.epoch === previous.epoch) return;
  ++intent; request?.abort(); request = null;
  accountProfileStore.setState({ userId: null, nickname: null, loading: false, error: null });
});
