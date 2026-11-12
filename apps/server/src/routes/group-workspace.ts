/**
 * 模块职责：将组图快照、内容动作及本人幂等收据接入既有会话护栏。
 * 收据只确认本人已执行动作的目标标识，不绕过已退出／解散组的内容权限。
 */
import { constants as bufferConstants } from "node:buffer";
import {
  GroupGraphActionSchema, GroupGraphReceiptQuerySchema, GroupGraphReceiptResponseSchema,
  GroupGraphWriteResponseSchema, GroupWorkspaceQuerySchema, GroupWorkspaceResponseSchema,
} from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import type { AccountAuth } from "../accounts/auth.js";
import type { GroupWorkspaceStorage } from "../groups/workspace-storage.js";
import { GroupAccessError } from "../groups/errors.js";
import { authorizeGroupConnection, registerGroupSessionRoutes } from "./group-session.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

export function registerGroupWorkspaceRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: GroupWorkspaceStorage | null; publicOrigin: string | null;
  sync?: GroupSyncRuntime | null;
}>): void {
  registerGroupSessionRoutes(server, options, (routes, guard) => {
    routes.get("/api/group-workspace", guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      const query = GroupWorkspaceQuerySchema.safeParse(request.query);
      if (!query.success) throw new GroupAccessError("GROUP_INVALID");
      return reply.send(GroupWorkspaceResponseSchema.parse(await options.storage.read(identity.userId, query.data.groupId, operation)));
    }));
    routes.post("/api/group-workspace", { bodyLimit: bufferConstants.MAX_LENGTH }, guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new GroupAccessError("GROUP_INVALID");
      const input = GroupGraphActionSchema.safeParse(request.body);
      if (!input.success) throw new GroupAccessError("GROUP_INVALID");
      const admitted = authorizeGroupConnection(request, identity, input.data.groupId, operation, options.sync);
      const result = GroupGraphWriteResponseSchema.parse(await options.storage.write(identity.userId, input.data, admitted, identity.sessionId));
      options.sync?.notifyGroup(input.data.groupId);
      return reply.send(result);
    }));
    routes.get("/api/group-receipt", guard(async (request, reply, identity, operation) => {
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      const query = GroupGraphReceiptQuerySchema.safeParse(request.query);
      if (!query.success) throw new GroupAccessError("GROUP_INVALID");
      return reply.send(GroupGraphReceiptResponseSchema.parse(await options.storage.receipt(identity.userId, query.data.mutationId, operation)));
    }));
  });
}
