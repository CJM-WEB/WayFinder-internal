/** 掩码内存视图不改变账号/图同步代际，旧读/并行服务ACK不能回退其他服务版本。 */
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "./account.js";
import { accountKeysStore, publishAccountKeys } from "./account-keys.js";
import { createCredentialSettingsStore, readGuestApiKey } from "./credential-settings.js";

const identity = accountStore.getState(), initial = accountKeysStore.getState();
afterEach(() => { accountStore.setState(identity); accountKeysStore.setState(initial); });
const a = { userId: "fixture-A", email: "a@example.test" };
const summary = () => ({ userId: a.userId, deepseek: { configured: true as const, mask: "••••abcd", revision: "deepseek-1" }, serpapi: { configured: true as const, mask: "••••efgh", revision: "serpapi-1" } });

describe("云Key内存状态与独立来源", () => {
  it("单服务写ACK只更新该服务且推进专属代际，旧GET和旧身份均拒绝", () => {
    accountStore.setState({ account: a, scopeUserId: a.userId, epoch: 4 });
    expect(publishAccountKeys(summary(), a.userId, 4)).toBe(true);
    expect(accountKeysStore.getState().generation).toBe(initial.generation);
    const generation = accountKeysStore.getState().generation;
    expect(publishAccountKeys({ ...summary(), deepseek: { ...summary().deepseek, revision: "deepseek-2" } }, a.userId, 4, "deepseek")).toBe(true);
    expect(publishAccountKeys({ ...summary(), serpapi: { ...summary().serpapi, revision: "serpapi-2" } }, a.userId, 4, "serpapi")).toBe(true);
    expect(accountKeysStore.getState().summary?.deepseek.revision).toBe("deepseek-2");
    expect(accountKeysStore.getState().summary?.serpapi.revision).toBe("serpapi-2");
    expect(accountKeysStore.getState().generation).toBe(generation + 2); expect(accountStore.getState().epoch).toBe(4);
    publishAccountKeys({ ...summary(), serpapi: { ...summary().serpapi, revision: "serpapi-2" } }, a.userId, 4, "serpapi");
    expect(accountKeysStore.getState().generation).toBe(generation + 2);
    expect(publishAccountKeys(summary(), a.userId, 4, undefined, generation)).toBe(false);
    const current = accountKeysStore.getState().summary;
    if (current === null) throw new Error("缺少Key状态");
    publishAccountKeys({ ...current, deepseek: { configured: false, mask: null, revision: "remote-tombstone" } }, a.userId, 4);
    expect(accountKeysStore.getState().generation).toBe(generation + 3);
    expect(accountKeysStore.getState().changedServices).toEqual(["deepseek"]);
    accountStore.setState({ account: null, scopeUserId: null, epoch: 5 });
    expect(accountKeysStore.getState().summary).toBeNull(); expect(publishAccountKeys(summary(), a.userId, 4)).toBe(false);
  });
  it("显式读取访客Key不写源、不改当前账号来源，cloud偏好保留浏览器Key", () => {
    const guest = JSON.stringify({ deepseek: { source: "own", apiKey: "fixture-guest" }, serpapi: { source: "own", apiKey: "fixture-search" } });
    const values = new Map<string, string>([["wayfinder.credentials.v1", guest]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences = createCredentialSettingsStore(() => storage); preferences.getState().setIdentity(a.userId);
    preferences.getState().saveService("deepseek", { source: "own", apiKey: "fixture-browser" });
    expect(readGuestApiKey("deepseek", () => storage)).toBe("fixture-guest");
    expect(preferences.getState().preferences.deepseek).toEqual({ source: "own", apiKey: "fixture-browser" });
    preferences.getState().saveService("deepseek", { source: "cloud", apiKey: "fixture-browser" });
    expect(preferences.getState().preferences.deepseek).toEqual({ source: "cloud", apiKey: "fixture-browser" });
    expect(values.get("wayfinder.credentials.v1")).toBe(guest);
  });
});
