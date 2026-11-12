/** 登录弹窗、设置与身份分区旅程；HTTP 只使用假账号，不调用邮件或真实 Provider（服务提供方）。 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AccountActionSchema, AccountProfileActionSchema, type Account } from "@wayfinder/contracts";

async function fixture(page: Page) {
  let account: Account | null = null;
  let searches = 0;
  let nickname: string | null = null;
  let rejectVerify = false;
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
        // 每次显式设置最多拒绝一次验证码，验证失败后的下一次提交仍可走既有成功路径。
        if (action.action === "verify" && rejectVerify) {
          rejectVerify = false;
          return route.fulfill({ status: 401, json: { code: "ACCOUNT_INVALID" } });
        }
        if (action.action === "login") account = { userId: "fixture-A", email: action.email };
        else if (action.action === "logout") account = null;
        else return route.fulfill({ json: { accepted: true } });
      }
      return route.fulfill({ json: { account } });
    }
    if (path === "/api/profile" && account !== null) {
      if (request.method() === "POST") nickname = AccountProfileActionSchema.parse(request.postDataJSON()).nickname;
      return route.fulfill({ json: { profile: { userId: account.userId, nickname } } });
    }
    if (path === "/api/search") ++searches;
    return route.fulfill({ status: 503, json: { code: "EXPERIENCE_UNAVAILABLE" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return { setAccount: (value: Account | null) => { account = value; }, searches: () => searches,
    rejectNextVerify: () => { rejectVerify = true; } };
}
async function settings(page: Page, language: "zh-CN" | "en-US" = "zh-CN") {
  const enter = page.getByRole("button", { name: language === "zh-CN" ? "开始探索" : "Start exploring", exact: true });
  await enter.click();
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: language === "zh-CN" ? "设置" : "Settings", exact: true }).click();
  return page.getByRole("region", { name: language === "zh-CN" ? "账号" : "Account", exact: true });
}

test("邮箱动作状态正确，登录不自动导入访客Key，退出恢复独立访客空间", async ({ page }) => {
  const environment = await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog"), form = dialog.getByRole("form", { name: "邮箱账号" });
  await expect(dialog.locator("svg")).toHaveCount(0);
  await dialog.getByRole("button", { name: "注册", exact: true }).click();
  // 注册先收集邮箱和密码；验证码入口只能由服务端受理后的自动阶段切换产生。
  await expect(page.getByRole("dialog", { name: "注册", exact: true })).toBeVisible();
  await expect(form.getByLabel("验证码", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "验证邮箱", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(form.getByLabel("邮箱", { exact: true })).toBeFocused();
  await expect(dialog.getByText("注册成功，请登录。", { exact: true })).toHaveCount(0);
  await form.getByLabel("邮箱", { exact: true }).fill("fixture@example.test");
  await form.getByLabel("密码", { exact: true }).fill("fixture-password");
  await form.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "验证邮箱", exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("此提示不代表已投递成功");
  await expect(dialog.getByText("注册成功，请登录。", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "重新发送验证码", exact: true })).toBeVisible();
  await expect(form.getByLabel("邮箱", { exact: true })).toBeFocused();
  // 受理和验证失败均不能冒充注册成功；一次失败后仍留在验证阶段，并可重新提交。
  environment.rejectNextVerify();
  await form.getByLabel("验证码", { exact: true }).fill("654321");
  await form.getByRole("button", { name: "验证邮箱", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("账号操作未完成，请检查输入或稍后重试。");
  await expect(page.getByRole("dialog", { name: "验证邮箱", exact: true })).toBeVisible();
  await expect(form.getByLabel("验证码", { exact: true })).toHaveValue("");
  await expect(dialog.getByText("注册成功，请登录。", { exact: true })).toHaveCount(0);
  await form.getByLabel("验证码", { exact: true }).fill("123456");
  await form.getByRole("button", { name: "验证邮箱", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "登录", exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("注册成功，请登录。");
  await expect(form.getByLabel("邮箱", { exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "忘记密码？", exact: true }).click();
  await form.getByRole("button", { name: "找回密码", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("此提示不代表已投递成功");
  await expect(form.getByLabel("邮箱", { exact: true })).toBeFocused();
  await form.getByLabel("验证码", { exact: true }).fill("123456");
  await form.getByLabel("密码", { exact: true }).fill("fixture-new-password");
  await form.getByRole("button", { name: "重置密码", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("操作已完成，请登录。");
  await expect(form.getByLabel("邮箱", { exact: true })).toBeFocused();
  await form.getByLabel("密码", { exact: true }).fill("fixture-new-password");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
  const account = await settings(page);
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
  await expect(trial.getByRole("alert")).toContainText("Log in before verifying an invitation.");
  await trial.getByRole("button", { name: "Cancel", exact: true }).click();
  await account.getByRole("button", { name: "Log in", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Log in", exact: true }).getByRole("form", { name: "Email account" });
  await form.getByLabel("Email", { exact: true }).fill("fixture@example.test");
  await form.getByLabel("Password", { exact: true }).fill("fixture-password");
  await form.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(form).toHaveCount(0);
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

/** 弹窗关闭必须销毁秘密草稿；焦点循环与恢复同时覆盖键盘操作，避免 Tab 落入后方画布。 */
test("登录弹窗约束焦点，关闭和Escape清空秘密并恢复入口焦点", async ({ page }) => {
  await fixture(page); await page.goto("/");
  const trigger = page.getByRole("button", { name: "登录", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "登录", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("邮箱", { exact: true }).fill("draft@example.test");
  await dialog.getByLabel("密码", { exact: true }).fill("fixture-secret-draft");
  const focusable = dialog.locator('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]');
  await focusable.last().focus(); await page.keyboard.press("Tab"); await expect(focusable.first()).toBeFocused();
  await focusable.first().focus(); await page.keyboard.press("Shift+Tab"); await expect(focusable.last()).toBeFocused();
  await dialog.getByRole("button", { name: "收起面板", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue("");
  await dialog.getByLabel("密码", { exact: true }).fill("fixture-another-secret");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  // 设置中的登录按钮随抽屉关闭而卸载；焦点必须回到常驻顶栏，不能落回已隐藏的旧入口。
  const account = await settings(page);
  await account.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "收起面板", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
});

/** 昵称保存沿用 profile（账号资料）接口；头像只显示当前账号状态，不把邮箱写成默认成员昵称。 */
test("设置快速关开后旧退出请求的失败不落入新面板", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录", exact: true });
  await dialog.getByLabel("邮箱", { exact: true }).fill("fixture@example.test");
  await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/account", async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "logout") return route.fallback();
    started(); await held; await route.fulfill({ status: 503, json: { code: "ACCOUNT_UNAVAILABLE" } });
  });
  await page.getByRole("button", { name: "账号", exact: true }).click();
  const panel = page.getByRole("region", { name: "设置", exact: true });
  await panel.getByRole("button", { name: "退出登录", exact: true }).click(); await pending;
  await page.keyboard.press("Escape");
  await expect(page.locator("#ink-settings")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "账号", exact: true }).click();
  await expect(panel).toBeVisible(); release();
  await expect(panel.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
  // 云端工作区的假离线提示仍合法存在；这里只检查账号组件自己的迟到失败提示。
  await expect(panel.locator(".ink-settings__account > [role=alert]")).toHaveCount(0);
});

test("头像回退本人账号，点击进入设置且昵称保存后即时显示", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录", exact: true });
  await dialog.getByLabel("邮箱", { exact: true }).fill("fixture@example.test");
  await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const avatar = page.getByRole("button", { name: "账号", exact: true });
  await avatar.hover(); await expect(avatar).toContainText("fixture@example.test");
  await avatar.click();
  const panel = page.getByRole("region", { name: "设置", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox", { name: "账号昵称", exact: true }).fill("新的小甲");
  await panel.getByRole("button", { name: "保存昵称", exact: true }).click();
  await expect(avatar).toContainText("新的小甲");
  await panel.getByRole("button", { name: "收起面板", exact: true }).click();
  await avatar.hover(); await expect(page.getByText("新的小甲", { exact: true })).toBeVisible();
});


/** 只暂停真实 Web Animations（网页动画）以固定采样时点；不替换关键帧、曲线或完成通知。 */
async function installPausedAccountMotion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { calls: 0 }, animate = Element.prototype.animate;
    Object.assign(window, { accountMotionFixture: state });
    Element.prototype.animate = function (this: Element, keyframes, options): Animation {
      const animation = animate.call(this, keyframes, options);
      if (this.matches(".ink-account-dialog") || this.closest(".ink-account-dialog") !== null) {
        state.calls++; animation.pause();
      }
      return animation;
    };
  });
}

/** 四分之一时刻低于线性进度，首尾通过 finish（完成）真实推进，避免依赖墙钟等待。 */
async function finishAccountMotion(dialog: Locator): Promise<void> {
  await expect.poll(() => dialog.evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)
      && animation.playState !== "finished" && animation.playState !== "idle").length)).toBeGreaterThan(0);
  const sample = await dialog.evaluate(element => {
    const animation = element.getAnimations({ subtree: true }).find(value => !(value instanceof CSSAnimation) && !(value instanceof CSSTransition)
      && value.playState !== "finished" && value.playState !== "idle");
    if (animation?.effect === null || animation?.effect === undefined) throw new Error("认证面板没有可采样的真实动画");
    const timing = animation.effect.getTiming();
    if (typeof timing.duration !== "number") throw new Error("认证动画必须具有明确时长");
    animation.currentTime = timing.duration / 4;
    const progress = animation.effect.getComputedTiming().progress;
    animation.finish();
    return { easing: timing.easing?.replace(/\s/g, "") ?? "linear", duration: timing.duration, progress };
  });
  expect(sample.easing).toBe("cubic-bezier(0.6,0,0.4,1)");
  expect(sample.duration).toBe(360);
  expect(sample.progress).not.toBeNull();
  expect(sample.progress!).toBeGreaterThan(0); expect(sample.progress!).toBeLessThan(.25);
}

test("认证面板以S曲线进入、切换和退出，退场清理秘密并遵守减少动态偏好", async ({ page }) => {
  await fixture(page); await installPausedAccountMotion(page);
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.goto("/");
  const trigger = page.getByRole("button", { name: "登录", exact: true }); await trigger.click();
  const dialog = page.getByRole("dialog"), form = dialog.getByRole("form", { name: "邮箱账号" });
  await expect(dialog).toBeVisible(); await finishAccountMotion(dialog);
  const change = async (name: string, action: () => Promise<void>): Promise<void> => {
    await action(); await expect(dialog).toHaveAttribute("data-changing", "true");
    await finishAccountMotion(dialog);
    await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
    await finishAccountMotion(dialog); await expect(dialog).not.toHaveAttribute("data-changing", "true");
  };
  // 手动导航与服务端受理后的自动换页都要使用同一条非线性曲线。
  await change("注册", () => dialog.getByRole("button", { name: "注册", exact: true }).click());
  await form.getByLabel("邮箱", { exact: true }).fill("motion@example.test");
  await form.getByLabel("密码", { exact: true }).fill("fixture-motion-password");
  await change("验证邮箱", () => form.getByRole("button", { name: "注册", exact: true }).click());
  await form.getByLabel("验证码", { exact: true }).fill("123456");
  await change("登录", () => form.getByRole("button", { name: "验证邮箱", exact: true }).click());
  await change("找回密码", () => dialog.getByRole("button", { name: "忘记密码？", exact: true }).click());
  await change("重置密码", () => form.getByRole("button", { name: "找回密码", exact: true }).click());
  await form.getByLabel("密码", { exact: true }).fill("fixture-closing-password");
  await form.getByLabel("验证码", { exact: true }).fill("654321");
  await dialog.getByRole("button", { name: "收起面板", exact: true }).click();
  await expect(dialog).toHaveAttribute("data-closing", "true");
  const closing = await dialog.evaluate(element => {
    const currentForm = element.querySelector("form");
    return {
      open: element instanceof HTMLDialogElement && element.open,
      secrets: Array.from(element.querySelectorAll<HTMLInputElement>('input[name="password"], input[name="otp"]')).map(input => input.value),
      blocked: currentForm !== null && (currentForm.closest("[inert]") !== null
        || Array.from(currentForm.querySelectorAll("input, button")).every(control => control.matches(":disabled"))),
    };
  });
  expect(closing.open).toBe(true); expect(closing.secrets).toEqual(["", ""]); expect(closing.blocked).toBe(true);
  await finishAccountMotion(dialog); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  // 偏好在动画中途改变也要完成当前动作；后续导航和关闭不再创建动画。
  await trigger.click(); await expect(dialog).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => dialog.evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)
      && animation.playState !== "finished" && animation.playState !== "idle").length)).toBe(0);
  await expect(dialog.locator('input[name="password"]')).toHaveValue("");
  const calls = await page.evaluate(() => (window as unknown as { accountMotionFixture: { calls: number } }).accountMotionFixture.calls);
  await dialog.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "注册", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "收起面板", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { accountMotionFixture: { calls: number } }).accountMotionFixture.calls)).toBe(calls);
});
