/**
 * 模块职责：在独立浏览器存档中保存两服务的明确选择及自带 Key（密钥），不参与图历史或撤销。
 * 失败路径：读失败不覆盖未知旧数据；明确保存成功后才发布新偏好，保存失败继续保留原配置。
 * 隐私边界：不保存邀请码、资格布尔值或授权 Cookie（浏览器凭证），不订阅自动写入。
 */
import {
  ApiKeySchema, CredentialServiceSchema, CredentialsErrorResponseSchema,
  type CredentialService, type CredentialsErrorResponse,
} from "@wayfinder/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

export const CREDENTIAL_SETTINGS_STORAGE_KEY = "wayfinder.credentials.v1";
export type CredentialPreference = Readonly<{ source: "own" | "author"; apiKey: string }>;
export type CredentialPreferences = Readonly<Record<CredentialService, CredentialPreference>>;
export type CredentialSettingsState = {
  preferences: CredentialPreferences;
  error: "read" | "save" | null;
  notice: CredentialsErrorResponse | null;
  saveService: (service: CredentialService, next: CredentialPreference) => boolean;
  reload: () => boolean;
  clearNotice: () => void;
  setNotice: (problem: CredentialsErrorResponse) => void;
};
export type CredentialSettingsStore = StoreApi<CredentialSettingsState>;
type CredentialStorage = Pick<Storage, "getItem" | "setItem">;

function defaults(): CredentialPreferences {
  return Object.freeze({
    deepseek: Object.freeze({ source: "own", apiKey: "" }),
    serpapi: Object.freeze({ source: "own", apiKey: "" }),
  });
}

/** 本地偏好不是公共传输对象：author 也保留原 own Key，发请求时再按公共 Schema 投影。 */
function parsePreference(input: unknown): CredentialPreference | null {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !("source" in input) || !("apiKey" in input) ||
    !Object.hasOwn(input, "source") || !Object.hasOwn(input, "apiKey") ||
    (input.source !== "own" && input.source !== "author") || typeof input.apiKey !== "string") return null;
  const key = input.apiKey === "" ? "" : ApiKeySchema.safeParse(input.apiKey);
  if (key !== "" && !key.success) return null;
  return Object.freeze({ source: input.source, apiKey: key === "" ? "" : key.data });
}

function parsePreferences(input: unknown): CredentialPreferences | null {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !("deepseek" in input) || !("serpapi" in input) ||
    !Object.hasOwn(input, "deepseek") || !Object.hasOwn(input, "serpapi")) return null;
  const deepseek = parsePreference(input.deepseek);
  const serpapi = parsePreference(input.serpapi);
  return deepseek === null || serpapi === null ? null : Object.freeze({ deepseek, serpapi });
}

export function createCredentialSettingsStore(
  storageGetter: () => CredentialStorage = () => window.localStorage,
): CredentialSettingsStore {
  const store = createStore<CredentialSettingsState>()((set, get) => ({
    preferences: defaults(), error: null, notice: null,
    reload: () => {
      try {
        const saved = storageGetter().getItem(CREDENTIAL_SETTINGS_STORAGE_KEY);
        const preferences = saved === null ? defaults() : parsePreferences(JSON.parse(saved) as unknown);
        if (preferences === null) throw new Error("本地凭据配置格式无效");
        set({ preferences, error: null });
        return true;
      } catch {
        set({ error: "read" });
        return false;
      }
    },
    saveService: (service, next) => {
      if (get().error === "read") return false;
      const parsed = parsePreference(next);
      if (!CredentialServiceSchema.safeParse(service).success || parsed === null) {
        set({ error: "save" });
        return false;
      }
      const preferences = Object.freeze({ ...get().preferences, [service]: parsed });
      try {
        storageGetter().setItem(CREDENTIAL_SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
        set({ preferences, error: null });
        return true;
      } catch {
        set({ error: "save" });
        return false;
      }
    },
    clearNotice: () => set({ notice: null }),
    setNotice: problem => {
      const parsed = CredentialsErrorResponseSchema.safeParse(problem);
      if (parsed.success) set({ notice: Object.freeze(parsed.data) });
    },
  }));
  // 初始化只读；缺失存档也不自动落盘，避免导入模块或展示设置就修改浏览器数据。
  store.getState().reload();
  return store;
}

export const credentialSettingsStore = createCredentialSettingsStore();
