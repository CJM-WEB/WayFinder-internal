/**
 * 模块职责：在既有40秒搜索之外冻结组目标、发起者会话及成员代际，并签发真实完成结果收据。
 * 额度边界：所有凭据来源都先核组身份；首次Provider前持久claim防重复，签名不做期限后的数据库写入。
 * 应用边界：结果正文只有签名一致且仍有同代成员资格才可信；消费claim与图／历史写入共用调用方事务。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  CLOUD_ACCOUNT_HEADER, GROUP_SEARCH_TARGET_HEADER, GroupSearchReceiptSchema, GroupSearchTargetSchema,
  ResultGraphSchema, SearchRequestSchema, UserIdSchema,
  type GroupGraphAction, type GroupGraphRecord, type GroupSearchReceipt, type GroupSearchTarget,
  type ResultGraph, type SearchRequest,
} from "@wayfinder/contracts";
import type { FastifyRequest } from "fastify";
import type { AccountAuth } from "../accounts/auth.js";
import type { AccountDatabase, DatabaseOperation } from "../accounts/database.js";
import { accountRequestHeaders } from "../routes/account.js";
import { authorizeGroupConnection } from "../routes/group-session.js";
import { isSameOriginRequest } from "../settings/request-origin.js";
import { GroupAccessError } from "./errors.js";
import { ensureGroupMembershipEpoch, groupTransaction, loadMemberGroup, lockGroupActor, readGroupMembershipEpoch, type GroupQuery } from "./storage.js";
import type { GroupSyncRuntime } from "./sync.js";
import { readActiveGroupGraph } from "./workspace-storage.js";

type ApplySearch = Extract<GroupGraphAction, { action: "applySearch" }>;
export type GroupPreparedSearch = Readonly<{
  input: SearchRequest; signal: AbortSignal;
  assertActive: (signal: AbortSignal) => Promise<void>;
  receipt: (result: ResultGraph) => GroupSearchReceipt;
}>;
export type GroupSearchAccess = Readonly<{
  prepare: (request: FastifyRequest, signal: AbortSignal, deadlineAt: number, assertRunActive?: () => number) => Promise<GroupPreparedSearch | null>;
  consume: (query: GroupQuery, userId: string, sessionId: string, input: ApplySearch, current: GroupGraphRecord) => Promise<ResultGraph>;
}>;
const ClaimSchema = z.strictObject({ kind: z.literal("groupSearchClaim"), runId: SearchRequestSchema.shape.runId,
  target: GroupSearchTargetSchema, sessionHash: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  membershipEpoch: UserIdSchema, appliedMutationId: UserIdSchema.nullable() });
type Claim = z.infer<typeof ClaimSchema>;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const claimKey = (runId: string): string => `gs_${digest(runId)}`;

/** 对象字段排序、数组顺序保留；不依赖客户端JSON缩进／对象键顺序，资源排序语义保持不变。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().flatMap(key => {
      const item = (value as Record<string, unknown>)[key];
      return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
    }).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new GroupAccessError("GROUP_INVALID");
  return encoded;
}
async function loadClaim(query: GroupQuery, userId: string, runId: string): Promise<Claim | null> {
  const rows = z.array(z.object({ payload: z.unknown() })).parse(await query(
    "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ? FOR UPDATE", [userId, claimKey(runId)]));
  const value = rows[0]?.payload;
  return rows.length === 0 ? null : ClaimSchema.parse(typeof value === "string" ? JSON.parse(value) as unknown : value);
}

export function createGroupSearch(options: Readonly<{
  database: AccountDatabase; auth: Pick<AccountAuth, "getIdentity">; sync: GroupSyncRuntime; secret: string; publicOrigin?: string | null;
}>): GroupSearchAccess {
  if (options.secret.length < 32) throw new GroupAccessError("GROUP_UNAVAILABLE");
  // 域隔离派生键不离开闭包；现有auth secret在重启间稳定，不新增Secret或让收据授予登录权限。
  const signingKey = createHmac("sha256", options.secret).update("wayfinder:group-search:v1").digest();
  const signature = (userId: string, claim: Claim, result: ResultGraph): string => createHmac("sha256", signingKey)
    .update(canonicalJson({ version: "groupSearch.v1", userId, sessionHash: claim.sessionHash, target: claim.target,
      membershipEpoch: claim.membershipEpoch, requestHash: claim.requestHash, runId: claim.runId, resultHash: digest(canonicalJson(result)) })).digest("hex");
  return {
    async prepare(request, signal, deadlineAt, assertRunActive) {
      const targetHeader = request.headers[GROUP_SEARCH_TARGET_HEADER];
      if (targetHeader === undefined) return null;
      if (!isSameOriginRequest(request, options.publicOrigin ?? null)) throw new GroupAccessError("GROUP_FORBIDDEN");
      const repeated = (header: string): boolean => request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === header).length > 1;
      let target: GroupSearchTarget, original: SearchRequest;
      try {
        if (typeof targetHeader !== "string" || repeated(GROUP_SEARCH_TARGET_HEADER)) throw new Error();
        target = GroupSearchTargetSchema.parse(JSON.parse(targetHeader) as unknown); original = SearchRequestSchema.parse(request.body);
      } catch { throw new GroupAccessError("GROUP_INVALID"); }
      const expected = UserIdSchema.safeParse(request.headers[CLOUD_ACCOUNT_HEADER]);
      if (!expected.success || repeated(CLOUD_ACCOUNT_HEADER)) throw new GroupAccessError("GROUP_INVALID");
      const operation = (currentSignal: AbortSignal): DatabaseOperation => {
        currentSignal.throwIfAborted(); signal.throwIfAborted();
        // 生产复用原RunScope的私有deadline reason，不能另造TimeoutError误判成用户取消。
        if (assertRunActive !== undefined) assertRunActive();
        else if (Date.now() >= deadlineAt) throw new DOMException("Run deadline exceeded", "TimeoutError");
        return { signal: AbortSignal.any([signal, currentSignal]), deadline: Math.min(Date.now() + 5_000, deadlineAt) };
      };
      const headers = accountRequestHeaders(request);
      const identity = await options.auth.getIdentity(headers, operation(signal));
      if (identity === null || identity.userId !== expected.data) throw new GroupAccessError("ACCOUNT_REQUIRED");
      // 只在入场时确认在线；不能把30秒连接租期的取消／期限绑定到独立40秒Run。
      authorizeGroupConnection(request, identity, target.groupId, operation(signal), options.sync);
      const { claim, input } = await groupTransaction(options.database, operation(signal), async query => {
        await lockGroupActor(query, identity.userId);
        if (await loadClaim(query, identity.userId, original.runId) !== null) throw new GroupAccessError("GROUP_CONFLICT");
        await loadMemberGroup(query, identity.userId, target.groupId);
        const record = await readActiveGroupGraph(query, target.groupId, target.graphId, target.expectedRevision);
        let input = original;
        if (target.nodeId !== undefined) {
          const node = record.document.nodes.find(item => item.id === target.nodeId);
          if (node === undefined) throw new GroupAccessError("GROUP_NOT_FOUND");
          input = SearchRequestSchema.parse({ ...original, nodeSearch: { node: { id: node.id, title: node.title, description: node.description },
            analysis: record.document.analysis ?? null } });
        } else if (original.nodeSearch !== undefined) throw new GroupAccessError("GROUP_INVALID");
        const claim = ClaimSchema.parse({ kind: "groupSearchClaim", runId: input.runId, target,
          sessionHash: digest(identity.sessionId), membershipEpoch: await ensureGroupMembershipEpoch(query, identity.userId, target.groupId),
          requestHash: digest(canonicalJson(input)), appliedMutationId: null });
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?)",
          [identity.userId, claimKey(input.runId), JSON.stringify(claim)]);
        return { claim, input };
      });
      const revoked = new AbortController();
      return {
        input, signal: revoked.signal,
        async assertActive(currentSignal) {
          revoked.signal.throwIfAborted();
          try {
            const current = await options.auth.getIdentity(headers, operation(currentSignal));
            if (current === null || current.userId !== identity.userId || current.sessionId !== identity.sessionId) throw new GroupAccessError("ACCOUNT_REQUIRED");
            await groupTransaction(options.database, operation(currentSignal), async query => {
              await loadMemberGroup(query, identity.userId, target.groupId, false);
              if (await readGroupMembershipEpoch(query, identity.userId, target.groupId) !== claim.membershipEpoch) throw new GroupAccessError("GROUP_FORBIDDEN");
              const record = await readActiveGroupGraph(query, target.groupId, target.graphId);
              if (target.nodeId !== undefined && !record.document.nodes.some(node => node.id === target.nodeId)) throw new GroupAccessError("GROUP_NOT_FOUND");
            }, true);
          } catch (error: unknown) {
            // 原Run取消／deadline沿用自己的来源；身份或组失效则取消兄弟Provider，防止后续继续花额度。
            if (!currentSignal.aborted && !signal.aborted) revoked.abort(error);
            throw error;
          }
        },
        receipt(value) {
          revoked.signal.throwIfAborted();
          const result = ResultGraphSchema.parse(value);
          if (result.runId !== input.runId || result.query.raw !== input.query || result.query.language !== input.language) throw new GroupAccessError("GROUP_INVALID");
          // 纯计算可随原terminal settlement执行，期限耗尽后不重新获取数据库或Provider预算。
          return GroupSearchReceiptSchema.parse({ version: "groupSearch.v1", target, runId: input.runId, signature: signature(identity.userId, claim, result) });
        },
      };
    },
    async consume(query, trustedUserId, sessionId, input, current) {
      const userId = UserIdSchema.parse(trustedUserId), receipt = GroupSearchReceiptSchema.parse(input.receipt), result = ResultGraphSchema.parse(input.result);
      const claim = await loadClaim(query, userId, receipt.runId);
      if (claim === null) throw new GroupAccessError("GROUP_NOT_FOUND");
      if (claim.sessionHash !== digest(sessionId)) throw new GroupAccessError("ACCOUNT_REQUIRED");
      if (claim.appliedMutationId !== null) throw new GroupAccessError("GROUP_CONFLICT");
      if (canonicalJson(claim.target) !== canonicalJson(receipt.target) || result.runId !== claim.runId
        || receipt.target.groupId !== input.groupId || receipt.target.graphId !== current.document.id) throw new GroupAccessError("GROUP_CONFLICT");
      const expectedSignature = signature(userId, claim, result);
      if (!timingSafeEqual(Buffer.from(expectedSignature, "ascii"), Buffer.from(receipt.signature, "ascii"))) throw new GroupAccessError("GROUP_CONSTRAINT");
      if (await readGroupMembershipEpoch(query, userId, input.groupId) !== claim.membershipEpoch) throw new GroupAccessError("GROUP_FORBIDDEN");
      if (current.revision !== input.expectedRevision || current.revision < claim.target.expectedRevision
        || current.revision !== claim.target.expectedRevision && input.confirmedRevision !== current.revision
        || input.confirmedRevision !== undefined && input.confirmedRevision !== current.revision) throw new GroupAccessError("GROUP_CONFLICT");
      if (claim.target.nodeId !== undefined && !current.document.nodes.some(node => node.id === claim.target.nodeId)) throw new GroupAccessError("GROUP_NOT_FOUND");
      // 只在调用方同一组事务内消费；后续投影、URL校验、历史或收据失败会经保存点整体回滚。
      await query("UPDATE wf_user_data SET payload = ? WHERE userId = ? AND recordId = ?",
        [JSON.stringify({ ...claim, appliedMutationId: input.mutationId }), userId, claimKey(claim.runId)]);
      return result;
    },
  };
}
