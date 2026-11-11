/** 测试职责：独立凭据存档只在明确保存后写入，覆盖严格恢复、清除及读写失败保护。 */
import { describe, expect, it, vi } from "vitest";

import {
  CREDENTIAL_SETTINGS_STORAGE_KEY, createCredentialSettingsStore, type CredentialPreference,
} from "./credential-settings.js";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage = {
    getItem: vi.fn<Storage["getItem"]>(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
  };
  return { storage, value: () => value, replace: (next: string | null) => { value = next; } };
}

describe("独立凭据设置存储", () => {
  it("访客和不同账号使用独立Key空间，读取失败也不保留旧Key", () => {
    const values = new Map<string, string>();
    let failRead = false;
    const storage = { getItem: (key: string) => { if (failRead) throw new Error(); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = createCredentialSettingsStore(() => storage);
    store.getState().saveService("deepseek", { source: "own", apiKey: "fixture-guest-key" });
    store.getState().setIdentity("fixture-A");
    expect(store.getState().preferences.deepseek.apiKey).toBe("");
    store.getState().saveService("deepseek", { source: "own", apiKey: "fixture-A-key" });
    store.getState().setIdentity("fixture-B");
    expect(store.getState().preferences.deepseek.apiKey).toBe("");
    store.getState().setIdentity("fixture-A");
    expect(store.getState().preferences.deepseek.apiKey).toBe("fixture-A-key");
    store.getState().setIdentity(null);
    expect(store.getState().preferences.deepseek.apiKey).toBe("fixture-guest-key");
    failRead = true; store.getState().setIdentity("fixture-B");
    expect(store.getState().preferences.deepseek.apiKey).toBe("");
    expect(store.getState().error).toBe("read");
    expect(values.size).toBe(2);
  });
  it("默认两个服务都自带空Key，初始化、reload及notice变化均不自动写入", () => {
    const disk = memoryStorage();
    const store = createCredentialSettingsStore(() => disk.storage);
    expect(store.getState().preferences).toEqual({ deepseek: { source: "own", apiKey: "" }, serpapi: { source: "own", apiKey: "" } });
    expect(store.getState().error).toBeNull();
    expect(disk.storage.getItem).toHaveBeenCalledWith(CREDENTIAL_SETTINGS_STORAGE_KEY);
    store.getState().setNotice({ code: "CREDENTIALS_REQUIRED", service: "deepseek" });
    store.getState().clearNotice();
    expect(store.getState().reload()).toBe(true);
    expect(disk.storage.setItem).not.toHaveBeenCalled();
    expect(disk.value()).toBeNull();
  });

  it("规范化保存并跨实例恢复；选择author保留显式提供的own Key，清除支持空串", () => {
    const disk = memoryStorage();
    const store = createCredentialSettingsStore(() => disk.storage);
    expect(store.getState().saveService("deepseek", { source: "own", apiKey: "  fake-own-key  " })).toBe(true);
    expect(store.getState().preferences.deepseek.apiKey).toBe("fake-own-key");
    expect(store.getState().saveService("deepseek", { source: "author", apiKey: store.getState().preferences.deepseek.apiKey })).toBe(true);
    const restored = createCredentialSettingsStore(() => disk.storage);
    expect(restored.getState().preferences.deepseek).toEqual({ source: "author", apiKey: "fake-own-key" });
    expect(restored.getState().preferences.serpapi).toEqual({ source: "own", apiKey: "" });
    expect(restored.getState().saveService("deepseek", { source: "own", apiKey: "" })).toBe(true);
    expect(createCredentialSettingsStore(() => disk.storage).getState().preferences.deepseek).toEqual({ source: "own", apiKey: "" });
    expect(Object.keys(JSON.parse(disk.value() ?? "{}")).sort()).toEqual(["deepseek", "serpapi"]);
  });

  it("非法Key、来源或未知字段均不覆盖已保存的偏好", () => {
    const disk = memoryStorage();
    const store = createCredentialSettingsStore(() => disk.storage);
    store.getState().saveService("serpapi", { source: "own", apiKey: "fake-previous" });
    const previous = store.getState().preferences;
    const saved = disk.value();
    for (const input of [
      { source: "own", apiKey: "   " }, { source: "own", apiKey: "fake\nkey" },
      { source: "own", apiKey: "假密钥" }, { source: "unknown", apiKey: "fake-key" },
      { source: "author", apiKey: "fake-key", verified: true },
      { source: "own", apiKey: "x".repeat(4097) },
    ]) {
      expect(store.getState().saveService("serpapi", input as CredentialPreference)).toBe(false);
      expect(store.getState().preferences).toBe(previous);
      expect(store.getState().error).toBe("save");
      expect(disk.value()).toBe(saved);
    }
    expect(disk.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("损坏、未知字段及带资格的旧数据读失败，显式保存也不能覆盖，修复后reload恢复", () => {
    const normal = { deepseek: { source: "own", apiKey: "fake-restored" }, serpapi: { source: "own", apiKey: "" } };
    for (const initial of ["{bad", "null", JSON.stringify({ ...normal, authorized: true }), JSON.stringify({ deepseek: normal.deepseek })]) {
      const disk = memoryStorage(initial);
      const store = createCredentialSettingsStore(() => disk.storage);
      expect(store.getState().error).toBe("read");
      expect(store.getState().saveService("deepseek", { source: "own", apiKey: "fake-overwrite" })).toBe(false);
      expect(disk.value()).toBe(initial);
      expect(disk.storage.setItem).not.toHaveBeenCalled();
      disk.replace(JSON.stringify(normal));
      expect(store.getState().reload()).toBe(true);
      expect(store.getState().preferences).toEqual(normal);
      expect(store.getState().error).toBeNull();
    }
  });

  it("getter或读取抛错只报告read，不暴露异常；后续读取失败保留已知内存配置", () => {
    const disk = memoryStorage();
    const denied = createCredentialSettingsStore(() => { throw new Error("fake-private-storage-secret"); });
    expect(denied.getState().error).toBe("read");
    const store = createCredentialSettingsStore(() => disk.storage);
    store.getState().saveService("deepseek", { source: "own", apiKey: "fake-known" });
    const previous = store.getState().preferences;
    disk.storage.getItem.mockImplementationOnce(() => { throw new Error("fake-private-storage-secret"); });
    expect(store.getState().reload()).toBe(false);
    expect(store.getState().preferences).toBe(previous);
    expect(store.getState().notice).toBeNull();
    expect(JSON.stringify(denied.getState())).not.toContain("fake-private-storage-secret");
  });

  it("写入或清除失败维持旧内存和存档，重试成功才发布新配置", () => {
    const disk = memoryStorage();
    const store = createCredentialSettingsStore(() => disk.storage);
    store.getState().saveService("serpapi", { source: "own", apiKey: "fake-saved" });
    const previous = store.getState().preferences;
    const saved = disk.value();
    disk.storage.setItem.mockImplementationOnce(() => { throw new Error("fake-quota-secret"); });
    expect(store.getState().saveService("serpapi", { source: "own", apiKey: "" })).toBe(false);
    expect(store.getState().preferences).toBe(previous);
    expect(store.getState().error).toBe("save");
    expect(disk.value()).toBe(saved);
    expect(store.getState().saveService("serpapi", { source: "own", apiKey: "" })).toBe(true);
    expect(store.getState().preferences.serpapi.apiKey).toBe("");
    expect(store.getState().error).toBeNull();
  });

  it("发布偏好与输入对象隔离，notice仅保留公共字段且不落盘", () => {
    const disk = memoryStorage();
    const store = createCredentialSettingsStore(() => disk.storage);
    const input: CredentialPreference = { source: "own", apiKey: "fake-key" };
    store.getState().saveService("deepseek", input);
    expect(store.getState().preferences.deepseek).not.toBe(input);
    expect(Object.isFrozen(store.getState().preferences)).toBe(true);
    store.getState().setNotice({ code: "EXPERIENCE_REVOKED" });
    expect(store.getState().notice).toEqual({ code: "EXPERIENCE_REVOKED" });
    expect(disk.value()).not.toContain("EXPERIENCE_REVOKED");
    expect(disk.value()).not.toContain("inviteCode");
    expect(disk.value()).not.toContain("authorized");
  });
});
