/** 真实浏览器云同步/冲突/导入与IDB隔离回归；HTTP仅使用明确假数据，不调用付费服务。 */
import { expect, test, type Page } from "@playwright/test";
import { CLOUD_ACCOUNT_HEADER, CloudGraphWriteRequestSchema, CloudWorkspaceImportRequestSchema,
  type Account, type CloudGraphRecord, type CloudWorkspaceResponse } from "@wayfinder/contracts";
import { appendHistory, remapGraphHistoryIdentity, restoreGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";

async function install(page: Page, signedIn = true) {
  let account: Account | null = signedIn ? { userId: "fixture-cloud-A", email: "cloud@example.test" } : null;
  const remote: CloudWorkspaceResponse = { userId: "fixture-cloud-A", graphs: [], activeOrder: [], deletedIds: [] };
  const imports = new Set<string>();
  const seenBodies: string[] = [];
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        return kind.includes("webgl") ? null : Reflect.apply(original, this, [kind, ...options]) as RenderingContext | null;
      } });
    if (!localStorage.getItem("wayfinder.credentials.v1")) localStorage.setItem("wayfinder.credentials.v1", JSON.stringify({
      deepseek: { source: "own", apiKey: "fixture-private-guest-key" }, serpapi: { source: "own", apiKey: "fixture-private-guest-search" },
    }));
  });
  await page.context().route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/account") {
      if (request.method() === "POST") {
        const input = request.postDataJSON() as { action?: string };
        account = input.action === "logout" ? null : { userId: "fixture-cloud-A", email: "cloud@example.test" };
      }
      return route.fulfill({ json: { account } });
    }
    if (path !== "/api/workspace") return route.fulfill({ status: 503, json: { code: "EXPERIENCE_UNAVAILABLE" } });
    expect(request.headers()[CLOUD_ACCOUNT_HEADER]).toBe("fixture-cloud-A");
    if (account === null) return route.fulfill({ status: 401, json: { code: "ACCOUNT_REQUIRED" } });
    if (request.method() === "GET") return route.fulfill({ json: structuredClone(remote) });
    const raw: unknown = request.postDataJSON(); seenBodies.push(request.postData() ?? "");
    const batch = CloudWorkspaceImportRequestSchema.safeParse(raw);
    if (batch.success) {
      if (!imports.has(batch.data.importId)) {
        imports.add(batch.data.importId);
        for (const entry of batch.data.documents) {
          const mapped = remapGraphHistoryIdentity(entry.document, entry.history, `import-${batch.data.importId}-${entry.document.id}`);
          remote.graphs.push({ ...mapped, status: "active", originalIndex: null, revision: 1 }); remote.activeOrder.push(mapped.document.id);
        }
        for (const entry of batch.data.deletedGraphs) {
          const mapped = remapGraphHistoryIdentity(entry.document, entry.history, `import-${batch.data.importId}-${entry.document.id}`);
          remote.graphs.push({ ...mapped, status: "deleted", originalIndex: entry.originalIndex, revision: 1 }); remote.deletedIds.push(mapped.document.id);
        }
      }
      return route.fulfill({ json: structuredClone(remote) });
    }
    const input = CloudGraphWriteRequestSchema.parse(raw), id = input.action === "save" ? input.document.id : input.graphId;
    const current = remote.graphs.find(record => record.document.id === id);
    if (input.expectedRevision === 0 ? current !== undefined : current?.revision !== input.expectedRevision) return route.fulfill({ status: 409, json: { code: "WORKSPACE_CONFLICT" } });
    let record: CloudGraphRecord;
    if (input.action === "save") {
      restoreGraphHistory(input.history, input.document, 100);
      record = { document: input.document, history: input.history, revision: input.expectedRevision + 1, status: "active", originalIndex: null };
      if (current === undefined) remote.activeOrder.push(id);
    } else {
      if (current === undefined) throw new Error("缺少固定图");
      if (input.action === "delete") {
        record = { ...current, status: "deleted", originalIndex: remote.activeOrder.indexOf(id), revision: current.revision + 1 };
        remote.activeOrder = remote.activeOrder.filter(value => value !== id); remote.deletedIds.push(id);
      } else {
        if (current.status !== "deleted" || remote.deletedIds.at(-1) !== id) return route.fulfill({ status: 409, json: { code: "WORKSPACE_CONFLICT" } });
        record = { ...current, status: "active", originalIndex: null, revision: current.revision + 1 };
        remote.activeOrder.splice(current.originalIndex, 0, id); remote.deletedIds.pop();
      }
    }
    remote.graphs = [...remote.graphs.filter(value => value.document.id !== id), record];
    return route.fulfill({ json: { userId: remote.userId, record, activeOrder: remote.activeOrder, deletedIds: remote.deletedIds } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return { remote, imports, seenBodies };
}
async function enter(page: Page) {
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
}
async function history(page: Page) {
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  return page.getByRole("region", { name: "搜索历史", exact: true });
}
async function create(page: Page) {
  await page.locator(".ink-study__stage").click({ button: "right", position: { x: 340, y: 230 } });
  await page.getByRole("menuitem", { name: "新建节点", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建节点", exact: true });
  await form.getByRole("textbox", { name: "节点标题", exact: true }).fill("本地节点");
  await form.getByRole("button", { name: "新建节点", exact: true }).click();
  await expect(page.locator("[data-ink-node]").getByRole("heading", { name: "本地节点", exact: true })).toBeVisible();
}
async function rename(page: Page, title: string) {
  const panel = await history(page);
  await panel.getByRole("button", { name: /^重命名：/ }).first().click();
  const input = panel.getByRole("textbox", { name: "记录名称", exact: true }); await input.fill(title); await input.press("Enter");
  return panel;
}

test("云端保存及刷新恢复，双设备冲突另存完整历史副本", async ({ page }, testInfo) => {
  const fixture = await install(page); await page.goto("/"); await enter(page); await create(page);
  await expect.poll(() => fixture.remote.graphs.length).toBe(1);
  await rename(page, "我的云端图"); await expect.poll(() => fixture.remote.graphs[0]?.document.title).toBe("我的云端图");
  await page.reload(); await enter(page);
  const panel = await history(page); await expect(panel).toContainText("我的云端图");
  const original = fixture.remote.graphs[0]; if (original === undefined) throw new Error("缺少云端图");
  const updated = { ...original.document, title: "另一设备修改" };
  const updatedHistory = appendHistory(restoreGraphHistory(original.history, original.document, 100), original.document, updated,
    { id: "server-event", occurredAt: "2026-01-01T00:00:00Z", active: true, kind: "graph.rename", subject: updated.title }, 100);
  fixture.remote.graphs[0] = { ...original, document: updated, history: storeGraphHistory(updatedHistory), revision: original.revision + 1 };
  await panel.getByRole("button", { name: /^重命名：/ }).first().click();
  await panel.getByRole("textbox", { name: "记录名称", exact: true }).fill("本地冲突修改");
  await panel.getByRole("textbox", { name: "记录名称", exact: true }).press("Enter");
  const cloud = panel.getByRole("region", { name: "云端工作区", exact: true });
  await expect(cloud).toContainText("本地修改已保留");
  await page.screenshot({ path: testInfo.outputPath("cloud-conflict.png") });
  await cloud.getByRole("button", { name: "另存本地副本", exact: true }).click();
  await expect.poll(() => fixture.remote.graphs.length).toBe(2);
  await expect(cloud.getByRole("status")).toHaveText("已同步到云端");
  expect(fixture.remote.graphs.find(value => value.document.id === original.document.id)?.document.title).toBe("另一设备修改");
  const copy = fixture.remote.graphs.find(value => value.document.id !== original.document.id);
  expect(copy?.document.title).toBe("本地冲突修改"); expect(copy?.history.events.length).toBeGreaterThan(0);
  expect(copy?.history.events.every(event => event.before.id === copy.document.id && event.after.id === copy.document.id)).toBe(true);
});

test("访客删除队列经明确确认导入且源保留，不上传Key或重复导入", async ({ page }, testInfo) => {
  const fixture = await install(page, false); await page.goto("/"); await enter(page); await create(page);
  const panel = await rename(page, "访客待恢复图");
  await panel.getByRole("button", { name: "删除记录：访客待恢复图", exact: true }).click();
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("region", { name: "账号", exact: true }).getByRole("button", { name: "登录", exact: true }).click();
  const form = page.getByRole("form", { name: "邮箱账号", exact: true });
  await form.getByLabel("邮箱", { exact: true }).fill("cloud@example.test"); await form.getByLabel("密码", { exact: true }).fill("fixture-password");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0); await enter(page);
  await page.locator(".ink-study__history-dock").hover(); await page.getByRole("button", { name: "设置", exact: true }).click();
  const cloud = page.getByRole("region", { name: "云端工作区", exact: true });
  await expect(cloud.getByRole("status")).toHaveText("已同步到云端"); expect(fixture.remote.graphs).toHaveLength(0);
  await cloud.getByRole("button", { name: "导入访客图及历史", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("cloud-import-confirmation.png") });
  await cloud.getByRole("button", { name: "取消", exact: true }).click(); expect(fixture.imports.size).toBe(0);
  await cloud.getByRole("button", { name: "导入访客图及历史", exact: true }).click();
  await cloud.getByRole("button", { name: "确认导入图及历史", exact: true }).click();
  await expect.poll(() => fixture.imports.size).toBe(1); await expect(cloud.getByRole("status")).toHaveText("已同步到云端");
  expect(fixture.remote.deletedIds).toHaveLength(1); expect(fixture.remote.graphs[0]?.history.events.length).toBeGreaterThan(0);
  await cloud.getByRole("button", { name: "导入访客图及历史", exact: true }).click();
  await cloud.getByRole("button", { name: "确认导入图及历史", exact: true }).click();
  expect(fixture.imports.size).toBe(1); expect(fixture.seenBodies.join("\n")).not.toContain("fixture-private-guest-key");
  const guest = await page.evaluate(async () => {
    const path = "/src/stores/workspace-persistence.ts";
    const module: typeof import("../src/stores/workspace-persistence.js") = await import(path);
    return module.parseWorkspaceSnapshot(await module.accountWorkspaceStorage(null).load());
  });
  expect(guest?.deletedGraphs).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("wayfinder.credentials.v1"))).toContain("fixture-private-guest-key");
});

test("真实IndexedDB多标签CAS拒绝旧代际覆盖，已成功快照仍完整", async ({ page, context }) => {
  await install(page, false); await page.goto("/");
  const second = await context.newPage(); await second.goto("/");
  const prepare = async (target: Page) => target.evaluate(async () => {
    const path = "/src/stores/workspace-persistence.ts";
    const module: typeof import("../src/stores/workspace-persistence.js") = await import(path);
    const storage = module.accountWorkspaceStorage("fixture-CAS"); await storage.load();
    Object.assign(window, { fixtureCasStorage: storage });
  });
  await prepare(page); await prepare(second);
  const write = async (target: Page, name: string) => target.evaluate(async title => {
    const storage = (window as unknown as { fixtureCasStorage: import("../src/stores/workspace-persistence.js").WorkspaceStorage }).fixtureCasStorage;
    try {
      await storage.save({ version: "workspace-storage.v2", currentId: null, documents: [], histories: {}, cloud: { fixture: title }, deletedGraphs: [] });
      return true;
    } catch { return false; }
  }, name);
  expect(await write(page, "first-tab")).toBe(true); expect(await write(second, "stale-second-tab")).toBe(false);
  const result = await page.evaluate(async () => {
    const path = "/src/stores/workspace-persistence.ts";
    const module: typeof import("../src/stores/workspace-persistence.js") = await import(path);
    return module.accountWorkspaceStorage("fixture-CAS").load();
  });
  expect(result).toMatchObject({ cloud: { fixture: "first-tab" }, localGeneration: 1, deletedGraphs: [] });
  await second.close();
});
