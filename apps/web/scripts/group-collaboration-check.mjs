/**
 * 显式D12跨层验收：真实生产组合根、隔离MySQL、三个独立Chromium账号；普通CI不执行。
 * 邮件只在内存接收OTP，搜索恒用假Provider；浏览器只准访问本轮回环Origin，不读.env。
 * 失败只输出阶段码，不输出Cookie、密码、邀请码或原始响应；finally按本轮账号精确清理并核对。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";
import { CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, AccountResponseSchema, CloudWorkspaceResponseSchema,
  GroupDetailsSchema, GroupErrorResponseSchema, GroupGraphActionSchema, GroupGraphReceiptResponseSchema,
  GroupGraphWriteResponseSchema, GroupWorkspaceResponseSchema } from "@wayfinder/contracts";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData } from "../../server/dist/accounts/database.js";
import { createAccountAuth } from "../../server/dist/accounts/auth.js";
import { createAccountProfileStorage } from "../../server/dist/accounts/profile-storage.js";
import { createAccountKeyStorage } from "../../server/dist/accounts/key-storage.js";
import { createWorkspaceStorage } from "../../server/dist/accounts/workspace-storage.js";
import { migrateGroupData } from "../../server/dist/groups/database.js";
import { createGroupStorage } from "../../server/dist/groups/storage.js";
import { createGroupWorkspaceStorage } from "../../server/dist/groups/workspace-storage.js";
import { createGroupSync, readGroupSyncSnapshot } from "../../server/dist/groups/sync.js";
import { createGroupSearch } from "../../server/dist/groups/search.js";
import { buildProductionServer } from "../../server/dist/production-server.js";
import { parseServerConfig } from "../../server/dist/config.js";
import { GraphOutlineSchema } from "../../server/dist/ai/graph-outline.js";
import { SearchPlanBundleSchema } from "../../server/dist/ai/search-plan-generator.js";
import { SerpApiBingSearchProvider } from "../../server/dist/search/providers/serpapi-bing.js";

const expect = baseExpect.configure({ timeout: 15_000 });
const QUERY = "TypeScript compiler guide", NODE = "browser-node", GROUP_NAME = "跨层学习组";
const operation = () => databaseOperation(new globalThis.AbortController().signal, 10_000);
const gate = () => { let release = () => {}; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function bounded(pending, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("CHECK_TIMEOUT")), milliseconds); })]); }
  finally { globalThis.clearTimeout(timer); }
}
async function availablePort() {
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); return address.port;
}

/** 固定假Adapter仍走正式Planner／队列／签名／预览应用；没有默认真实Provider回退。 */
function fakeProviders() {
  const outline = GraphOutlineSchema.parse({ analysis: { intent: "learn", topic: QUERY, freshnessSensitive: false, ambiguityLevel: "medium",
    broadSearchQueries: [], strategy: "plan_first", presentationMode: "compact" }, nodes: [{ id: NODE, title: QUERY,
    description: "Learn TypeScript compiler options", nodeType: "primary", layer: 0, status: "planned" }], edges: [] });
  const bundle = SearchPlanBundleSchema.parse({ plans: [{ nodeId: NODE, queries: [QUERY], rankingProfile: "knowledge" }] });
  let serial = 0, failNext = false, blocked = null;
  const calls = { factories: 0, llm: 0, search: 0, aborted: 0 };
  return {
    calls,
    fail: () => { failNext = true; },
    hold: () => { assert.equal(blocked, null); blocked = { reached: gate(), release: gate() }; return blocked; },
    release: () => { blocked?.release.release(); blocked = null; },
    factory: (keys, beforeAttempt) => {
      assert.equal(keys.llmApiKey, "fixture-browser-llm"); assert.equal(keys.serpApiKey, "fixture-browser-search");
      ++calls.factories; const current = ++serial;
      return {
        searchProvider: new SerpApiBingSearchProvider({ apiKey: keys.serpApiKey, beforeAttempt, searchTimeoutMs: 2_000,
          fetchImplementation: async (_input, init) => {
            init?.signal?.throwIfAborted(); ++calls.search;
            return new globalThis.Response(JSON.stringify({ search_metadata: { status: "Success" }, organic_results: [{ position: 1,
              title: QUERY, link: `https://docs.example.com/browser-${current}`, snippet: "TypeScript compiler options with practical examples." }] }),
            { headers: { "content-type": "application/json" } });
          } }),
        llmProvider: { id: "fixture-browser-llm", async structured(input, options) {
          ++calls.llm; options.signal.throwIfAborted();
          if (failNext && input.schemaName === "graph_outline") { failNext = false; throw new Error("FIXTURE_MODEL_FAILURE"); }
          if (blocked !== null) {
            const held = blocked; held.reached.release();
            let abort;
            try {
              await bounded(Promise.race([held.release.promise, new Promise((_, reject) => {
                abort = () => { ++calls.aborted; reject(options.signal.reason); }; options.signal.addEventListener("abort", abort, { once: true });
                if (options.signal.aborted) abort();
              })]));
            } finally { if (abort !== undefined) options.signal.removeEventListener("abort", abort); }
          }
          options.signal.throwIfAborted();
          if (input.schemaName === "graph_outline") return outline;
          if (input.schemaName === "search_plan_bundle") return bundle;
          if (input.schemaName === "resource_rerank") return { ranking: [{ candidateId: "candidate_1", scores: { relevance: 0.95, authority: 0.95,
            clarity: 0.95, completeness: 0.95, trustSafety: 0.95, freshness: 0.95 }, summary: "编译选项说明。", whySelected: "直接解释目标主题。" }] };
          throw new Error("UNEXPECTED_FAKE_SCHEMA");
        } },
      };
    },
  };
}

/** 负面权限检查也从页面同源fetch发出，使用真实会话；不手工伪造Cookie。 */
async function api(page, endpoint, userId, body, proof) {
  return page.evaluate(async input => {
    const response = await globalThis.fetch(input.endpoint, { method: input.body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      headers: { [input.accountHeader]: input.userId, ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.proof === undefined ? {} : { [input.proofHeader]: input.proof }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal: globalThis.AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  }, { endpoint, userId, body, proof, accountHeader: CLOUD_ACCOUNT_HEADER, proofHeader: GROUP_CONNECTION_HEADER });
}
const groupPanel = page => page.getByRole("region", { name: "小组", exact: true });
async function panel(page, name) {
  await page.bringToFront();
  const target = page.getByRole("region", { name: name === "撤销" ? "撤销记录" : name, exact: true });
  if (!(await target.isVisible())) {
    const dock = page.locator(".ink-study__history-dock"); await dock.hover(); await dock.getByRole("button", { name, exact: true }).click();
  }
  await expect(target).toBeVisible(); return target;
}
async function product(page) {
  await expect.poll(async () => await page.getByRole("button", { name: "开始探索", exact: true }).isVisible()
    || await page.locator('.ink-study__stage[data-search-ready="true"]').count() > 0).toBe(true);
  if (await page.getByRole("button", { name: "开始探索", exact: true }).isVisible()) await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
}
async function closePanel(page) { await page.keyboard.press("Escape"); await expect(page.locator('.ink-study__history-panel[data-active="true"]')).toHaveCount(0); }
async function openGroup(page, name = GROUP_NAME) {
  const groups = await panel(page, "小组"); await groups.getByRole("button", { name: `进入小组：${name}`, exact: true }).click();
  await expect(groups.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online"); return groups;
}
async function selectGraph(page, title) {
  // 内容副本允许同名；本旅程原图始终在权威activeOrder首位，选择同名首条而非假定名称唯一。
  const groups = await panel(page, "小组"); await groups.locator(".ink-group-workspace").getByRole("button", { name: title, exact: true }).first().click();
  await closePanel(page);
}
async function workspace(page, userId, groupId) {
  const response = await api(page, `/api/group-workspace?groupId=${encodeURIComponent(groupId)}`, userId);
  assert.equal(response.status, 200); assert.match(response.cache, /no-store/); return GroupWorkspaceResponseSchema.parse(response.body);
}
async function personalWorkspace(page, userId) {
  const response = await api(page, "/api/workspace", userId); assert.equal(response.status, 200); return CloudWorkspaceResponseSchema.parse(response.body);
}
const heading = page => page.locator(`[data-ink-node="${NODE}"]`).getByRole("heading");
async function nodeForm(page) {
  await heading(page).click({ button: "right" }); await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑节点", exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function startResearch(page, node = false) {
  const target = node ? heading(page) : page.locator(".react-flow__pane").first();
  if (node) await target.click({ button: "right" });
  else {
    const box = await target.boundingBox(); assert(box);
    await page.mouse.click(box.x + box.width - 35, box.y + box.height - 70, { button: "right" });
  }
  await page.getByRole("menuitem", { name: node ? "重新搜索此节点" : "重新搜索全图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重搜预览", exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}
async function liveRecord(page, userId, groupId, graphId) {
  const current = await workspace(page, userId, groupId); const record = current.graphs.find(row => row.document.id === graphId); assert(record); return record;
}

export async function checkGroupCollaboration() {
  let stage = "CONFIG", database, server, browser, directory, sync;
  const contexts = [], users = [], errors = [], requests = [], syntheticEmails = [], proofs = new Map();
  const providers = fakeProviders();
  let succeeded = false, cleanupFailed = false;
  try {
    assert(!process.env.DEBUG && !process.env.PWDEBUG);
    const raw = process.env.WF_TEST_MYSQL_URL; assert(raw);
    const config = databaseConfigFromUrl(raw);
    assert(["127.0.0.1", "localhost", "::1"].includes(config.host) && /^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database));
    database = new AccountDatabase(config); const db = database;
    const port = await availablePort(), origin = `http://127.0.0.1:${port}`, runId = randomUUID();
    const secret = randomBytes(32).toString("base64url"), messages = new Map();
    directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-group-browser-"));
    const assets = fileURLToPath(new URL("../dist", import.meta.url)); await fs.access(path.join(assets, "index.html"));
    let deliveryFailure = false;
    const auth = createAccountAuth({ database: db, origin, secret, mailer: { sendOTP: async message => {
      assert(syntheticEmails.includes(message.email) && message.purpose === "verify"); messages.set(message.email, message.otp);
    } }, onDeliveryFailure: () => { deliveryFailure = true; } });
    stage = "AUTH_MIGRATION";
    await auth.migrate(operation()); await migrateAccountData(db, operation()); await migrateGroupData(db, operation()); await auth.initialize(operation());
    const groups = createGroupStorage(db), personal = createWorkspaceStorage(db), profile = createAccountProfileStorage(db);
    sync = createGroupSync({ auth, readSnapshot: (userId, groupId, op) => readGroupSyncSnapshot(db, userId, groupId, op) });
    const search = createGroupSearch({ database: db, auth, sync, secret, publicOrigin: origin });
    const shared = createGroupWorkspaceStorage(db, { search });
    const keys = createAccountKeyStorage(db, randomBytes(32).toString("base64")); assert(keys);
    const serverConfig = parseServerConfig({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash", LLM_API_KEY: "fixture-browser-llm",
      SERPAPI_API_KEY: "fixture-browser-search", EXPERIENCE_CONFIG_PATH: path.join(directory, "private", "experience.json"),
      PUBLIC_ORIGIN: origin, RUN_LOGGING: "false", SEARCH_CONCURRENCY: "1", LLM_CONCURRENCY: "1" });
    server = await buildProductionServer({ config: serverConfig, repositoryRoot: directory, webAssetsDirectory: assets,
      accounts: { auth, database: { close: async () => {} }, workspace: personal, keys, profile, groups, groupWorkspace: shared, groupSync: sync, groupSearch: search },
      providerFactory: providers.factory });
    assert.equal(await server.listen({ host: "127.0.0.1", port }), origin);
    stage = "REGISTER_VERIFY";
    for (const [index, role] of ["owner", "member", "outsider"].entries()) {
      const email = `wf-browser-${runId}-${role}@example.invalid`, password = randomBytes(24).toString("base64url");
      syntheticEmails.push(email);
      const headers = new globalThis.Headers({ origin, "content-type": "application/json", "x-wayfinder-client-ip": `192.0.2.${index + 1}` });
      await auth.handle({ action: "register", email, password }, headers, operation());
      const rows = await db.query(operation(), "SELECT id,email FROM `user` WHERE email = ?", [email]); assert.equal(rows.length, 1);
      users.push({ userId: rows[0].id, email, password });
      const otp = messages.get(email); assert.match(otp ?? "", /^[0-9]{6}$/);
      await auth.handle({ action: "verify", email, otp }, headers, operation()); messages.delete(email); assert.equal(deliveryFailure, false);
    }
    const launchEnv = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "DISPLAY", "XDG_RUNTIME_DIR", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    browser = await chromium.launch({ headless: true, env: launchEnv });
    let lastLogin = 0;
    const open = async user => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" }); contexts.push(context);
      await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
      await context.addInitScript(userId => {
        const preferences = JSON.stringify({ deepseek: { source: "own", apiKey: "fixture-browser-llm" }, serpapi: { source: "own", apiKey: "fixture-browser-search" } });
        globalThis.localStorage.setItem("wayfinder.credentials.v1", preferences);
        globalThis.localStorage.setItem(`wayfinder.credentials.v1.user.${userId}`, preferences);
      }, user.userId);
      const page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
      page.on("pageerror", () => errors.push("PAGE_ERROR"));
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/group-workspace") {
          const parsed = GroupGraphActionSchema.safeParse(request.postDataJSON()); if (parsed.success) requests.push(parsed.data);
          const headers = request.headers();
          if (headers[CLOUD_ACCOUNT_HEADER] && headers[GROUP_CONNECTION_HEADER]) proofs.set(headers[CLOUD_ACCOUNT_HEADER], headers[GROUP_CONNECTION_HEADER]);
        }
      });
      await page.goto(origin); await product(page);
      const settings = await panel(page, "设置"), form = settings.getByRole("form", { name: "邮箱账号" });
      await form.getByLabel("邮箱", { exact: true }).fill(user.email); await form.getByLabel("密码", { exact: true }).fill(user.password);
      // 固定版本认证库按同一IP／登录端点限速；等待真实期限，不重试被拒绝的登录。
      await delay(Math.max(0, lastLogin + 10_200 - Date.now()));
      const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/account" && response.request().method() === "POST"),
        form.getByRole("button", { name: "登录", exact: true }).click()]); lastLogin = Date.now();
      assert.equal(response.status(), 200); await expect(settings).toBeHidden();
      const cookie = (await context.cookies(origin)).filter(value => value.name.endsWith("session_token"));
      assert.equal(cookie.length, 1); assert(cookie[0].secure && cookie[0].httpOnly && cookie[0].sameSite === "Strict");
      const identity = AccountResponseSchema.parse((await api(page, "/api/account", user.userId)).body); assert.equal(identity.account?.userId, user.userId);
      // 账号切换按既有产品流程返回首页；重新进入探索后才有底部四入口。
      await product(page);
      return page;
    };
    stage = "SECURE_COOKIE_PREFLIGHT";
    const a = await open(users[0]); console.info("GROUP_BROWSER_COOKIE_OK");
    stage = "THREE_REAL_SESSIONS";
    const b = await open(users[1]), outsider = await open(users[2]);
    console.info("GROUP_BROWSER_THREE_SESSIONS_OK");
    stage = "NICKNAME_CREATE_JOIN";
    for (const [page, nickname] of [[a, "共同昵称"], [b, "共同昵称"], [outsider, "外部同学"]]) {
      stage = page === a ? "NICKNAME_OWNER" : page === b ? "NICKNAME_MEMBER" : "NICKNAME_OUTSIDER";
      const group = await panel(page, "小组"); await group.getByRole("textbox", { name: "账号昵称", exact: true }).fill(nickname);
      await group.getByRole("button", { name: "保存昵称", exact: true }).click();
      await expect.poll(async () => (await profile.read(page === a ? users[0].userId : page === b ? users[1].userId : users[2].userId, operation())).nickname).toBe(nickname);
    }
    stage = "CREATE_GROUP";
    let group = await panel(a, "小组"); await group.getByRole("button", { name: "创建小组", exact: true }).first().click();
    await group.getByRole("textbox", { name: "小组名称", exact: true }).fill(GROUP_NAME);
    await group.getByRole("textbox", { name: "小组说明", exact: true }).fill("真实浏览器协作检查");
    await group.getByRole("button", { name: "创建小组", exact: true }).last().click();
    await expect(group.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
    const groupId = await group.locator(".ink-group-workspace").getAttribute("data-group-id"); assert(groupId);
    const invitation = await group.getByRole("textbox", { name: "邀请码", exact: true }).inputValue();
    assert(invitation.startsWith(`${users[0].email}#`) && /^[A-Za-z0-9]{20}$/.test(invitation.slice(-20)));
    stage = "JOIN_GROUP";
    group = await panel(b, "小组"); await group.getByRole("button", { name: "加入小组", exact: true }).first().click();
    await group.locator('input[aria-label="邀请码"]:not([readonly])').fill(invitation); await group.getByRole("button", { name: "加入小组", exact: true }).last().click();
    await expect(group.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
    assert.equal(await group.getByRole("button", { name: "编辑小组", exact: true }).count(), 0);
    assert.equal(await group.getByRole("button", { name: "解散小组", exact: true }).count(), 0);
    await expect(group.getByRole("button", { name: "退出小组", exact: true })).toBeEnabled();
    const ownerDetails = GroupDetailsSchema.parse((await api(a, `/api/groups?groupId=${groupId}`, users[0].userId)).body);
    assert.equal(ownerDetails.members.length, 2); assert.equal(ownerDetails.members[0].nickname, ownerDetails.members[1].nickname);
    assert(!JSON.stringify(ownerDetails.members).includes("@"));
    group = await panel(a, "小组"); await group.getByRole("button", { name: "编辑小组", exact: true }).click();
    await group.getByRole("textbox", { name: "小组说明", exact: true }).fill("创建者更新后的组说明");
    await group.getByRole("button", { name: "保存", exact: true }).click();
    await expect(group.getByRole("textbox", { name: "小组说明", exact: true })).toHaveCount(0);
    await expect(groupPanel(b).locator(".ink-group-selected")).toContainText("创建者更新后的组说明");
    console.info("GROUP_BROWSER_CREATE_JOIN_OK");
    stage = "OUTSIDE_DENIED";
    for (const endpoint of [`/api/groups?groupId=${groupId}`, `/api/group-workspace?groupId=${groupId}`, `/api/group-sync?groupId=${groupId}`]) {
      const denied = await api(outsider, endpoint, users[2].userId); assert.equal(denied.status, 403); assert.equal(GroupErrorResponseSchema.parse(denied.body).code, "GROUP_FORBIDDEN");
    }
    const spoofed = await api(outsider, "/api/group-workspace", users[0].userId,
      { action: "delete", groupId, graphId: "not-known", expectedRevision: 1, mutationId: randomUUID() }, "not-a-live-proof");
    assert.equal(spoofed.status, 401);
    const beforeOutside = await workspace(a, users[0].userId, groupId);
    const correctOutside = await api(outsider, "/api/group-workspace", users[2].userId,
      { action: "delete", groupId, graphId: "not-known", expectedRevision: 1, mutationId: randomUUID() }, "not-a-live-proof");
    assert.notEqual(correctOutside.status, 200); GroupErrorResponseSchema.parse(correctOutside.body);
    assert.deepEqual(await workspace(a, users[0].userId, groupId), beforeOutside);

    stage = "GROUP_SEARCH_UI";
    group = await panel(a, "小组"); await group.getByRole("button", { name: "小组新搜索", exact: true }).click();
    await expect(a.getByRole("searchbox")).toBeVisible(); await a.getByRole("searchbox").fill(QUERY);
    await a.locator(".ink-study__search-submit").click(); await expect(heading(a)).toHaveText(QUERY);
    let current = await workspace(a, users[0].userId, groupId); const graphId = current.activeOrder[0]; assert(graphId);
    await expect.poll(async () => (await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0]?.resources.length).toBe(1);
    const firstResult = await liveRecord(a, users[0].userId, groupId, graphId);
    await selectGraph(b, QUERY); await expect(heading(b)).toHaveText(QUERY);
    console.info("GROUP_BROWSER_SEARCH_UI_OK");
    assert.equal((await personalWorkspace(a, users[0].userId)).graphs.length, 0);
    assert.equal((await personalWorkspace(b, users[1].userId)).graphs.length, 0);

    stage = "TWO_DOM_MERGE";
    const formA = await nodeForm(a), formB = await nodeForm(b);
    await formA.getByRole("textbox", { name: "节点标题", exact: true }).fill("甲的节点标题");
    await formB.getByRole("textbox", { name: "节点说明", exact: true }).fill("乙的独立说明");
    await formA.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(formA).toBeHidden();
    await formB.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(formB).toBeHidden();
    await expect(heading(a)).toHaveText("甲的节点标题"); await expect(heading(b)).toHaveText("甲的节点标题");
    assert.equal((await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].description, "乙的独立说明");
    const groupMetadata = GroupDetailsSchema.parse((await api(a, `/api/groups?groupId=${groupId}`, users[0].userId)).body);
    assert(proofs.get(users[1].userId));
    const forbiddenMetadata = await api(b, "/api/groups", users[1].userId, { action: "update", groupId,
      expectedRevision: groupMetadata.group.revision, name: "普通成员不可改名", description: "不可修改", mutationId: randomUUID() }, proofs.get(users[1].userId));
    assert.equal(forbiddenMetadata.status, 403); assert.equal(GroupErrorResponseSchema.parse(forbiddenMetadata.body).code, "GROUP_FORBIDDEN");
    assert.deepEqual(GroupDetailsSchema.parse((await api(a, `/api/groups?groupId=${groupId}`, users[0].userId)).body).group, groupMetadata.group);
    stage = "SAME_FIELD_CONFLICT";
    const conflictA = await nodeForm(a), conflictB = await nodeForm(b);
    await conflictA.getByRole("textbox", { name: "节点标题", exact: true }).fill("甲的先到修改");
    await conflictB.getByRole("textbox", { name: "节点标题", exact: true }).fill("乙保留的草稿");
    await conflictA.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(conflictA).toBeHidden();
    await conflictB.getByRole("button", { name: "保存节点", exact: true }).click();
    await expect(conflictB.getByRole("textbox", { name: "节点标题", exact: true })).toHaveValue("乙保留的草稿");
    assert.equal((await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].title, "甲的先到修改");
    await conflictB.getByRole("button", { name: "取消编辑", exact: true }).click();
    group = await panel(b, "小组"); b.once("dialog", dialog => dialog.accept());
    await group.getByRole("button", { name: "确认保留我的修改", exact: true }).click();
    await closePanel(b); await expect(heading(a)).toHaveText("乙保留的草稿"); await expect(heading(b)).toHaveText("乙保留的草稿");
    console.info("GROUP_BROWSER_MERGE_CONFLICT_OK");

    stage = "PERSONAL_UNDO_REDO";
    const beforeUndo = await liveRecord(a, users[0].userId, groupId, graphId);
    const undo = await panel(b, "撤销"); await expect(undo).toContainText(GROUP_NAME);
    await undo.getByRole("button", { name: /^撤销：编辑节点/ }).first().click();
    await expect.poll(async () => (await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].title).toBe("甲的先到修改");
    await undo.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].title).toBe(beforeUndo.document.nodes[0].title);
    await closePanel(b);

    stage = "NODE_SEARCH_APPEND";
    const preview = await startResearch(a, true); await expect(a.locator("[data-research-status]")).toHaveAttribute("data-research-status", "ready");
    await preview.getByRole("button", { name: "追加到此节点", exact: true }).click(); await expect(preview).toBeHidden();
    await expect.poll(async () => (await liveRecord(b, users[1].userId, groupId, graphId)).document.nodes[0].resources.length).toBe(2);
    stage = "GRAPH_PREVIEW_APPLY";
    const fullPreview = await startResearch(a); await expect(a.locator("[data-research-status]")).toHaveAttribute("data-research-status", "ready");
    const beforeApply = await liveRecord(b, users[1].userId, groupId, graphId); assert.equal(beforeApply.document.nodes[0].resources.length, 2);
    const previewBaseline = await nodeForm(b);
    await previewBaseline.getByRole("textbox", { name: "节点说明", exact: true }).fill("预览期间由乙更新");
    await previewBaseline.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(previewBaseline).toBeHidden();
    await fullPreview.getByRole("button", { name: "应用替换", exact: true }).click();
    await expect(a.getByText("内容已变化，已保留你的修改，请核对后再确认。", { exact: true }).first()).toBeVisible();
    await expect(fullPreview).toBeVisible();
    assert.equal((await liveRecord(b, users[1].userId, groupId, graphId)).document.nodes[0].description, "预览期间由乙更新");
    a.once("dialog", dialog => dialog.accept()); await fullPreview.getByRole("button", { name: "应用替换", exact: true }).click(); await expect(fullPreview).toBeHidden();
    await expect.poll(async () => (await liveRecord(b, users[1].userId, groupId, graphId)).document.nodes[0].resources.length).toBe(1);
    stage = "SEARCH_CANCEL_FAILURE";
    const held = providers.hold(), cancelPreview = await startResearch(a); await bounded(held.reached.promise);
    await cancelPreview.getByRole("button", { name: "取消重搜", exact: true }).click(); providers.release();
    await expect(cancelPreview).toBeHidden();
    const stable = await liveRecord(a, users[0].userId, groupId, graphId); providers.fail();
    const failed = await startResearch(a); await expect(a.locator("[data-research-status]")).toHaveAttribute("data-research-status", "failed");
    await failed.getByRole("button", { name: "弃用新结果", exact: true }).click(); await expect(failed).toBeHidden();
    assert.deepEqual((await liveRecord(a, users[0].userId, groupId, graphId)).document, stable.document);
    console.info("GROUP_BROWSER_PREVIEW_CANCEL_FAILURE_OK");

    stage = "OFFLINE_CATCHUP";
    const offlineForm = await nodeForm(a); await offlineForm.getByRole("textbox", { name: "节点标题", exact: true }).fill("断网期间保留的草稿");
    const beforeOffline = requests.length;
    await a.context().setOffline(true); await expect(offlineForm.locator("[data-workspace-save]")).toBeDisabled();
    const reconnectReached = gate(), reconnectRelease = gate(); let holdReconnect = true;
    await a.context().route("**/api/group-sync?*", async route => {
      if (holdReconnect) { holdReconnect = false; reconnectReached.release(); await reconnectRelease.promise; }
      try { await route.continue(); } catch { /* 关闭测试上下文取消未发出的请求。 */ }
    });
    await a.context().setOffline(false); await bounded(reconnectReached.promise);
    await expect(offlineForm.locator("[data-workspace-save]")).toBeDisabled();
    await expect(offlineForm.getByRole("textbox", { name: "节点标题", exact: true })).toHaveValue("断网期间保留的草稿");
    assert.equal(requests.length, beforeOffline);
    reconnectRelease.release(); await expect(offlineForm.locator("[data-workspace-save]")).toBeEnabled();
    await offlineForm.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(offlineForm).toBeHidden();
    await expect(heading(b)).toHaveText("断网期间保留的草稿");

    stage = "COPYOUT_LOST_ACK";
    let dropped = false, receiptDropped = false, originalMutation;
    await a.context().route("**/api/group-workspace", async route => {
      const action = GroupGraphActionSchema.safeParse(route.request().postDataJSON());
      if (!dropped && action.success && action.data.action === "copyOut") {
        dropped = true; originalMutation = action.data.mutationId;
        const response = await route.fetch(); assert.equal(response.status(), 200); GroupGraphWriteResponseSchema.parse(await response.json()); await route.abort("failed");
      } else await route.fallback();
    });
    await a.context().route("**/api/group-receipt?*", async route => {
      if (dropped && !receiptDropped) { receiptDropped = true; await route.abort("failed"); } else await route.fallback();
    });
    group = await panel(a, "小组"); const beforeCopy = requests.filter(action => action.action === "copyOut").length;
    await group.getByRole("button", { name: "复制到个人", exact: true }).first().click();
    await expect(group.getByRole("button", { name: "核对上次结果", exact: true })).toBeVisible();
    await group.getByRole("button", { name: "返回个人图", exact: true }).click();
    await openGroup(a); group = groupPanel(a);
    await group.getByRole("button", { name: "核对上次结果", exact: true }).click();
    await expect(group.getByRole("button", { name: "核对上次结果", exact: true })).toHaveCount(0);
    assert.equal(requests.filter(action => action.action === "copyOut").length, beforeCopy + 1);
    const ownReceipt = GroupGraphReceiptResponseSchema.parse((await api(a, `/api/group-receipt?mutationId=${originalMutation}`, users[0].userId)).body);
    assert(ownReceipt.applied && ownReceipt.personalGraphId);
    const privateCopy = (await personalWorkspace(a, users[0].userId)).graphs.find(row => row.document.id === ownReceipt.personalGraphId); assert(privateCopy);
    const source = await liveRecord(a, users[0].userId, groupId, graphId);
    assert.notEqual(privateCopy.document.id, graphId); assert.equal(privateCopy.history.events.length, 0);
    assert.deepEqual(privateCopy.document.positions, source.document.positions); assert.deepEqual(privateCopy.document.nodes, source.document.nodes);
    assert(source.history.events.length > 0); assert.equal((await personalWorkspace(b, users[1].userId)).graphs.length, 0);
    const crossPrivate = await api(b, "/api/workspace", users[0].userId); assert.equal(crossPrivate.status, 401);

    stage = "COPYIN_MULTIGRAPH";
    await group.getByRole("combobox", { name: "选择个人图", exact: true }).selectOption(privateCopy.document.id);
    await group.getByRole("button", { name: "复制个人图到小组", exact: true }).click();
    await expect.poll(async () => (await workspace(a, users[0].userId, groupId)).activeOrder.length).toBe(2);
    current = await workspace(a, users[0].userId, groupId); const copiedIn = current.graphs.find(row => row.document.id !== graphId); assert(copiedIn);
    assert.equal(copiedIn.history.events.length, 0); assert.notEqual(copiedIn.document.id, privateCopy.document.id);
    assert.deepEqual(copiedIn.document.nodes, privateCopy.document.nodes); assert.deepEqual(copiedIn.document.positions, privateCopy.document.positions);
    assert.deepEqual((await liveRecord(a, users[0].userId, groupId, graphId)).history, source.history);

    stage = "LEAVE_CONTRIBUTION";
    await selectGraph(b, QUERY);
    const contribution = await nodeForm(b);
    await contribution.getByRole("textbox", { name: "节点说明", exact: true }).fill("退出前乙已生效的独立贡献");
    await contribution.getByRole("button", { name: "保存节点", exact: true }).click(); await expect(contribution).toBeHidden();
    await expect.poll(async () => (await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].description).toBe("退出前乙已生效的独立贡献");
    await openGroup(b); group = groupPanel(b); await group.getByRole("button", { name: "退出小组", exact: true }).click();
    await expect(group.locator(".ink-group-workspace")).toHaveCount(0);
    assert.equal((await api(b, `/api/group-workspace?groupId=${groupId}`, users[1].userId)).status, 403);
    assert.equal((await liveRecord(a, users[0].userId, groupId, graphId)).document.nodes[0].description, "退出前乙已生效的独立贡献");
    group = await panel(b, "小组"); await group.getByRole("button", { name: "加入小组", exact: true }).first().click();
    await group.locator('input[aria-label="邀请码"]:not([readonly])').fill(invitation); await group.getByRole("button", { name: "加入小组", exact: true }).last().click();
    await expect(group.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
    stage = "DISSOLVE_BOTH_CLIENTS";
    group = await panel(a, "小组"); a.once("dialog", dialog => dialog.accept()); await group.getByRole("button", { name: "解散小组", exact: true }).click();
    await expect(group.locator(".ink-group-workspace")).toHaveCount(0);
    await expect(groupPanel(b).locator(".ink-group-workspace [data-group-connection]")).not.toHaveAttribute("data-group-connection", "online");
    await expect(heading(b)).toHaveCount(0);
    assert.equal((await api(b, `/api/group-workspace?groupId=${groupId}`, users[1].userId)).status, 404);
    assert.equal((await api(a, `/api/group-workspace?groupId=${groupId}`, users[0].userId)).status, 404);
    assert.equal((await personalWorkspace(a, users[0].userId)).graphs.length, 1);
    assert.equal((await personalWorkspace(b, users[1].userId)).graphs.length, 0);
    assert.equal((await personalWorkspace(outsider, users[2].userId)).graphs.length, 0);
    assert.equal(firstResult.document.nodes[0].resources.length, 1); assert(providers.calls.search >= 3);
    assert.deepEqual(errors, []); succeeded = true;
  } catch (failure) {
    // 只给阶段和脚本行号定位；Playwright原错误可能含表单值，禁止整段输出。
    const line = failure instanceof Error ? failure.stack?.match(/group-collaboration-check\.mjs:(\d+):\d+/)?.[1] ?? "0" : "0";
    console.error(`GROUP_BROWSER_FAILED_${stage}_L${line}`); process.exitCode = 1;
    // 只拍本轮全假账号页面，供本机定位交互；不保存网络／Cookie／控制台或真实配置。
    for (const [index, context] of contexts.entries()) {
      try { await bounded(context.pages()[0]?.screenshot({ path: fileURLToPath(new URL(`../../../scratch/d12/browser-failure-${index}.png`, import.meta.url)) }), 5_000); }
      catch { /* 截图不能阻断资源与假数据清理。 */ }
    }
  } finally {
    const close = async action => { try { await bounded(Promise.resolve().then(action), 15_000); } catch { cleanupFailed = true; process.exitCode = 1; } };
    providers.release();
    for (const context of contexts) await close(() => context.close());
    if (browser !== undefined) await close(() => browser.close());
    if (sync !== undefined) await close(() => sync.close());
    if (server !== undefined) { await close(() => server.close()); server.server.closeAllConnections(); }
    if (database !== undefined) {
      try {
        await database.transaction(operation(), async query => {
          // 即使注册确认中途丢失，也只以本轮完整UUID邮箱定位；其他账号不在清理集合。
          for (const email of syntheticEmails) {
            await query("DELETE FROM verification WHERE identifier = ? OR identifier = ?", [`email-verification-otp-${email}`, `forget-password-otp-${email}`]);
            const rows = await query("SELECT id,email FROM `user` WHERE email = ? FOR UPDATE", [email]);
            if (rows.length === 0) continue; assert.equal(rows.length, 1); assert.equal(rows[0].email, email);
            const user = users.find(user => user.email === email); if (user !== undefined) assert.equal(rows[0].id, user.userId);
            const userId = rows[0].id;
            await query("DELETE FROM wf_groups WHERE ownerUserId = ?", [userId]);
            await query("DELETE FROM wf_group_members WHERE userId = ?", [userId]);
            await query("DELETE FROM wf_user_data WHERE userId = ?", [userId]);
            await query("DELETE FROM `session` WHERE userId = ?", [userId]);
            await query("DELETE FROM `account` WHERE userId = ?", [userId]);
            await query("DELETE FROM `user` WHERE id = ? AND email = ?", [userId, email]);
          }
        });
        for (const email of syntheticEmails) {
          assert.deepEqual(await database.query(operation(), "SELECT id FROM `user` WHERE email = ?", [email]), []);
          assert.deepEqual(await database.query(operation(), "SELECT identifier FROM verification WHERE identifier LIKE ?", [`%${email}`]), []);
        }
        for (const user of users) {
          for (const table of ["wf_user_data", "session", "account", "wf_group_members"]) {
            assert.deepEqual(await database.query(operation(), `SELECT userId FROM \`${table}\` WHERE userId = ?`, [user.userId]), []);
          }
          assert.deepEqual(await database.query(operation(), "SELECT groupId FROM wf_groups WHERE ownerUserId = ?", [user.userId]), []);
        }
        if (!cleanupFailed) console.info("GROUP_BROWSER_CLEANUP_OK");
      } catch { cleanupFailed = true; console.error("GROUP_BROWSER_CLEANUP_FAILED"); process.exitCode = 1; }
      await close(() => database.close());
    }
    if (directory !== undefined) await close(() => fs.rm(directory, { recursive: true, force: true }));
    if (cleanupFailed) console.error("GROUP_BROWSER_RESOURCE_OR_DATA_CLEANUP_FAILED");
    if (succeeded && !cleanupFailed) console.info("GROUP_BROWSER_OK: 真实三会话／双DOM协作与冲突／本人撤销重做／假搜索预览／断网追平／原ID丢确认／双向复制／退出贡献／解散无备份");
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await checkGroupCollaboration();
