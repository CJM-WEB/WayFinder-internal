/**
 * 模块职责：在流式响应前解析请求凭据，并为整次运行冻结凭据和作者授权代际。
 *
 * 失败路径：所有外部头先经过公共 Schema；错误不携带原值。作者配置不确定或改码时
 * 中止本运行，后续缓存、队列和上游尝试仍须调用 assertService，不能只信入口检查。
 */
import {
  MAX_API_KEY_LENGTH,
  SEARCH_CREDENTIALS_HEADER,
  SearchCredentialsSchema,
  CLOUD_ACCOUNT_HEADER, UserIdSchema,
  type CredentialService,
  type SearchCredentials,
} from "@wayfinder/contracts";
import type { FastifyRequest } from "fastify";

import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { databaseOperation } from "../accounts/database.js";
import { accountRequestHeaders } from "../routes/account.js";
import { AccountKeyAccessError, type AccountKeyStorage, type CloudKeyRevisions } from "../accounts/key-storage.js";

import { RUN_DEADLINE_MS, type ServerConfig } from "../config.js";
import { CredentialsAccessError, isAuthorAuthorized } from "./experience-authorization.js";
import { readExperienceConfig, type ExperienceConfig } from "./experience-config.js";
import { isSameOriginRequest } from "./request-origin.js";

export type EffectiveProviderKeys = Readonly<{ llmApiKey: string; serpApiKey: string }>;
export type SearchCredentialScope = Readonly<{
  credentials: SearchCredentials;
  keys: EffectiveProviderKeys;
  authorGeneration: string | null;
  signal: AbortSignal;
  assertService: (service: CredentialService, signal: AbortSignal) => Promise<void>;
}>;

function parseCredentials(request: FastifyRequest): SearchCredentials {
  const header = request.headers[SEARCH_CREDENTIALS_HEADER];
  if (header === undefined) throw new CredentialsAccessError("CREDENTIALS_REQUIRED");
  // 重复敏感头不能由 Node 的逗号合并规则意外选出一个可用值。
  const duplicates = request.raw.rawHeaders.filter((name, index) =>
    index % 2 === 0 && name.toLowerCase() === SEARCH_CREDENTIALS_HEADER).length;
  if (duplicates > 1 || typeof header !== "string" || header.length > MAX_API_KEY_LENGTH * 4 + 256) {
    throw new CredentialsAccessError("CREDENTIALS_INVALID");
  }
  let raw: unknown;
  try { raw = JSON.parse(header) as unknown; }
  catch { throw new CredentialsAccessError("CREDENTIALS_INVALID"); }
  const parsed = SearchCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const service = first?.path[0];
    throw new CredentialsAccessError("CREDENTIALS_INVALID",
      service === "deepseek" || service === "serpapi" ? service : undefined);
  }
  return Object.freeze({
    deepseek: Object.freeze(parsed.data.deepseek),
    serpapi: Object.freeze(parsed.data.serpapi),
  });
}

async function currentAuthorConfig(path: string | null): Promise<ExperienceConfig> {
  try {
    const config = await readExperienceConfig(path);
    if (config === null) throw new CredentialsAccessError("EXPERIENCE_UNAVAILABLE");
    return config;
  } catch {
    throw new CredentialsAccessError("EXPERIENCE_UNAVAILABLE");
  }
}

/** 自带凭据不读取体验配置，因此配置故障或改码不会阻断双自带请求。 */
export async function prepareSearchCredentialScope(
  request: FastifyRequest,
  config: ServerConfig,
  connectionSignal: AbortSignal,
  auth: Pick<AccountAuth, "getIdentity"> | null = null,
  runDeadline = Date.now() + RUN_DEADLINE_MS,
  keyStorage: AccountKeyStorage | null = null,
  assertRunActive?: () => number,
): Promise<SearchCredentialScope> {
  connectionSignal.throwIfAborted();
  if (!isSameOriginRequest(request, config.publicOrigin)) throw new CredentialsAccessError("CREDENTIALS_INVALID");
  const credentials = parseCredentials(request);
  const needsAuthor = credentials.deepseek.source === "author" || credentials.serpapi.source === "author";
  const cloudServices = (["deepseek", "serpapi"] as const).filter(service => credentials[service].source === "cloud");
  const needsCloud = cloudServices.length > 0;
  const active = (signal: AbortSignal): void => {
    signal.throwIfAborted(); connectionSignal.throwIfAborted();
    if (assertRunActive !== undefined) assertRunActive();
    else if (Date.now() >= runDeadline) throw new DOMException("Run deadline exceeded", "TimeoutError");
  };
  const operation = (signal: AbortSignal) => {
    active(signal);
    const boundedSignal = AbortSignal.any([signal, connectionSignal]);
    return { signal: boundedSignal, deadline: Math.min(databaseOperation(boundedSignal).deadline, runDeadline) };
  };
  // 预期账号只防Cookie换号后的迟到选择，不从请求头选择或授予账号权限。
  const expectedAccount = needsCloud ? UserIdSchema.safeParse(request.headers[CLOUD_ACCOUNT_HEADER]) : null;
  const duplicates = needsCloud ? request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === CLOUD_ACCOUNT_HEADER).length : 0;
  if (needsCloud && (expectedAccount === null || !expectedAccount.success || duplicates > 1)) throw new CredentialsAccessError("CREDENTIALS_INVALID");
  const identity = async (signal: AbortSignal): Promise<AccountIdentity> => {
    signal.throwIfAborted();
    if (auth === null) throw new CredentialsAccessError("ACCOUNT_REQUIRED");
    try {
      const value = await auth.getIdentity(accountRequestHeaders(request), operation(signal));
      active(signal);
      if (value === null) throw new CredentialsAccessError("ACCOUNT_REQUIRED");
      if (needsCloud && expectedAccount?.success && value.userId !== expectedAccount.data) throw new CredentialsAccessError("ACCOUNT_REQUIRED");
      return value;
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (connectionSignal.aborted) throw connectionSignal.reason;
      if (error instanceof CredentialsAccessError) throw error;
      throw new CredentialsAccessError(needsCloud ? "CLOUD_KEY_UNAVAILABLE" : "EXPERIENCE_UNAVAILABLE");
    }
  };
  const initialIdentity = needsAuthor || needsCloud ? await identity(connectionSignal) : null;
  const initial = needsAuthor ? await currentAuthorConfig(config.experienceConfigPath) : null;
  connectionSignal.throwIfAborted();
  const cookie = request.headers.cookie;
  if (needsAuthor && !isAuthorAuthorized(cookie, initial, initialIdentity)) throw new CredentialsAccessError("EXPERIENCE_REVOKED");
  const revocation = new AbortController();
  const cloudKeys: Partial<Record<CredentialService, { apiKey: string; revision: string }>> = {};
  const cloudRevisions: Partial<Record<CredentialService, string>> = {};
  const cloudFailure = (error: unknown, service?: CredentialService): CredentialsAccessError =>
    error instanceof CredentialsAccessError ? error : new CredentialsAccessError(
      error instanceof AccountKeyAccessError && error.code === "KEY_CONFLICT" ? "CLOUD_KEY_REVOKED" : "CLOUD_KEY_UNAVAILABLE",
      error instanceof AccountKeyAccessError ? error.service ?? service : service);
  for (const service of cloudServices) {
    if (keyStorage === null || initialIdentity === null) throw new CredentialsAccessError("CLOUD_KEY_UNAVAILABLE", service);
    try {
      const value = await keyStorage.resolve(initialIdentity.userId, service, operation(connectionSignal));
      active(connectionSignal);
      if (value === null) throw new CredentialsAccessError("CLOUD_KEY_REQUIRED", service);
      cloudKeys[service] = value; cloudRevisions[service] = value.revision;
    } catch (error: unknown) {
      if (connectionSignal.aborted) throw connectionSignal.reason;
      throw cloudFailure(error, service);
    }
  }

  const assertService = async (service: CredentialService, signal: AbortSignal): Promise<void> => {
    active(signal);
    revocation.signal.throwIfAborted();
    if (!needsCloud && credentials[service].source !== "author") return;
    try {
      const currentIdentity = await identity(signal);
      if (initialIdentity === null || currentIdentity.userId !== initialIdentity.userId || currentIdentity.sessionId !== initialIdentity.sessionId) {
        throw new CredentialsAccessError("ACCOUNT_REQUIRED", service);
      }
      // 任一云Key更换／删除都撤销整次旧Run，即使当前阶段正在使用own或author服务。
      if (needsCloud) {
        if (keyStorage === null) throw new CredentialsAccessError("CLOUD_KEY_UNAVAILABLE", service);
        try { await keyStorage.assertCurrent(currentIdentity.userId, cloudRevisions as CloudKeyRevisions, operation(signal)); }
        catch (error: unknown) { throw cloudFailure(error, service); }
        active(signal);
      }
      if (credentials[service].source !== "author") return;
      const current = await currentAuthorConfig(config.experienceConfigPath);
      active(signal);
      if (initial === null || current.generation !== initial.generation || !isAuthorAuthorized(cookie, current, currentIdentity)) {
        throw new CredentialsAccessError("EXPERIENCE_REVOKED", service);
      }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (connectionSignal.aborted) throw connectionSignal.reason;
      const failure = error instanceof CredentialsAccessError ? error : new CredentialsAccessError(needsCloud ? "CLOUD_KEY_UNAVAILABLE" : "EXPERIENCE_UNAVAILABLE", service);
      revocation.abort(failure);
      throw failure;
    }
  };

  // 冻结前再次核对账号和全部云版本，防两个服务读取期间已发生更换。
  if (needsCloud) await assertService("deepseek", connectionSignal);

  return {
    credentials,
    keys: Object.freeze({
      llmApiKey: credentials.deepseek.source === "own" ? credentials.deepseek.apiKey : credentials.deepseek.source === "cloud" ? cloudKeys.deepseek!.apiKey : config.llmApiKey,
      serpApiKey: credentials.serpapi.source === "own" ? credentials.serpapi.apiKey : credentials.serpapi.source === "cloud" ? cloudKeys.serpapi!.apiKey : config.serpApiKey,
    }),
    authorGeneration: initial?.generation ?? null,
    signal: revocation.signal,
    assertService,
  };
}
