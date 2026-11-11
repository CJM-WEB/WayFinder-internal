/** 同源云工作区边界：预期账号只防错号，权限由服务端会话决定；错误固定且不带图或秘密。 */
import { CLOUD_ACCOUNT_HEADER, CloudGraphWriteResponseSchema, CloudWorkspaceResponseSchema, CloudWorkspaceErrorResponseSchema,
  type CloudGraphWriteRequest, type CloudWorkspaceImportRequest, type CloudGraphWriteResponse, type CloudWorkspaceResponse } from "@wayfinder/contracts";
import { restoreGraphHistory } from "@wayfinder/contracts/graph-history";

export class CloudWorkspaceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CloudWorkspaceError"; }
}
export type CloudWorkspaceApi = {
  read: (userId: string, signal: AbortSignal) => Promise<CloudWorkspaceResponse>;
  write: (userId: string, input: CloudGraphWriteRequest, signal: AbortSignal) => Promise<CloudGraphWriteResponse>;
  import: (userId: string, input: CloudWorkspaceImportRequest, signal: AbortSignal) => Promise<CloudWorkspaceResponse>;
};
function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(new CloudWorkspaceError("WORKSPACE_UNAVAILABLE")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); }, abort);
    if (signal.aborted) abort();
  });
}
export function createCloudWorkspaceApi(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): CloudWorkspaceApi {
  const request = async <T>(userId: string, signal: AbortSignal, decode: (raw: unknown) => T,
    input?: CloudGraphWriteRequest | CloudWorkspaceImportRequest): Promise<T> => {
    const expiresAt = Date.now() + 10_000;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const assertActive = (): void => {
      deadline.throwIfAborted();
      // 大正文编码或历史重放可能阻塞Timer；绝对期限也必须在同步阶段后再次核对。
      if (Date.now() >= expiresAt) throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE");
    };
    try {
      assertActive();
      const body = input === undefined ? undefined : JSON.stringify(input);
      assertActive();
      const response = await bounded(fetcher("/api/workspace", { method: input === undefined ? "GET" : "POST", signal: deadline,
        cache: "no-store", credentials: "same-origin", headers: { [CLOUD_ACCOUNT_HEADER]: userId, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body }) }), deadline);
      assertActive();
      const raw: unknown = await bounded(response.json(), deadline);
      assertActive();
      if (!response.ok) { const parsed = CloudWorkspaceErrorResponseSchema.safeParse(raw); throw new CloudWorkspaceError(parsed.success ? parsed.data.code : "WORKSPACE_UNAVAILABLE"); }
      // 成功HTTP同样是不可信输入；Schema或重放异常不得把原始字段名／正文带进错误。
      const result = decode(raw);
      assertActive();
      return result;
    } catch (error: unknown) { if (error instanceof CloudWorkspaceError) throw error; throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE"); }
  };
  const workspace = (raw: unknown, userId: string): CloudWorkspaceResponse => {
    const result = CloudWorkspaceResponseSchema.parse(raw);
    if (result.userId !== userId) throw new CloudWorkspaceError("ACCOUNT_REQUIRED");
    for (const record of result.graphs) restoreGraphHistory(record.history, record.document, 100);
    return result;
  };
  return {
    read: (userId, signal) => request(userId, signal, raw => workspace(raw, userId)),
    import: (userId, input, signal) => request(userId, signal, raw => workspace(raw, userId), input),
    write: (userId, input, signal) => request(userId, signal, raw => {
      const result = CloudGraphWriteResponseSchema.parse(raw);
      if (result.userId !== userId) throw new CloudWorkspaceError("ACCOUNT_REQUIRED");
      restoreGraphHistory(result.record.history, result.record.document, 100);
      return result;
    }, input),
  };
}
