/**
 * 模块职责：显式建立小组、成员关系和组内数据三张表，个人昵称复用既有用户数据表。
 * 身份边界：groupId 是独立归属键，不伪装为 userId；成员和数据随解散级联删除。
 * 迁移不在导入、构建或启动中运行；重复执行保留已有账号和个人图。
 */
import type { AccountDatabase, DatabaseOperation } from "../accounts/database.js";

export async function migrateGroupData(database: AccountDatabase, operation: DatabaseOperation): Promise<void> {
  await database.query(operation, `CREATE TABLE IF NOT EXISTS wf_groups (
    groupId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ownerUserId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    invitationCode VARBINARY(1024) NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (groupId), UNIQUE KEY wf_group_invitation (invitationCode)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  await database.query(operation, `CREATE TABLE IF NOT EXISTS wf_group_members (
    groupId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    userId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (groupId, userId), KEY wf_member_groups (userId),
    FOREIGN KEY (groupId) REFERENCES wf_groups (groupId) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  await database.query(operation, `CREATE TABLE IF NOT EXISTS wf_group_data (
    groupId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recordId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (groupId, recordId),
    FOREIGN KEY (groupId) REFERENCES wf_groups (groupId) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}
