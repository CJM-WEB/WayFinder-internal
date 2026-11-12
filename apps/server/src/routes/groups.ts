/** 小组HTTP投影仅接受公共动作，创建者邮箱和操作者身份始终从已复核会话取得。 */
import { GroupActionSchema, GroupActionResponseSchema, GroupDetailsSchema, GroupListResponseSchema, GroupReadQuerySchema } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import type { AccountAuth } from "../accounts/auth.js";
import type { GroupStorage } from "../groups/storage.js";
import { GroupAccessError } from "../groups/errors.js";
import { authorizeGroupConnection, registerGroupSessionRoutes } from "./group-session.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

export function registerGroupRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: GroupStorage | null; publicOrigin: string | null;
  sync?: GroupSyncRuntime | null;
}>): void {
  registerGroupSessionRoutes(server, options, (routes, guard) => {
    routes.get("/api/groups", guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      const query = GroupReadQuerySchema.safeParse(request.query);
      if (!query.success) throw new GroupAccessError("GROUP_INVALID");
      return query.data.groupId === undefined
        ? reply.send(GroupListResponseSchema.parse(await options.storage.list(identity.userId, operation)))
        : reply.send(GroupDetailsSchema.parse(await options.storage.read(identity.userId, query.data.groupId, operation)));
    }));
    routes.post("/api/groups", guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new GroupAccessError("GROUP_INVALID");
      const input = GroupActionSchema.safeParse(request.body);
      if (!input.success) throw new GroupAccessError("GROUP_INVALID");
      const admitted = input.data.action === "create" || input.data.action === "join" ? operation
        : authorizeGroupConnection(request, identity, input.data.groupId, operation, options.sync);
      const result = GroupActionResponseSchema.parse(await options.storage.write(identity, input.data, admitted));
      const groupId = input.data.action === "create" || input.data.action === "join" ? result.details?.group.groupId : input.data.groupId;
      if (groupId !== undefined) options.sync?.notifyGroup(groupId);
      return reply.send(result);
    }));
  });
}
