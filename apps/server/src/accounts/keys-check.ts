/**
 * 显式云Key集成检查：仅回环隔离MySQL、假账号／邮件／Key；不调用真实Provider。
 * 覆盖实际CAS、认证篡改、墓碑与重试，以及真实Cookie下的归属和运行撤销。
 * 输出只含阶段名称，退出时清理本次创建的假身份，不打印原始错误或秘密。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { z } from "zod";
import { CLOUD_ACCOUNT_HEADER, SEARCH_CREDENTIALS_HEADER, EditableGraphSchema, type AccountKeyAction, type CredentialService } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { buildServer } from "../app.js";
import { parseServerConfig } from "../config.js";
import { registerAccountKeyRoutes } from "../routes/account-keys.js";
import { prepareSearchCredentialScope, type SearchCredentialScope } from "../settings/search-credentials.js";
import { createAccountAuth } from "./auth.js";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData } from "./database.js";
import { createAccountKeyStorage } from "./key-storage.js";
import { createWorkspaceStorage } from "./workspace-storage.js";

type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
/** 写入新密文后故意触发实际SQL错误，证明事务不会留下失败更换的Key或版本。 */
class FailingKeyDatabase extends AccountDatabase {
  override transaction<T>(operation: Parameters<AccountDatabase["transaction"]>[0], action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values = []) => {
      const result = await query(sql, values);
      if (sql.includes("UPDATE payload") && typeof values[1] === "string" && values[1].startsWith("k_")) await query("SELECT fixture_missing_key_column FROM wf_user_data");
      return result;
    }), consistentRead);
  }
}

const operation = () => databaseOperation(new AbortController().signal);
const master = Buffer.alloc(32, 79).toString("base64"), fakeKey = "fixture-key-first-private-value";
const save = (service: CredentialService, expectedRevision: string | null, apiKey = fakeKey): AccountKeyAction => ({
  action: "save", service, expectedRevision, mutationId: randomUUID(), apiKey,
});
let database: AccountDatabase | undefined, second: AccountDatabase | undefined, failing: FailingKeyDatabase | undefined, stage = "配置";
const users: string[] = [], emails: string[] = [];
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error();
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) || !/^wf_d11_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error();
  database = new AccountDatabase(config); second = new AccountDatabase(config); failing = new FailingKeyDatabase(config);
  const db = database, storage = createAccountKeyStorage(db, master), other = createAccountKeyStorage(second, master);
  assert(storage && other); await migrateAccountData(db, operation());
  const messages = new Map<string, string>(), origin = "https://fixture.example";
  const auth = createAccountAuth({ database: db, origin, secret: "fixture-key-auth-secret-at-least-thirty-two-characters",
    mailer: { sendOTP: async value => { messages.set(value.email, value.otp); } } });
  await auth.migrate(operation()); await auth.initialize(operation());
  let ip = 1;
  const authHeaders = (cookie?: string) => new Headers({ origin, "content-type": "application/json", "x-wayfinder-client-ip": `192.0.2.${ip++}`,
    ...(cookie === undefined ? {} : { cookie }) });
  const cookies: string[] = [];
  for (let index = 0; index < 2; index++) {
    const email = `wf-keys-${randomUUID()}@example.com`; emails.push(email);
    await auth.handle({ action: "register", email, password: "fixture-keys-password" }, authHeaders(), operation());
    const otp = messages.get(email); assert(otp);
    await auth.handle({ action: "verify", email, otp }, authHeaders(), operation());
    const login = await auth.handle({ action: "login", email, password: "fixture-keys-password" }, authHeaders(), operation());
    const cookie = login.cookies.map(value => value.split(";", 1)[0]).join("; "); cookies.push(cookie);
    const identity = await auth.getIdentity(authHeaders(cookie), operation()); assert(identity); users.push(identity.userId);
  }
  const a = users[0] ?? "", b = users[1] ?? "";
  const readRaw = async (userId: string, service: CredentialService) => {
    const raw = await db.query(operation(), "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?", [userId, `k_${service}`]);
    const value = z.array(z.object({ payload: z.unknown() })).parse(raw)[0]?.payload;
    return z.record(z.string(), z.unknown()).parse(typeof value === "string" ? JSON.parse(value) as unknown : value);
  };
  const putRaw = async (userId: string, service: CredentialService, value: unknown) => {
    await db.query(operation(), "UPDATE wf_user_data SET payload = ? WHERE userId = ? AND recordId = ?", [JSON.stringify(value), userId, `k_${service}`]);
  };
  stage = "短Key掩码与真实归属";
  assert.deepEqual((await storage.read(a, operation())).deepseek, { configured: false, mask: null, revision: null });
  let revision: string | null = null;
  for (const [apiKey, expectedMask] of [["a", "••••"], ["12345678", "••••"], ["123456789", "••••6789"]]) {
    const result = await storage.write(a, save("deepseek", revision, apiKey), operation());
    assert.equal(result.deepseek.mask, expectedMask); revision = result.deepseek.revision;
  }
  assert.equal((await storage.read(b, operation())).deepseek.configured, false);
  stage = "更换、丢失ACK幂等与真实双连接CAS";
  const firstInput = save("deepseek", revision), first = await storage.write(a, firstInput, operation());
  assert.deepEqual(await storage.write(a, firstInput, operation()), first);
  assert.equal((await storage.resolve(a, "deepseek", operation()))?.apiKey, fakeKey);
  assert.equal(firstInput.action, "save");
  await assert.rejects(storage.write(a, { ...firstInput, apiKey: "fixture-different-private-value" } as AccountKeyAction, operation()), { code: "KEY_CONFLICT" });
  const receiptBefore = await readRaw(a, "deepseek");
  const concurrent = await Promise.allSettled([
    storage.write(a, save("deepseek", first.deepseek.revision, "fixture-concurrent-A-value"), operation()),
    other.write(a, save("deepseek", first.deepseek.revision, "fixture-concurrent-B-value"), operation()),
  ]);
  assert.equal(concurrent.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter(value => value.status === "rejected").length, 1);
  await assert.rejects(storage.write(a, firstInput, operation()), { code: "KEY_CONFLICT" });
  const current = await storage.read(a, operation()), correct = await readRaw(a, "deepseek");
  assert(!JSON.stringify(correct).includes(fakeKey)); assert(!JSON.stringify(correct).includes(master));
  stage = "密文已写后SQL故障回滚";
  const failingStorage = createAccountKeyStorage(failing, master); assert(failingStorage);
  await assert.rejects(failingStorage.write(a, save("deepseek", current.deepseek.revision, "fixture-rollback-private-value"), operation()), { code: "KEY_UNAVAILABLE" });
  assert.deepEqual(await storage.read(a, operation()), current); assert.deepEqual(await readRaw(a, "deepseek"), correct);
  stage = "普通状态也验证错误主密钥与完整性";
  const wrong = createAccountKeyStorage(db, Buffer.alloc(32, 80).toString("base64")); assert(wrong);
  await assert.rejects(wrong.read(a, operation()), { code: "KEY_UNAVAILABLE" });
  assert.equal(createAccountKeyStorage(db, undefined), null); assert.equal(createAccountKeyStorage(db, "invalid-private-master"), null);
  const encrypted = z.record(z.string(), z.unknown()).parse(correct.encrypted);
  const tampered = [
    { ...correct, revision: randomUUID() },
    { ...correct, encrypted: { ...encrypted, tag: Buffer.alloc(16).toString("base64") } },
    { ...correct, encrypted: { ...encrypted, keyVersion: "v2" } },
    // 旧receipt拼接到新cipher必须认证失败，不能绕过CAS错误进入幂等成功。
    { ...correct, lastMutationId: receiptBefore.lastMutationId, requestFingerprint: receiptBefore.requestFingerprint },
  ];
  for (const value of tampered) {
    await putRaw(a, "deepseek", value);
    await assert.rejects(storage.read(a, operation()), { code: "KEY_UNAVAILABLE" });
    await assert.rejects(storage.resolve(a, "deepseek", operation()), { code: "KEY_UNAVAILABLE" });
    await assert.rejects(storage.write(a, firstInput, operation()), { code: "KEY_UNAVAILABLE" });
  }
  await putRaw(a, "deepseek", correct);
  await storage.write(a, save("serpapi", null, "fixture-search-private-value"), operation());
  const searchCorrect = await readRaw(a, "serpapi");
  await putRaw(a, "serpapi", correct); await assert.rejects(storage.read(a, operation()), { code: "KEY_UNAVAILABLE" });
  await putRaw(a, "serpapi", searchCorrect);
  await storage.write(b, save("deepseek", null, "fixture-owner-B-private-value"), operation());
  const ownerBCorrect = await readRaw(b, "deepseek");
  await putRaw(b, "deepseek", correct); await assert.rejects(storage.read(b, operation()), { code: "KEY_UNAVAILABLE" });
  await putRaw(b, "deepseek", ownerBCorrect);
  stage = "删除认证墓碑与同值重建防ABA";
  const oldResolve = await storage.resolve(a, "deepseek", operation()); assert(oldResolve);
  const deleted = await storage.write(a, { action: "delete", service: "deepseek", expectedRevision: current.deepseek.revision, mutationId: randomUUID() }, operation());
  assert.equal(deleted.deepseek.configured, false); assert.equal(deleted.deepseek.mask, null);
  assert(deleted.deepseek.revision && deleted.deepseek.revision !== current.deepseek.revision);
  assert.equal(await storage.resolve(a, "deepseek", operation()), null);
  const tombstone = await readRaw(a, "deepseek"); await putRaw(a, "deepseek", { ...tombstone, revision: randomUUID() });
  await assert.rejects(storage.read(a, operation()), { code: "KEY_UNAVAILABLE" }); await putRaw(a, "deepseek", tombstone);
  await assert.rejects(storage.assertCurrent(a, { deepseek: oldResolve.revision }, operation()), { code: "KEY_CONFLICT" });
  await assert.rejects(storage.write(a, save("deepseek", null), operation()), { code: "KEY_CONFLICT" });
  const recreated = await storage.write(a, save("deepseek", deleted.deepseek.revision, oldResolve.apiKey), operation());
  assert.notEqual(recreated.deepseek.revision, oldResolve.revision);
  await assert.rejects(storage.assertCurrent(a, { deepseek: oldResolve.revision }, operation()), { code: "KEY_CONFLICT" });
  stage = "同用户图与Key命名空间共存";
  const graphs = createWorkspaceStorage(db), beforeGraph = await storage.read(a, operation());
  // 故意复用Key记录的可见名称；图实际使用哈希前缀，不能覆盖或混入Key行。
  const document = EditableGraphSchema.parse({ version: "workspace.v1", id: "k_deepseek", title: "共存假图", query: "", language: "zh-CN",
    presentationMode: "graph", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z", lastRunId: null, nodes: [], edges: [], positions: {} });
  const graphRecord = await graphs.write(a, { action: "save", document, history: storeGraphHistory(createGraphHistory(document)), expectedRevision: 0, mutationId: randomUUID() }, operation());
  assert.deepEqual((await graphs.read(a, operation())).graphs, [graphRecord.record]);
  assert.deepEqual(await storage.read(a, operation()), beforeGraph);
  const graphDeleted = await graphs.write(a, { action: "delete", graphId: document.id, expectedRevision: graphRecord.record.revision, mutationId: randomUUID() }, operation());
  assert.deepEqual(await storage.read(a, operation()), beforeGraph);
  await graphs.write(a, { action: "restore", graphId: document.id, expectedRevision: graphDeleted.record.revision, mutationId: randomUUID() }, operation());
  assert.deepEqual((await graphs.read(a, operation())).graphs.map(record => record.document), [document]);
  assert.deepEqual(await storage.read(a, operation()), beforeGraph);
  assert.deepEqual((await graphs.read(b, operation())).graphs, []);
  stage = "取消与到期不产生迟到写";
  const beforeCancel = await storage.read(a, operation()), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(storage.write(a, save("deepseek", recreated.deepseek.revision), databaseOperation(cancelled.signal)), { code: "KEY_UNAVAILABLE" });
  await assert.rejects(storage.write(a, save("deepseek", recreated.deepseek.revision), { signal: new AbortController().signal, deadline: Date.now() - 1 }), { code: "KEY_UNAVAILABLE" });
  assert.deepEqual(await storage.read(a, operation()), beforeCancel);
  stage = "真实Cookie护栏与混合阶段退出撤销";
  const server = buildServer(); registerAccountKeyRoutes(server, { auth, storage, publicOrigin: origin });
  let scope: SearchCredentialScope | undefined;
  const serverConfig = parseServerConfig({ PUBLIC_ORIGIN: origin, LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
    LLM_API_KEY: "fixture-author-llm", SERPAPI_API_KEY: "fixture-author-search" });
  server.post("/scope", async (request, reply) => {
    scope = await prepareSearchCredentialScope(request, serverConfig, new AbortController().signal, auth, Date.now() + 40_000, storage);
    return reply.code(204).send();
  });
  try {
    const goodHeaders = { host: "fixture.example", origin, cookie: cookies[0] ?? "", [CLOUD_ACCOUNT_HEADER]: a };
    const beforeB = await storage.read(b, operation());
    const wrongAccount = await server.inject({ method: "POST", url: "/api/account/keys", headers: { ...goodHeaders, cookie: cookies[1] ?? "" }, payload: save("deepseek", recreated.deepseek.revision) });
    assert.equal(wrongAccount.statusCode, 401); assert.deepEqual(await storage.read(b, operation()), beforeB);
    const read = await server.inject({ url: "/api/account/keys", headers: goodHeaders }); assert.equal(read.statusCode, 200);
    assert(!read.body.includes(oldResolve.apiKey));
    assert.equal((await server.inject({ method: "POST", url: "/scope", headers: { ...goodHeaders,
      [SEARCH_CREDENTIALS_HEADER]: JSON.stringify({ deepseek: { source: "cloud" }, serpapi: { source: "own", apiKey: "fixture-own-search" } }) } })).statusCode, 204);
    assert(scope); await auth.handle({ action: "logout" }, authHeaders(cookies[0]), operation());
    await assert.rejects(scope.assertService("serpapi", new AbortController().signal), { code: "ACCOUNT_REQUIRED" }); assert(scope.signal.aborted);
  } finally { await server.close(); }
  console.info("MySQL 云Key：掩码/归属/双连接CAS/真实故障回滚/丢失ACK/篡改与receipt拼接/交换归属/认证墓碑ABA/图Key共存/取消期限/真实Cookie与退出撤销通过");
} catch {
  console.error(`MySQL 云Key隔离验证失败：${stage}；未输出原始异常、身份或秘密`); process.exitCode = 1;
} finally {
  if (database !== undefined) {
    for (const userId of users) await database.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [userId]);
    for (const email of emails) {
      await database.query(operation(), "DELETE FROM verification WHERE identifier LIKE ?", [`%${email}`]);
      await database.query(operation(), "DELETE FROM `user` WHERE email = ?", [email]);
    }
  }
  await failing?.close(); await second?.close(); await database?.close();
}
