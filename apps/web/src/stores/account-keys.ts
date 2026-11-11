/** 只保留账号Key掩码/版本的内存视图；专属代际撤销运行，不改变账号代际或图同步生命周期。 */
import { createStore } from "zustand/vanilla";
import { AccountKeysResponseSchema, type AccountKeysResponse, type AccountKeysErrorResponse, type CredentialService } from "@wayfinder/contracts";
import { accountStore } from "./account.js";

export const accountKeysStore = createStore<{
  summary: AccountKeysResponse | null; error: AccountKeysErrorResponse | null; generation: number; loading: boolean;
  serviceGenerations: Readonly<Record<CredentialService, number>>; changedServices: readonly CredentialService[];
}>(() => ({ summary: null, error: null, generation: 0, loading: false,
  serviceGenerations: { deepseek: 0, serpapi: 0 }, changedServices: [] }));

export function publishAccountKeys(response: AccountKeysResponse, expectedUserId: string, epoch: number, changedService?: CredentialService, expectedGeneration?: number): boolean {
  const identity = accountStore.getState();
  if (identity.epoch !== epoch || identity.scopeUserId !== expectedUserId) return false;
  if (expectedGeneration !== undefined && accountKeysStore.getState().generation !== expectedGeneration) return false;
  const parsed = AccountKeysResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.userId !== expectedUserId) return false;
  accountKeysStore.setState(state => {
    const candidates = changedService !== undefined ? [changedService] : state.summary?.userId === expectedUserId ? ["deepseek", "serpapi"] as const : [];
    const changed = candidates.filter(service => state.summary?.userId !== expectedUserId || state.summary[service].revision !== parsed.data[service].revision);
    return {
    summary: changedService !== undefined && state.summary?.userId === expectedUserId
      ? { ...state.summary, [changedService]: parsed.data[changedService] } : parsed.data,
    error: null, loading: false, generation: state.generation + (changed.length > 0 ? 1 : 0),
    serviceGenerations: { deepseek: state.serviceGenerations.deepseek + Number(changed.includes("deepseek")), serpapi: state.serviceGenerations.serpapi + Number(changed.includes("serpapi")) },
    changedServices: changed.length > 0 ? changed : state.changedServices,
    };
  });
  return true;
}

accountStore.subscribe((next, previous) => {
  if (next.epoch !== previous.epoch) accountKeysStore.setState({ summary: null, error: null, loading: false });
});
