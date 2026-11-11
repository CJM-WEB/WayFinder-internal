/** 账号Key只走同源专用通道；普通响应只有掩码/版本，任何坏响应或原始异常均固定脱敏。 */
import { AccountKeyActionSchema, AccountKeysResponseSchema, AccountKeysErrorResponseSchema, CLOUD_ACCOUNT_HEADER,
  type AccountKeyAction, type AccountKeysResponse, type AccountKeysErrorResponse } from "@wayfinder/contracts";

export class AccountKeysError extends Error {
  constructor(readonly problem: AccountKeysErrorResponse = { code: "KEY_UNAVAILABLE" }) { super(problem.code); this.name = "AccountKeysError"; }
}
function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(new AccountKeysError()); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); }, abort);
    if (signal.aborted) abort();
  });
}
export function createAccountKeysApi(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  const request = async (userId: string, signal: AbortSignal, action?: AccountKeyAction): Promise<AccountKeysResponse> => {
    const expiresAt = Date.now() + 10_000, deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const assertActive = (): void => { deadline.throwIfAborted(); if (Date.now() >= expiresAt) throw new AccountKeysError(); };
    try {
      assertActive();
      const body = action === undefined ? undefined : JSON.stringify(AccountKeyActionSchema.parse(action));
      assertActive();
      const response = await bounded(fetcher("/api/account/keys", { method: body === undefined ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", signal: deadline,
        headers: { [CLOUD_ACCOUNT_HEADER]: userId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body }),
      }), deadline);
      assertActive(); const raw: unknown = await bounded(response.json(), deadline); assertActive();
      if (!response.ok) { const error = AccountKeysErrorResponseSchema.safeParse(raw); throw new AccountKeysError(error.success ? error.data : undefined); }
      const result = AccountKeysResponseSchema.parse(raw);
      if (result.userId !== userId) throw new AccountKeysError({ code: "ACCOUNT_REQUIRED" });
      assertActive(); return result;
    } catch (error: unknown) {
      signal.throwIfAborted();
      if (error instanceof AccountKeysError) throw error;
      throw new AccountKeysError();
    }
  };
  return { read: (userId: string, signal: AbortSignal) => request(userId, signal),
    write: (userId: string, action: AccountKeyAction, signal: AbortSignal) => request(userId, signal, action) };
}
export const accountKeysApi = createAccountKeysApi();
