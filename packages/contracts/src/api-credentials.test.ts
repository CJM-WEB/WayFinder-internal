/**
 * 测试职责：冻结 D9 凭据与资格的传输边界，避免缺省作者调用、头注入和秘密字段混入搜索内容。
 * 验证仅使用假 Key（密钥）及假邀请码，不发起上游调用，也不把状态布尔值当作真实授权。
 */
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ApiKeySchema,
  AppErrorCodeSchema,
  CredentialsErrorCodeSchema,
  CredentialsErrorResponseSchema,
  ExperienceInviteRequestSchema,
  ExperienceStatusResponseSchema,
  MAX_API_KEY_LENGTH,
  MAX_INVITE_CODE_LENGTH,
  ResultGraphSchema,
  SEARCH_CREDENTIALS_HEADER,
  SearchCredentialsSchema,
  SearchRequestSchema,
  ServiceCredentialsSchema,
  SettingsPublicResponseSchema,
} from "./index.js";
import type {
  CredentialsErrorResponse,
  ExperienceInviteRequest,
  ExperienceStatusResponse,
  SearchCredentials,
  SettingsPublicResponse,
} from "./index.js";

const ownCredentials = { source: "own", apiKey: "fake-test-key" } as const;
const authorCredentials = { source: "author" } as const;
const searchRequest = { runId: "fake-run", query: "学习 TypeScript", language: "zh-CN" } as const;

describe("D9 凭据来源与输入保护", () => {
  it("要求两个服务明确选择来源，不因缺配置而隐式采用作者 Key", () => {
    for (const input of [
      undefined, {}, { deepseek: ownCredentials },
      { deepseek: {}, serpapi: authorCredentials },
      { deepseek: { apiKey: "fake-key" }, serpapi: authorCredentials },
      { deepseek: { source: "own" }, serpapi: authorCredentials },
      { deepseek: { source: "unknown" }, serpapi: authorCredentials },
    ]) expect(SearchCredentialsSchema.safeParse(input).success).toBe(false);
  });

  it("允许两服务独立选择及混合来源，同时拒绝未知字段和前端自授资格", () => {
    for (const deepseek of [ownCredentials, authorCredentials]) {
      for (const serpapi of [ownCredentials, authorCredentials]) {
        expect(SearchCredentialsSchema.parse({ deepseek, serpapi })).toEqual({ deepseek, serpapi });
      }
    }
    for (const input of [
      { ...authorCredentials, apiKey: "fake-key" },
      { ...authorCredentials, verified: true },
      { ...ownCredentials, authorization: "fake-authorization" },
    ]) expect(ServiceCredentialsSchema.safeParse(input).success).toBe(false);
    expect(SearchCredentialsSchema.safeParse({ deepseek: ownCredentials, serpapi: authorCredentials, extra: true }).success).toBe(false);
    expect(SEARCH_CREDENTIALS_HEADER).toBe("x-wayfinder-credentials");
  });

  it("在裁剪之前拒绝头控制字符与非 ASCII，并保留技术长度边界", () => {
    expect(ApiKeySchema.parse("  fake-key  ")).toBe("fake-key");
    expect(ApiKeySchema.parse("k".repeat(MAX_API_KEY_LENGTH))).toHaveLength(MAX_API_KEY_LENGTH);
    for (const input of [
      "", "   ", "\nfake-key", "fake-key\r", "fake\tkey", "fake\u0000key", "fake\u007fkey", "假密钥",
      "k".repeat(MAX_API_KEY_LENGTH + 1),
    ]) expect(ApiKeySchema.safeParse(input).success).toBe(false);
  });

  it("邀请码支持 Unicode 并裁剪空白，拒绝控制字符、空值及超长输入", () => {
    expect(ExperienceInviteRequestSchema.parse({ inviteCode: "  假邀请码-测试  " })).toEqual({ inviteCode: "假邀请码-测试" });
    expect(ExperienceInviteRequestSchema.safeParse({ inviteCode: "码".repeat(MAX_INVITE_CODE_LENGTH) }).success).toBe(true);
    for (const inviteCode of ["", "  ", "\n假码", "假码\r", "假\u0085码", "码".repeat(MAX_INVITE_CODE_LENGTH + 1)]) {
      expect(ExperienceInviteRequestSchema.safeParse({ inviteCode }).success).toBe(false);
    }
    expect(ExperienceInviteRequestSchema.safeParse({ inviteCode: "假码", verified: true }).success).toBe(false);
  });
});

describe("D9 设置与前置错误", () => {
  it("公开公告保留作者原文，包括主动公开的假邀请码，不增加秘密字段", () => {
    const response = { announcement: "体验公告\n邀请码：假码", experienceAvailable: true };
    expect(SettingsPublicResponseSchema.parse(response)).toEqual(response);
    expect(SettingsPublicResponseSchema.parse({ announcement: "", experienceAvailable: false })).toEqual({ announcement: "", experienceAvailable: false });
    for (const field of ["inviteCode", "apiKey", "signingSecret", "inviteHash"]) {
      expect(SettingsPublicResponseSchema.safeParse({ ...response, [field]: "fake-secret" }).success).toBe(false);
    }
    expect(SettingsPublicResponseSchema.safeParse({ announcement: "公告" }).success).toBe(false);
  });

  it("资格响应只反馈状态，授权凭证不进入通用业务响应", () => {
    for (const authorized of [true, false]) {
      expect(ExperienceStatusResponseSchema.parse({ authorized })).toEqual({ authorized });
    }
    expect(ExperienceStatusResponseSchema.safeParse({}).success).toBe(false);
    expect(ExperienceStatusResponseSchema.safeParse({ authorized: true, token: "fake-token" }).success).toBe(false);
  });

  it("前置错误不成为 AppError，且不携带原始消息或秘密", () => {
    for (const code of CredentialsErrorCodeSchema.options) {
      expect(CredentialsErrorResponseSchema.parse({ code })).toEqual({ code });
      for (const service of ["deepseek", "serpapi"]) {
        expect(CredentialsErrorResponseSchema.parse({ code, service })).toEqual({ code, service });
      }
      expect(AppErrorCodeSchema.safeParse(code).success).toBe(false);
    }
    for (const input of [
      { code: "UNKNOWN" }, { code: "CREDENTIALS_REQUIRED", service: "unknown" },
      { code: "CREDENTIALS_INVALID", message: "fake upstream detail" },
      { code: "INVITE_CODE_INVALID", inviteCode: "fake-code" },
    ]) expect(CredentialsErrorResponseSchema.safeParse(input).success).toBe(false);
  });

  it("既有搜索请求和结果拒绝凭据字段，不改变正常内容协议", async () => {
    const raw: unknown = JSON.parse(await readFile(new URL("../../../tests/fixtures/contracts/result-graphs.valid.json", import.meta.url), "utf8"));
    const fixtures = z.strictObject({ ready: ResultGraphSchema, partial: ResultGraphSchema, failed: ResultGraphSchema }).parse(raw);
    expect(SearchRequestSchema.parse(searchRequest)).toEqual(searchRequest);
    for (const field of ["credentials", "apiKey", "inviteCode", "authorization"]) {
      expect(SearchRequestSchema.safeParse({ ...searchRequest, [field]: "fake-secret" }).success).toBe(false);
      expect(ResultGraphSchema.safeParse({ ...fixtures.ready, [field]: "fake-secret" }).success).toBe(false);
    }
  });

  it("公共类型始终从 Zod 推导，不维护平行类型定义", () => {
    expectTypeOf<SearchCredentials>().toEqualTypeOf<z.infer<typeof SearchCredentialsSchema>>();
    expectTypeOf<SettingsPublicResponse>().toEqualTypeOf<z.infer<typeof SettingsPublicResponseSchema>>();
    expectTypeOf<ExperienceInviteRequest>().toEqualTypeOf<z.infer<typeof ExperienceInviteRequestSchema>>();
    expectTypeOf<ExperienceStatusResponse>().toEqualTypeOf<z.infer<typeof ExperienceStatusResponseSchema>>();
    expectTypeOf<CredentialsErrorResponse>().toEqualTypeOf<z.infer<typeof CredentialsErrorResponseSchema>>();
  });
});
