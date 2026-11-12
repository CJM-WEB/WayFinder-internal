/**
 * 运维职责：人员显式执行 prepare／verify／cleanup，验证真实 HTTPS 浏览器与正式库的最小闭环。
 * 额度边界：任何导航前封锁外站与发信动作；搜索只能返回既有固定样例，绝不访问真实 Provider。
 * 隐私边界：密码／Cookie／IndexedDB 仅写目标机700目录中的600文件；失败只输出阶段码、白名单类别与脚本行号。
 * 阶段边界：重启由人员在 prepare 与 verify 之间执行；普通导入、CI和应用启动均不运行本入口。
 * 验收范围：仅认证、账号隔离、邀请码及一张图／Key的存储；其他产品功能由人员手测。
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import {
  AccountActionSchema, AccountErrorResponseSchema, AccountKeysResponseSchema, CLOUD_ACCOUNT_HEADER,
  CloudWorkspaceResponseSchema, EditableGraphSchema,
  GraphPlanSchema, ResultGraphSchema, StreamEventSchema,
} from "@wayfinder/contracts";
import { appendHistory, createGraphHistory, remapGraphHistoryIdentity, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { AccountDatabase, databaseOperation, loadDatabaseConfig } from "../../server/dist/accounts/database.js";
import { createAccountAuth } from "../../server/dist/accounts/auth.js";
import { readExperienceConfig, readProtectedJson } from "../../server/dist/settings/experience-config.js";

const ORIGIN = "https://cjmproject.com";
const STATE = "browser-check.json", PROFILE = "fixture-browser.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operation = () => databaseOperation(new globalThis.AbortController().signal);

/** 纯判定可供无秘密检查导入；只列举无计费接口，不提供任意 URL 的通用旁路。 */
export function deploymentRequestPolicy(rawUrl, method, body) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== ORIGIN) return "block";
    const pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");
    if (pathname.startsWith("/api/search")) return "fake-search";
    if (pathname === "/api/account" && method === "POST") {
      const action = AccountActionSchema.parse(JSON.parse(body));
      return action.action === "login" || action.action === "logout" ? "allow" : "block";
    }
    const reads = ["/api/account", "/api/account/keys", "/api/workspace", "/api/settings", "/api/experience/status"];
    const writes = ["/api/account/keys", "/api/workspace", "/api/experience"];
    if (method === "GET" && reads.includes(pathname)) return "allow";
    if (method === "POST" && writes.includes(pathname)) return "allow";
    return !pathname.startsWith("/api/") && ["GET", "HEAD"].includes(method) ? "allow" : "block";
  } catch { return "block"; }
}

/** 错误诊断只输出白名单类别与本脚本帧行号，绝不回显可能包含表单秘密的message/stack。 */
export function deploymentFailureCode(failure) {
  try {
    const names = ["Error", "AssertionError", "TimeoutError", "TypeError", "SyntaxError", "ZodError", "AggregateError"];
    const name = failure instanceof Error && names.includes(failure.name) ? failure.name : "Error";
    const frame = failure instanceof Error && typeof failure.stack === "string"
      ? failure.stack.split("\n").map(line => line.match(/^\s+at .*[\\/]deployment-browser-check\.mjs:(\d+):\d+\)?$/)).find(Boolean) : null;
    const line = frame ? Number(frame[1]) : 0;
    return `${name}_L${Number.isSafeInteger(line) && line > 0 && line < 10000 ? line : 0}`;
  } catch { return "Error_L0"; }
}

/** HTTP诊断仅保留整数状态与Contract枚举；未知正文/额外字段均折叠为固定码。 */
export function deploymentLoginHttpCode(status, body) {
  const parsed = AccountErrorResponseSchema.safeParse(body);
  return `HTTP_${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0}_${parsed.success ? parsed.data.code : "ACCOUNT_RESPONSE_INVALID"}`;
}
class LoginResponseError extends Error {
  constructor(status, body) { super("DEPLOYMENT_LOGIN_FAILED"); this.fixedCode = deploymentLoginHttpCode(status, body); }
}

/** 复用 Contract 的 ready 样例，按现有 Mock Stream 顺序派生连贯 NDJSON，不复制资源正文。 */
export async function fakeSearchBody() {
  const fixtures = JSON.parse(await fs.readFile(new URL("../../../tests/fixtures/contracts/result-graphs.valid.json", import.meta.url), "utf8"));
  const result = ResultGraphSchema.parse(fixtures.ready), events = [];
  const append = payload => events.push(StreamEventSchema.parse({ ...payload, runId: result.runId,
    sequence: events.length + 1, protocolVersion: "0.1", timestamp: "2026-10-18T08:00:00.000Z" }));
  append({ type: "query.analysis", data: result.analysis });
  append({ type: "graph.plan", data: GraphPlanSchema.parse({ analysis: result.analysis,
    nodes: result.graph.nodes.map(({ id, title, description, nodeType, layer, searchPlan }) =>
      ({ id, title, description, nodeType, layer, searchPlan, status: "planned" })), edges: result.graph.edges }) });
  for (const node of result.graph.nodes) {
    append({ type: "node.status", nodeId: node.id, status: "searching" });
    append({ type: "node.ready", nodeId: node.id, resources: node.resources, warnings: node.warnings });
  }
  append({ type: "complete", data: { finalStatus: "complete", result } });
  return events.map(event => JSON.stringify(event)).join("\n") + "\n";
}

/** 受控状态只认普通文件与当前账号所有权；排他创建阻止重跑覆盖上一轮证据。 */
async function privateFile(directory, name, create = false) {
  const file = await fs.open(path.join(directory, name), create ? "wx" : constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && (stat.mode & 0o777) === 0o600 && (process.getuid === undefined || stat.uid === process.getuid()));
    return file;
  } catch (failure) { await file.close(); throw failure; }
}
async function persist(file, value) {
  const buffer = Buffer.from(JSON.stringify(value));
  assert.equal((await file.write(buffer, 0, buffer.length, 0)).bytesWritten, buffer.length);
  await file.truncate(buffer.length); await file.sync();
}
function validateManifest(state) {
  assert(state.version === "deployment-browser.v1" && UUID.test(state.runId));
  assert(["creating", "prepared", "verified"].includes(state.phase));
  assert.equal(state.users.length, 2);
  state.users.forEach((user, index) => {
    assert.equal(user.email, `wf-browser-${state.runId}-${index}@example.invalid`);
    assert(typeof user.password === "string" && user.password.length === 32);
    assert(user.userId === null || (typeof user.userId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(user.userId)));
  });
  assert(state.users[0].userId === null || state.users[0].userId !== state.users[1].userId);
}

/** 所有 HTTP 均由页面 fetch 发出，接受同一 context 的拦截；禁止 APIRequestContext 绕过门禁。 */
async function api(page, endpoint, body, userId) {
  assert(["/api/account", "/api/account/keys", "/api/workspace", "/api/experience", "/api/experience/status"].includes(endpoint));
  return page.evaluate(async ({ endpoint, body, userId, accountHeader }) => {
    const response = await globalThis.fetch(endpoint, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(userId === undefined ? {} : { [accountHeader]: userId }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: globalThis.AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  }, { endpoint, body, userId, accountHeader: CLOUD_ACCOUNT_HEADER });
}
async function workspace(page, userId) {
  const result = await api(page, "/api/workspace", undefined, userId);
  assert.equal(result.status, 200); assert.match(result.cache, /no-store/);
  const value = CloudWorkspaceResponseSchema.parse(result.body); assert.equal(value.userId, userId); return value;
}
async function keys(page, userId) {
  const result = await api(page, "/api/account/keys", undefined, userId);
  assert.equal(result.status, 200); assert.match(result.cache, /no-store/);
  const value = AccountKeysResponseSchema.parse(result.body); assert.equal(value.userId, userId); return value;
}
async function product(page) {
  const explore = page.getByRole("button", { name: "开始探索", exact: true });
  // 等待入口或已就绪画布；load本身不保证React已挂载，超时仍按真实失败处理。
  await expect.poll(async () => (await explore.isVisible()) ||
    (await page.locator('.ink-study__stage[data-search-ready="true"]').count()) > 0, { timeout: 20000 }).toBe(true);
  if (await explore.isVisible()) await explore.click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
}
async function panel(page, name) {
  const target = page.getByRole("region", { name, exact: true });
  if (!(await target.isVisible())) {
    await page.locator(".ink-study__history-dock").hover();
    await page.getByRole("button", { name, exact: true }).click();
  }
  await expect(target).toBeVisible(); return target;
}
async function cookieCheck(context, previousCookies) {
  const cookies = (await context.cookies(ORIGIN)).filter(cookie => cookie.name.endsWith("session_token"));
  assert.equal(cookies.length, 1);
  const cookie = cookies[0], remaining = cookie.expires - Date.now() / 1000;
  assert(cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict" && remaining > 0 && remaining <= 604810);
  if (previousCookies === undefined) assert(remaining > 604000);
  else {
    const previous = previousCookies.filter(value => value.name.endsWith("session_token")); assert.equal(previous.length, 1);
    assert(cookie.value === previous[0].value && cookie.expires === previous[0].expires);
  }
}
// pinned Better Auth每次成功请求刷新lastRequest；探针距上一真实POST完成至少10.2秒，不重试失败。
let lastLoginCompletedAt = 0;
async function login(page, user) {
  await product(page); const settings = await panel(page, "设置");
  await settings.getByRole("region", { name: "账号", exact: true }).getByRole("button", { name: "登录", exact: true }).click();
  const form = page.getByRole("dialog", { name: "登录", exact: true }).getByRole("form", { name: "邮箱账号" });
  await form.getByLabel("邮箱", { exact: true }).fill(user.email);
  await form.getByLabel("密码", { exact: true }).fill(user.password);
  await delay(Math.max(0, lastLoginCompletedAt + 10200 - Date.now()));
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === ORIGIN && url.pathname === "/api/account" && response.request().method() === "POST";
    }),
    form.getByRole("button", { name: "登录", exact: true }).click(),
  ]);
  lastLoginCompletedAt = Date.now();
  if (response.status() !== 200) {
    let body; try { body = await response.json(); } catch { body = null; }
    throw new LoginResponseError(response.status(), body);
  }
  await expect(form).toHaveCount(0); await expect(settings).toHaveCount(0); await product(page);
  assert.equal((await api(page, "/api/account")).body.account?.userId, user.userId);
  await cookieCheck(page.context());
}
async function logout(page) {
  const result = await api(page, "/api/account", { action: "logout" }); assert.equal(result.status, 200);
  await page.reload(); await product(page);
  assert.equal((await api(page, "/api/account")).body.account, null);
  assert(!(await page.context().cookies(ORIGIN)).some(cookie => cookie.name.endsWith("session_token")));
}
async function guestSnapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open("wayfinder-workspace", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("IDB"));
    });
    try { const value = await new Promise((resolve, reject) => {
      const request = db.transaction("workspace").objectStore("workspace").get("current"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("IDB"));
    });
      // 保存代际是CAS内部计数；源保留比较完整图/历史/删除栈，允许身份切换完成其正常落盘。
      return { version: value.version, documents: value.documents, currentId: value.currentId, histories: value.histories, deletedGraphs: value.deletedGraphs ?? [] };
    } finally { db.close(); }
  });
}
async function synced(page) {
  const settings = await panel(page, "设置");
  await expect(settings.getByRole("region", { name: "云端工作区", exact: true })).toContainText("已同步到云端", { timeout: 20000 });
  return settings;
}

export async function checkDeploymentBrowser(args = process.argv.slice(2)) {
  let database, browser, stateFile, state, stage = "CONFIG";
  const contexts = [];
  try {
    assert(!process.env.DEBUG && !process.env.PWDEBUG);
    assert.equal(process.versions.node.split(".")[0], "24");
    const [phase, ...options] = args;
    assert(["prepare", "verify", "cleanup"].includes(phase) && options.length % 2 === 0);
    const flags = new Map();
    for (let index = 0; index < options.length; index += 2) {
      assert(["--state-dir", "--existing-account-state", "--experience-config"].includes(options[index]) && !flags.has(options[index]));
      assert(path.isAbsolute(options[index + 1])); flags.set(options[index], options[index + 1]);
    }
    assert.equal(flags.size, phase === "prepare" ? 3 : 1);
    let existing, experience;
    if (phase === "prepare") {
      assert(flags.has("--existing-account-state") && flags.has("--experience-config"));
      existing = await readProtectedJson(flags.get("--existing-account-state"));
      assert(existing.stage === "completed" && typeof existing.password === "string" && existing.userId && /^[^@\s]+@qq\.com$/.test(existing.email));
      experience = await readExperienceConfig(flags.get("--experience-config")); assert(experience);
    }
    const directory = flags.get("--state-dir"); assert(directory);
    if (phase === "prepare") await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && (process.getuid === undefined || stat.uid === process.getuid()));
    const config = await loadDatabaseConfig(process.env);
    assert(config.host === "127.0.0.1" && config.database === "wf_production" && config.user === "wf_app" && process.env.PUBLIC_ORIGIN === ORIGIN);
    database = new AccountDatabase(config);
    if (phase === "prepare") {
      stateFile = await privateFile(directory, STATE, true);
      const runId = randomUUID();
      state = { version: "deployment-browser.v1", phase: "creating", runId,
        users: [0, 1].map(index => ({ email: `wf-browser-${runId}-${index}@example.invalid`, password: randomBytes(24).toString("base64url"), userId: null })) };
      await persist(stateFile, state);
      stage = "FIXTURE_ACCOUNTS";
      let otp, target, deliveryFailed = false;
      const auth = createAccountAuth({ database, origin: ORIGIN, secret: process.env.WAYFINDER_AUTH_SECRET,
        mailer: { sendOTP: async message => { assert(message.email === target && message.purpose === "verify"); otp = message.otp; } },
        onDeliveryFailure: () => { deliveryFailed = true; } });
      await auth.initialize(operation());
      for (const user of state.users) {
        assert.deepEqual(await database.query(operation(), "SELECT id FROM `user` WHERE email = ?", [user.email]), []);
        target = user.email; otp = undefined;
        const headers = new globalThis.Headers({ origin: ORIGIN, "content-type": "application/json" });
        await auth.handle({ action: "register", email: user.email, password: user.password }, headers, operation());
        const rows = await database.query(operation(), "SELECT id, email FROM `user` WHERE email = ?", [user.email]);
        assert.equal(rows.length, 1); assert.equal(rows[0].email, user.email);
        user.userId = rows[0].id; await persist(stateFile, state);
        assert(!deliveryFailed && /^\d{6}$/.test(otp));
        await auth.handle({ action: "verify", email: user.email, otp }, headers, operation()); otp = undefined;
      }
    } else {
      stateFile = await privateFile(directory, STATE);
      state = JSON.parse(await stateFile.readFile("utf8")); validateManifest(state);
    }
    if (phase === "cleanup") {
      stage = "OWNED_CLEANUP";
      // UUID命名空间、原始清单、数据库id+email必须同时匹配；未知/既有账号不进入清理集合。
      await database.transaction(operation(), async query => {
        for (const user of state.users) {
          const rows = await query("SELECT id, email FROM `user` WHERE email = ? FOR UPDATE", [user.email]);
          if (rows.length === 0) continue;
          assert(rows.length === 1 && user.userId !== null && rows[0].id === user.userId && rows[0].email === user.email);
          await query("DELETE FROM wf_user_data WHERE userId = ?", [user.userId]);
          await query("DELETE FROM `session` WHERE userId = ?", [user.userId]);
          await query("DELETE FROM `account` WHERE userId = ?", [user.userId]);
          await query("DELETE FROM verification WHERE identifier = ?", [`email-verification-otp-${user.email}`]);
          await query("DELETE FROM `user` WHERE id = ? AND email = ?", [user.userId, user.email]);
        }
      });
      try { const profile = await privateFile(directory, PROFILE); await profile.close(); await fs.unlink(path.join(directory, PROFILE)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await persist(stateFile, { version: state.version, runId: state.runId, phase: "cleaned", fixtureAccounts: 2 });
      console.info("DEPLOYMENT_BROWSER_CLEANUP_OK"); return;
    }
    validateManifest(state); assert(state.users.every(user => user.userId !== null));
    if (phase === "verify") assert.equal(state.phase, "prepared");
    for (const user of state.users) {
      const rows = await database.query(operation(), "SELECT id, email FROM `user` WHERE id = ? AND email = ?", [user.userId, user.email]);
      assert(rows.length === 1 && rows[0].id === user.userId && rows[0].email === user.email);
    }
    const ndjson = await fakeSearchBody();
    // 子进程只继承系统运行所需字段，不继承Node进程中的数据库、认证或Provider秘密。
    const env = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "DISPLAY", "XDG_RUNTIME_DIR", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    stage = "CHROMIUM";
    // Playwright临时profile同样落受控700目录；浏览器退出后由SDK清理，不落系统公共临时区。
    const previousTmp = process.env.TMPDIR;
    try { process.env.TMPDIR = directory; browser = await chromium.launch({ headless: true, env: { ...env, TMPDIR: directory } }); }
    finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
    const gates = [];
    const open = async storageState => {
      const context = await browser.newContext({ baseURL: ORIGIN, serviceWorkers: "block", reducedMotion: "reduce", ...(storageState ? { storageState } : {}) });
      contexts.push(context); const gate = { blocked: false, failImport: false }; gates.push(gate);
      await context.route("**/*", async route => {
        try {
          const request = route.request(), policy = deploymentRequestPolicy(request.url(), request.method(), request.postData());
          if (policy === "fake-search") return await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson });
          if (policy === "block") { gate.blocked = true; return await route.abort("blockedbyclient"); }
          if (gate.failImport && new URL(request.url()).pathname === "/api/workspace" && request.method() === "POST" && request.postDataJSON()?.action === "import") {
            gate.failImport = false; return await route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"WORKSPACE_UNAVAILABLE"}' });
          }
          await route.continue();
        } catch { gate.blocked = true; await route.abort("blockedbyclient").catch(() => {}); }
      });
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      await page.addInitScript(() => {
        const original = globalThis.HTMLCanvasElement.prototype.getContext;
        globalThis.HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind.includes("webgl") ? null : Reflect.apply(original, this, [kind, ...rest]); };
      });
      await page.goto(ORIGIN); await product(page); return { context, page, gate };
    };
    const [a, b] = state.users;
    if (phase === "prepare") {
      stage = "EXISTING_ACCOUNT";
      assert(!state.users.some(user => user.email === existing.email || user.userId === existing.userId));
      const known = await open(); await login(known.page, existing); await logout(known.page); await known.context.close();

      stage = "GUEST_IMPORT";
      const first = await open(), page = first.page;
      const before = EditableGraphSchema.parse({ version: "workspace.v1", id: randomUUID(), title: "144测试图原名", query: "", language: "zh-CN", presentationMode: "graph",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastRunId: null, nodes: [], edges: [], positions: {} });
      const document = EditableGraphSchema.parse({ ...before, title: "144访客测试图" });
      const history = storeGraphHistory(appendHistory(createGraphHistory(before), before, document,
        { id: randomUUID(), occurredAt: document.updatedAt, active: true, kind: "graph.rename", subject: document.title }, 100));
      const guest = { version: "workspace-storage.v2", documents: [document], currentId: document.id, histories: { [document.id]: history }, deletedGraphs: [] };
      const fakeKey = `fake-144-browser-${state.runId}`;
      await page.evaluate(async ({ guest, fakeKey }) => {
        globalThis.localStorage.setItem("wayfinder.credentials.v1", JSON.stringify({ deepseek: { source: "own", apiKey: fakeKey }, serpapi: { source: "own", apiKey: "fake-144-search" } }));
        const db = await new Promise((resolve, reject) => { const request = globalThis.indexedDB.open("wayfinder-workspace", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("IDB")); });
        try { await new Promise((resolve, reject) => { const tx = db.transaction("workspace", "readwrite"); tx.objectStore("workspace").put(guest, "current"); tx.oncomplete = resolve; tx.onerror = () => reject(new Error("IDB")); }); }
        finally { db.close(); }
      }, { guest, fakeKey });
      await page.reload(); await product(page);
      const source = await guestSnapshot(page);
      assert.equal((await api(page, "/api/experience/status")).body.authorized, false);
      assert.equal((await api(page, "/api/experience", { inviteCode: experience.inviteCode })).status, 401);
      await login(page, a); const settings = await synced(page);
      assert.deepEqual((await workspace(page, a.userId)).graphs, []); assert.equal((await keys(page, a.userId)).deepseek.configured, false);
      const cloud = settings.getByRole("region", { name: "云端工作区", exact: true });
      await cloud.getByRole("button", { name: "导入访客图及历史", exact: true }).click();
      await cloud.getByRole("button", { name: "取消", exact: true }).click();
      assert.deepEqual((await workspace(page, a.userId)).graphs, []); assert.deepEqual(await guestSnapshot(page), source);
      first.gate.failImport = true;
      await cloud.getByRole("button", { name: "导入访客图及历史", exact: true }).click();
      await cloud.getByRole("button", { name: "确认导入图及历史", exact: true }).click();
      await expect(cloud).toContainText("云端同步未完成"); assert.deepEqual(await guestSnapshot(page), source);
      await cloud.getByRole("button", { name: "重试云端同步", exact: true }).click(); await synced(page);
      assert.deepEqual(await guestSnapshot(page), source);
      const snapshot = await workspace(page, a.userId);
      assert.equal(snapshot.graphs.length, 1);
      assert.deepEqual(snapshot.graphs[0].history, remapGraphHistoryIdentity(document, history, snapshot.graphs[0].document.id).history);
      assert.equal((await keys(page, a.userId)).deepseek.configured, false);

      stage = "KEY_CONFIRMATION";
      const keyPanel = settings.getByRole("region", { name: "DeepSeek 云端 Key", exact: true });
      await keyPanel.getByRole("button", { name: "读取该服务的访客 Key", exact: true }).click();
      await keyPanel.getByRole("button", { name: "保存到云端", exact: true }).click();
      await keyPanel.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal((await keys(page, a.userId)).deepseek.configured, false);
      await keyPanel.getByRole("button", { name: "读取该服务的访客 Key", exact: true }).click();
      await keyPanel.getByRole("button", { name: "保存到云端", exact: true }).click();
      await keyPanel.getByRole("button", { name: "确认保存云端 Key", exact: true }).click();
      await expect(keyPanel).toContainText("云端 Key 已更新");
      await expect(keyPanel.getByRole("button", { name: "使用云端 Key", exact: true })).toHaveAttribute("aria-pressed", "false");
      assert(!(JSON.stringify(await keys(page, a.userId))).includes(fakeKey));
      assert.equal(await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem("wayfinder.credentials.v1")).deepseek.apiKey), fakeKey);

      stage = "ISOLATION_ACCOUNT_B";
      const isolated = await open(); await login(isolated.page, b); await synced(isolated.page);
      assert.deepEqual((await workspace(isolated.page, b.userId)).graphs, []); assert.equal((await keys(isolated.page, b.userId)).deepseek.configured, false);
      assert.equal((await api(isolated.page, "/api/workspace", undefined, a.userId)).status, 401);
      assert.equal((await api(isolated.page, "/api/account/keys", undefined, a.userId)).status, 401);
      await isolated.context.close();
      stage = "INVITATION_GRANT";
      assert.equal((await api(page, "/api/experience", { inviteCode: experience.inviteCode })).status, 200);
      assert.equal((await api(page, "/api/experience/status")).body.authorized, true);
      stage = "INVITATION_RELOGIN";
      await logout(page); await login(page, a);
      assert.equal((await api(page, "/api/experience/status")).body.authorized, false);
      await synced(page); await page.reload(); await product(page); await synced(page);
      state.expectedWorkspace = await workspace(page, a.userId); state.expectedKeys = await keys(page, a.userId);
      state.expectedGuest = await guestSnapshot(page); assert.deepEqual(state.expectedGuest, source);
      // indexedDB:true 是跨浏览器进程恢复本地持久化的必要条件，不能只保存Cookie/localStorage。
      const profile = await privateFile(directory, PROFILE, true);
      try { await persist(profile, await first.context.storageState({ indexedDB: true })); } finally { await profile.close(); }
      assert(gates.every(gate => !gate.blocked)); state.phase = "prepared"; await persist(stateFile, state);
    } else {
      stage = "RESTART_PERSISTENCE"; assert.equal(state.phase, "prepared");
      const profile = await privateFile(directory, PROFILE); let stored;
      try { stored = JSON.parse(await profile.readFile("utf8")); } finally { await profile.close(); }
      assert(stored.origins.every(origin => origin.origin === ORIGIN));
      assert(stored.origins.some(origin => origin.indexedDB?.some(db => db.name === "wayfinder-workspace")));
      const resumed = await open(stored);
      assert.equal((await api(resumed.page, "/api/account")).body.account?.userId, a.userId);
      await cookieCheck(resumed.context, stored.cookies); await synced(resumed.page);
      assert.deepEqual(await workspace(resumed.page, a.userId), state.expectedWorkspace);
      assert.deepEqual(await keys(resumed.page, a.userId), state.expectedKeys);
      // 云端不会重建访客源；比较其原始语义快照才能证明IDB与浏览器Key确实跨进程保留。
      assert.deepEqual(await guestSnapshot(resumed.page), state.expectedGuest);
      assert.equal(await resumed.page.evaluate(() => JSON.parse(globalThis.localStorage.getItem("wayfinder.credentials.v1")).deepseek.apiKey), `fake-144-browser-${state.runId}`);
      await resumed.page.reload(); await product(resumed.page); await synced(resumed.page);
      assert.deepEqual(await workspace(resumed.page, a.userId), state.expectedWorkspace);
      const independent = await open(); await login(independent.page, a); await synced(independent.page);
      assert.deepEqual(await workspace(independent.page, a.userId), state.expectedWorkspace);

      stage = "KEY_REPLACE_DELETE";
      const settings = await panel(independent.page, "设置"), keyPanel = settings.getByRole("region", { name: "DeepSeek 云端 Key", exact: true });
      await keyPanel.getByLabel("DeepSeek 待保存的云端 Key", { exact: true }).fill("fake-144-replacement-key");
      await keyPanel.getByRole("button", { name: "保存到云端", exact: true }).click();
      await keyPanel.getByRole("button", { name: "确认保存云端 Key", exact: true }).click();
      await expect(keyPanel).toContainText("云端 Key 已更新");
      const replacement = await keys(independent.page, a.userId); assert.equal(replacement.deepseek.mask, "••••-key");
      assert.notEqual(replacement.deepseek.revision, state.expectedKeys.deepseek.revision);
      await keyPanel.getByRole("button", { name: "删除云端 Key", exact: true }).click();
      await keyPanel.getByRole("button", { name: "确认删除云端 Key", exact: true }).click();
      await expect(keyPanel).toContainText("尚未配置"); assert.equal((await keys(independent.page, a.userId)).deepseek.configured, false);
      assert(gates.every(gate => !gate.blocked)); state.phase = "verified"; await persist(stateFile, state);
    }
    assert(gates.every(gate => !gate.blocked));
    console.info(`DEPLOYMENT_BROWSER_${phase.toUpperCase()}_OK`);
  } catch (failure) {
    const http = failure instanceof LoginResponseError ? `_${failure.fixedCode}` : "";
    console.error(`DEPLOYMENT_BROWSER_CHECK_FAILED_${stage}${http}_${deploymentFailureCode(failure)}`); process.exitCode = 1;
  }
  finally {
    try { for (const context of contexts) await context.close(); await browser?.close(); await stateFile?.close(); await database?.close(); }
    catch { console.error("DEPLOYMENT_BROWSER_CHECK_FAILED_CLOSE"); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkDeploymentBrowser();
