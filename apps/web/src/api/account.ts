/** 同源账号边界：只发送 Contract 动作，不保存密码/验证码或展示原始网络异常。 */
import { AccountActionSchema, AccountErrorResponseSchema, AccountResponseSchema, type AccountAction, type AccountResponse } from "@wayfinder/contracts";

export class AccountRequestError extends Error {
  constructor(readonly code = "ACCOUNT_UNAVAILABLE") { super(code); this.name = "AccountRequestError"; }
}

function boundedResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(new AccountRequestError()); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new AccountRequestError()); else resolve(value);
    }, () => { signal.removeEventListener("abort", abort); reject(new AccountRequestError()); });
    if (signal.aborted) abort();
  });
}

export function createAccountApi(fetchImplementation: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  return async (action?: AccountAction, signal?: AbortSignal): Promise<AccountResponse> => {
    const deadline = AbortSignal.timeout(10_000);
    const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    try {
      bounded.throwIfAborted();
      const request = fetchImplementation("/api/account", {
        method: action === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal: bounded,
        ...(action === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(AccountActionSchema.parse(action)) }),
      });
      // 即使测试传输忽略 Signal，身份切换也不能被一个迟到响应长期阻塞。
      const response = await boundedResult(request, bounded);
      const raw: unknown = await boundedResult(response.json(), bounded);
      bounded.throwIfAborted();
      if (!response.ok) {
        const error = AccountErrorResponseSchema.safeParse(raw);
        throw new AccountRequestError(error.success ? error.data.code : undefined);
      }
      return AccountResponseSchema.parse(raw);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError();
    }
  };
}
export const accountApi = createAccountApi();
