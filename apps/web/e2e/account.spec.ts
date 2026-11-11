/** 真实设置界面与身份分区旅程；仅HTTP服务端使用明确假账号，不调用邮件或真实Provider。 */
import { expect, test, type Page } from "@playwright/test";
import { AccountActionSchema, type Account } from "@wayfinder/contracts";

async function fixture(page: Page) {
  let account: Account | null = null;
  let searches = 0;
  await page.addInitScript(() => {
    localStorage.setItem("wayfinder.credentials.v1", JSON.stringify({
      deepseek: { source: "own", apiKey: "fixture-guest-llm" }, serpapi: { source: "own", apiKey: "fixture-guest-search" },
    }));
    const getContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        return kind.includes("webgl") ? null : Reflect.apply(getContext, this, [kind, ...options]) as RenderingContext | null;
      } });
  });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/account") {
      if (request.method() === "POST") {
        const action = AccountActionSchema.parse(request.postDataJSON());
        if (action.action === "login") account = { userId: "fixture-A", email: action.email };
        else if (action.action === "logout") account = null;
        else return route.fulfill({ json: { accepted: true } });
      }
      return route.fulfill({ json: { account } });
    }
    if (path === "/api/search") ++searches;
    return route.fulfill({ status: 503, json: { code: "EXPERIENCE_UNAVAILABLE" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return { setAccount: (value: Account | null) => { account = value; }, searches: () => searches };
}
async function settings(page: Page, language: "zh-CN" | "en-US" = "zh-CN") {
  const enter = page.getByRole("button", { name: language === "zh-CN" ? "开始探索" : "Start exploring", exact: true });
  await enter.click();
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: language === "zh-CN" ? "设置" : "Settings", exact: true }).click();
  return page.getByRole("region", { name: language === "zh-CN" ? "账号" : "Account", exact: true });
}

test("邮箱动作状态正确，登录不自动导入访客Key，退出恢复独立访客空间", async ({ page }) => {
  await fixture(page); await page.goto("/");
  const account = await settings(page), form = account.getByRole("form", { name: "邮箱账号" });
  await account.getByRole("button", { name: "注册", exact: true }).click();
  await form.getByLabel("邮箱", { exact: true }).fill("fixture@example.test");
  await form.getByLabel("密码", { exact: true }).fill("fixture-password");
  await form.getByRole("button", { name: "注册", exact: true }).click();
  await expect(account.getByRole("status")).toContainText("此提示不代表已投递成功");
  await form.getByLabel("验证码", { exact: true }).fill("123456");
  await form.getByRole("button", { name: "验证邮箱", exact: true }).click();
  await expect(account.getByRole("status")).toHaveText("操作已完成，请登录。");
  await account.getByRole("button", { name: "找回密码", exact: true }).click();
  await form.getByRole("button", { name: "找回密码", exact: true }).click();
  await expect(account.getByRole("status")).toContainText("此提示不代表已投递成功");
  await form.getByLabel("验证码", { exact: true }).fill("123456");
  await form.getByLabel("密码", { exact: true }).fill("fixture-new-password");
  await form.getByRole("button", { name: "重置密码", exact: true }).click();
  await expect(account.getByRole("status")).toHaveText("操作已完成，请登录。");
  await form.getByLabel("密码", { exact: true }).fill("fixture-new-password");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
  await settings(page);
  await expect(account).toContainText("fixture@example.test");
  const llm = page.getByRole("form", { name: "DeepSeek 设置", exact: true });
  await expect(llm.getByLabel("DeepSeek API Key", { exact: true })).toHaveValue("");
  await llm.getByLabel("DeepSeek API Key", { exact: true }).fill("fixture-account-llm");
  await llm.getByRole("button", { name: "保存设置", exact: true }).click();
  await account.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
  await settings(page);
  await expect(llm.getByLabel("DeepSeek API Key", { exact: true })).toHaveValue("fixture-guest-llm");
  const saved = await page.evaluate(() => ({ guest: localStorage.getItem("wayfinder.credentials.v1"), account: localStorage.getItem("wayfinder.credentials.v1.user.fixture-A") }));
  expect(saved.guest).toContain("fixture-guest-llm"); expect(saved.account).toContain("fixture-account-llm");
});

test("English访客不能验证作者邀请码；服务端换号后旧账号Key不发起搜索", async ({ page }) => {
  const environment = await fixture(page); await page.goto("/?language=en-US");
  const account = await settings(page, "en-US");
  const llm = page.getByRole("form", { name: "DeepSeek Settings", exact: true });
  await llm.getByRole("button", { name: "Author trial", exact: true }).click();
  const trial = page.getByRole("dialog", { name: "Try the author's API keys", exact: true });
  await expect(trial.getByRole("alert")).toContainText("Log in in Settings");
  await trial.getByRole("button", { name: "Cancel", exact: true }).click();
  const form = account.getByRole("form", { name: "Email account" });
  await form.getByLabel("Email", { exact: true }).fill("fixture@example.test");
  await form.getByLabel("Password", { exact: true }).fill("fixture-password");
  await form.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
  await settings(page, "en-US");
  for (const [service, key] of [["DeepSeek", "fixture-A-llm"], ["SerpAPI", "fixture-A-search"]]) {
    const preferences = page.getByRole("form", { name: `${service} Settings`, exact: true });
    await preferences.getByLabel(`${service} API key`, { exact: true }).fill(key ?? "");
    await preferences.getByRole("button", { name: "Save settings", exact: true }).click();
  }
  await page.getByRole("region", { name: "Settings", exact: true }).getByRole("button", { name: "Close panel", exact: true }).click();
  environment.setAccount({ userId: "fixture-B", email: "b@example.test" });
  const search = page.getByRole("searchbox", { name: "Search any topic", exact: true });
  await search.fill("old account must not search"); await search.press("Enter");
  await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toBeVisible();
  expect(environment.searches()).toBe(0);
  await settings(page, "en-US");
  await expect(account).toContainText("b@example.test");
  await expect(llm.getByLabel("DeepSeek API key", { exact: true })).toHaveValue("");
});
