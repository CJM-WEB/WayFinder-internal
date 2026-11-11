/** 云Key公共边界：只有明确保存请求可含原文，普通读取和来源选择不能携带秘密或授予账号权限。 */
import { describe, expect, it } from "vitest";
import { AccountKeyActionSchema, AccountKeyStatusSchema, AccountKeysResponseSchema,
  AccountKeysErrorResponseSchema, CredentialsErrorResponseSchema, SearchCredentialsSchema } from "./index.js";

const absent = { configured: false, mask: null, revision: null };
const saved = { configured: true, mask: "••••7890", revision: "fixture-revision" };

describe("账号Key公共协议", () => {
  it("cloud来源没有原文或前端已验证标记，混合来源仍逐项显式", () => {
    const selected = { deepseek: { source: "cloud" }, serpapi: { source: "own", apiKey: "fixture-only-key" } };
    expect(SearchCredentialsSchema.parse(selected)).toEqual(selected);
    for (const deepseek of [{ source: "cloud", apiKey: "fixture-only-key" }, { source: "cloud", verified: true },
      { source: "cloud", userId: "another-user" }, { source: "automatic" }]) {
      expect(SearchCredentialsSchema.safeParse({ ...selected, deepseek }).success).toBe(false);
    }
  });

  it("保存须明确版本及操作标识，删除不接收Key或任意归属字段", () => {
    const save = { action: "save", service: "deepseek", expectedRevision: null, mutationId: "fixture-mutation", apiKey: "fixture-only-key" };
    expect(AccountKeyActionSchema.parse(save)).toEqual(save);
    expect(AccountKeyActionSchema.parse({ action: "delete", service: "serpapi", expectedRevision: "deleted-revision", mutationId: "fixture-delete" }).action).toBe("delete");
    for (const invalid of [{ ...save, expectedRevision: undefined }, { ...save, userId: "other-user" },
      { ...save, action: "delete" }, { ...save, service: "unknown-service" }]) {
      expect(AccountKeyActionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("状态保留删除版本但不能以mask回传短Key，普通响应拒绝密文与原文", () => {
    expect(AccountKeyStatusSchema.parse({ ...absent, revision: "deleted-revision" }).configured).toBe(false);
    expect(AccountKeyStatusSchema.parse({ ...saved, mask: "••••" }).configured).toBe(true);
    for (const invalid of [{ ...saved, revision: null }, { ...saved, mask: "short-key" },
      { ...absent, mask: "••••" }, { ...saved, apiKey: "fixture-only-key" }, { ...saved, ciphertext: "fixture-ciphertext" }]) {
      expect(AccountKeyStatusSchema.safeParse(invalid).success).toBe(false);
    }
    const response = { userId: "fixture-user", deepseek: saved, serpapi: absent };
    expect(AccountKeysResponseSchema.parse(response)).toEqual(response);
    expect(AccountKeysResponseSchema.safeParse({ ...response, masterKey: "fixture-only-secret" }).success).toBe(false);
  });

  it("失败只发布固定代码，可选服务不携带原异常或Key", () => {
    expect(AccountKeysErrorResponseSchema.parse({ code: "KEY_CONFLICT", service: "deepseek" })).toEqual({ code: "KEY_CONFLICT", service: "deepseek" });
    expect(AccountKeysErrorResponseSchema.safeParse({ code: "KEY_UNAVAILABLE", message: "fixture-only-secret" }).success).toBe(false);
    for (const code of ["CLOUD_KEY_REQUIRED", "CLOUD_KEY_REVOKED", "CLOUD_KEY_UNAVAILABLE"]) {
      expect(CredentialsErrorResponseSchema.safeParse({ code, service: "serpapi" }).success).toBe(true);
    }
  });
});
