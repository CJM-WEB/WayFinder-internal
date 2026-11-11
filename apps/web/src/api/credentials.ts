/**
 * 模块职责：读取公开配置、验证体验资格，并在搜索前冻结已保存的凭据选择。
 * 安全边界：后端 JSON 始终按公共 Schema 投影；不保存邀请码或资格，不回传原始错误正文。
 * 取消边界：原 AbortSignal（中止信号）优先，取消不设置错误提示，也不改动已保存偏好。
 */
import {
  ApiKeySchema, CredentialsErrorResponseSchema, ExperienceInviteRequestSchema,
  ExperienceStatusResponseSchema, SearchCredentialsSchema, SettingsPublicResponseSchema,
  type CredentialService, type CredentialsErrorResponse, type SearchCredentials,
  type ServiceCredentials, type SettingsPublicResponse,
} from "@wayfinder/contracts";

import {
  credentialSettingsStore, type CredentialPreference, type CredentialSettingsStore,
} from "../stores/credential-settings.js";
import { accountStore } from "../stores/account.js";

/** 任何构造来源都再次投影，避免原始网络错误、响应字段或秘密进入可展示异常。 */
export class CredentialsConfigurationError extends Error {
  readonly problem: CredentialsErrorResponse;

  constructor(problem: CredentialsErrorResponse) {
    super("API 凭据配置或体验资格不可用");
    this.name = "CredentialsConfigurationError";
    const parsed = CredentialsErrorResponseSchema.safeParse(problem);
    this.problem = Object.freeze(parsed.success ? parsed.data : { code: "EXPERIENCE_UNAVAILABLE" });
  }
}

/** 即使测试 Fetch 或正文读取忽略 Signal，关闭界面仍能及时结束等待且保留原 reason。 */
function awaitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => { cleanup(); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) onAbort();
  });
}

function toWirePreference(service: CredentialService, saved: CredentialPreference): ServiceCredentials {
  if (saved.source === "author") return { source: "author" };
  if (saved.source !== "own") throw new CredentialsConfigurationError({ code: "CREDENTIALS_INVALID", service });
  if (saved.apiKey === "") throw new CredentialsConfigurationError({ code: "CREDENTIALS_REQUIRED", service });
  const key = ApiKeySchema.safeParse(saved.apiKey);
  if (!key.success) throw new CredentialsConfigurationError({ code: "CREDENTIALS_INVALID", service });
  return { source: "own", apiKey: key.data };
}

export function createCredentialsApi(
  store: CredentialSettingsStore = credentialSettingsStore,
  fetchImplementation: typeof fetch = (input, init) => globalThis.fetch(input, init),
  checkIdentity?: (signal: AbortSignal | undefined, selected: SearchCredentials) => Promise<void>,
) {
  const requestJson = async (url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> => {
    try {
      signal?.throwIfAborted();
      const response = await awaitWithSignal(fetchImplementation(url, {
        ...init, cache: "no-store", credentials: "same-origin", ...(signal === undefined ? {} : { signal }),
      }), signal);
      signal?.throwIfAborted();
      const raw: unknown = await awaitWithSignal(response.json(), signal);
      signal?.throwIfAborted();
      if (!response.ok) {
        const parsed = CredentialsErrorResponseSchema.safeParse(raw);
        throw new CredentialsConfigurationError(parsed.success ? parsed.data : { code: "EXPERIENCE_UNAVAILABLE" });
      }
      return raw;
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (error instanceof CredentialsConfigurationError) throw error;
      throw new CredentialsConfigurationError({ code: "EXPERIENCE_UNAVAILABLE" });
    }
  };
  const fetchSettings = async (signal?: AbortSignal): Promise<SettingsPublicResponse> => {
    const result = SettingsPublicResponseSchema.safeParse(await requestJson("/api/settings", { method: "GET" }, signal));
    if (!result.success) throw new CredentialsConfigurationError({ code: "EXPERIENCE_UNAVAILABLE" });
    return result.data;
  };
  const readExperienceStatus = async (signal?: AbortSignal): Promise<boolean> => {
    const result = ExperienceStatusResponseSchema.safeParse(await requestJson("/api/experience/status", { method: "GET" }, signal));
    if (!result.success) throw new CredentialsConfigurationError({ code: "EXPERIENCE_UNAVAILABLE" });
    return result.data.authorized;
  };
  const verifyExperience = async (inviteCode: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const input = ExperienceInviteRequestSchema.safeParse({ inviteCode });
    if (!input.success) throw new CredentialsConfigurationError({ code: "INVITE_CODE_INVALID" });
    const result = ExperienceStatusResponseSchema.safeParse(await requestJson("/api/experience", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data),
    }, signal));
    if (!result.success) throw new CredentialsConfigurationError({ code: "EXPERIENCE_UNAVAILABLE" });
    if (!result.data.authorized) throw new CredentialsConfigurationError({ code: "EXPERIENCE_REVOKED" });
  };
  const prepareSearchCredentials = async (signal?: AbortSignal): Promise<SearchCredentials> => {
    try {
      signal?.throwIfAborted();
      const state = store.getState();
      if (state.error === "read") throw new CredentialsConfigurationError({ code: "CREDENTIALS_INVALID" });
      // 在任何 await 之前逐项复制并验证；之后保存新设置也不能串改本次搜索意图的凭据。
      const selected = SearchCredentialsSchema.parse({
        deepseek: toWirePreference("deepseek", { ...state.preferences.deepseek }),
        serpapi: toWirePreference("serpapi", { ...state.preferences.serpapi }),
      });
      if (checkIdentity !== undefined) await checkIdentity(signal, selected);
      signal?.throwIfAborted();
      if ((selected.deepseek.source === "author" || selected.serpapi.source === "author") &&
        !await readExperienceStatus(signal)) throw new CredentialsConfigurationError({ code: "EXPERIENCE_REVOKED" });
      signal?.throwIfAborted();
      store.getState().clearNotice();
      return Object.freeze({ deepseek: Object.freeze(selected.deepseek), serpapi: Object.freeze(selected.serpapi) });
    } catch (error: unknown) {
      signal?.throwIfAborted();
      const safe = error instanceof CredentialsConfigurationError ? error
        : new CredentialsConfigurationError({ code: "CREDENTIALS_INVALID" });
      store.getState().setNotice(safe.problem);
      throw safe;
    }
  };
  return { fetchSettings, readExperienceStatus, verifyExperience, prepareSearchCredentials };
}

/** 只允许原本就是访客的双自带Key在身份服务故障时继续；旧账号空间不能降级发送。 */
export async function checkSearchIdentity(signal: AbortSignal | undefined, selected: SearchCredentials): Promise<void> {
    const wasGuest = accountStore.getState().account === null && accountStore.getState().scopeUserId === null;
    const epoch = accountStore.getState().epoch;
    try { await accountStore.getState().refresh(signal); }
    catch (error: unknown) {
      signal?.throwIfAborted();
      if (!(wasGuest && accountStore.getState().account === null && accountStore.getState().epoch === epoch &&
          selected.deepseek.source === "own" && selected.serpapi.source === "own")) throw error;
    }
    if (accountStore.getState().epoch !== epoch) throw new CredentialsConfigurationError({ code: "ACCOUNT_REQUIRED" });
}
export const credentialsApi = createCredentialsApi(credentialSettingsStore, (input, init) => globalThis.fetch(input, init), checkSearchIdentity);
export const prepareSearchCredentials = credentialsApi.prepareSearchCredentials;
