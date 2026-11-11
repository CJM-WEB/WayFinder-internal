/**
 * 运维职责：显式验证目标机正式库的最小读写权限和账号初始化；普通导入／CI不执行。
 * 发信边界：只有指定开关才注册本人QQ邮箱，最多两次发送尝试；私有账本阻止重跑重置额度。
 * 秘密边界：OTP／Cookie只留内存，随机测试密码只进入人员指定的700目录／600文件，不输出身份。
 */
import assert from "node:assert/strict";
import console from "node:console";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { EditableGraphSchema } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { AccountDatabase, loadDatabaseConfig, databaseOperation } from "../dist/accounts/database.js";
import { createAccountAuth } from "../dist/accounts/auth.js";
import { createSmtpAccountMailer } from "../dist/accounts/mail.js";
import { createWorkspaceStorage } from "../dist/accounts/workspace-storage.js";
import { createAccountKeyStorage } from "../dist/accounts/key-storage.js";

/** 固定正式库／回环目标，避免把此显式探针误用于旧云实例或任意数据库。 */
export async function checkDeploymentAccount(args = process.argv.slice(2)) {
  let database, ledger, stateFile;
  let stage = "CONFIG";
  const operation = () => databaseOperation(new globalThis.AbortController().signal);
  try {
    const send = args.includes("--send-two-self-addressed-messages");
    const directoryIndex = args.indexOf("--state-dir");
    const directory = directoryIndex < 0 ? undefined : args[directoryIndex + 1];
    assert.deepEqual(args, send ? ["--send-two-self-addressed-messages", "--state-dir", directory] : []);
    const config = await loadDatabaseConfig(process.env);
    assert.equal(config.database, "wf_production");
    assert.equal(config.user, "wf_app");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(process.env.PUBLIC_ORIGIN, "https://cjmproject.com");
    database = new AccountDatabase(config);
    const noMail = { sendOTP: async () => { throw new Error("DEPLOYMENT_MAIL_DISABLED"); } };
    let deliveryFailed = false;
    const base = { database, origin: process.env.PUBLIC_ORIGIN, secret: process.env.WAYFINDER_AUTH_SECRET,
      onDeliveryFailure: () => { deliveryFailed = true; } };
    let auth = createAccountAuth({ ...base, mailer: noMail });
    stage = "DATABASE";
    await auth.initialize(operation());
    const userId = `deployment_probe_${randomUUID()}`;
    const otherUserId = `deployment_probe_${randomUUID()}`;
    const graphs = createWorkspaceStorage(database);
    const keys = createAccountKeyStorage(database, process.env.WAYFINDER_KEY_ENCRYPTION_KEY); assert(keys);
    try {
      const now = new Date().toISOString();
      const document = EditableGraphSchema.parse({ version: "workspace.v1", id: randomUUID(), title: "部署验证🌏",
        query: "", language: "zh-CN", presentationMode: "graph", createdAt: now, updatedAt: now,
        lastRunId: null, nodes: [], edges: [], positions: {} });
      const saved = await graphs.write(userId, { action: "save", document, expectedRevision: 0,
        history: storeGraphHistory(createGraphHistory(document)), mutationId: randomUUID() }, operation());
      const fakeKey = "fixture-deployment-no-provider";
      await keys.write(userId, { action: "save", service: "deepseek", apiKey: fakeKey,
        expectedRevision: null, mutationId: randomUUID() }, operation());
      assert.deepEqual((await graphs.read(userId, operation())).graphs, [saved.record]);
      assert.equal((await keys.read(userId, operation())).deepseek.mask, "••••ider");
      assert.equal((await keys.resolve(userId, "deepseek", operation()))?.apiKey, fakeKey);
      assert.deepEqual((await graphs.read(otherUserId, operation())).graphs, []);
      assert.equal((await keys.read(otherUserId, operation())).deepseek.configured, false);
      let inserted = false;
      await assert.rejects(database.transaction(operation(), async query => {
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, 'rollback_probe', '{}')", [userId]);
        inserted = true;
        throw new Error("DEPLOYMENT_EXPECTED_ROLLBACK");
      }));
      assert(inserted);
      assert.deepEqual(await database.query(operation(), "SELECT recordId FROM wf_user_data WHERE userId = ? AND recordId = 'rollback_probe'", [userId]), []);
    } finally {
      // 只清理本次随机假用户的全部图／元数据／墓碑／假Key，不删除真实账号或其他用户记录。
      for (const id of [userId, otherUserId]) await database.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [id]);
    }
    assert.deepEqual(await database.query(operation(), "SELECT recordId FROM wf_user_data WHERE userId = ?", [userId]), []);
    if (!send) { console.info("DEPLOYMENT_DATABASE_CHECK_OK"); return; }

    /** 先校验配置和账号不存在，再排他建立账本；已有真实账号绝不改密或接管。 */
    stage = "MAIL_GUARD";
    assert(directory && path.isAbsolute(directory));
    const email = process.env.SMTP_FROM;
    assert(email && email === process.env.SMTP_USER && /^[^@\s]+@qq\.com$/.test(email));
    assert.equal(process.env.SMTP_HOST, "smtp.qq.com");
    assert.equal(process.env.SMTP_PORT, "465");
    const smtp = createSmtpAccountMailer({ host: process.env.SMTP_HOST, port: 465,
      user: email, from: email, password: process.env.SMTP_PASSWORD });
    const existing = await database.query(operation(), "SELECT id FROM `user` WHERE email = ? LIMIT 1", [email]);
    assert(Array.isArray(existing) && existing.length === 0);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(directory);
    assert(stats.isDirectory() && !stats.isSymbolicLink() && (stats.mode & 0o777) === 0o700);
    ledger = await fs.open(path.join(directory, "mail-attempts.json"), "wx", 0o600);
    stateFile = await fs.open(path.join(directory, "account-state.json"), "wx", 0o600);
    const persist = async (file, value) => {
      const buffer = Buffer.from(JSON.stringify(value));
      assert.equal((await file.write(buffer, 0, buffer.length, 0)).bytesWritten, buffer.length);
      await file.truncate(buffer.length); await file.sync();
    };
    // 目标Ubuntu上同步新建目录项，防止崩溃后账本文件消失而误获新发送额度。
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    let attempts = 0, purpose = "verify", otp;
    await persist(ledger, { attempts, stage });
    auth = createAccountAuth({ ...base, mailer: { sendOTP: async (message, signal) => {
      assert(message.email === email && message.purpose === purpose && attempts < 2);
      assert.equal(message.purpose, attempts === 0 ? "verify" : "reset");
      // 在每次发送前持久化计数：失败也占一次；账本存在即拒绝重新创建整个流程。
      ++attempts; await persist(ledger, { attempts, stage });
      await smtp.sendOTP(message, signal); otp = message.otp;
    } } });
    const headers = cookie => new globalThis.Headers({ origin: base.origin, "content-type": "application/json",
      ...(cookie ? { cookie } : {}) });
    const action = async input => {
      const result = await auth.handle(input, headers(), operation());
      assert(!deliveryFailed); return result;
    };
    const cookieOf = result => result.cookies.map(value => value.split(";", 1)[0]).join("; ");
    const password = randomBytes(24).toString("base64url");
    const resetPassword = randomBytes(24).toString("base64url");
    await persist(stateFile, { email, password, resetPassword, stage: "prepared" });
    stage = "REGISTER";
    await action({ action: "register", email, password }); assert.match(otp ?? "", /^\d{6}$/);
    await action({ action: "verify", email, otp }); otp = undefined;
    const first = await action({ action: "login", email, password });
    const oldCookie = cookieOf(first);
    const identity = await auth.getIdentity(headers(oldCookie), operation()); assert(identity);
    stage = "RECOVER"; purpose = "reset";
    await action({ action: "recover", email }); assert.match(otp ?? "", /^\d{6}$/);
    await action({ action: "reset", email, otp, password: resetPassword }); otp = undefined;
    assert.equal(await auth.getIdentity(headers(oldCookie), operation()), null);
    const last = await action({ action: "login", email, password: resetPassword });
    const lastHeaders = headers(cookieOf(last));
    assert.equal((await auth.getIdentity(lastHeaders, operation()))?.userId, identity.userId);
    await auth.handle({ action: "logout" }, lastHeaders, operation());
    assert.equal(await auth.getIdentity(lastHeaders, operation()), null);
    assert.equal(attempts, 2);
    await persist(stateFile, { email, password: resetPassword, userId: identity.userId, stage: "completed" });
    await persist(ledger, { attempts, stage: "completed" });
    // 这里只确认SMTP调用及生命周期成功；实际收件由人员另行核对，不伪称送达。
    console.info("DEPLOYMENT_ACCOUNT_CHECK_OK_DELIVERY_REQUIRES_CONFIRMATION");
  } catch {
    console.error(`DEPLOYMENT_ACCOUNT_CHECK_FAILED_${stage}`); process.exitCode = 1;
  } finally {
    try { await ledger?.close(); await stateFile?.close(); await database?.close(); }
    catch { console.error("DEPLOYMENT_ACCOUNT_CHECK_FAILED_CLEANUP"); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkDeploymentAccount();
