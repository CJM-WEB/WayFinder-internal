/**
 * 路由职责：复用既有会话及小组接口的统一安全边界，提供本人昵称读取和修改。
 * 昵称是纯展示资料，不改变邮箱登录或成员权限；失败只返回固定协议码。
 */
import { AccountProfileActionSchema, AccountProfileResponseSchema } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import type { AccountAuth } from "../accounts/auth.js";
import type { AccountProfileStorage } from "../accounts/profile-storage.js";
import { GroupAccessError } from "../groups/errors.js";
import { registerGroupSessionRoutes } from "./group-session.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

export function registerProfileRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: AccountProfileStorage | null; publicOrigin: string | null;
  sync?: GroupSyncRuntime | null;
}>): void {
  registerGroupSessionRoutes(server, options, (routes, guard) => {
    routes.get("/api/profile", guard(async (_request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      return reply.send(AccountProfileResponseSchema.parse({ profile: await options.storage.read(identity.userId, operation) }));
    }));
    routes.post("/api/profile", guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new GroupAccessError("GROUP_INVALID");
      const input = AccountProfileActionSchema.safeParse(request.body);
      if (!input.success) throw new GroupAccessError("GROUP_INVALID");
      const result = AccountProfileResponseSchema.parse({ profile: await options.storage.write(identity.userId, input.data.nickname, operation) });
      options.sync?.notifyUser(identity.userId);
      return reply.send(result);
    }));
  });
}
