/**
 * 跨层回归：真实浏览器设置、生产授权路由与搜索 Pipeline（流水线）共用同一条请求链。
 * 账号服务使用内存假实现（真实认证库/MySQL另有显式集成验证），付费边界替换 LLM 输出和 SerpAPI Fetch；Cookie 由 Chromium 接收和发送，
 * 不注入资格、不改浏览器 fetch，也不监听额外端口。全部凭据及配置都是本测试生成的假数据。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { EditableGraphSchema, StreamEventSchema, type EditableGraph } from "@wayfinder/contracts";

import { GraphOutlineSchema } from "../../server/src/ai/graph-outline.js";
import { SearchPlanBundleSchema } from "../../server/src/ai/search-plan-generator.js";
import { parseServerConfig } from "../../server/src/config.js";
import { buildProductionServer } from "../../server/src/production-server.js";
import { SerpApiBingSearchProvider } from "../../server/src/search/providers/serpapi-bing.js";
import { updateExperienceConfig } from "../../server/src/settings/experience-config.js";
import { EXPERIENCE_COOKIE_NAME } from "../../server/src/settings/experience-authorization.js";
import { AccountAccessError, type AccountAuth } from "../../server/src/accounts/auth.js";

const ORIGIN = "http://127.0.0.1:4174";
const QUERY = "TypeScript compiler guide";
const BROAD_QUERY = "TypeScript compiler ecosystem";
const INVITE_A = "fake-browser-production-invite-a";
const INVITE_B = "fake-browser-production-invite-b";
const AUTHOR_KEYS = { llmApiKey: "fake-browser-author-llm", serpApiKey: "fake-browser-author-search" };
const OWN_KEYS = { llmApiKey: "fake-browser-own-llm", serpApiKey: "fake-browser-own-search" };
const ACCOUNT = { userId: "fixture-browser-user", email: "fixture-browser@example.test", password: "fixture-browser-password" };
const ACCOUNT_COOKIE = "__Host-wayfinder_fixture_session";
const SCREENSHOT_DIRECTORY = fileURLToPath(new URL("../../../scratch/d11/", import.meta.url));
const SECRETS = [...Object.values(AUTHOR_KEYS), ...Object.values(OWN_KEYS), INVITE_A, INVITE_B, ACCOUNT.password];

// 采用服务器凭据集成测试的最小合法产物；Planner、Reviser、SearchPlan、Rerank 均走正式校验。
const OUTLINE = GraphOutlineSchema.parse({
  analysis: { intent: "learn", topic: QUERY, freshnessSensitive: false, ambiguityLevel: "medium",
    broadSearchQueries: [BROAD_QUERY], strategy: "evidence_assisted", presentationMode: "compact" },
  nodes: [{ id: "compiler-guide", title: QUERY, description: "Learn TypeScript compiler options", nodeType: "primary", layer: 0, status: "planned" }],
  edges: [],
});
const BUNDLE = SearchPlanBundleSchema.parse({ plans: [{ nodeId: "compiler-guide", queries: [QUERY], rankingProfile: "knowledge" }] });
const RANKING = { ranking: [{ candidateId: "candidate_1",
  scores: { relevance: 0.95, authority: 0.95, clarity: 0.95, completeness: 0.95, trustSafety: 0.95, freshness: 0.95 },
  summary: "TypeScript 编译器选项说明。", whySelected: "该文档直接解释当前节点主题。",
}] };
type Stage = "planner" | "reviser" | "searchPlan" | "rerank";
type Keys = typeof OWN_KEYS;
type Exchange = Readonly<{ path: string; status: number; body: string; sentCookie: boolean }>;

/** 组合根可在相同受保护配置下重建；代理始终指向当前实例，浏览器存储不参与重建。 */
async function productionFixture(page: Page) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "wayfinder-browser-production-"));
  const webAssetsDirectory = path.join(directory, "web");
  const configPath = path.join(directory, "private", "experience.json");
  await fs.mkdir(path.join(webAssetsDirectory, "assets"), { recursive: true });
  await fs.writeFile(path.join(webAssetsDirectory, "index.html"), '<div id="root"></div>');
  await updateExperienceConfig(configPath, { announcement: "跨层测试作者公告", inviteCode: INVITE_A });
  const config = parseServerConfig({
    LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash", LLM_API_KEY: AUTHOR_KEYS.llmApiKey,
    SERPAPI_API_KEY: AUTHOR_KEYS.serpApiKey, EXPERIENCE_CONFIG_PATH: configPath, PUBLIC_ORIGIN: ORIGIN,
  });
  const calls = { factories: [] as Keys[], llm: [] as { key: string; stage: Stage; prompt: string }[], search: [] as { key: string | null; query: string }[] };
  const exchanges: Exchange[] = [];
  // 测试会话也只能由登录动作签发，浏览器自然保存HttpOnly Cookie；不直接注入登录或邀请码资格。
  const sessions = new Map<string, { userId: string; sessionId: string; email: string }>();
  const tokenFrom = (headers: Headers): string => (headers.get("cookie") ?? "").split(";")
    .map(part => part.trim()).find(part => part.startsWith(`${ACCOUNT_COOKIE}=`))?.slice(ACCOUNT_COOKIE.length + 1) ?? "";
  const auth: AccountAuth = {
    initialize: async () => {}, migrate: async () => {},
    getIdentity: async headers => sessions.get(tokenFrom(headers)) ?? null,
    handle: async (input, headers) => {
      if (input.action === "login") {
        if (input.email !== ACCOUNT.email || input.password !== ACCOUNT.password) throw new AccountAccessError("ACCOUNT_INVALID");
        sessions.delete(tokenFrom(headers));
        const token = randomUUID();
        sessions.set(token, { userId: ACCOUNT.userId, sessionId: randomUUID(), email: ACCOUNT.email });
        return { body: { account: { userId: ACCOUNT.userId, email: ACCOUNT.email } },
          cookies: [`${ACCOUNT_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`] };
      }
      if (input.action !== "logout") throw new AccountAccessError("ACCOUNT_INVALID");
      sessions.delete(tokenFrom(headers));
      return { body: { accepted: true }, cookies: [`${ACCOUNT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`] };
    },
  };
  const createServer = () => buildProductionServer({
    config, repositoryRoot: directory, webAssetsDirectory,
    accounts: { auth, database: { close: async () => {} } },
    providerFactory: (keys, beforeAttempt) => {
      calls.factories.push({ ...keys });
      let outlines = 0;
      return {
        searchProvider: new SerpApiBingSearchProvider({ apiKey: keys.serpApiKey, searchTimeoutMs: 1_000, beforeAttempt,
          fetchImplementation: async input => {
            const url = new URL(String(input));
            const query = url.searchParams.get("q") ?? "";
            calls.search.push({ key: url.searchParams.get("api_key"), query });
            return new Response(JSON.stringify({ search_metadata: { status: "Success" }, organic_results: [{
              position: 1, title: QUERY, link: `https://docs.example.com/${query === BROAD_QUERY ? "ecosystem" : "compiler"}`,
              snippet: "Learn TypeScript compiler options with practical examples.",
            }] }), { headers: { "content-type": "application/json" } });
          } }),
        llmProvider: { id: "fake-browser-production-llm", structured: async (input, options) => {
          options.signal.throwIfAborted();
          const stage: Stage = input.schemaName === "graph_outline" ? outlines++ === 0 ? "planner" : "reviser"
            : input.schemaName === "search_plan_bundle" ? "searchPlan" : input.schemaName === "resource_rerank" ? "rerank"
              : (() => { throw new Error("假模型收到了未知输出协议"); })();
          calls.llm.push({ key: keys.llmApiKey, stage, prompt: `${input.system}\n${input.user}` });
          return input.schemaName === "graph_outline" ? OUTLINE : input.schemaName === "search_plan_bundle" ? BUNDLE : RANKING;
        } },
      };
    },
  });
  let server = await createServer().catch(async (error: unknown) => {
    await fs.rm(directory, { recursive: true, force: true }); throw error;
  });
  // 只截获根 /api/：Vite 的 /src/api/*.ts 是真实浏览器模块，必须继续由开发服务器提供。
  await page.route(url => url.origin === ORIGIN && url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["/api/account", "/api/account/keys", "/api/workspace", "/api/settings", "/api/experience", "/api/experience/status", "/api/search"].includes(url.pathname)) {
      throw new Error("跨层夹具收到未声明的 API 路径");
    }
    const method = request.method();
    if (method !== "GET" && method !== "POST") throw new Error("跨层夹具收到未声明的 HTTP 方法");
    // Playwright 不暴露网络栈生成的 Host；等价补齐当前请求 URL 的 authority（主机与端口），不伪造 Origin。
    const headers: Record<string, string> = { ...await request.allHeaders(), host: url.host };
    const response = await server.inject({ method, url: `${url.pathname}${url.search}`, headers,
      ...(request.postData() === null ? {} : { payload: request.postData() ?? "" }) });
    exchanges.push({ path: url.pathname, status: response.statusCode, body: response.body, sentCookie: (headers.cookie ?? "").includes(`${EXPERIENCE_COOKIE_NAME}=`) });
    // 不替换 Cookie、不修改安全属性：由真实浏览器处理生产 Set-Cookie，再自然携带后续请求。
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join("\n") : String(value);
    }
    await route.fulfill({ status: response.statusCode, headers: responseHeaders, body: response.rawPayload });
  });
  return { calls, exchanges, configPath,
    restart: async () => { await server.close(); server = await createServer(); },
    close: async () => {
      try { if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" }); }
      finally { try { await server.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } }
    },
  };
}

/** 只移除无关的 GPU 流体成本；真实 UI、存储、凭据协调器和 HTTP 请求保持完整。 */
async function openProduct(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        return kind.includes("webgl") ? null : Reflect.apply(original, this, [kind, ...options]) as RenderingContext | null;
      } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
}
async function openSettings(page: Page): Promise<Locator> {
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("region", { name: "设置", exact: true });
  await expect(panel).toBeVisible(); return panel;
}
/** 通过真实界面提交登录，再等待身份边界重挂页面；不写会话或资格Cookie。 */
async function logIn(page: Page, touch = false): Promise<Locator> {
  const settings = async (): Promise<Locator> => {
    if (!touch) return openSettings(page);
    await page.getByRole("button", { name: "搜索历史", exact: true }).tap();
    await page.getByRole("button", { name: "设置", exact: true }).tap();
    return page.getByRole("region", { name: "设置", exact: true });
  };
  const panel = await settings();
  const form = panel.getByRole("form", { name: "邮箱账号", exact: true });
  await form.getByLabel("邮箱", { exact: true }).fill(ACCOUNT.email);
  await form.getByLabel("密码", { exact: true }).fill(ACCOUNT.password);
  await fs.mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIRECTORY, `way-137-login-${touch ? "mobile" : "desktop"}.png`) });
  const submit = form.getByRole("button", { name: "登录", exact: true });
  if (touch) await submit.tap(); else await submit.click();
  const explore = page.getByRole("button", { name: "开始探索", exact: true });
  await expect(explore).toBeVisible();
  if (touch) await explore.tap(); else await explore.click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
  const loggedIn = await settings();
  await expect(loggedIn.getByRole("region", { name: "账号", exact: true })).toContainText(ACCOUNT.email);
  return loggedIn;
}
async function selectTrial(panel: Locator, service: "DeepSeek" | "SerpAPI"): Promise<Locator> {
  const settingsResponse = panel.page().waitForResponse(response => new URL(response.url()).pathname === "/api/settings");
  await panel.getByRole("form", { name: `${service} 设置`, exact: true }).getByRole("button", { name: "体验 APIKEY", exact: true }).click();
  expect((await settingsResponse).status()).toBe(200);
  const trial = panel.getByRole("dialog", { name: "使用作者 APIKEY 体验", exact: true });
  await expect(trial).toBeVisible(); return trial;
}
async function configureOwn(panel: Locator, service: "DeepSeek" | "SerpAPI", key: string): Promise<void> {
  const form = panel.getByRole("form", { name: `${service} 设置`, exact: true });
  await form.getByRole("button", { name: "自己的 API Key", exact: true }).click();
  await form.getByLabel(`${service} API Key`, { exact: true }).fill(key);
  await form.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("已保存到本浏览器");
}
async function newSearch(page: Page): Promise<void> {
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("button", { name: "新建搜索图", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索任意主题", exact: true })).toBeFocused();
}
async function submitSearch(page: Page): Promise<void> {
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill(QUERY); await input.press("Enter");
}
async function readDocuments(page: Page): Promise<readonly EditableGraph[]> {
  const raw: unknown = await page.evaluate(async userId => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wayfinder-workspace", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readonly"), request = transaction.objectStore("workspace").get(`user:${userId}`);
      transaction.oncomplete = () => resolve(request.result ?? null); transaction.onerror = () => reject(transaction.error);
    }); } finally { database.close(); }
  }, ACCOUNT.userId);
  if (typeof raw !== "object" || raw === null || !("documents" in raw) || !Array.isArray(raw.documents)) return [];
  return raw.documents.map(document => EditableGraphSchema.parse(document));
}
async function assertCompleted(page: Page, exchanges: readonly Exchange[], expectedRuns: number): Promise<void> {
  await expect.poll(() => exchanges.filter(exchange => exchange.path === "/api/search").length).toBe(expectedRuns);
  const search = exchanges.filter(exchange => exchange.path === "/api/search").at(-1);
  expect(search?.status).toBe(200);
  const events = (search?.body ?? "").split("\n").filter(Boolean).map(line => StreamEventSchema.parse(JSON.parse(line) as unknown));
  const complete = events.find(event => event.type === "complete");
  expect(complete?.type === "complete" ? complete.data.finalStatus : null).toBe("complete");
  await expect(page.locator("[data-ink-node]")).toHaveCount(1);
  await expect.poll(async () => (await readDocuments(page)).length).toBe(expectedRuns);
  const text = `${search?.body ?? ""}\n${JSON.stringify(await readDocuments(page))}`;
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}
async function assertBrowserGrant(page: Page): Promise<string> {
  const cookies = await page.context().cookies(ORIGIN);
  const grant = cookies.find(cookie => cookie.name === EXPERIENCE_COOKIE_NAME);
  expect(grant).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/", domain: "127.0.0.1" });
  expect(grant?.expires).toBeGreaterThan(Date.now() / 1_000 + 300 * 24 * 60 * 60);
  expect(await page.evaluate(() => document.cookie)).not.toContain(EXPERIENCE_COOKIE_NAME);
  if (grant === undefined) throw new Error("生产授权未被浏览器保存");
  return grant.value;
}

test.describe("生产体验授权跨层", () => {
  test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  test("真实Cookie贯通混合搜索、公告更新、重启、改回旧码及自带Key隔离", async ({ page }) => {
    const fixture = await productionFixture(page);
    try {
      await openProduct(page);
      let panel = await logIn(page);
      await configureOwn(panel, "DeepSeek", OWN_KEYS.llmApiKey);
      let trial = await selectTrial(panel, "SerpAPI");
      await expect(trial.getByLabel("邀请码", { exact: true })).toBeEnabled();
      await expect(trial.locator(".ink-settings__announcement")).toContainText("跨层测试作者公告");
      await fs.mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
      await page.screenshot({ path: path.join(SCREENSHOT_DIRECTORY, "way-137-settings-desktop.png") });
      await trial.getByLabel("邀请码", { exact: true }).fill(INVITE_A);
      await trial.getByRole("button", { name: "确认使用", exact: true }).click();
      await expect(trial).toHaveCount(0);
      const originalGrant = await assertBrowserGrant(page);
      const preferences = await page.evaluate(id => localStorage.getItem(`wayfinder.credentials.v1.user.${id}`), ACCOUNT.userId);
      expect(JSON.parse(preferences ?? "null") as unknown).toEqual({
        deepseek: { source: "own", apiKey: OWN_KEYS.llmApiKey }, serpapi: { source: "author", apiKey: "" },
      });
      expect(preferences).not.toContain(INVITE_A); expect(preferences).not.toContain(originalGrant);
      await panel.getByRole("button", { name: "收起面板", exact: true }).click();
      await submitSearch(page); await assertCompleted(page, fixture.exchanges, 1);
      const mixed = { llmApiKey: OWN_KEYS.llmApiKey, serpApiKey: AUTHOR_KEYS.serpApiKey };
      expect(fixture.calls.factories).toEqual([mixed]);
      expect(fixture.calls.llm.map(call => call.stage)).toEqual(["planner", "reviser", "searchPlan", "rerank"]);
      expect(fixture.calls.llm.every(call => call.key === OWN_KEYS.llmApiKey)).toBe(true);
      expect(fixture.calls.search).toEqual([{ key: AUTHOR_KEYS.serpApiKey, query: BROAD_QUERY }, { key: AUTHOR_KEYS.serpApiKey, query: QUERY }]);
      expect(fixture.exchanges.find(exchange => exchange.path === "/api/search")?.sentCookie).toBe(true);

      // 公告只更新展示内容；同配置重建后仍由服务器校验浏览器原 Cookie，均无需重新输入邀请码。
      await updateExperienceConfig(fixture.configPath, { announcement: "公告已更新，资格继续有效" });
      await fixture.restart();
      await newSearch(page); panel = await openSettings(page); trial = await selectTrial(panel, "SerpAPI");
      await expect(trial.locator(".ink-settings__announcement")).toContainText("公告已更新，资格继续有效");
      await expect(trial.getByText("本浏览器已有有效体验资格，无需再次输入邀请码。", { exact: true })).toBeVisible();
      await expect(trial.getByLabel("邀请码", { exact: true })).toHaveCount(0);
      await trial.getByRole("button", { name: "确认使用", exact: true }).click();
      await expect(trial).toHaveCount(0);
      expect(await assertBrowserGrant(page)).toBe(originalGrant);
      await panel.getByRole("button", { name: "收起面板", exact: true }).click();
      await submitSearch(page); await assertCompleted(page, fixture.exchanges, 2);
      expect(fixture.calls.factories.at(-1)).toEqual(mixed);

      // A→B→A 不刷新页面：文本相同也不能复活旧代际；准备失败不得生成新图或调用付费边界。
      await newSearch(page);
      const documentsBeforeRevocation = await readDocuments(page), factoriesBeforeRevocation = fixture.calls.factories.length;
      await updateExperienceConfig(fixture.configPath, { inviteCode: INVITE_B });
      await updateExperienceConfig(fixture.configPath, { inviteCode: INVITE_A });
      await submitSearch(page);
      await expect(page.getByRole("alert")).toContainText("体验资格已失效");
      await expect(page.getByRole("searchbox", { name: "搜索任意主题", exact: true })).toHaveValue(QUERY);
      expect(await readDocuments(page)).toEqual(documentsBeforeRevocation);
      expect(fixture.calls.factories).toHaveLength(factoriesBeforeRevocation);
      expect(fixture.exchanges.filter(exchange => exchange.path === "/api/search")).toHaveLength(2);
      expect(await assertBrowserGrant(page)).toBe(originalGrant);
      await page.getByRole("button", { name: "打开设置", exact: true }).click(); panel = page.getByRole("region", { name: "设置", exact: true });
      trial = await selectTrial(panel, "SerpAPI");
      await expect(trial.getByLabel("邀请码", { exact: true })).toBeEnabled();
      await trial.getByLabel("邀请码", { exact: true }).fill(INVITE_A);
      await trial.getByRole("button", { name: "确认使用", exact: true }).click();
      await expect(trial).toHaveCount(0);
      expect(await assertBrowserGrant(page)).not.toBe(originalGrant);
      await panel.getByRole("button", { name: "收起面板", exact: true }).click();
      expect(fixture.exchanges.filter(exchange => exchange.path === "/api/search")).toHaveLength(2);
      await submitSearch(page); await assertCompleted(page, fixture.exchanges, 3);

      // 两项均用自己的 Key 后，作者改码与资格状态查询不再参与搜索准备。
      await newSearch(page); panel = await openSettings(page); await configureOwn(panel, "SerpAPI", OWN_KEYS.serpApiKey);
      await panel.getByRole("button", { name: "收起面板", exact: true }).click();
      const statusChecks = fixture.exchanges.filter(exchange => exchange.path === "/api/experience/status").length;
      await updateExperienceConfig(fixture.configPath, { inviteCode: INVITE_B });
      await submitSearch(page); await assertCompleted(page, fixture.exchanges, 4);
      expect(fixture.calls.factories.at(-1)).toEqual(OWN_KEYS);
      expect(fixture.calls.search.slice(-2)).toEqual([{ key: OWN_KEYS.serpApiKey, query: BROAD_QUERY }, { key: OWN_KEYS.serpApiKey, query: QUERY }]);
      expect(fixture.exchanges.filter(exchange => exchange.path === "/api/experience/status")).toHaveLength(statusChecks);
      for (const call of fixture.calls.llm) for (const secret of SECRETS) expect(call.prompt).not.toContain(secret);
    } finally { await fixture.close(); }
  });
});

test.describe("生产体验授权移动布局", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 780 }, deviceScaleFactor: 1 });
  test("滚动SerpAPI真实授权公告与确认可达，Cookie与本地来源分别保存", async ({ page }) => {
    const fixture = await productionFixture(page);
    try {
      await openProduct(page);
      const panel = await logIn(page, true);
      const button = panel.getByRole("form", { name: "SerpAPI 设置", exact: true }).getByRole("button", { name: "体验 APIKEY", exact: true });
      await button.scrollIntoViewIfNeeded(); await button.tap();
      const trial = panel.getByRole("dialog", { name: "使用作者 APIKEY 体验", exact: true });
      await expect(trial.locator(".ink-settings__announcement")).toBeInViewport({ ratio: 1 });
      await expect(trial.getByLabel("邀请码", { exact: true })).toBeInViewport({ ratio: 1 });
      await trial.getByLabel("邀请码", { exact: true }).fill(INVITE_A);
      const confirm = trial.getByRole("button", { name: "确认使用", exact: true });
      await expect(confirm).toBeInViewport({ ratio: 1 }); await expect(confirm).toBeEnabled();
      await fs.mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
      await page.screenshot({ path: path.join(SCREENSHOT_DIRECTORY, "way-137-settings-mobile.png") });
      await confirm.tap(); await expect(trial).toHaveCount(0); await assertBrowserGrant(page);
      expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`wayfinder.credentials.v1.user.${id}`) ?? "null") as unknown, ACCOUNT.userId)).toEqual({
        deepseek: { source: "own", apiKey: "" }, serpapi: { source: "author", apiKey: "" },
      });
      expect(fixture.calls.factories).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});
