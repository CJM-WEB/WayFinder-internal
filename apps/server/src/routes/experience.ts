/**
 * 路由职责：公开公告、唯一邀请码验证及持久资格状态，独立于搜索结果和流式状态机。
 * 失败边界：同源检查先于请求体处理，所有响应 no-store（禁止缓存）；解析异常只输出固定公共错误。
 * 本项不接搜索门禁或 Provider，后续调用方必须在实际调用、出队和缓存命中前重新校验资格。
 */
import {
  CredentialsErrorResponseSchema,
  ExperienceInviteRequestSchema,
  ExperienceStatusResponseSchema,
  SettingsPublicResponseSchema,
} from "@wayfinder/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createExperienceCookie,
  CredentialsAccessError,
  isAuthorAuthorized,
  isExperienceInviteValid,
} from "../settings/experience-authorization.js";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { databaseOperation } from "../accounts/database.js";
import { accountRequestHeaders } from "./account.js";
import { readExperienceConfig, type ExperienceConfig } from "../settings/experience-config.js";
import { isSameOriginRequest } from "../settings/request-origin.js";

/** 公共错误只投影已批准字段，不回显 JSON 解析器、文件系统或框架原始异常。 */
export function sendCredentialsAccessError(
  reply: FastifyReply,
  error: CredentialsAccessError,
  statusCode?: number,
): FastifyReply {
  const status = statusCode ?? (error.code === "ACCOUNT_REQUIRED" ? 401 : error.code === "EXPERIENCE_UNAVAILABLE" ? 503
    : error.code === "INVITE_CODE_INVALID" || error.code === "EXPERIENCE_REVOKED" ? 403 : 400);
  return reply.header("Cache-Control", "no-store").code(status).send(CredentialsErrorResponseSchema.parse({
    code: error.code,
    ...(error.service === undefined ? {} : { service: error.service }),
  }));
}

async function loadConfig(configPath: string | null): Promise<ExperienceConfig | null> {
  try {
    return await readExperienceConfig(configPath);
  } catch {
    throw new CredentialsAccessError("EXPERIENCE_UNAVAILABLE");
  }
}

/** 复查代际与签名材料，避免在第一次读取后改码仍签发或续存旧授权。 */
function sameAuthorization(first: ExperienceConfig, current: ExperienceConfig | null): current is ExperienceConfig {
  return current !== null && first.generation === current.generation && first.signingSecret === current.signingSecret;
}

export function registerExperienceRoutes(
  server: FastifyInstance,
  options: Readonly<{ configPath: string | null; publicOrigin: string | null; auth?: Pick<AccountAuth, "getIdentity"> | null }>,
): void {
  const withIdentity = async <T>(request: FastifyRequest, reply: FastifyReply,
    action: (read: () => Promise<AccountIdentity | null>) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once("aborted", abort); reply.raw.once("close", disconnected);
    const operation = databaseOperation(controller.signal);
    try { return await action(async () => options.auth?.getIdentity(accountRequestHeaders(request), operation) ?? null); }
    finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); }
  };
  // Fastify 封装域让固定错误处理只作用于这三路，不改变既有搜索和静态资源错误语义。
  void server.register(async routes => {
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) {
        return sendCredentialsAccessError(reply, new CredentialsAccessError("CREDENTIALS_INVALID"), 403);
      }
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof CredentialsAccessError) return sendCredentialsAccessError(reply, error);
      const status = typeof error === "object" && error !== null && "statusCode" in error &&
        typeof error.statusCode === "number" ? error.statusCode : 503;
      return sendCredentialsAccessError(reply, new CredentialsAccessError(
        status >= 400 && status < 500 ? "CREDENTIALS_INVALID" : "EXPERIENCE_UNAVAILABLE",
      ), status >= 400 && status < 500 ? status : 503);
    });

    routes.get("/api/settings", async (_request, reply) => {
      const config = await loadConfig(options.configPath);
      return reply.send(SettingsPublicResponseSchema.parse({
        announcement: config?.announcement ?? "",
        experienceAvailable: config !== null && options.auth !== undefined && options.auth !== null,
      }));
    });

    routes.post("/api/experience", { bodyLimit: 32 * 1_024 }, async (request, reply) => {
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return sendCredentialsAccessError(reply, new CredentialsAccessError("CREDENTIALS_INVALID"), 415);
      }
      const parsed = ExperienceInviteRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendCredentialsAccessError(reply, new CredentialsAccessError("INVITE_CODE_INVALID"), 400);
      const config = await loadConfig(options.configPath);
      if (config === null) throw new CredentialsAccessError("EXPERIENCE_UNAVAILABLE");
      return withIdentity(request, reply, async readIdentity => {
      const identity = await readIdentity();
      if (identity === null) throw new CredentialsAccessError("ACCOUNT_REQUIRED");
      if (!isExperienceInviteValid(parsed.data.inviteCode, config)) throw new CredentialsAccessError("INVITE_CODE_INVALID");
      const current = await loadConfig(options.configPath);
      if (!sameAuthorization(config, current) || !isExperienceInviteValid(parsed.data.inviteCode, current)) {
        throw new CredentialsAccessError("EXPERIENCE_REVOKED");
      }
      const currentIdentity = await readIdentity();
      if (currentIdentity === null || currentIdentity.userId !== identity.userId || currentIdentity.sessionId !== identity.sessionId) {
        throw new CredentialsAccessError("ACCOUNT_REQUIRED");
      }
      return reply.header("Set-Cookie", createExperienceCookie(current, identity))
        .send(ExperienceStatusResponseSchema.parse({ authorized: true }));
      });
    });

    routes.get("/api/experience/status", async (request, reply) => withIdentity(request, reply, async readIdentity => {
      const identity = await readIdentity();
      const config = await loadConfig(options.configPath);
      if (config === null || !isAuthorAuthorized(request.headers.cookie, config, identity)) {
        return reply.send(ExperienceStatusResponseSchema.parse({ authorized: false }));
      }
      const current = await loadConfig(options.configPath);
      const currentIdentity = await readIdentity();
      const authorized = currentIdentity !== null && identity !== null && currentIdentity.userId === identity.userId && currentIdentity.sessionId === identity.sessionId && sameAuthorization(config, current) && isAuthorAuthorized(request.headers.cookie, current, currentIdentity);
      if (authorized) reply.header("Set-Cookie", createExperienceCookie(current, currentIdentity));
      return reply.send(ExperienceStatusResponseSchema.parse({ authorized }));
    }));
  });
}
