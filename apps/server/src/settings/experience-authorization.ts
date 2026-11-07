/**
 * 模块职责：校验唯一邀请码，并签发 / 验证绑定当前授权代际的浏览器资格。
 * 安全边界：Cookie（浏览器凭证）不含原始邀请码；签名用途固定，比较使用等长摘要的恒时校验。
 * 本模块不保存用户记录、访问 Provider（服务提供方）或记录原始输入。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { CredentialService, CredentialsErrorCode } from "@wayfinder/contracts";

import type { ExperienceConfig } from "./experience-config.js";

export const EXPERIENCE_COOKIE_NAME = "__Host-wayfinder_experience";
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const SIGNATURE_PURPOSE = "wayfinder-author-experience:v1:";

/** 固定错误不携带原始消息或 cause；HTTP 层只投影公共 code / service。 */
export class CredentialsAccessError extends Error {
  readonly code: CredentialsErrorCode;
  readonly service?: CredentialService;

  constructor(code: CredentialsErrorCode, service?: CredentialService) {
    super("凭据或体验资格不可用");
    this.name = "CredentialsAccessError";
    this.code = code;
    if (service !== undefined) this.service = service;
  }
}

export function isExperienceInviteValid(inviteCode: string, config: ExperienceConfig): boolean {
  const supplied = createHash("sha256").update(inviteCode).digest();
  const expected = createHash("sha256").update(config.inviteCode).digest();
  return timingSafeEqual(supplied, expected);
}

function signGeneration(config: ExperienceConfig): string {
  return createHmac("sha256", Buffer.from(config.signingSecret, "hex"))
    .update(`${SIGNATURE_PURPOSE}${config.generation}`).digest("hex");
}

/**
 * 400 天只约束浏览器保留时长，服务端签名不设邀请码天数到期；有效状态查询可续存。
 * __Host 前缀要求 Secure、Path=/ 且无 Domain，防止兄弟子域覆盖资格 Cookie。
 */
export function createExperienceCookie(config: ExperienceConfig): string {
  const token = `v1.${config.generation}.${signGeneration(config)}`;
  return `${EXPERIENCE_COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * 外部 Cookie 一律不可信：重名、格式错误、篡改与旧代际均拒绝，不能挑选第一个看似有效值。
 * 配置须由调用方在当前检查点重新加载；本函数不维护陈旧授权缓存。
 */
export function isAuthorAuthorized(rawCookie: unknown, config: ExperienceConfig | null): boolean {
  if (config === null || typeof rawCookie !== "string" || rawCookie.length > 16 * 1_024) return false;
  const matches = rawCookie.split(";").filter(part => part.slice(0, part.indexOf("=")).trim() === EXPERIENCE_COOKIE_NAME);
  if (matches.length !== 1) return false;
  const part = matches[0];
  if (part === undefined) return false;
  const token = part.slice(part.indexOf("=") + 1).trim();
  const fields = token.split(".");
  if (fields.length !== 3 || fields[0] !== "v1" || fields[1] !== config.generation ||
    fields[2] === undefined || !/^[a-f0-9]{64}$/.test(fields[2])) return false;
  return timingSafeEqual(Buffer.from(fields[2], "hex"), Buffer.from(signGeneration(config), "hex"));
}
