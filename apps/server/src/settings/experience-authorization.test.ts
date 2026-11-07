/** 测试职责：固定假秘密验证用途隔离、签名篡改、重复 Cookie 与改码撤销，不发起外部调用。 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createExperienceCookie,
  EXPERIENCE_COOKIE_NAME,
  isAuthorAuthorized,
  isExperienceInviteValid,
} from "./experience-authorization.js";
import type { ExperienceConfig } from "./experience-config.js";

const config: ExperienceConfig = {
  announcement: "假公告",
  inviteCode: "假邀请码",
  generation: "11111111-1111-4111-8111-111111111111",
  signingSecret: "ab".repeat(32),
};
const cookie = () => createExperienceCookie(config).split(";")[0] ?? "";

describe("持久作者体验授权", () => {
  it("签发 host-only 安全 Cookie，不携带邀请码或签名秘密", () => {
    const header = createExperienceCookie(config);
    for (const attribute of ["Path=/;", "Max-Age=34560000;", "HttpOnly;", "Secure;", "SameSite=Strict"]) {
      expect(header).toContain(attribute);
    }
    expect(header.startsWith(`${EXPERIENCE_COOKIE_NAME}=`)).toBe(true);
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain(config.inviteCode);
    expect(header).not.toContain(config.signingSecret);
    expect(isAuthorAuthorized(cookie(), { ...config })).toBe(true);
    expect(isAuthorAuthorized(`other=value; ${cookie()}`, config)).toBe(true);
  });

  it("公告和重建的同一配置保持资格；改代际或签名材料立即拒绝旧 Cookie", () => {
    expect(isAuthorAuthorized(cookie(), { ...config, announcement: "新公告" })).toBe(true);
    expect(isAuthorAuthorized(cookie(), { ...config, generation: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    expect(isAuthorAuthorized(cookie(), { ...config, signingSecret: "cd".repeat(32) })).toBe(false);
    expect(isAuthorAuthorized(cookie(), null)).toBe(false);
  });

  it("拒绝篡改、重复、截断及跨用途签名，不从多个 Cookie 里挑选有效值", () => {
    const valid = cookie();
    const wrongPurpose = createHmac("sha256", Buffer.from(config.signingSecret, "hex"))
      .update(`other-purpose:${config.generation}`).digest("hex");
    for (const input of [
      undefined, [], "", valid.slice(0, -1), valid.replace("v1.", "v2."),
      `${valid}; ${valid}`, `${valid}; ${EXPERIENCE_COOKIE_NAME}=invalid`,
      `${EXPERIENCE_COOKIE_NAME}=v1.${config.generation}.${wrongPurpose}`,
      `${valid}x`, "x".repeat(16_385),
    ]) expect(isAuthorAuthorized(input, config)).toBe(false);
  });

  it("邀请码通过固定长度摘要比较，错误值不获得资格", () => {
    expect(isExperienceInviteValid("假邀请码", config)).toBe(true);
    expect(isExperienceInviteValid("假邀请码错误", config)).toBe(false);
    expect(isExperienceInviteValid("", config)).toBe(false);
  });
});
