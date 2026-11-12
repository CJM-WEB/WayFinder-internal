/**
 * D12 协议回归：身份字段不可注入、邀请码保留邮箱、历史按作者有界而非全组截断。
 * 历史完整重放和并发合并由共享算法／服务端另验；这里只锁定公共输入与状态形状。
 */
import { describe, expect, it } from "vitest";
import {
  AccountNicknameSchema, AccountProfileActionSchema, AccountProfileResponseSchema,
  EditableGraphSchema, GroupActionSchema, GroupActionResponseSchema, GroupDetailsSchema,
  GroupGraphActionSchema, GroupGraphHistorySchema, GroupInvitationCodeSchema,
  GroupSyncEventSchema, GroupWorkspaceResponseSchema, StoredGraphHistorySchema,
} from "./index.js";
import { createGraphHistory, storeGraphHistory } from "./graph-history.js";

const document = EditableGraphSchema.parse({
  version: "workspace.v1", id: "fixture-graph", title: "测试图", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z",
  lastRunId: null, nodes: [], edges: [], positions: {},
});
const privateHistory = storeGraphHistory(createGraphHistory(document));
const history = { version: "groupHistory.v1", base: privateHistory.base, events: [], redoIdsByUser: {} };
const group = { groupId: "fixture-group", name: "学习组", description: "共同整理资料", ownerUserId: "owner", revision: 1 };
const members = [{ userId: "owner", nickname: "同学", role: "owner" }, { userId: "member", nickname: "同学", role: "member" }];
const details = { group, members, invitationCode: "owner+tag@example.test#Ab123456789012345678" };
const record = { document, history, revision: 1, status: "active", originalIndex: null };
const workspace = { groupId: group.groupId, revision: 1, activeOrder: [document.id], deletedIds: [], graphs: [record] };
const event = (id: string, actorUserId = "owner", undoable = true, active = true) => ({
  id, actorUserId, undoable, active, occurredAt: document.updatedAt, kind: "graph.rename",
  subject: "标题", before: document, after: document,
});

describe("D12 昵称与邀请码", () => {
  it("旧账号允许尚无昵称，填写仅规范化空白且不附加未批准的长度上限", () => {
    expect(AccountProfileResponseSchema.parse({ profile: { userId: "owner", nickname: null } }).profile.nickname).toBeNull();
    expect(AccountNicknameSchema.parse("  共同学习  ")).toBe("共同学习");
    expect(AccountNicknameSchema.safeParse("   ").success).toBe(false);
    expect(AccountNicknameSchema.safeParse("学".repeat(500)).success).toBe(true);
    expect(AccountProfileActionSchema.safeParse({ nickname: "同学", userId: "another-user" }).success).toBe(false);
    expect(AccountProfileActionSchema.safeParse({ nickname: "同学", email: "private@example.test" }).success).toBe(false);
  });

  it.each(["owner@example.test", "owner+tag@example.test", "owner.name@example.test"])("完整邮箱不被内部字符拆分：%s", email => {
    const invitationCode = `${email}#Ab123456789012345678`;
    expect(GroupInvitationCodeSchema.parse(invitationCode)).toBe(invitationCode);
    expect(invitationCode.length).toBeGreaterThan(20);
  });

  it("随机部分恰20位字母数字，完整码不能省略邮箱或夹带换行", () => {
    for (const code of ["Ab123456789012345678", "owner@example.test#short", "owner@example.test#Ab1234567890123456789",
      "invalid-email#Ab123456789012345678", "owner@example.test#Ab12345678901234567_", "owner@example.test\n#Ab123456789012345678"]) {
      expect(GroupInvitationCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it("成员列表可重名但不能重复身份或改写创建者，普通成员投影允许隐藏邀请码", () => {
    expect(GroupDetailsSchema.safeParse(details).success).toBe(true);
    expect(GroupDetailsSchema.safeParse({ ...details, invitationCode: null }).success).toBe(true);
    expect(GroupDetailsSchema.safeParse({ ...details, members: [...members, members[1]] }).success).toBe(false);
    expect(GroupDetailsSchema.safeParse({ ...details, group: { ...group, ownerUserId: "member" } }).success).toBe(false);
    expect(GroupDetailsSchema.safeParse({ ...details, members: members.map(member => ({ ...member, email: "private@example.test" })) }).success).toBe(false);
  });
});

describe("D12 管理与图动作", () => {
  it("管理动作仅带目标及版本，拒绝客户端指定创建者邮箱、角色和操作者", () => {
    const create = { action: "create", name: "学习组", description: "", mutationId: "create-1" };
    expect(GroupActionSchema.safeParse(create).success).toBe(true);
    for (const injection of [{ ownerUserId: "member" }, { creatorEmail: "fake@example.test" }, { role: "owner" }, { userId: "member" }]) {
      expect(GroupActionSchema.safeParse({ ...create, ...injection }).success).toBe(false);
    }
    expect(GroupActionSchema.safeParse({ action: "join", mutationId: "join-1", invitationCode: details.invitationCode }).success).toBe(true);
    expect(GroupActionSchema.safeParse({ action: "dissolve", mutationId: "dissolve-1", groupId: group.groupId, expectedRevision: 0 }).success).toBe(false);
    expect(GroupActionResponseSchema.safeParse({ groups: [], details: null }).success).toBe(true);
  });

  it("普通编辑必须使用同一图身份和正版本，历史及作者不能由客户端提交", () => {
    const edit = { action: "edit", groupId: group.groupId, mutationId: "edit-1", graphId: document.id,
      expectedRevision: 1, before: document, after: { ...document, title: "新标题" }, kind: "graph.rename", subject: "标题" };
    expect(GroupGraphActionSchema.safeParse(edit).success).toBe(true);
    for (const invalid of [{ ...edit, expectedRevision: 0 }, { ...edit, graphId: "another-graph" },
      { ...edit, after: { ...document, id: "another-graph" } }, { ...edit, actorUserId: "owner" }, { ...edit, history }]) {
      expect(GroupGraphActionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("双向复制只提交已授权来源，不能携带旧历史或指定目标账号", () => {
    const copyIn = { action: "copyIn", groupId: group.groupId, mutationId: "copy-in", sourceGraphId: document.id, sourceRevision: 1 };
    const copyOut = { action: "copyOut", groupId: group.groupId, mutationId: "copy-out", graphId: document.id, expectedRevision: 1 };
    expect(GroupGraphActionSchema.safeParse(copyIn).success).toBe(true);
    expect(GroupGraphActionSchema.safeParse(copyOut).success).toBe(true);
    expect(GroupGraphActionSchema.safeParse({ ...copyIn, history: privateHistory }).success).toBe(false);
    expect(GroupGraphActionSchema.safeParse({ ...copyOut, targetUserId: "another-user" }).success).toBe(false);
  });
});

describe("D12 本人历史与同步快照", () => {
  it("每位成员可保留100步，全组多于100条仍合法，旧个人历史上限保持", () => {
    const events = [
      ...Array.from({ length: 100 }, (_, i) => event(`a-${i}`)),
      ...Array.from({ length: 100 }, (_, i) => event(`b-${i}`, "member")),
    ];
    expect(GroupGraphHistorySchema.safeParse({ ...history, events }).success).toBe(true);
    expect(GroupGraphHistorySchema.safeParse({ ...history, events: [...events, event("a-101")] }).success).toBe(false);
    const privateEvents = Array.from({ length: 101 }, (_, i) => ({ id: `private-${i}`, active: true,
      occurredAt: document.updatedAt, kind: "graph.rename", subject: "标题", before: document, after: document }));
    expect(StoredGraphHistorySchema.safeParse({ ...privateHistory, events: privateEvents }).success).toBe(false);
  });

  it("窗口外因果事件可以保留，但不能被他人重做或伪装成可撤销事件", () => {
    const events = [event("owner-old", "owner", false), event("owner-undone", "owner", true, false), event("member-undone", "member", true, false)];
    const current = { ...history, events, redoIdsByUser: { owner: ["owner-undone"], member: ["member-undone"] } };
    expect(GroupGraphHistorySchema.safeParse(current).success).toBe(true);
    for (const redoIdsByUser of [{ owner: ["member-undone"] }, { owner: ["owner-old"] },
      { owner: ["missing"] }, { owner: ["owner-undone", "owner-undone"] }]) {
      expect(GroupGraphHistorySchema.safeParse({ ...current, redoIdsByUser }).success).toBe(false);
    }
    expect(GroupGraphHistorySchema.safeParse({ ...current, events: [...events, events[1]] }).success).toBe(false);
  });

  it("组图顺序和删除栈必须与记录一致，快照不能把另一组内容套进当前组", () => {
    expect(GroupWorkspaceResponseSchema.safeParse(workspace).success).toBe(true);
    expect(GroupWorkspaceResponseSchema.safeParse({ ...workspace, deletedIds: [document.id] }).success).toBe(false);
    expect(GroupWorkspaceResponseSchema.safeParse({ ...workspace, activeOrder: [] }).success).toBe(false);
    expect(GroupSyncEventSchema.safeParse({ type: "snapshot", connectionId: "connection-1", sequence: 1, details, workspace }).success).toBe(true);
    expect(GroupSyncEventSchema.safeParse({ type: "snapshot", connectionId: "connection-1", sequence: 1, details,
      workspace: { ...workspace, groupId: "another-group" } }).success).toBe(false);
    expect(GroupSyncEventSchema.safeParse({ type: "snapshot", connectionId: "connection-1", sequence: 8, details,
      workspace: { ...workspace, revision: 2 } }).success).toBe(false);
    expect(GroupSyncEventSchema.safeParse({ type: "renew", sequence: 2 }).success).toBe(true);
    expect(GroupSyncEventSchema.safeParse({ type: "heartbeat", sequence: -1 }).success).toBe(false);
    expect(GroupSyncEventSchema.safeParse({ type: "revoked", code: "GROUP_FORBIDDEN", token: "not-allowed" }).success).toBe(false);
  });
});
