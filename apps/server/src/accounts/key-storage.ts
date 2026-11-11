/**
 * 模块职责：复用用户数据表托管两项服务Key，普通读取仅状态／掩码，解密限定当前调用。
 * 并发边界：按用户锁固定元数据行，再执行服务记录CAS；删除保留认证墓碑和随机版本，防ABA。
 * 失败路径：业务冲突先以事务结果返回，再转固定错误，避免数据库层把409改为503。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccountKeyActionSchema, AccountKeysResponseSchema, UserIdSchema, CredentialServiceSchema,
  type AccountKeyAction, type AccountKeyStatus, type AccountKeysResponse, type AccountKeysErrorResponse,
  type CredentialService } from "@wayfinder/contracts";
import { AccountDatabase, type DatabaseOperation } from "./database.js";
import { createKeyEncryption, EncryptedKeySchema, type KeyEncryption } from "./key-encryption.js";

export class AccountKeyAccessError extends Error {
  constructor(readonly code: AccountKeysErrorResponse["code"], readonly service?: CredentialService) { super(code); this.name = "AccountKeyAccessError"; }
}
export type CloudKeyRevisions = Readonly<Partial<Record<CredentialService, string>>>;
export type AccountKeyStorage = Readonly<{
  read: (userId: string, operation: DatabaseOperation) => Promise<AccountKeysResponse>;
  write: (userId: string, input: AccountKeyAction, operation: DatabaseOperation) => Promise<AccountKeysResponse>;
  resolve: (userId: string, service: CredentialService, operation: DatabaseOperation) => Promise<{ apiKey: string; revision: string } | null>;
  assertCurrent: (userId: string, revisions: CloudKeyRevisions, operation: DatabaseOperation) => Promise<void>;
}>;
const EnvelopeSchema = z.strictObject({
  kind: z.literal("accountKey"), revision: UserIdSchema, encrypted: EncryptedKeySchema,
  lastMutationId: UserIdSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
type Envelope = z.infer<typeof EnvelopeSchema>;
type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
const services: readonly CredentialService[] = ["deepseek", "serpapi"];
const recordId = (service: CredentialService) => `k_${service}`;
function rows(value: unknown): unknown[] {
  return z.array(z.object({ payload: z.unknown() })).parse(value).map(row =>
    typeof row.payload === "string" ? JSON.parse(row.payload) as unknown : row.payload);
}
async function load(query: Query, userId: string, service: CredentialService, encryption: KeyEncryption, lock = false): Promise<{ envelope: Envelope; apiKey: string | null } | null> {
  const value = rows(await query(`SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?${lock ? " FOR UPDATE" : ""}`, [userId, recordId(service)]))[0];
  if (value === undefined) return null;
  const envelope = EnvelopeSchema.parse(value);
  return { envelope, apiKey: encryption.decrypt(envelope.encrypted, { userId, service, revision: envelope.revision,
    lastMutationId: envelope.lastMutationId, requestFingerprint: envelope.requestFingerprint }) };
}
const mask = (apiKey: string): string => apiKey.length <= 8 ? "••••" : `••••${apiKey.slice(-4)}`;
function status(value: Awaited<ReturnType<typeof load>>): AccountKeyStatus {
  return value?.apiKey ? { configured: true, mask: mask(value.apiKey), revision: value.envelope.revision }
    : { configured: false, mask: null, revision: value?.envelope.revision ?? null };
}
async function snapshot(query: Query, userId: string, encryption: KeyEncryption): Promise<AccountKeysResponse> {
  const deepseek = await load(query, userId, "deepseek", encryption), serpapi = await load(query, userId, "serpapi", encryption);
  return AccountKeysResponseSchema.parse({ userId, deepseek: status(deepseek), serpapi: status(serpapi) });
}
/** 所有公开存储错误均固定；取消仍由上层Signal判定，不携带驱动或密文原值。 */
async function guarded<T>(action: () => Promise<T>, service?: CredentialService): Promise<T> {
  try { return await action(); }
  catch (error: unknown) { if (error instanceof AccountKeyAccessError) throw error; throw new AccountKeyAccessError("KEY_UNAVAILABLE", service); }
}
export function createAccountKeyStorage(database: AccountDatabase, master: string | undefined): AccountKeyStorage | null {
  const encryption = createKeyEncryption(master);
  if (encryption === null) return null;
  return {
    read: (trustedUserId, operation) => guarded(() => {
      const userId = UserIdSchema.parse(trustedUserId);
      return database.transaction(operation, query => snapshot(query, userId, encryption), true);
    }),
    write: (trustedUserId, raw, operation) => guarded(async () => {
      const userId = UserIdSchema.parse(trustedUserId), parsed = AccountKeyActionSchema.safeParse(raw);
      if (!parsed.success) throw new AccountKeyAccessError("KEY_INVALID");
      const input = parsed.data;
      const fingerprint = encryption.fingerprint(JSON.stringify([userId, input.action, input.service, input.expectedRevision, input.mutationId,
        input.action === "save" ? input.apiKey : null]));
      const outcome = await database.transaction(operation, async query => {
        // 固定用户行消除初次创建的空行竞争；不建立新表或每用户队列。
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, 'keys_meta', ?) ON DUPLICATE KEY UPDATE recordId = recordId", [userId, '{"kind":"accountKeys"}']);
        await query("SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = 'keys_meta' FOR UPDATE", [userId]);
        const current = await load(query, userId, input.service, encryption, true);
        if (current?.envelope.lastMutationId === input.mutationId) {
          return current.envelope.requestFingerprint === fingerprint ? { ok: true as const, value: await snapshot(query, userId, encryption) } : { ok: false as const };
        }
        if ((current?.envelope.revision ?? null) !== input.expectedRevision) return { ok: false as const };
        const revision = randomUUID();
        const payload: Envelope = { kind: "accountKey", revision, lastMutationId: input.mutationId, requestFingerprint: fingerprint,
          encrypted: encryption.encrypt(input.action === "save" ? input.apiKey : null, { userId, service: input.service, revision,
            lastMutationId: input.mutationId, requestFingerprint: fingerprint }) };
        const serialized = JSON.stringify(payload);
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = ?", [userId, recordId(input.service), serialized, serialized]);
        return { ok: true as const, value: await snapshot(query, userId, encryption) };
      });
      if (!outcome.ok) throw new AccountKeyAccessError("KEY_CONFLICT", input.service);
      return outcome.value;
    }),
    resolve: (trustedUserId, rawService, operation) => guarded(async () => {
      const userId = UserIdSchema.parse(trustedUserId), service = CredentialServiceSchema.parse(rawService);
      return database.transaction(operation, async query => {
        const current = await load(query, userId, service, encryption);
        return current?.apiKey ? { apiKey: current.apiKey, revision: current.envelope.revision } : null;
      }, true);
    }, rawService),
    assertCurrent: (trustedUserId, revisions, operation) => guarded(async () => {
      const userId = UserIdSchema.parse(trustedUserId);
      const outcome = await database.transaction(operation, async query => {
        for (const service of services) {
          const revision = revisions[service]; if (revision === undefined) continue;
          const current = await load(query, userId, service, encryption);
          if (!current?.apiKey || current.envelope.revision !== revision) return service;
        }
        return null;
      }, true);
      if (outcome !== null) throw new AccountKeyAccessError("KEY_CONFLICT", outcome);
    }),
  };
}
