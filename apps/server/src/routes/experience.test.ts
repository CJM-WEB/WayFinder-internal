/**
 * 测试职责：通过真实 Fastify 路由验证同源、持久资格、撤销交错、输入错误脱敏和禁止缓存。
 * 全部配置与请求仅使用临时假秘密；不组装或调用真实 Provider（服务提供方）。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../app.js";
import { createExperienceCookie, EXPERIENCE_COOKIE_NAME } from "../settings/experience-authorization.js";
import * as configuration from "../settings/experience-config.js";
import { registerExperienceRoutes } from "./experience.js";

const directories: string[] = [];
const servers: FastifyInstance[] = [];
const publicOrigin = "https://wayfinder.example";
const headers = { host: "wayfinder.example", origin: publicOrigin, "sec-fetch-site": "same-origin" };
const inviteCode = "fake-invite-secret";

async function fixture(options: { disabled?: boolean; local?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-experience-route-"));
  directories.push(directory);
  const configPath = path.join(directory, "experience.json");
  await configuration.updateExperienceConfig(configPath, { inviteCode, announcement: "作者原文\n第二行" });
  const server = buildServer();
  servers.push(server);
  registerExperienceRoutes(server, {
    configPath: options.disabled ? null : configPath,
    publicOrigin: options.local ? null : publicOrigin,
  });
  return { server, configPath };
}

function cookieValue(value: string | string[] | number | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") throw new Error("预期返回专用授权 Cookie");
  return header.split(";")[0] ?? "";
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("体验公告与持久资格路由", () => {
  it("关闭体验时公告为空、资格为假，三路成功和失败均禁止缓存", async () => {
    const { server } = await fixture({ disabled: true });
    const settings = await server.inject({ method: "GET", url: "/api/settings", headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({ announcement: "", experienceAvailable: false });
    const status = await server.inject({ method: "GET", url: "/api/experience/status", headers });
    expect(status.json()).toEqual({ authorized: false });
    const grant = await server.inject({ method: "POST", url: "/api/experience", headers, payload: { inviteCode } });
    expect(grant.statusCode).toBe(503);
    expect(grant.json()).toEqual({ code: "EXPERIENCE_UNAVAILABLE" });
    for (const response of [settings, status, grant]) expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("只投影公开公告；授权与有效状态查询续存安全 Cookie，不返回秘密", async () => {
    const { server, configPath } = await fixture();
    const config = await configuration.readExperienceConfig(configPath);
    const settings = await server.inject({ method: "GET", url: "/api/settings", headers });
    expect(settings.json()).toEqual({ announcement: "作者原文\n第二行", experienceAvailable: true });
    const grant = await server.inject({ method: "POST", url: "/api/experience", headers, payload: { inviteCode } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toEqual({ authorized: true });
    const cookie = cookieValue(grant.headers["set-cookie"]);
    const status = await server.inject({ method: "GET", url: "/api/experience/status", headers: { ...headers, cookie } });
    expect(status.json()).toEqual({ authorized: true });
    expect(status.headers["set-cookie"]).toBeDefined();
    for (const response of [settings, grant, status]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(inviteCode);
      expect(response.body).not.toContain(config?.signingSecret);
      expect(JSON.stringify(response.headers)).not.toContain(config?.signingSecret);
    }
    const wrong = await server.inject({ method: "POST", url: "/api/experience", headers: { ...headers, cookie }, payload: { inviteCode: "fake-wrong" } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ code: "INVITE_CODE_INVALID" });
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const stillValid = await server.inject({ method: "GET", url: "/api/experience/status", headers: { ...headers, cookie } });
    expect(stillValid.json()).toEqual({ authorized: true });
  });

  it("公告可主动公开假码，改码及重复 Cookie 不会得到旧资格", async () => {
    const { server, configPath } = await fixture();
    const grant = await server.inject({ method: "POST", url: "/api/experience", headers, payload: { inviteCode } });
    const cookie = cookieValue(grant.headers["set-cookie"]);
    await configuration.updateExperienceConfig(configPath, { announcement: `公开假码：${inviteCode}` });
    const settings = await server.inject({ method: "GET", url: "/api/settings", headers });
    expect(settings.json().announcement).toBe(`公开假码：${inviteCode}`);
    const duplicate = await server.inject({ method: "GET", url: "/api/experience/status", headers: { ...headers, cookie: `${cookie}; ${EXPERIENCE_COOKIE_NAME}=invalid` } });
    expect(duplicate.json()).toEqual({ authorized: false });
    expect(duplicate.headers["set-cookie"]).toBeUndefined();
    await configuration.updateExperienceConfig(configPath, { inviteCode: "fake-new" });
    const revoked = await server.inject({ method: "GET", url: "/api/experience/status", headers: { ...headers, cookie } });
    expect(revoked.json()).toEqual({ authorized: false });
    expect(revoked.headers["set-cookie"]).toBeUndefined();
  });

  it("损坏或缺失配置返回固定503，不回退、泄露路径或清除旧 Cookie", async () => {
    const { server, configPath } = await fixture();
    await fs.writeFile(configPath, "{fake-broken-secret", { mode: 0o600 });
    for (const url of ["/api/settings", "/api/experience/status"]) {
      const response = await server.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "EXPERIENCE_UNAVAILABLE" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain(configPath);
      expect(response.body).not.toContain("fake-broken-secret");
    }
    await fs.unlink(configPath);
    const missing = await server.inject({ method: "POST", url: "/api/experience", headers, payload: { inviteCode } });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toEqual({ code: "EXPERIENCE_UNAVAILABLE" });
  });

  it("校验后到响应前改码，既不签发也不续存旧代际", async () => {
    const { server, configPath } = await fixture();
    const original = await configuration.readExperienceConfig(configPath);
    if (original === null) throw new Error("预期假配置存在");
    const changed = { ...original, generation: "22222222-2222-4222-8222-222222222222" };
    vi.spyOn(configuration, "readExperienceConfig").mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
    const grant = await server.inject({ method: "POST", url: "/api/experience", headers, payload: { inviteCode } });
    expect(grant.statusCode).toBe(403);
    expect(grant.json()).toEqual({ code: "EXPERIENCE_REVOKED" });
    expect(grant.headers["set-cookie"]).toBeUndefined();
    vi.restoreAllMocks();
    vi.spyOn(configuration, "readExperienceConfig").mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
    const cookie = cookieValue(createExperienceCookie(original));
    const status = await server.inject({ method: "GET", url: "/api/experience/status", headers: { ...headers, cookie } });
    expect(status.json()).toEqual({ authorized: false });
    expect(status.headers["set-cookie"]).toBeUndefined();
  });
});

describe("体验路由的同源与输入边界", () => {
  it("拒绝缺Origin、不同Host/Origin、兄弟子域和伪造转发来源", async () => {
    const { server } = await fixture();
    for (const hostile of [
      { host: "wayfinder.example" },
      { ...headers, host: "evil.example" },
      { ...headers, origin: "https://evil.example" },
      { ...headers, origin: "null" },
      { ...headers, "sec-fetch-site": "cross-site" },
      { ...headers, "sec-fetch-site": "same-site" },
      { ...headers, host: "evil.example", "x-forwarded-host": "wayfinder.example", "x-forwarded-proto": "https" },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/experience", headers: hostile, payload: { inviteCode } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "CREDENTIALS_INVALID" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("未配置站点仅接受规范回环地址，不能通过localhost后缀或IPv4缩写绕过", async () => {
    const { server } = await fixture({ local: true });
    for (const local of [
      { host: "localhost:5173", origin: "http://localhost:5173" },
      { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
      { host: "[::1]:5173", origin: "http://[::1]:5173" },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/experience", headers: local, payload: { inviteCode } });
      expect(response.statusCode).toBe(200);
    }
    for (const hostile of [
      { host: "localhost.evil:3000", origin: "http://localhost:5173" },
      { host: "127.1:3000", origin: "http://localhost:5173" },
      { host: "localhost:3000", origin: "http://2130706433:5173" },
      { host: "localhost:3000", origin: "http://localhost.evil:5173" },
      { host: "evil.example", origin: "http://localhost:5173", "x-forwarded-host": "localhost:3000" },
      { host: "localhost:3000", origin: "http://localhost:5173" },
      { host: "localhost:5173", origin: "http://127.0.0.1:5173" },
      { host: "localhost:5173", origin: "https://localhost:5173" },
    ]) expect((await server.inject({ method: "POST", url: "/api/experience", headers: hostile, payload: { inviteCode } })).statusCode).toBe(403);
  });

  it("非法JSON、字段、Content-Type及超大请求只返回固定脱敏错误", async () => {
    const { server } = await fixture();
    for (const input of [
      { type: "application/json", payload: '{"inviteCode":"fake-secret-sentinel"', status: 400 },
      { type: "application/json", payload: JSON.stringify({ inviteCode, verified: true }), status: 400 },
      { type: "text/plain", payload: "fake-secret-sentinel", status: 415 },
      { type: "application/octet-stream", payload: "fake-secret-sentinel", status: 415 },
      { type: "application/json", payload: JSON.stringify({ inviteCode: "x".repeat(33_000) }), status: 413 },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/experience", headers: { ...headers, "content-type": input.type }, payload: input.payload });
      expect(response.statusCode).toBe(input.status);
      expect(Object.keys(response.json())).toEqual(["code"]);
      expect(response.body).not.toContain("fake-secret-sentinel");
      expect(response.body).not.toContain(inviteCode);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });
});
