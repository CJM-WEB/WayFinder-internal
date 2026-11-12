/**
 * 模块职责：将账号统一昵称保存在已有用户分区，不修改认证库邮箱或登录身份。
 * 失败边界：外部数据先校验；同名不影响权限，其他账号的同一记录键不可读取或改写。
 */
import { AccountNicknameSchema, AccountProfileSchema, type AccountProfile } from "@wayfinder/contracts";
import { z } from "zod";
import { userDataAccess, type AccountDatabase, type DatabaseOperation } from "./database.js";

export type AccountProfileStorage = Readonly<{
  read: (userId: string, operation: DatabaseOperation) => Promise<AccountProfile>;
  write: (userId: string, nickname: string, operation: DatabaseOperation) => Promise<AccountProfile>;
}>;
// mysql2 会把 JSON 标量字符串直接解码；以对象封装避免旧 DAL 再次解析普通昵称文本。
const StoredNicknameSchema = z.strictObject({ nickname: AccountNicknameSchema });

export function createAccountProfileStorage(database: AccountDatabase): AccountProfileStorage {
  return {
    async read(userId, operation) {
      const value = await userDataAccess(database, userId).read(operation, "profile");
      return AccountProfileSchema.parse({ userId, nickname: value === null ? null : StoredNicknameSchema.parse(value).nickname });
    },
    async write(userId, input, operation) {
      const nickname = AccountNicknameSchema.parse(input);
      await userDataAccess(database, userId).put(operation, "profile", { nickname });
      return AccountProfileSchema.parse({ userId, nickname });
    },
  };
}
