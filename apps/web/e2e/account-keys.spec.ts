/** 真实设置界面的独立云Key确认/选择/撤销旅程；HTTP使用假密钥，不调用真实Provider。 */
import { expect, test, type Page } from "@playwright/test";
import { AccountKeyActionSchema, CLOUD_ACCOUNT_HEADER, SEARCH_CREDENTIALS_HEADER, SearchCredentialsSchema,
  type AccountKeyAction, type AccountKeysResponse } from "@wayfinder/contracts";

async function fixture(page: Page) {
  const userId = "fixture-key-user", email = "keys@example.test";
  const summary: AccountKeysResponse = { userId, deepseek: { configured: false, mask: null, revision: null }, serpapi: { configured: false, mask: null, revision: null } };
  const actions: AccountKeyAction[] = [], searches: { headers: Record<string, string>; body: string }[] = [];
  const receipts = new Map<string, AccountKeysResponse>();
  let fail = false, version = 0;
  await page.addInitScript(() => {
    if (!localStorage.getItem("wayfinder.credentials.v1")) localStorage.setItem("wayfinder.credentials.v1", JSON.stringify({
      deepseek: { source: "own", apiKey: "fixture-guest-private-key" }, serpapi: { source: "own", apiKey: "fixture-guest-search-key" },
    }));
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        return kind.includes("webgl") ? null : Reflect.apply(original, this, [kind, ...options]) as RenderingContext | null;
      } });
  });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/account") return route.fulfill({ json: { account: { userId, email } } });
    if (path === "/api/workspace") return route.fulfill({ json: { userId, graphs: [], activeOrder: [], deletedIds: [] } });
    if (path === "/api/account/keys") {
      expect(request.headers()[CLOUD_ACCOUNT_HEADER]).toBe(userId);
      if (request.method() === "POST") {
        const action = AccountKeyActionSchema.parse(request.postDataJSON()); actions.push(action);
        if (fail) return route.fulfill({ status: 503, json: { code: "KEY_UNAVAILABLE", service: action.service } });
        const receipt = receipts.get(action.mutationId);
        if (receipt !== undefined) return route.fulfill({ json: receipt });
        if (action.expectedRevision !== summary[action.service].revision) return route.fulfill({ status: 409, json: { code: "KEY_CONFLICT", service: action.service } });
        summary[action.service] = action.action === "save" ? { configured: true, mask: `••••${action.apiKey.slice(-4)}`, revision: `key-${++version}` }
          : { configured: false, mask: null, revision: `key-${++version}` };
        receipts.set(action.mutationId, structuredClone(summary));
      }
      return route.fulfill({ json: structuredClone(summary) });
    }
    if (path === "/api/search") {
      searches.push({ headers: request.headers(), body: request.postData() ?? "" });
      return route.fulfill({ status: 503, json: { code: "CLOUD_KEY_UNAVAILABLE", service: "deepseek" } });
    }
    return route.fulfill({ status: 503, json: { code: "EXPERIENCE_UNAVAILABLE" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return { summary, actions, searches, fail: (value: boolean) => { fail = value; } };
}
async function open(page: Page, english = false) {
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const panel = page.getByRole("region", { name: english ? "Settings" : "设置", exact: true });
  await expect(panel).toBeVisible(); return panel;
}

test("独立确认保存不自动切来源，失败重试保留访客源，cloud混合请求不含云Key明文", async ({ page }, testInfo) => {
  const remote = await fixture(page); await page.goto("/"); await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const panel = await open(page), card = panel.getByRole("form", { name: "DeepSeek 设置", exact: true }), cloud = card.getByRole("region", { name: "DeepSeek 云端 Key", exact: true });
  await expect(cloud.getByRole("button", { name: "读取该服务的访客 Key", exact: true })).toBeEnabled();
  await cloud.getByRole("button", { name: "读取该服务的访客 Key", exact: true }).click();
  const input = cloud.getByLabel("DeepSeek 待保存的云端 Key", { exact: true });
  await expect(input).toHaveValue("fixture-guest-private-key"); await input.press("Enter"); expect(remote.actions).toHaveLength(0);
  await cloud.getByRole("button", { name: "保存到云端", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("cloud-key-confirmation.png") });
  await cloud.getByRole("button", { name: "取消", exact: true }).click(); expect(remote.actions).toHaveLength(0);
  await expect(input).toHaveValue("");
  await cloud.getByRole("button", { name: "读取该服务的访客 Key", exact: true }).click();
  await cloud.getByRole("button", { name: "保存到云端", exact: true }).click();
  await cloud.getByRole("button", { name: "确认保存云端 Key", exact: true }).click();
  await expect(cloud).toContainText("云端 Key 已更新"); await expect(card.getByRole("button", { name: "自己的 API Key", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(cloud.getByRole("button", { name: "使用云端 Key", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByLabel("DeepSeek API Key", { exact: true })).toHaveValue("");
  await input.fill("fixture-replacement-key"); await cloud.getByRole("button", { name: "保存到云端", exact: true }).click(); remote.fail(true);
  await cloud.getByRole("button", { name: "确认保存云端 Key", exact: true }).click();
  await expect(cloud.getByRole("alert")).toContainText("暂不可用");
  const failed = structuredClone(remote.actions.at(-1)); remote.fail(false);
  await cloud.getByRole("button", { name: "确认保存云端 Key", exact: true }).click(); await expect(cloud).toContainText("云端 Key 已更新");
  expect(remote.actions.at(-1)).toEqual(failed);
  await cloud.getByRole("button", { name: "使用云端 Key", exact: true }).click();
  const search = panel.getByRole("form", { name: "SerpAPI 设置", exact: true });
  await search.getByLabel("SerpAPI API Key", { exact: true }).fill("fixture-account-search-key"); await search.getByRole("button", { name: "保存设置", exact: true }).click();
  await panel.getByRole("button", { name: "收起面板", exact: true }).click();
  const box = page.getByRole("searchbox", { name: "搜索任意主题", exact: true }); await box.fill("fixture cloud mixed"); await box.press("Enter");
  await expect.poll(() => remote.searches.length).toBe(1);
  const sent = remote.searches[0]; if (sent === undefined) throw new Error("缺少搜索请求");
  expect(sent.headers[CLOUD_ACCOUNT_HEADER]).toBe("fixture-key-user");
  expect(SearchCredentialsSchema.parse(JSON.parse(sent.headers[SEARCH_CREDENTIALS_HEADER] ?? "null"))).toEqual({ deepseek: { source: "cloud" }, serpapi: { source: "own", apiKey: "fixture-account-search-key" } });
  expect(JSON.stringify(sent)).not.toContain("fixture-replacement-key"); expect(JSON.stringify(sent)).not.toContain("fixture-guest-private-key");
  expect(await page.evaluate(() => localStorage.getItem("wayfinder.credentials.v1"))).toContain("fixture-guest-private-key");
  expect(await page.evaluate(() => localStorage.getItem("wayfinder.credentials.v1.user.fixture-key-user"))).not.toContain("fixture-replacement-key");
  await open(page);
  await cloud.getByRole("button", { name: "删除云端 Key", exact: true }).click(); await cloud.getByRole("button", { name: "取消", exact: true }).click(); expect(remote.summary.deepseek.configured).toBe(true);
  await cloud.getByRole("button", { name: "删除云端 Key", exact: true }).click(); await cloud.getByRole("button", { name: "确认删除云端 Key", exact: true }).click();
  await expect.poll(() => remote.summary.deepseek.configured).toBe(false);
  await expect(cloud.getByRole("button", { name: "使用云端 Key", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(cloud.getByRole("button", { name: "使用云端 Key", exact: true })).toBeDisabled();
});

test.describe("云Key触屏English", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 780 } });
  test("明确确认保持可见，取消和关闭清草稿且不上传", async ({ page }, testInfo) => {
    const remote = await fixture(page); await page.goto("/?language=en-US"); await page.getByRole("button", { name: "Start exploring", exact: true }).tap();
    await page.getByRole("button", { name: "Search history", exact: true }).tap(); await page.getByRole("button", { name: "Settings", exact: true }).tap();
    const cloud = page.getByRole("region", { name: "DeepSeek Cloud key", exact: true });
    const input = cloud.getByLabel("DeepSeek Cloud key to save", { exact: true }); await input.fill("fixture-cancel-only-key");
    await cloud.getByRole("button", { name: "Save to cloud", exact: true }).tap();
    const confirmation = cloud.getByRole("button", { name: "Confirm cloud key save", exact: true }); await confirmation.scrollIntoViewIfNeeded();
    await expect(confirmation).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("cloud-key-mobile-confirmation.png") });
    await cloud.getByRole("button", { name: "Cancel", exact: true }).tap(); await expect(input).toHaveValue(""); expect(remote.actions).toHaveLength(0);
    await input.fill("fixture-unsaved-key"); await page.getByRole("region", { name: "Settings", exact: true }).getByRole("button", { name: "Close panel", exact: true }).tap();
    await page.getByRole("button", { name: "Search history", exact: true }).tap(); await page.getByRole("button", { name: "Settings", exact: true }).tap();
    await expect(input).toHaveValue(""); expect(remote.actions).toHaveLength(0);
  });
});
