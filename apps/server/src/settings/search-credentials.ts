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
  type CredentialService,
  type SearchCredentials,
} from "@wayfinder/contracts";
import type { FastifyRequest } from "fastify";

import type { ServerConfig } from "../config.js";
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
): Promise<SearchCredentialScope> {
  connectionSignal.throwIfAborted();
  if (!isSameOriginRequest(request, config.publicOrigin)) throw new CredentialsAccessError("CREDENTIALS_INVALID");
  const credentials = parseCredentials(request);
  const needsAuthor = credentials.deepseek.source === "author" || credentials.serpapi.source === "author";
  const initial = needsAuthor ? await currentAuthorConfig(config.experienceConfigPath) : null;
  connectionSignal.throwIfAborted();
  const cookie = request.headers.cookie;
  if (needsAuthor && !isAuthorAuthorized(cookie, initial)) throw new CredentialsAccessError("EXPERIENCE_REVOKED");
  const revocation = new AbortController();

  const assertService = async (service: CredentialService, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    revocation.signal.throwIfAborted();
    if (credentials[service].source !== "author") return;
    try {
      const current = await currentAuthorConfig(config.experienceConfigPath);
      signal.throwIfAborted();
      if (initial === null || current.generation !== initial.generation || !isAuthorAuthorized(cookie, current)) {
        throw new CredentialsAccessError("EXPERIENCE_REVOKED", service);
      }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      const failure = error instanceof CredentialsAccessError ? error : new CredentialsAccessError("EXPERIENCE_UNAVAILABLE", service);
      revocation.abort(failure);
      throw failure;
    }
  };

  return {
    credentials,
    keys: Object.freeze({
      llmApiKey: credentials.deepseek.source === "own" ? credentials.deepseek.apiKey : config.llmApiKey,
      serpApiKey: credentials.serpapi.source === "own" ? credentials.serpapi.apiKey : config.serpApiKey,
    }),
    authorGeneration: initial?.generation ?? null,
    signal: revocation.signal,
    assertService,
  };
}
