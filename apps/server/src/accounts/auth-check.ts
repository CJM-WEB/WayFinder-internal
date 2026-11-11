/**
 * 显式认证集成验证：仅连接回环专用假数据库、使用进程内假邮件，不发送真实邮件。
 * 验证真实库迁移、密码/会话、验证码单次消费和期限；普通 CI 不执行此入口。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AccountAction } from "@wayfinder/contracts";
import { createAccountAuth } from "./auth.js";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "./database.js";
import { buildServer } from "../app.js";
import { registerAccountRoutes } from "../routes/account.js";
import { registerExperienceRoutes, sendCredentialsAccessError } from "../routes/experience.js";
import { updateExperienceConfig } from "../settings/experience-config.js";
import { CredentialsAccessError } from "../settings/experience-authorization.js";
import { prepareSearchCredentialScope, type SearchCredentialScope } from "../settings/search-credentials.js";
import { parseServerConfig } from "../config.js";

let database: AccountDatabase | undefined;
let stage = "配置";
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error();
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) || !/^wf_d11_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error();
  database = new AccountDatabase(config);
  const db = database;
  const operation = () => databaseOperation(new AbortController().signal);
  const origin = "https://fixture.example";
  const emails = ["a", "b", "failure"].map(name => `wf-${name}-${randomUUID()}@example.com`);
  const email = emails[0] ?? "", secondEmail = emails[1] ?? "", failureEmail = emails[2] ?? "";
  const messages = new Map<string, string>();
  let failures = 0, mailFails = false, ip = 1;
  const auth = createAccountAuth({ database: db, origin, secret: "fixture-auth-secret-with-more-than-thirty-two-characters",
    mailer: { sendOTP: async message => {
      if (mailFails) throw new Error("fixture SMTP unavailable");
      messages.set(`${message.purpose}:${message.email}`, message.otp);
    } }, onDeliveryFailure: () => { ++failures; } });
  const headers = (cookie?: string, fixedIp?: string): Headers => new Headers({ origin, "content-type": "application/json",
    "x-wayfinder-client-ip": fixedIp ?? `192.0.2.${ip++}`, ...(cookie === undefined ? {} : { cookie }) });
  const action = (input: AccountAction, cookie?: string, fixedIp?: string) => auth.handle(input, headers(cookie, fixedIp), operation());
  const cookieOf = (cookies: string[]): string => cookies.map(cookie => cookie.split(";", 1)[0]).join("; ");
  stage = "迁移";
  await auth.migrate(operation()); await auth.migrate(operation()); await auth.initialize(operation());
  try {
    stage = "注册及验证";
    const password = "fixture-password-original";
    assert.deepEqual((await action({ action: "register", email, password })).body, { accepted: true });
    await assert.rejects(action({ action: "login", email, password }), { message: "ACCOUNT_INVALID" });
    const otp = messages.get(`verify:${email}`); assert.match(otp ?? "", /^[0-9]{6}$/);
    assert.deepEqual((await action({ action: "register", email, password })).body, { accepted: true });
    const verification = await Promise.allSettled([
      action({ action: "verify", email, otp: otp ?? "" }), action({ action: "verify", email, otp: otp ?? "" }),
    ]);
    assert.equal(verification.filter(result => result.status === "fulfilled").length, 1);
    await assert.rejects(action({ action: "verify", email, otp: otp ?? "" }));

    stage = "登录退出及换会话";
    const first = await action({ action: "login", email, password });
    assert.deepEqual(first.body, { account: { userId: ("account" in first.body ? first.body.account?.userId : ""), email } });
    assert(!JSON.stringify(first.body).includes("token"));
    assert(first.cookies.some(cookie => cookie.includes("Secure") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict")));
    const firstCookie = cookieOf(first.cookies);
    const firstIdentity = await auth.getIdentity(headers(firstCookie), operation()); assert(firstIdentity?.userId);
    const relogin = await action({ action: "login", email, password }, firstCookie);
    assert.equal(await auth.getIdentity(headers(firstCookie), operation()), null);
    const currentCookie = cookieOf(relogin.cookies);
    assert((await auth.getIdentity(headers(currentCookie), operation()))?.userId);
    await action({ action: "logout" }, currentCookie);
    assert.equal(await auth.getIdentity(headers(currentCookie), operation()), null);

    stage = "密码哈希及找回撤销";
    const beforeReset = cookieOf((await action({ action: "login", email, password })).cookies);
    const missing = `wf-missing-${randomUUID()}@example.com`;
    assert.deepEqual((await action({ action: "recover", email: missing })).body,
      (await action({ action: "recover", email })).body);
    const resetOtp = messages.get(`reset:${email}`); assert(resetOtp);
    await action({ action: "reset", email, otp: resetOtp, password: "fixture-password-replaced" });
    await assert.rejects(action({ action: "reset", email, otp: resetOtp, password: "fixture-password-again" }));
    assert.equal(await auth.getIdentity(headers(beforeReset), operation()), null);
    await assert.rejects(action({ action: "login", email, password }));
    const afterReset = await action({ action: "login", email, password: "fixture-password-replaced" });
    assert((await auth.getIdentity(headers(cookieOf(afterReset.cookies)), operation()))?.userId);
    const hashes = await db.query(operation(), "SELECT a.password FROM `account` a JOIN `user` u ON u.id=a.userId WHERE u.email=?", [email]);
    assert(!JSON.stringify(hashes).includes("fixture-password"));

    stage = "验证码失效和限次";
    await action({ action: "register", email: secondEmail, password });
    const secondOtp = messages.get(`verify:${secondEmail}`); assert(secondOtp);
    const wrong = secondOtp === "000000" ? "111111" : "000000";
    for (let count = 0; count < 3; ++count) await assert.rejects(action({ action: "verify", email: secondEmail, otp: wrong }));
    await assert.rejects(action({ action: "verify", email: secondEmail, otp: secondOtp }));
    await action({ action: "resend", email: secondEmail });
    const expired = messages.get(`verify:${secondEmail}`); assert(expired);
    await db.query(operation(), "UPDATE verification SET expiresAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE identifier LIKE ?", [`%${secondEmail}`]);
    await assert.rejects(action({ action: "verify", email: secondEmail, otp: expired }));

    stage = "限速及投递失败";
    for (let count = 0; count < 3; ++count) await action({ action: "recover", email }, undefined, "198.51.100.1");
    await assert.rejects(action({ action: "recover", email }, undefined, "198.51.100.1"), { message: "ACCOUNT_RATE_LIMITED" });
    mailFails = true;
    assert.deepEqual((await action({ action: "register", email: failureEmail, password })).body, { accepted: true });
    assert.equal(failures, 1);
    assert(!messages.has(`verify:${failureEmail}`));
    stage = "取消";
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(auth.getIdentity(headers(), databaseOperation(cancelled.signal)), { message: "DATABASE_CANCELLED" });
    stage = "真实认证与HTTP路由接线";
    const server = buildServer();
    registerAccountRoutes(server, { auth, publicOrigin: origin });
    const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-auth-gate-"));
    const configPath = path.join(directory, "experience.json");
    await updateExperienceConfig(configPath, { inviteCode: "fixture-invite" });
    registerExperienceRoutes(server, { auth, publicOrigin: origin, configPath });
    const config = parseServerConfig({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
      LLM_API_KEY: "fixture-author-llm", SERPAPI_API_KEY: "fixture-author-search", PUBLIC_ORIGIN: origin,
      EXPERIENCE_CONFIG_PATH: configPath });
    let scope: SearchCredentialScope | undefined;
    server.post("/fixture-author", async (request, reply) => {
      try { scope = await prepareSearchCredentialScope(request, config, new AbortController().signal, auth); return reply.code(204).send(); }
      catch (error: unknown) {
        if (error instanceof CredentialsAccessError) return sendCredentialsAccessError(reply, error);
        throw error;
      }
    });
    const httpHeaders = { host: "fixture.example", origin, cookie: cookieOf(afterReset.cookies) };
    try {
      const session = await server.inject({ url: "/api/account", headers: httpHeaders });
      assert.equal(session.statusCode, 200);
      assert.deepEqual(session.json(), afterReset.body);
      assert(!session.body.includes("token") && !session.body.includes("sessionId"));
      stage = "真实会话与作者双门禁";
      const trial = { method: "POST" as const, url: "/api/experience", payload: { inviteCode: "fixture-invite" } };
      assert.equal((await server.inject({ ...trial, headers: { host: "fixture.example", origin } })).statusCode, 401);
      const grant = await server.inject({ ...trial, headers: httpHeaders });
      assert.equal(grant.statusCode, 200);
      const grantHeader = grant.headers["set-cookie"];
      const trialCookie = cookieOf(Array.isArray(grantHeader) ? grantHeader : [String(grantHeader)]);
      const selected = JSON.stringify({ deepseek: { source: "author" }, serpapi: { source: "author" } });
      assert.equal((await server.inject({ method: "POST", url: "/fixture-author", headers: {
        ...httpHeaders, cookie: `${httpHeaders.cookie}; ${trialCookie}`, "x-wayfinder-credentials": selected,
      } })).statusCode, 204);
      assert(scope);
      const logout = await server.inject({ method: "POST", url: "/api/account", headers: httpHeaders,
        payload: { action: "logout" } });
      assert.equal(logout.statusCode, 200);
      assert.deepEqual((await server.inject({ url: "/api/account", headers: httpHeaders })).json(), { account: null });
      await assert.rejects(scope.assertService("deepseek", new AbortController().signal), { code: "ACCOUNT_REQUIRED" });
      assert.equal(scope.signal.aborted, true);
      assert.deepEqual((await server.inject({ url: "/api/experience/status", headers: {
        ...httpHeaders, cookie: `${httpHeaders.cookie}; ${trialCookie}`,
      } })).json(), { authorized: false });
      const newLogin = await action({ action: "login", email, password: "fixture-password-replaced" });
      assert.deepEqual((await server.inject({ url: "/api/experience/status", headers: {
        ...httpHeaders, cookie: `${cookieOf(newLogin.cookies)}; ${trialCookie}`,
      } })).json(), { authorized: false });
    } finally { await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  } finally {
    for (const email of emails) {
      await db.query(operation(), "DELETE FROM verification WHERE identifier LIKE ?", [`%${email}`]);
      await db.query(operation(), "DELETE FROM `user` WHERE email = ?", [email]);
    }
  }
  console.info("MySQL 真实认证：迁移/注册验证/密码会话/重置撤销/验证码边界/限速/假邮件失败/取消/作者登录双门禁通过");
} catch {
  console.error(`MySQL 账号隔离验证失败：${stage}；未输出原始异常、邮箱、Cookie 或验证码`);
  process.exitCode = 1;
} finally { await database?.close(); }
