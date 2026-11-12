/**
 * 小组同源通道：公共协议校验、预期账号及有限等待；不缓存正文，不重试或排队写操作。
 * 连接证明只是在线门禁，服务端仍从会话和成员事务决定权限。
 */
import {
  CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, AccountProfileResponseSchema, GroupActionResponseSchema,
  GroupDetailsSchema, GroupErrorResponseSchema, GroupGraphReceiptResponseSchema, GroupGraphWriteResponseSchema,
  GroupListResponseSchema, GroupSyncEventSchema, GroupWorkspaceResponseSchema,
  type AccountProfileAction, type GroupAction, type GroupErrorCode, type GroupGraphAction, type GroupSyncEvent,
} from "@wayfinder/contracts";

export class GroupRequestError extends Error {
  constructor(readonly code: GroupErrorCode = "GROUP_UNAVAILABLE") { super(code); this.name = "GroupRequestError"; }
}
/** 即使测试传输忽略Signal，也不能无限等待fetch、正文或Reader。 */
export function awaitGroupOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(new GroupRequestError("GROUP_OFFLINE")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}
export function createGroupApi(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  const request = async <T>(path: string, userId: string, signal: AbortSignal, decode: (raw: unknown) => T,
    input?: AccountProfileAction | GroupAction | GroupGraphAction, connectionId?: string): Promise<T> => {
    const expiresAt = Date.now() + 10_000, deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const active = (): void => { deadline.throwIfAborted(); if (Date.now() >= expiresAt) throw new GroupRequestError(); };
    try {
      active(); const body = input === undefined ? undefined : JSON.stringify(input); active();
      const response = await awaitGroupOperation(fetcher(path, { method: body === undefined ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", signal: deadline,
        headers: { [CLOUD_ACCOUNT_HEADER]: userId, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(connectionId === undefined ? {} : { [GROUP_CONNECTION_HEADER]: connectionId }) },
        ...(body === undefined ? {} : { body }),
      }), deadline);
      active(); const raw: unknown = await awaitGroupOperation(response.json(), deadline); active();
      if (!response.ok) { const parsed = GroupErrorResponseSchema.safeParse(raw); throw new GroupRequestError(parsed.success ? parsed.data.code : undefined); }
      const result = decode(raw); active(); return result;
    } catch (error: unknown) { if (error instanceof GroupRequestError) throw error; throw new GroupRequestError(); }
  };
  const profile = (raw: unknown, userId: string) => {
    const result = AccountProfileResponseSchema.parse(raw);
    if (result.profile.userId !== userId) throw new GroupRequestError("ACCOUNT_REQUIRED");
    return result;
  };
  const workspace = (raw: unknown, groupId: string) => {
    const result = GroupWorkspaceResponseSchema.parse(raw);
    if (result.groupId !== groupId) throw new GroupRequestError("GROUP_FORBIDDEN");
    return result;
  };
  return {
    profile: (userId: string, signal: AbortSignal, input?: AccountProfileAction) => request("/api/profile", userId, signal, raw => profile(raw, userId), input),
    list: (userId: string, signal: AbortSignal) => request("/api/groups", userId, signal, raw => GroupListResponseSchema.parse(raw)),
    details: (userId: string, groupId: string, signal: AbortSignal) => request(`/api/groups?groupId=${encodeURIComponent(groupId)}`, userId, signal, raw => {
      const result = GroupDetailsSchema.parse(raw); if (result.group.groupId !== groupId) throw new GroupRequestError("GROUP_FORBIDDEN"); return result;
    }),
    manage: (userId: string, input: GroupAction, signal: AbortSignal, connectionId?: string) => {
      if (input.action !== "create" && input.action !== "join" && !connectionId) return Promise.reject(new GroupRequestError("GROUP_OFFLINE"));
      return request("/api/groups", userId, signal, raw => GroupActionResponseSchema.parse(raw), input, connectionId);
    },
    read: (userId: string, groupId: string, signal: AbortSignal) => request(`/api/group-workspace?groupId=${encodeURIComponent(groupId)}`, userId, signal, raw => workspace(raw, groupId)),
    write: (userId: string, input: GroupGraphAction, connectionId: string, signal: AbortSignal) => {
      if (!connectionId) return Promise.reject(new GroupRequestError("GROUP_OFFLINE"));
      return request("/api/group-workspace", userId, signal, raw => {
        // 外层Schema已经完整校验workspace；这里只核对归属，避免把整组历史再次解析和复制。
        const result = GroupGraphWriteResponseSchema.parse(raw);
        if (result.workspace.groupId !== input.groupId) throw new GroupRequestError("GROUP_FORBIDDEN");
        return result;
      }, input, connectionId);
    },
    receipt: (userId: string, mutationId: string, signal: AbortSignal) => request(`/api/group-receipt?mutationId=${encodeURIComponent(mutationId)}`, userId, signal, raw => {
      const result = GroupGraphReceiptResponseSchema.parse(raw); if (result.mutationId !== mutationId) throw new GroupRequestError(); return result;
    }),
    /** 每条消息由同一Contract解码；序号和连接生命周期交由小组同步控制器判断。 */
    stream: async (userId: string, groupId: string, signal: AbortSignal, onEvent: (event: GroupSyncEvent) => void): Promise<void> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = (): void => { if (reader !== undefined) void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        const response = await awaitGroupOperation(fetcher(`/api/group-sync?groupId=${encodeURIComponent(groupId)}`, {
          credentials: "same-origin", cache: "no-store", signal, headers: { [CLOUD_ACCOUNT_HEADER]: userId },
        }), signal);
        if (!response.ok) {
          const raw: unknown = await awaitGroupOperation(response.json(), signal), error = GroupErrorResponseSchema.safeParse(raw);
          throw new GroupRequestError(error.success ? error.data.code : undefined);
        }
        if (response.body === null) throw new GroupRequestError();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "";
        const emit = (line: string): void => {
          signal.throwIfAborted(); if (!line.trim()) return;
          const raw: unknown = JSON.parse(line), event = GroupSyncEventSchema.parse(raw);
          if (event.type === "snapshot" && (event.workspace.groupId !== groupId || !event.details.members.some(member => member.userId === userId))) {
            throw new GroupRequestError("GROUP_FORBIDDEN");
          }
          onEvent(event);
        };
        while (true) {
          const part = await awaitGroupOperation(reader.read(), signal); signal.throwIfAborted();
          if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) { emit(buffer.slice(0, index)); buffer = buffer.slice(index + 1); index = buffer.indexOf("\n"); }
        }
        buffer += decoder.decode(); emit(buffer);
      } catch (error: unknown) { if (error instanceof GroupRequestError) throw error; throw new GroupRequestError(); }
      finally { signal.removeEventListener("abort", cancel); cancel(); reader?.releaseLock(); }
    },
  };
}
export type GroupApi = ReturnType<typeof createGroupApi>;
export const groupApi = createGroupApi();
