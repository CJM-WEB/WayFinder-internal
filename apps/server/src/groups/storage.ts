/**
 * 模块职责：在现有会话与MySQL事务上提供小组创建、加入、成员授权、退出及解散。
 * 并发顺序：先锁操作者稳定用户行，再锁目标组；组级锁同时串行化成员与后续组图写入。
 * 幂等收据留在用户分区，解散后仍可识别迟到重试，不能因收据级联删除而复活旧组。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountNicknameSchema, GroupActionSchema, GroupActionResponseSchema, GroupDetailsSchema,
  GroupInvitationCodeSchema, GroupListResponseSchema, GroupSummarySchema, UserIdSchema,
  type GroupAction, type GroupActionResponse, type GroupDetails, type GroupErrorCode,
  type GroupListResponse, type GroupSummary,
} from "@wayfinder/contracts";
import type { AccountIdentity } from "../accounts/auth.js";
import type { AccountDatabase, DatabaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";

export type GroupQuery = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
export type GroupStorage = Readonly<{
  list: (userId: string, operation: DatabaseOperation) => Promise<GroupListResponse>;
  read: (userId: string, groupId: string, operation: DatabaseOperation) => Promise<GroupDetails>;
  write: (identity: AccountIdentity, input: GroupAction, operation: DatabaseOperation) => Promise<GroupActionResponse>;
}>;
type Outcome<T> = { ok: true; value: T } | { ok: false; code: GroupErrorCode };
type GroupRow = { groupId: string; ownerUserId: string; invitationCode: unknown; payload: unknown };
const GroupRowsSchema = z.array(z.object({ groupId: UserIdSchema, ownerUserId: UserIdSchema, invitationCode: z.unknown(), payload: z.unknown() }));
const ReceiptSchema = z.strictObject({ kind: z.literal("groupMutation"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), groupId: UserIdSchema });
const NicknameSchema = z.strictObject({ nickname: AccountNicknameSchema });
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const jsonValue = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) as unknown : value;

/**
 * 业务拒绝先回滚到保存点，再在事务内返回判别结果，避免数据库适配把它改写成未知503。
 * 保存点保护后续组合操作：即使写入后的业务校验拒绝，也不能带着部分成员或组数据提交。
 * SQL及结构损坏异常继续抛出，触发整个事务真实回滚。
 */
export async function groupTransaction<T>(database: AccountDatabase, operation: DatabaseOperation,
  action: (query: GroupQuery) => Promise<T>, consistentRead = false): Promise<T> {
  const outcome = await database.transaction<Outcome<T>>(operation, async query => {
    await query("SAVEPOINT wf_group_action");
    try { return { ok: true, value: await action(query) }; }
    catch (error: unknown) {
      if (error instanceof GroupAccessError) {
        await query("ROLLBACK TO SAVEPOINT wf_group_action");
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }, consistentRead);
  if (!outcome.ok) throw new GroupAccessError(outcome.code);
  return outcome.value;
}

function summary(row: GroupRow): GroupSummary {
  const group = GroupSummarySchema.parse(jsonValue(row.payload));
  if (group.groupId !== row.groupId || group.ownerUserId !== row.ownerUserId) throw new Error("小组存档身份不一致");
  return group;
}
async function groupRow(query: GroupQuery, groupId: string, lock: boolean): Promise<GroupRow | null> {
  const rows = GroupRowsSchema.parse(await query(`SELECT groupId, ownerUserId, invitationCode, payload FROM wf_groups WHERE groupId = ?${lock ? " FOR UPDATE" : ""}`, [groupId]));
  return rows[0] ?? null;
}
async function isMember(query: GroupQuery, userId: string, groupId: string): Promise<boolean> {
  return z.array(z.object({ userId: UserIdSchema })).parse(await query("SELECT userId FROM wf_group_members WHERE groupId = ? AND userId = ?", [groupId, userId])).length === 1;
}

/** 先锁真实组再验证成员；客户端传入的标识只能定位目标，不能授予权限。 */
export async function loadMemberGroup(query: GroupQuery, userId: string, groupId: string, lock = true): Promise<GroupSummary> {
  const row = await groupRow(query, groupId, lock);
  if (row === null) throw new GroupAccessError("GROUP_NOT_FOUND");
  if (!await isMember(query, userId, groupId)) throw new GroupAccessError("GROUP_FORBIDDEN");
  return summary(row);
}

/** 每次组状态变化递增同一权威版本，供后续实时快照、成员失效与组图动作排序复用。 */
export async function bumpGroupRevision(query: GroupQuery, group: GroupSummary): Promise<GroupSummary> {
  const next = GroupSummarySchema.parse({ ...group, revision: group.revision + 1 });
  await query("UPDATE wf_groups SET payload = ? WHERE groupId = ?", [JSON.stringify(next), next.groupId]);
  return next;
}

async function listGroups(query: GroupQuery, userId: string): Promise<GroupListResponse> {
  const rows = GroupRowsSchema.parse(await query("SELECT g.groupId, g.ownerUserId, g.invitationCode, g.payload FROM wf_groups g INNER JOIN wf_group_members m ON m.groupId = g.groupId WHERE m.userId = ? ORDER BY g.groupId", [userId]));
  return GroupListResponseSchema.parse({ groups: rows.map(summary) });
}
async function nickname(query: GroupQuery, userId: string): Promise<string> {
  // 写入先锁用户groups_meta及收据，再以当前读核验昵称，最后取得组锁。
  // 此处若普通SELECT先建立RR旧快照，等待组锁后即使锁读看到了新成员，详情普通读仍会漏人。
  // FOR SHARE不提前建立旧快照，也阻止本次加入前昵称被并发改空；其他账号的昵称仍可独立更新。
  const rows = z.array(z.object({ payload: z.unknown() })).parse(await query("SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ? FOR SHARE", [userId, "profile"]));
  if (rows.length === 0) throw new GroupAccessError("NICKNAME_REQUIRED");
  return NicknameSchema.parse(jsonValue(rows[0]?.payload)).nickname;
}
async function details(query: GroupQuery, userId: string, group: GroupSummary): Promise<GroupDetails> {
  const row = await groupRow(query, group.groupId, false);
  if (row === null) throw new GroupAccessError("GROUP_NOT_FOUND");
  const rows = z.array(z.object({ userId: UserIdSchema, profile: z.unknown() })).parse(await query(
    "SELECT m.userId, p.payload AS profile FROM wf_group_members m LEFT JOIN wf_user_data p ON p.userId = m.userId AND p.recordId = ? WHERE m.groupId = ? ORDER BY m.userId", ["profile", group.groupId]));
  const code = Buffer.isBuffer(row.invitationCode) ? row.invitationCode.toString("utf8") : row.invitationCode;
  return GroupDetailsSchema.parse({ group, invitationCode: group.ownerUserId === userId ? code : null,
    members: rows.map(member => ({ userId: member.userId, nickname: NicknameSchema.parse(jsonValue(member.profile)).nickname,
      role: member.userId === group.ownerUserId ? "owner" : "member" })) });
}
async function response(query: GroupQuery, userId: string, groupId: string): Promise<GroupActionResponse> {
  const groups = await listGroups(query, userId);
  const group = groups.groups.find(value => value.groupId === groupId);
  return GroupActionResponseSchema.parse({ ...groups, details: group === undefined ? null : await details(query, userId, group) });
}
async function lockUser(query: GroupQuery, userId: string): Promise<void> {
  await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE recordId = recordId",
    [userId, "groups_meta", '{"kind":"groups"}']);
}
async function receipt(query: GroupQuery, userId: string, key: string) {
  const rows = z.array(z.object({ payload: z.unknown() })).parse(await query("SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ? FOR UPDATE", [userId, key]));
  return rows.length === 0 ? null : ReceiptSchema.parse(jsonValue(rows[0]?.payload));
}
const isDuplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";

/** 从均匀随机字节拒绝取样，避免模运算让部分字母数字更常出现；失败次数有界。 */
function randomSuffix(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let batch = 0; batch < 4 && value.length < 20; batch++) {
    for (const byte of randomBytes(32)) if (byte < 248 && value.length < 20) value += alphabet[byte % 62];
  }
  if (value.length !== 20) throw new GroupAccessError("GROUP_UNAVAILABLE");
  return value;
}

export function createGroupStorage(database: AccountDatabase, options: Readonly<{
  createId?: () => string; createSuffix?: () => string;
}> = {}): GroupStorage {
  return {
    list: (trustedUserId, operation) => groupTransaction(database, operation, query => listGroups(query, UserIdSchema.parse(trustedUserId)), true),
    read: (trustedUserId, inputGroupId, operation) => groupTransaction(database, operation, async query => {
      const userId = UserIdSchema.parse(trustedUserId), groupId = UserIdSchema.parse(inputGroupId);
      return details(query, userId, await loadMemberGroup(query, userId, groupId, false));
    }, true),
    write: async (identity, raw, operation) => {
      let input: GroupAction;
      try { input = GroupActionSchema.parse(raw); UserIdSchema.parse(identity.userId); }
      catch { throw new GroupAccessError("GROUP_INVALID"); }
      const userId = identity.userId, key = `gm_${digest(input.mutationId)}`;
      const fingerprint = digest(JSON.stringify([userId, input]));
      return groupTransaction(database, operation, async query => {
        await lockUser(query, userId);
        const previous = await receipt(query, userId, key);
        if (previous !== null) {
          if (previous.fingerprint !== fingerprint) throw new GroupAccessError("GROUP_CONFLICT");
          // 重试只读当前可见状态；原create/join不得恢复已解散组或被后续leave撤销的成员资格。
          return response(query, userId, previous.groupId);
        }
        let groupId: string;
        if (input.action === "create") {
          await nickname(query, userId);
          let created: GroupSummary | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            const candidateId = UserIdSchema.parse(options.createId?.() ?? randomUUID());
            const code = GroupInvitationCodeSchema.safeParse(`${identity.email}#${options.createSuffix?.() ?? randomSuffix()}`);
            if (!code.success) throw new GroupAccessError("GROUP_INVALID");
            const candidate = GroupSummarySchema.parse({ groupId: candidateId, ownerUserId: userId,
              name: input.name, description: input.description, revision: 1 });
            try {
              await query("INSERT INTO wf_groups (groupId, ownerUserId, invitationCode, payload) VALUES (?, ?, ?, ?)",
                [candidateId, userId, code.data, JSON.stringify(candidate)]);
              created = candidate; break;
            } catch (error: unknown) { if (!isDuplicate(error)) throw error; }
          }
          if (created === undefined) throw new GroupAccessError("GROUP_CONFLICT");
          groupId = created.groupId;
          await query("INSERT INTO wf_group_members (groupId, userId) VALUES (?, ?)", [groupId, userId]);
        } else if (input.action === "join") {
          await nickname(query, userId);
          const rows = GroupRowsSchema.parse(await query("SELECT groupId, ownerUserId, invitationCode, payload FROM wf_groups WHERE invitationCode = ? FOR UPDATE", [input.invitationCode]));
          const row = rows[0];
          if (row === undefined) throw new GroupAccessError("GROUP_NOT_FOUND");
          const group = summary(row); groupId = group.groupId;
          if (!await isMember(query, userId, groupId)) {
            await query("INSERT INTO wf_group_members (groupId, userId) VALUES (?, ?)", [groupId, userId]);
            await bumpGroupRevision(query, group);
          }
        } else {
          groupId = input.groupId;
          const group = await loadMemberGroup(query, userId, groupId);
          const owner = group.ownerUserId === userId;
          if (input.action === "leave") {
            if (owner) throw new GroupAccessError("GROUP_FORBIDDEN");
            await query("DELETE FROM wf_group_members WHERE groupId = ? AND userId = ?", [groupId, userId]);
            await bumpGroupRevision(query, group);
          } else {
            if (!owner) throw new GroupAccessError("GROUP_FORBIDDEN");
            if (group.revision !== input.expectedRevision) throw new GroupAccessError("GROUP_CONFLICT");
            if (input.action === "update") await bumpGroupRevision(query, { ...group, name: input.name, description: input.description });
            else await query("DELETE FROM wf_groups WHERE groupId = ?", [groupId]);
          }
        }
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?)",
          [userId, key, JSON.stringify(ReceiptSchema.parse({ kind: "groupMutation", fingerprint, groupId }))]);
        return response(query, userId, groupId);
      });
    },
  };
}
