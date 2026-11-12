/** 小组协议与同步测试共用的脱敏空快照，不访问任何外部服务。 */
import type { GroupSyncEvent } from "@wayfinder/contracts";
export const syncFixture = (sequence = 0, revision = 1): Extract<GroupSyncEvent, { type: "snapshot" }> => ({
  type: "snapshot", sequence,
  details: { group: { groupId: "group-fixture", name: "学习组", description: "", ownerUserId: "user-fixture", revision },
    members: [{ userId: "user-fixture", nickname: "同学", role: "owner" }], invitationCode: null },
  workspace: { groupId: "group-fixture", revision, graphs: [], activeOrder: [], deletedIds: [] }, connectionId: "connection-fixture",
});
