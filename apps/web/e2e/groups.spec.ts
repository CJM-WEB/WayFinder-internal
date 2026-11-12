/**
 * D12小组界面旅程：真实浏览器与工作区适配器，服务端只用持续NDJSON假样例。
 * 重点覆盖用户入口、当前归属、可见权限及断网门禁；数据库竞态与搜索质量不在此重复实现。
 */
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_GROUP, FIXTURE_USER, INVITATION, MEMBER_GROUP, fixturePageErrors, installGroupFixture } from "./support/group-fixture.js";

/** 所有旅程均拒绝未捕获页面异常，防止异步写失败被DOM表面成功掩盖。 */
test.afterEach(({ page }) => { expect(fixturePageErrors.get(page) ?? []).toEqual([]); });

async function enter(page: Page) {
  await page.goto("/"); await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
}
async function groups(page: Page) {
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "小组", exact: true }).click();
  return page.getByRole("region", { name: "小组", exact: true });
}
async function openGroup(page: Page, groupId = FIXTURE_GROUP) {
  const panel = await groups(page);
  await panel.getByRole("button", { name: `进入小组：${groupId === FIXTURE_GROUP ? "学习小组" : "伙伴小组"}`, exact: true }).click();
  await expect(page.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  return panel;
}
async function selectGraph(page: Page, title = "组内搜索图") {
  await page.getByRole("region", { name: "小组", exact: true }).locator(".ink-group-workspace").getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator("[data-ink-node=fixture-node]").getByRole("heading")).toBeVisible();
}
async function editNode(page: Page, title: string) {
  await page.locator("[data-ink-node=fixture-node]").getByRole("heading").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑节点", exact: true });
  await dialog.getByRole("textbox", { name: "节点标题", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "保存节点", exact: true }).click();
  await expect(page.locator("[data-ink-node=fixture-node]").getByRole("heading")).toHaveText(title);
}

test("四个胶囊保持历史锚点并依次打开互斥面板，窄屏无越界", async ({ page }) => {
  await installGroupFixture(page); await enter(page);
  const dock = page.locator(".ink-study__history-dock"), history = page.getByRole("button", { name: "搜索历史", exact: true });
  await dock.hover();
  const controls = [history, page.getByRole("button", { name: "小组", exact: true }), page.getByRole("button", { name: "撤销", exact: true }), page.getByRole("button", { name: "设置", exact: true })];
  const lefts = await Promise.all(controls.map(async button => { const box = await button.boundingBox(); expect(box).not.toBeNull(); return box!.x; }));
  expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  const stage = await page.locator(".ink-study__stage").boundingBox(); expect(stage).not.toBeNull();
  // 原三按钮展开宽262且居中+37px；新增按钮只能向其右边扩展，历史左锚点仍是同一位置。
  expect(Math.abs(lefts[0]! - (stage!.x + stage!.width / 2 - 94))).toBeLessThan(2);
  for (const [index, name] of ["搜索历史", "小组", "撤销记录", "设置"].entries()) {
    await dock.hover(); await controls[index]!.click(); await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
    for (const other of ["搜索历史", "小组", "撤销记录", "设置"].filter(value => value !== name)) await expect(page.getByRole("region", { name: other, exact: true })).toBeHidden();
  }
  await page.keyboard.press("Escape"); await expect(page.getByRole("region", { name: "设置", exact: true })).toBeHidden();
  await page.setViewportSize({ width: 375, height: 760 }); await dock.hover();
  for (const button of controls) { const box = await button.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375); }
});

test("先保存统一昵称再创建或加入小组，完整邀请码只在加入表单发送", async ({ page }) => {
  const fixture = await installGroupFixture(page, { nickname: null, empty: true }); await enter(page); const panel = await groups(page);
  await expect(panel.getByRole("button", { name: "创建小组", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "加入小组", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "创建小组", exact: true }).first().click();
  await panel.getByRole("textbox", { name: "小组名称", exact: true }).fill("算法学习");
  await panel.getByRole("textbox", { name: "小组说明", exact: true }).fill("共读图论资料");
  const createSubmit = panel.locator("form").filter({ has: page.getByRole("textbox", { name: "小组名称", exact: true }) }).getByRole("button", { name: "创建小组", exact: true });
  await expect(createSubmit).toBeDisabled(); expect(fixture.requests).toHaveLength(0);
  await panel.getByRole("textbox", { name: "账号昵称", exact: true }).fill("大学同学");
  await panel.getByRole("button", { name: "保存昵称", exact: true }).click();
  await expect(createSubmit).toBeEnabled(); await createSubmit.click();
  await expect(panel).toContainText("算法学习");
  await panel.getByRole("button", { name: "加入小组", exact: true }).first().click();
  await panel.locator('input[aria-label="邀请码"]:not([readonly])').fill(INVITATION);
  await panel.getByRole("button", { name: "加入小组", exact: true }).last().click();
  await expect(panel).toContainText("加入的小组");
  expect(fixture.requests.map(value => value.path)).toEqual(["/api/profile", "/api/groups", "/api/groups"]);
  expect(fixture.requests[1]?.body).toMatchObject({ action: "create", name: "算法学习", description: "共读图论资料" });
  expect(fixture.requests[2]?.body).toMatchObject({ action: "join", invitationCode: INVITATION });
});

test("小组条悬浮向下展开成员，创建者管理与普通成员退出分开", async ({ page }, testInfo) => {
  const fixture = await installGroupFixture(page); await enter(page); const panel = await groups(page);
  const owned = panel.locator(".ink-group-record").first();
  const member = panel.locator(".ink-group-record").filter({ has: page.getByRole("button", { name: "进入小组：伙伴小组", exact: true }) });
  const before = await owned.boundingBox(), next = await member.boundingBox();
  await owned.hover(); await expect(owned).toContainText("小乙");
  await expect.poll(async () => (await owned.boundingBox())!.height).toBeGreaterThan(before!.height);
  await expect.poll(async () => (await owned.boundingBox())!.width).toBeGreaterThan(before!.width);
  await expect.poll(async () => (await member.boundingBox())!.y).toBeGreaterThan(next!.y);
  await owned.getByRole("button", { name: "进入小组：学习小组", exact: true }).click();
  const selected = panel.locator(".ink-group-workspace");
  await expect(selected.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  await expect(selected.getByRole("textbox", { name: "邀请码", exact: true })).toHaveValue(INVITATION);
  await expect(selected.getByRole("button", { name: "解散小组", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("group-owner-members.png"), animations: "disabled" });
  await selected.getByRole("button", { name: "编辑小组", exact: true }).click();
  await panel.getByRole("textbox", { name: "小组名称", exact: true }).fill("共同学习");
  await panel.getByRole("textbox", { name: "小组说明", exact: true }).fill("更新说明");
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await expect(owned).toContainText("共同学习");
  // 推送可以先于HTTP确认到达；正常顺序旅程等待表单关闭，迟到确认另有专门用例覆盖。
  await expect(panel.getByRole("textbox", { name: "小组名称", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("status").filter({ hasText: "操作已完成" })).toBeVisible();
  const update = fixture.requests.find(value => (value.body as { action?: string }).action === "update");
  expect(update?.proof).toMatch(/^fixture-proof-/); expect(update?.body).toMatchObject({ name: "共同学习", description: "更新说明" });
  await member.getByRole("button", { name: "进入小组：伙伴小组", exact: true }).click();
  await expect(selected.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  await expect(selected.getByRole("button", { name: "编辑小组", exact: true })).toHaveCount(0);
  await expect(selected.getByRole("button", { name: "解散小组", exact: true })).toHaveCount(0);
  await expect(selected.getByRole("textbox", { name: "邀请码", exact: true })).toHaveCount(0);
  await selected.getByRole("button", { name: "退出小组", exact: true }).click();
  await expect(member).toHaveCount(0); expect(fixture.groups[MEMBER_GROUP]).toBeUndefined();
  await owned.getByRole("button", { name: "进入小组：共同学习", exact: true }).click();
  await expect(selected.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  page.once("dialog", dialog => dialog.accept()); await selected.getByRole("button", { name: "解散小组", exact: true }).click();
  await expect(owned).toHaveCount(0); expect(fixture.groups[FIXTURE_GROUP]).toBeUndefined();
});

test("真实编辑自动发往组图并接收另一成员推送，撤销仅显示本人且标明小组", async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page); await openGroup(page); await selectGraph(page);
  await editNode(page, "我的即时修改");
  const edit = fixture.requests.find(value => (value.body as { action?: string }).action === "edit");
  expect(edit?.proof).toMatch(/^fixture-proof-/); expect(edit?.body).toMatchObject({ action: "edit", groupId: FIXTURE_GROUP, kind: "node.edit" });
  await fixture.pushOtherEdit("伙伴实时修改");
  await expect(page.locator("[data-ink-node=fixture-node]").getByRole("heading")).toHaveText("伙伴实时修改");
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "撤销", exact: true }).click();
  const undo = page.getByRole("region", { name: "撤销记录", exact: true });
  await expect(undo).toContainText("本人记录"); await expect(undo).toContainText("学习小组");
  await expect(undo).not.toContainText("他人记录"); await expect(undo).not.toContainText("伙伴实时修改");
  await undo.getByRole("button", { name: /^撤销/ }).first().click();
  await expect.poll(() => fixture.requests.some(value => (value.body as { action?: string }).action === "undo")).toBe(true);
  const ownUndo = fixture.requests.find(value => (value.body as { action?: string }).action === "undo"); expect(ownUndo?.proof).toMatch(/^fixture-proof-/);
  expect(fixture.groups[FIXTURE_GROUP]?.workspace.graphs[0]?.history.events.find(value => !value.active)?.actorUserId).toBe(FIXTURE_USER);
});

test("组内与个人复制只带内容布局，退出组上下文恢复个人图与个人历史", async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page); const panel = await openGroup(page);
  // 来源选择是公开表单，不向组图写入个人历史或已保存凭据。
  await panel.getByRole("combobox", { name: "选择个人图", exact: true }).selectOption("fixture-private-graph");
  await panel.getByRole("button", { name: "复制个人图到小组", exact: true }).click();
  await expect.poll(() => fixture.groups[FIXTURE_GROUP]?.workspace.graphs.length).toBe(2);
  const copiedIn = fixture.groups[FIXTURE_GROUP]?.workspace.graphs.at(-1); expect(copiedIn?.history.events).toHaveLength(0);
  expect(copiedIn?.document.positions).toEqual(fixture.personal.graphs[0]?.document.positions);
  await groups(page); await panel.getByRole("button", { name: "复制到个人", exact: true }).first().click();
  await expect.poll(() => fixture.personal.graphs.length).toBe(2);
  const copiedOut = fixture.personal.graphs.at(-1); expect(copiedOut?.history.events).toHaveLength(0);
  expect(copiedOut?.document.positions).toEqual(fixture.groups[FIXTURE_GROUP]?.workspace.graphs[0]?.document.positions);
  expect(copiedOut?.document.id).not.toBe(fixture.groups[FIXTURE_GROUP]?.workspace.graphs[0]?.document.id);
  expect(fixture.requests.find(value => (value.body as { action?: string }).action === "copyIn")?.body).toMatchObject({ action: "copyIn", sourceGraphId: "fixture-private-graph", sourceRevision: 1 });
  expect(fixture.personal.graphs[0]?.history.events).toHaveLength(1);
  await panel.getByRole("button", { name: "返回个人图", exact: true }).click();
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true })).toContainText("个人源图已改名");
  await expect.poll(async () => (await fixture.streamStats()).active).toBe(0);
  expect(JSON.stringify(fixture.requests)).not.toContain("fixture-group-llm");
});

test("浏览器断网后保留已读图但所有写入口阻断，重新快照后才恢复", async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page); await openGroup(page); await selectGraph(page);
  await fixture.disconnect();
  await expect(page.locator("[data-group-connection]")).not.toHaveAttribute("data-group-connection", "online");
  const before = fixture.requests.length;
  const panel = await groups(page), selected = panel.locator(".ink-group-workspace");
  for (const name of ["创建小组", "加入小组", "保存昵称"]) await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(selected.getByRole("textbox", { name: "组图名称", exact: true })).toBeDisabled();
  await expect(selected.getByRole("button", { name: "新建组图", exact: true })).toBeDisabled();
  await expect(selected.getByRole("button", { name: "复制个人图到小组", exact: true })).toBeDisabled();
  for (const button of await selected.getByRole("button", { name: /重命名组图|删除组图|复制到个人/ }).all()) await expect(button).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator("[data-ink-node=fixture-node]").getByRole("heading").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "编辑节点", exact: true })).toBeHidden();
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "撤销", exact: true }).click();
  const undo = page.getByRole("region", { name: "撤销记录", exact: true });
  for (const button of await undo.getByRole("button", { name: /^撤销/ }).all()) await expect(button).toBeDisabled();
  expect(fixture.requests).toHaveLength(before);
  await fixture.reconnect();
  await expect(page.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  await page.keyboard.press("Escape"); await editNode(page, "恢复连接后的修改");
  expect(fixture.requests.length).toBeGreaterThan(before);
});

/** 真正的触屏上下文：首次点底部只展开，成员按钮作为无hover设备的明确替代入口。 */
test.describe("触屏小组入口", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 760 } });
  test("点按展开四选项并显式展示成员，胶囊始终落在屏幕内", async ({ page }, testInfo) => {
    await installGroupFixture(page); await enter(page);
    await page.getByRole("button", { name: "搜索历史", exact: true }).tap();
    const dock = page.locator(".ink-study__history-dock"); await expect(dock).toHaveAttribute("data-expanded", "true");
    await page.getByRole("button", { name: "小组", exact: true }).tap();
    const row = page.getByRole("region", { name: "小组", exact: true }).locator(".ink-group-record").first();
    await row.getByRole("button", { name: "小组成员", exact: true }).tap();
    await expect(row.getByRole("list", { name: "小组成员", exact: true })).toBeVisible();
    await expect(row).toContainText("小乙");
    await page.screenshot({ path: testInfo.outputPath("group-phone-members.png"), animations: "disabled" });
    const box = await dock.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  });
});

/** 管理写已发生，但HTTP确认仍可迟到；同一分支分别覆盖退出与解散，不能退出后来选择的小组。 */
for (const action of ["leave", "dissolve"] as const) test(`${action}迟到确认不会退出后来选择的小组`, async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page);
  const departing = action === "leave" ? MEMBER_GROUP : FIXTURE_GROUP, remaining = action === "leave" ? FIXTURE_GROUP : MEMBER_GROUP;
  const panel = await openGroup(page, departing), held = fixture.holdManagement(action);
  if (action === "dissolve") page.once("dialog", dialog => dialog.accept());
  await panel.getByRole("button", { name: action === "leave" ? "退出小组" : "解散小组", exact: true }).click();
  try {
    await held.entered;
    await panel.getByRole("button", { name: `进入小组：${remaining === FIXTURE_GROUP ? "学习小组" : "伙伴小组"}`, exact: true }).click();
    await expect(panel.locator(".ink-group-workspace")).toHaveAttribute("data-group-id", remaining);
    held.release();
    await expect(panel.locator(`.ink-group-record[data-group-id="${departing}"]`)).toHaveCount(0);
    await expect(panel.locator(".ink-group-workspace")).toHaveAttribute("data-group-id", remaining);
    await expect(panel.locator("[data-group-connection]")).toHaveAttribute("data-group-connection", "online");
  } finally { held.release(); }
});

test("节点草稿经过断流与新快照仍保留，原始基线提交冲突不覆盖他人修改", async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page); await openGroup(page); await selectGraph(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("[data-ink-node=fixture-node]").getByRole("heading").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑节点", exact: true }), input = dialog.getByRole("textbox", { name: "节点标题", exact: true });
  await input.fill("断网前的本地草稿"); await fixture.disconnect();
  const save = dialog.getByRole("button", { name: "保存节点", exact: true }); await expect(save).toBeDisabled();
  await expect(input).toHaveValue("断网前的本地草稿");
  await fixture.pushOtherEdit("离线期间伙伴修改"); await fixture.reconnect();
  await expect(save).toBeEnabled(); await expect(input).toHaveValue("断网前的本地草稿");
  fixture.rejectNextEdit(); await save.click();
  await expect(page.getByText("内容已变化，已保留你的修改，请核对后再确认。", { exact: true }).first()).toBeVisible();
  await expect(input).toHaveValue("断网前的本地草稿");
  const sent = fixture.requests.find(value => (value.body as { action?: string }).action === "edit");
  expect(sent?.body).toMatchObject({ expectedRevision: 3, before: { nodes: [{ id: "fixture-node", title: "共同节点" }, { id: "fixture-node-2" }] }, after: { nodes: [{ title: "断网前的本地草稿" }, { id: "fixture-node-2" }] } });
  expect(fixture.groups[FIXTURE_GROUP]?.workspace.graphs[0]?.document.nodes[0]?.title).toBe("离线期间伙伴修改");
  expect(errors).toEqual([]);
});

test("组图重命名冲突保留待处理动作且不会产生未捕获页面错误", async ({ page }) => {
  const fixture = await installGroupFixture(page); await enter(page); const panel = await openGroup(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  fixture.rejectNextEdit(); await panel.getByRole("button", { name: "重命名组图：组内搜索图", exact: true }).click();
  await panel.getByRole("textbox", { name: "重命名组图", exact: true }).fill("冲突时保留的名称");
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("内容已变化，已保留你的修改，请核对后再确认。", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "重试原操作", exact: true })).toBeVisible();
  expect(fixture.groups[FIXTURE_GROUP]?.workspace.graphs[0]?.document.title).toBe("组内搜索图");
  expect(fixture.requests.find(value => (value.body as { action?: string }).action === "edit")?.body).toMatchObject({ kind: "graph.rename", after: { title: "冲突时保留的名称" } });
  expect(errors).toEqual([]);
});
