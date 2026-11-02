/**
 * E2E 职责：在真实 Chromium 中覆盖统一 Omnibox 到 Graph、Resource Panel 与第二次 Query 的
 * Browser-like 主旅程，并确定性证明旧 Run 取消和过期事件隔离。
 *
 * 测试边界：
 * - Fixture 仅替换浏览器的 `/api/search` fetch，应用仍走真实 Search Coordinator、NDJSON Reader、
 *   Graph Store、React / React Flow 与 Resource Panel；
 * - Stream 由测试显式分段放行，不依赖 sleep、随机时序、Secret 或真实 Provider；
 * - 非 `/api/search` 的 JavaScript fetch 一律拒绝，Resource Open 只记录安全打开意图。
 */
import {
  StreamEventSchema,
  type Resource,
  type SearchLanguage,
  type SearchEngine,
  type StreamEvent,
} from "@wayfinder/contracts";
import { expect, test, type Page } from "@playwright/test";

import { createPythonMockStream } from "../src/testing/python-mock-stream.js";

const FIXTURE_TIME = Date.parse("2026-10-22T00:00:00.000Z");
const FIRST_QUERY = "Python";
const SECOND_QUERY = "TypeScript";
const READY_NODE_ID = "python-introduction";

type BrowserFixtureSnapshot = Readonly<{
  runId: string;
  query: string;
  language: SearchLanguage;
  engine: SearchEngine;
  nodeSearch?: unknown;
  aborted: boolean;
  cancelled: boolean;
}>;

type BrowserOpenCall = readonly [
  url: string,
  target: string,
  features: string,
];

type BrowserFixtureHarness = Readonly<{
  emit: (
    targetRunIndex: number,
    eventIndexes: readonly number[],
    sourceRunIndex?: number,
  ) => void;
  close: (runIndex: number) => void;
  fail: (runIndex: number) => void;
  snapshots: () => readonly BrowserFixtureSnapshot[];
  openCalls: () => readonly BrowserOpenCall[];
}>;

declare global {
  interface Window {
    __WAYFINDER_E2E__: BrowserFixtureHarness;
  }
}

/** 为首个 ready Node 扩充到 4 项资源，只服务于真实 Top 3 / Show More 浏览器断言。 */
function createJourneyEvents(): readonly StreamEvent[] {
  const events = createPythonMockStream({ now: () => FIXTURE_TIME });
  const readyEvent = events.find(
    (event): event is Extract<StreamEvent, { type: "node.ready" }> =>
      event.type === "node.ready" && event.nodeId === READY_NODE_ID,
  );
  const firstResource = readyEvent?.resources[0];
  if (readyEvent?.type !== "node.ready" || firstResource === undefined) {
    throw new Error("Browser-like Fixture 缺少首个 ready Resource");
  }

  const extraResources: readonly Resource[] = [
    {
      ...firstResource,
      id: "resource-python-docs",
      title: "Python Documentation",
      url: "https://docs.python.org/3/",
      canonicalUrl: "https://docs.python.org/3/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 2,
    },
    {
      ...firstResource,
      id: "resource-python-reference-e2e",
      title: "Python Language Reference",
      url: "https://docs.python.org/3/reference/",
      canonicalUrl: "https://docs.python.org/3/reference/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 3,
    },
    {
      ...firstResource,
      id: "resource-python-library-e2e",
      title: "Python Standard Library",
      url: "https://docs.python.org/3/library/",
      canonicalUrl: "https://docs.python.org/3/library/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 4,
    },
  ];
  const resources = [firstResource, ...extraResources];

  return events.map(event => {
    if (event.type === "node.ready" && event.nodeId === READY_NODE_ID) {
      return StreamEventSchema.parse({ ...event, resources });
    }
    if (event.type === "complete") {
      return StreamEventSchema.parse({
        ...event,
        data: {
          ...event.data,
          result: {
            ...event.data.result,
            graph: {
              ...event.data.result.graph,
              nodes: event.data.result.graph.nodes.map(node =>
                node.id === READY_NODE_ID && node.status === "ready"
                  ? { ...node, resources }
                  : node,
              ),
            },
          },
        },
      });
    }
    return event;
  });
}

/**
 * 在页面脚本之前安装可控 Stream。模板事件进入页面后仍会按每次真实 Request 的 runId / Query
 * 重写并逐行编码，因此第二次提交走的是完整的新 Run，而不是直接改 Store 的测试后门。
 */
async function installBrowserFixture(
  page: Page,
  eventTemplates: readonly StreamEvent[],
): Promise<void> {
  await page.addInitScript((templates: readonly StreamEvent[]) => {
    type BrowserRun = {
      runId: string;
      query: string;
      language: SearchLanguage;
      engine: SearchEngine;
      fixtureIndex: number;
      nodeSearch?: unknown;
      targetNode?: { id: string; title: string; description: string };
      signal: AbortSignal;
      controller: ReadableStreamDefaultController<Uint8Array>;
      aborted: boolean;
      cancelled: boolean;
    };

    const runs: BrowserRun[] = [];
    const openCalls: BrowserOpenCall[] = [];
    const encoder = new TextEncoder();

    const sourceNodeId = templates.find(event => event.type === "node.ready")?.nodeId;
    const resourceForRun = (resource: Resource, index: number, run: BrowserRun): Resource => run.targetNode === undefined
      ? { ...resource, engine: run.engine }
      : { ...resource, engine: run.engine, title: `Node result ${run.fixtureIndex}-${index}`,
          url: `https://node-${run.fixtureIndex}.example.com/resource-${index}`,
          canonicalUrl: `https://node-${run.fixtureIndex}.example.com/resource-${index}`,
          domain: `node-${run.fixtureIndex}.example.com` };
    const eventForRun = (template: StreamEvent, run: BrowserRun): StreamEvent => {
      // 固定样例按本次请求标注模拟实际来源，生产来源仍由真实 Adapter 独立验证。
      if (template.type === "complete") {
        const base = template.data.result;
        const initial = base.graph.nodes.find(node => node.id === sourceNodeId);
        const target = run.targetNode;
        if (target !== undefined && initial === undefined) throw new Error("节点固定样例缺少来源");
        return {
          ...template, runId: run.runId,
          data: { ...template.data, ...(target === undefined ? {} : { finalStatus: "complete" as const }), result: {
            ...base, runId: run.runId,
            query: { ...base.query, raw: run.query, normalized: run.query, language: run.language },
            analysis: { ...base.analysis, ...(target === undefined ? {} : { presentationMode: "compact" as const }) },
            meta: { ...base.meta, ...(target === undefined ? {} : { partial: false }) },
            graph: target === undefined ? { ...base.graph, nodes: base.graph.nodes.map(node => ({
              ...node, resources: node.resources.map((resource, index) => resourceForRun(resource, index, run)),
            })) } : { edges: [], nodes: initial === undefined ? [] : [{
              ...initial, id: target.id, title: target.title, description: target.description || target.title,
              nodeType: "primary", layer: 0, resources: initial.resources.map((resource, index) => resourceForRun(resource, index, run)),
            }] },
          } },
        };
      }
      if (run.targetNode !== undefined && template.type === "query.analysis") return {
        ...template, runId: run.runId, data: { ...template.data, presentationMode: "compact" },
      };
      if (run.targetNode !== undefined && template.type === "graph.plan") {
        const base = template.data.nodes.find(node => node.id === sourceNodeId);
        if (base === undefined) throw new Error("节点固定样例缺少计划");
        const target = run.targetNode;
        return { ...template, runId: run.runId, data: {
          ...template.data, analysis: { ...template.data.analysis, presentationMode: "compact" },
          edges: [], nodes: [{ ...base, id: target.id, title: target.title, description: target.description || target.title, nodeType: "primary", layer: 0 }],
        } };
      }
      if (template.type === "node.ready" || template.type === "node.partial") return {
        ...template, runId: run.runId,
        nodeId: run.targetNode !== undefined && template.nodeId === sourceNodeId ? run.targetNode.id : template.nodeId,
        resources: template.resources.map((resource, index) => resourceForRun(resource, index, run)),
      };
      if (template.type === "node.status" && run.targetNode !== undefined && template.nodeId === sourceNodeId) {
        return { ...template, runId: run.runId, nodeId: run.targetNode.id };
      }
      return { ...template, runId: run.runId };
    };

    window.__WAYFINDER_E2E__ = {
      emit(targetRunIndex, eventIndexes, sourceRunIndex = targetRunIndex) {
        const target = runs[targetRunIndex];
        const source = runs[sourceRunIndex];
        if (target === undefined || source === undefined) {
          throw new Error("E2E Stream Run 索引无效");
        }
        for (const eventIndex of eventIndexes) {
          const template = templates[eventIndex];
          if (template === undefined) {
            throw new Error("E2E Stream Event 索引无效");
          }
          const event = eventForRun(template, source);
          target.controller.enqueue(
            encoder.encode(`${JSON.stringify(event)}\n`),
          );
        }
      },
      close(runIndex) {
        const run = runs[runIndex];
        if (run === undefined) throw new Error("E2E Stream Run 索引无效");
        run.controller.close();
      },
      fail(runIndex) {
        const run = runs[runIndex];
        if (run === undefined) throw new Error("固定样例运行不存在");
        run.controller.error(new Error("固定样例模拟网络失败"));
      },
      snapshots: () =>
        runs.map(run => ({
          runId: run.runId,
          query: run.query,
          language: run.language,
          engine: run.engine,
          ...(run.nodeSearch === undefined ? {} : { nodeSearch: run.nodeSearch }),
          aborted: run.aborted,
          cancelled: run.cancelled,
        })),
      openCalls: () => structuredClone(openCalls),
    };

    window.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl =
        input instanceof Request ? input.url : input.toString();
      const url = new URL(requestUrl, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== "/api/search"
      ) {
        throw new Error(`E2E 禁止未声明的 fetch：${url.origin}${url.pathname}`);
      }
      if (typeof init?.body !== "string") {
        throw new Error("E2E Search Request 缺少 JSON Body");
      }
      const body: unknown = JSON.parse(init.body);
      if (
        typeof body !== "object" ||
        body === null ||
        !("runId" in body) ||
        !("query" in body) ||
        !("language" in body)
      ) {
        throw new Error("E2E Search Request 不符合 Fixture 边界");
      }
      const runId = body.runId;
      const query = body.query;
      const language = body.language;
      const engine = "engine" in body ? body.engine : language === "zh-CN" ? "baidu" : "google";
      const signal = init.signal;
      if (
        typeof runId !== "string" ||
        typeof query !== "string" ||
        (language !== "zh-CN" && language !== "en-US") ||
        (engine !== "baidu" && engine !== "google") ||
        !(signal instanceof AbortSignal)
      ) {
        throw new Error("E2E Search Request 不符合 Fixture 边界");
      }

      const rawNodeSearch = "nodeSearch" in body ? body.nodeSearch : undefined;
      let targetNode: BrowserRun["targetNode"];
      if (rawNodeSearch !== undefined) {
        if (typeof rawNodeSearch !== "object" || rawNodeSearch === null || !("node" in rawNodeSearch)) throw new Error("节点请求无效");
        const node = rawNodeSearch.node;
        if (typeof node !== "object" || node === null || !("id" in node) || !("title" in node) || !("description" in node) ||
            typeof node.id !== "string" || typeof node.title !== "string" || typeof node.description !== "string") throw new Error("节点目标无效");
        targetNode = { id: node.id, title: node.title, description: node.description };
      }
      let run: BrowserRun | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          run = {
            runId,
            query,
            language,
            engine,
            fixtureIndex: runs.length,
            ...(targetNode === undefined ? {} : { targetNode, nodeSearch: rawNodeSearch }),
            signal,
            controller,
            aborted: false,
            cancelled: false,
          };
        },
        cancel() {
          if (run !== undefined) run.cancelled = true;
        },
      });
      if (run === undefined) {
        throw new Error("E2E ReadableStream 未同步初始化");
      }
      const currentRun = run;
      currentRun.signal.addEventListener(
        "abort",
        () => {
          currentRun.aborted = true;
        },
        { once: true },
      );
      runs.push(currentRun);

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    };

    window.open = ((
      url?: string | URL,
      target?: string,
      features?: string,
    ): WindowProxy | null => {
      openCalls.push([
        url?.toString() ?? "",
        target ?? "",
        features ?? "",
      ]);
      return null;
    }) as typeof window.open;
  }, eventTemplates);
}

const readFixtureSnapshots = (page: Page) =>
  page.evaluate(() => window.__WAYFINDER_E2E__.snapshots());

const emitFixtureEvents = (
  page: Page,
  targetRunIndex: number,
  eventIndexes: readonly number[],
  sourceRunIndex?: number,
) =>
  page.evaluate(
    ({ target, indexes, source }) =>
      window.__WAYFINDER_E2E__.emit(target, indexes, source),
    {
      target: targetRunIndex,
      indexes: [...eventIndexes],
      ...(sourceRunIndex === undefined ? {} : { source: sourceRunIndex }),
    },
  );

test("新搜索页直接携带语言请求后端且不跳转旧展示页", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/ink-study.html");

  await expect(page.getByText("©26", { exact: true })).toHaveCount(0);
  await expect(page.getByText("浏览", { exact: true })).toHaveCount(0);
  await expect(page.getByText("移动指针，揭开灵感", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "画面导航" })).toHaveCount(0);
  await expect(page.getByText("打造属于自己的互联网", { exact: true })).toBeVisible();

  // 新入口持续保留原画布，仅在实际提交时复用搜索协调器，不跳转旧页面。
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByText("BUILD YOUR OWN INTERNET", { exact: true })).toBeVisible();
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await page.getByRole("button", { name: "Start exploring", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-layer", "explore");
  await expect(page.getByRole("searchbox", { name: "Search any topic", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Language", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Contact author", exact: true })).toBeVisible();
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
  await expect(page).toHaveURL(/\/ink-study\.html$/);

  const queryInput = page.getByRole("searchbox", { name: "Search any topic" });
  await queryInput.fill("TypeScript guides");
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: "TypeScript guides", language: "en-US", engine: "google" });
  await expect(page).toHaveURL(/\/ink-study\.html$/);
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await page.reload();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("开始胶囊连续伸展为搜索框并分裂按钮，品牌下移且角落控件不移动", async ({ page }) => {
  await page.goto("/ink-study.html");
  const shell = page.locator(".ink-study__search");
  const originalShell = await shell.elementHandle();
  const initialShell = await shell.boundingBox();
  const language = page.getByRole("button", { name: "语言", exact: true });
  const contact = page.getByRole("button", { name: "联系作者", exact: true });
  const initialLanguage = await language.boundingBox();
  const initialContact = await contact.boundingBox();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("输入状态预览");
  await expect(input).toHaveValue("输入状态预览");
  const submit = page.getByRole("button", { name: "搜索", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("");
  await expect.poll(async () => {
    const bounds = await submit.boundingBox();
    return bounds === null ? Infinity : Math.abs(bounds.width - bounds.height);
  }).toBeLessThan(1);
  expect(await originalShell?.evaluate(element => element.isConnected)).toBe(true);
  expect((await shell.boundingBox())?.width ?? 0).toBeGreaterThan((initialShell?.width ?? 0) * 3);
  expect(await language.boundingBox()).toEqual(initialLanguage);
  expect(await contact.boundingBox()).toEqual(initialContact);
  await expect.poll(async () => {
    const inputBox = await input.boundingBox();
    const submitBox = await page.locator(".ink-study__search-submit").boundingBox();
    return submitBox !== null && inputBox !== null ? submitBox.x - inputBox.x - inputBox.width : 0;
  }).toBeGreaterThan(8);
  await expect.poll(async () => {
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return title !== null && stage !== null && title.y >= stage.y + stage.height;
  }).toBe(true);
});

test("页面中线引擎胶囊影响真实请求，语言默认与独立覆盖仍遵循原规则", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const engine = page.locator(".ink-study__engine");
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await expect.poll(async () => {
    const engineBounds = await engine.boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return engineBounds === null || stage === null ? Infinity
      : Math.abs(engineBounds.x + engineBounds.width / 2 - stage.x - stage.width / 2);
  }).toBeLessThan(1);
  await engine.getByRole("button", { name: "搜索引擎：百度", exact: true }).click();
  await engine.getByRole("button", { name: "Google", exact: true }).click();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await input.fill("中文 Google");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ language: "zh-CN", engine: "google", query: "中文 Google" });

  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(engine.getByRole("button", { name: "搜索引擎：Google", exact: true })).toBeVisible();
  // 当前 Run 的展示语言仍锁定中文；下一次显式选择可覆盖 English 的默认 Google。
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await engine.getByRole("button", { name: "搜索引擎：Google", exact: true }).click();
  await engine.getByRole("button", { name: "百度", exact: true }).click();
  await input.fill("English Baidu");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[1])
    .toMatchObject({ language: "en-US", engine: "baidu", query: "English Baidu" });
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.evaluate(() => window.__WAYFINDER_E2E__.fail(1));
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(2);
});

test("新搜索入口沿用 Direct 与拒绝规则，不因改版额外请求后端", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("javascript:alert(1)");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await input.fill("https://example.com/docs");
  await input.press("Enter");
  expect(await page.evaluate(() => window.__WAYFINDER_E2E__.openCalls()))
    .toEqual([["https://example.com/docs", "_blank", "noopener,noreferrer"]]);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await expect(page).toHaveURL(/\/ink-study\.html$/);
});

test("后端运行失败明确反馈且不覆盖状态文字，重试和取消继续走原协调器", async ({ page }) => {
  const failure = StreamEventSchema.parse({
    type: "run.failed", runId: "failure-template", sequence: 1, protocolVersion: "0.1",
    timestamp: new Date(FIXTURE_TIME).toISOString(), error: { code: "PLANNER_FAILED", retryable: true },
  });
  await installBrowserFixture(page, [failure]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("计划失败固定样例");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, [0]);
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("本次搜索未完成，请重试。");
  const statusBounds = await page.locator(".ink-study__run-status").boundingBox();
  const errorBounds = await alert.boundingBox();
  expect(errorBounds?.y ?? 0).toBeGreaterThan((statusBounds?.y ?? 0) + (statusBounds?.height ?? 0));
  await input.fill("重新尝试");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await expect(alert).toHaveCount(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]?.aborted).toBe(true);
  await expect(alert).toHaveCount(0);
});

test("冷加载期间的无效输入和 Direct 不会丢弃已确认的合法搜索", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  let releaseModule = (): void => {};
  let moduleRequested = false;
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
  await page.route(/\/src\/api\/workspace-search\.(?:js|ts)/, async route => {
    moduleRequested = true;
    await moduleGate;
    await route.continue();
  });
  try {
    await page.goto("/ink-study.html");
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
    await input.fill("应保留的合法查询");
    await input.press("Enter");
    await expect.poll(() => moduleRequested).toBe(true);
    await input.fill("javascript:alert(1)");
    await input.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await input.fill("https://example.com/docs");
    await input.press("Enter");
    expect(await readFixtureSnapshots(page)).toHaveLength(0);
    releaseModule();
    await expect.poll(async () => (await readFixtureSnapshots(page))[0])
      .toMatchObject({ query: "应保留的合法查询", language: "zh-CN", engine: "baidu" });
    expect(await readFixtureSnapshots(page)).toHaveLength(1);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  } finally {
    releaseModule();
  }
});

test("左箭头原路返回并保留跨语言的输入和引擎选择", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/ink-study.html");
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("保留我的输入");
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Search engine：Google", exact: true }).click();
  await page.getByRole("button", { name: "Baidu", exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 760 });
  await page.getByRole("button", { name: "Back to home", exact: true }).click();
  const start = page.getByRole("button", { name: "Start exploring", exact: true });
  await expect(start).toBeFocused();
  await expect(page.getByRole("button", { name: "Search history", exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const shell = await page.locator(".ink-study__search").boundingBox();
    const button = await start.boundingBox();
    return shell === null || button === null ? Infinity : Math.abs(shell.width - button.width - 2);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return title === null || stage === null ? Infinity : Math.abs(title.y + title.height / 2 - stage.y - stage.height / 2);
  }).toBeLessThan(1);
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
  await start.click();
  await expect(page.getByRole("searchbox", { name: "Search any topic", exact: true })).toHaveValue("保留我的输入");
  await expect(page.getByRole("button", { name: "Search engine：Baidu", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("历史按钮底边悬浮稳定展开，真实只读历史进出与外部焦点恢复正确", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("只读历史记录样例");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  const stage = page.locator(".ink-study__stage");
  const stageBounds = await stage.boundingBox();
  if (stageBounds === null) throw new Error("缺少展示画布");
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  await page.mouse.move(stageBounds.x + stageBounds.width / 2, stageBounds.y + stageBounds.height - 2);
  await expect(toggle.locator("span")).toHaveCSS("opacity", "1");
  await expect(toggle).toHaveCSS("width", "114px");
  expect(await toggle.evaluate(element => element.matches(":hover"))).toBe(true);
  await page.mouse.move(0, 0);
  await expect(toggle.locator("span")).toHaveCSS("opacity", "0");
  await toggle.click();
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await expect(panel).toBeFocused();
  const panelColor = await panel.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(toggle).toHaveCSS("background-color", panelColor);
  await expect.poll(() => toggle.locator("svg").evaluate(element =>
    new DOMMatrix(getComputedStyle(element).transform).a)).toBeLessThan(-0.99);
  await expect(panel.getByRole("heading", { name: "只读历史记录样例", exact: true })).toBeVisible();
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect.poll(async () => {
    const layer = await page.locator(".ink-study__search-layer").boundingBox();
    return layer !== null && layer.y + layer.height <= stageBounds.y;
  }).toBe(true);
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  const language = page.getByRole("button", { name: "语言", exact: true });
  await language.click();
  await expect(panel).toHaveCount(0);
  await expect(language).toBeFocused();
  await expect(language).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await toggle.click();
  await expect(panel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("只读历史记录样例");
  await expect.poll(async () => {
    const bounds = await page.locator(".ink-study__search-layer").boundingBox();
    return bounds === null ? Infinity : Math.abs(bounds.y - stageBounds.y);
  }).toBeLessThan(1);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

test("历史打开时返回首页会取消本页搜索但保留真实记录", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("保留未完成记录");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  const start = page.getByRole("button", { name: "开始探索", exact: true });
  await expect(start).toBeFocused();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await start.click();
  await expect(input).toHaveValue("保留未完成记录");
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("heading", { name: "保留未完成记录", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

test("减弱动态时胶囊直接完成变形并聚焦输入框", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 400 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/ink-study.html");
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "搜索任意主题", exact: true })).toBeFocused();
    await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    expect(title?.y ?? 0).toBeGreaterThan((stage?.y ?? 0) + (stage?.height ?? 0));
  }
});

test("第二层的滑出与滑入均先加速后减速", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/ink-study.html");

  // 点击前安装监听，在动画创建时立即暂停并采样，慢机器也不会错过短暂的离场动画。
  await page.evaluate(() => {
    for (const selector of [".ink-study__intro", ".ink-study__back"]) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error("没有找到过渡元素");
      const capture = (event: TransitionEvent): void => {
        if (event.target !== element || event.propertyName !== "transform") return;
        element.removeEventListener("transitionrun", capture);
        const animation = element.getAnimations().find(candidate =>
          candidate instanceof CSSTransition && candidate.transitionProperty === "transform");
        const timing = animation?.effect?.getTiming();
        if (animation === undefined || timing === undefined || typeof timing.duration !== "number") {
          element.dataset.motionSamples = "没有找到可采样的位移动画";
          return;
        }
        animation.pause();
        const duration = timing.duration;
        const delay = timing.delay ?? 0;
        const leftAt = (fraction: number): number => {
          animation.currentTime = delay + duration * fraction;
          return element.getBoundingClientRect().left;
        };
        const start = leftAt(0);
        const end = leftAt(1);
        element.dataset.motionSamples = JSON.stringify(
          [0.25, 0.5, 0.75].map(fraction => (leftAt(fraction) - start) / (end - start)),
        );
      };
      element.addEventListener("transitionrun", capture);
    }
  });
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  for (const selector of [".ink-study__intro", ".ink-study__back"]) {
    const element = page.locator(selector);
    await expect(element).toHaveAttribute("data-motion-samples", /^\[/);
    const [quarter, middle, threeQuarters] = JSON.parse(await element.getAttribute("data-motion-samples") ?? "[]") as number[];
    expect(quarter).toBeLessThan(0.25);
    expect(middle).toBeCloseTo(0.5, 1);
    expect(threeQuarters).toBeGreaterThan(0.75);
  }
});

test("墨迹页圆角语言面板可收起，联系胶囊悬浮展开并在离开后恢复", async ({ page }) => {
  await page.goto("/ink-study.html");
  const language = page.getByRole("button", { name: "语言", exact: true });
  await language.click();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(language).toBeFocused();
  await expect(language).toHaveAttribute("aria-expanded", "false");
  await language.click();
  await page.getByRole("heading", { name: "WAYFINDER", exact: true }).click({ force: true });
  await expect(language).toHaveAttribute("aria-expanded", "false");

  // 检查真实尺寸和颜色变化，避免只验证 DOM 已经包含邮箱而漏掉悬浮呈现。
  const contact = page.getByRole("button", { name: "联系作者", exact: true });
  const email = contact.getByText("cjmweb@outlook.com", { exact: true });
  const closedWidth = (await contact.boundingBox())?.width ?? 0;
  await expect(email).toHaveCSS("max-width", "0px");
  await contact.hover();
  await expect(contact).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(email).toHaveCSS("opacity", "1");
  await expect.poll(async () => (await contact.boundingBox())?.width ?? 0).toBeGreaterThan(closedWidth + 100);
  await page.mouse.move(0, 0);
  await expect(email).toHaveCSS("opacity", "0");
  await expect.poll(async () => (await contact.boundingBox())?.width ?? 0).toBeCloseTo(closedWidth, 0);
  await expect(contact).toHaveCSS("background-color", "rgb(17, 17, 17)");
});

test("联系作者点击复制真实邮箱，拒绝剪贴板权限时显示失败提示", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "联系作者", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("邮箱已复制");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("cjmweb@outlook.com");
  await expect(page.getByRole("status")).toBeEmpty();

  // 只替换拒绝路径，确认失败不会被误报为成功；真实成功路径使用上面的浏览器剪贴板。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("拒绝测试", "NotAllowedError"); } },
    });
  });
  await page.getByRole("button", { name: "联系作者", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("复制失败，请手动复制邮箱");
});

test("English 选择器控制请求与页面语言，既有 Run 不随下一次选择混语", async ({
  page,
}) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");

  const languageSelector = page.getByRole("combobox", { name: "语言" });
  await languageSelector.selectOption("en-US");

  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const queryInput = page.getByRole("searchbox", {
    name: "Search any topic",
  });
  await queryInput.fill("What is MySQL?");
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(1);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: "What is MySQL?", language: "en-US" });

  const activeRunSelector = page.getByRole("combobox", { name: "Language" });
  await activeRunSelector.selectOption("zh-CN");

  await expect(activeRunSelector).toHaveValue("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("heading", { name: "Search results" }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "搜索结果" })).toHaveCount(0);
});

test("fixture 覆盖 Graph Draft、Resource 交互、取消与第二次 Query", async ({
  page,
}) => {
  const events = createJourneyEvents();
  const analysisIndex = events.findIndex(
    event => event.type === "query.analysis",
  );
  const planIndex = events.findIndex(event => event.type === "graph.plan");
  const readyIndex = events.findIndex(
    event => event.type === "node.ready" && event.nodeId === READY_NODE_ID,
  );
  const statusIndex = events.findIndex(
    event => event.type === "node.status" && event.nodeId === READY_NODE_ID,
  );
  const completeIndex = events.findIndex(event => event.type === "complete");
  if (
    analysisIndex < 0 ||
    planIndex < 0 ||
    readyIndex < 0 ||
    statusIndex < 0 ||
    completeIndex < 0
  ) {
    throw new Error("Browser-like Fixture 事件不完整");
  }

  const externalRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(url.href);
  });
  await installBrowserFixture(page, events);
  await page.goto("/");

  const queryInput = page.getByRole("searchbox", { name: "搜索任意主题" });
  await queryInput.fill(FIRST_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(1);

  // 先只释放 Analysis + Plan，证明 Graph Draft 不等待任何 Node 终态或 complete。
  await emitFixtureEvents(page, 0, [analysisIndex, planIndex]);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);
  await expect(page.getByText("暂无可展示的搜索结果。")).toHaveCount(0);
  await expect(page.getByRole("definition").filter({ hasText: "搜索中" }))
    .toHaveCount(1);

  await emitFixtureEvents(page, 0, [statusIndex]);
  await expect(
    page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`)
      .locator('[data-node-status="searching"]'),
  ).toHaveCount(1);

  await emitFixtureEvents(page, 0, [readyIndex]);
  const readyNode = page.locator(
    `.react-flow__node[data-id="${READY_NODE_ID}"]`,
  );
  await expect(readyNode.locator('[data-node-status="ready"]')).toHaveCount(1);
  await readyNode.click();

  const resourceList = page.getByRole("list", { name: "节点资源" });
  await expect(page.getByRole("heading", { name: "Python 简介" })).toHaveCount(2);
  await expect(resourceList.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByText("Python Standard Library")).toHaveCount(0);

  await page.getByRole("button", { name: "显示更多（1）" }).click();
  await expect(resourceList.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("Python Standard Library")).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(1);

  await page.getByRole("button", {
    name: "在新标签页打开 Python Programming Language",
  }).click();
  await expect.poll(() =>
    page.evaluate(() => window.__WAYFINDER_E2E__.openCalls()),
  ).toEqual([
    ["https://www.python.org/", "_blank", "noopener,noreferrer"],
  ]);

  // 第一条 Stream 保持 pending；第二次提交必须同步取消旧 Signal 并立即取得 Store 所有权。
  await queryInput.fill(SECOND_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(2);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: FIRST_QUERY, aborted: true, cancelled: true });
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY }))
    .toHaveCount(1);
  await expect(page.getByText("暂无可展示的搜索结果。")).toBeVisible();

  // 把旧 Run 的合法 complete 注入新 Reader；随后同一 Stream 的新 Plan 成功出现，证明
  // 旧 complete 已按顺序处理并被 runId Guard 丢弃，而非断言抢在 Reader 之前执行。
  await emitFixtureEvents(page, 1, [completeIndex], 0);
  await emitFixtureEvents(page, 1, [analysisIndex, planIndex]);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);

  // 新 Run 随后走剩余 Fixture Stream，证明旧事件不会破坏 sequence 或终态收敛。
  await emitFixtureEvents(
    page,
    1,
    events.flatMap((_event, index) =>
      index === analysisIndex || index === planIndex ? [] : [index],
    ),
  );
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.getByRole("definition").filter({ hasText: "已完成" }))
    .toHaveCount(1);
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY }))
    .toHaveCount(1);
  expect(externalRequests).toEqual([]);
});

/** 使用真实 IndexedDB 与正式侧栏证明恢复和记录隔离，不把状态直接注入应用仓库。 */
test("本地记录支持切换改名删除恢复，刷新及重新打开后不重新搜索", async ({ page, context }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  const queryInput = page.getByRole("searchbox", { name: "搜索任意主题" });
  const saved = sidebar.getByRole("status");
  await expect(saved).toHaveText("已保存到本浏览器");

  await queryInput.fill(FIRST_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(saved).toHaveText("已保存到本浏览器");
  const firstRecord = sidebar.getByRole("listitem").filter({ has: page.getByRole("button", { name: FIRST_QUERY, exact: true }) });
  await firstRecord.getByRole("button", { name: "重命名", exact: true }).click();
  await firstRecord.getByRole("textbox", { name: "记录名称" }).fill("Python 资料");
  await firstRecord.getByRole("button", { name: "保存名称" }).click();

  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await queryInput.fill(SECOND_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  const planIndexes = events.flatMap((event, index) => event.type === "query.analysis" || event.type === "graph.plan" ? [index] : []);
  await emitFixtureEvents(page, 1, planIndexes);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);
  await sidebar.getByRole("button", { name: "Python 资料", exact: true }).click();
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await expect(page.locator('[data-node-status="ready"]')).toHaveCount(2);

  // 后台新图完成后仍停留在用户选择的旧图。
  await emitFixtureEvents(page, 1, events.flatMap((_event, index) => planIndexes.includes(index) ? [] : [index]));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(saved).toHaveText("已保存到本浏览器");
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await sidebar.getByRole("button", { name: SECOND_QUERY, exact: true }).click();
  const readyNode = page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`);
  await readyNode.click();
  await page.getByRole("button", { name: "显示更多（1）" }).click();
  await expect(page.getByRole("list", { name: "节点资源" }).getByRole("listitem")).toHaveCount(4);
  const positionBefore = await readyNode.evaluate(node => getComputedStyle(node).transform);
  await expect(saved).toHaveText("已保存到本浏览器");

  await page.reload();
  await expect(sidebar.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY })).toHaveCount(1);
  await expect(readyNode).toHaveCSS("transform", positionBefore);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await readyNode.click();
  await page.getByRole("button", { name: "显示更多（1）" }).click();
  const titles = await page.getByRole("list", { name: "节点资源" }).getByRole("heading", { level: 3 }).allTextContents();
  expect(titles).toEqual(["Python Programming Language", "Python Documentation", "Python Language Reference", "Python Standard Library"]);

  await sidebar.getByRole("button", { name: "Python 资料", exact: true }).click();
  const renamedRecord = sidebar.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Python 资料", exact: true }) });
  await renamedRecord.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(sidebar.getByRole("listitem")).toHaveCount(1);
  await sidebar.getByRole("button", { name: "撤销删除记录", exact: true }).click();
  await expect(sidebar.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await expect(saved).toHaveText("已保存到本浏览器");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  const reopened = await context.newPage();
  const searchRequests: string[] = [];
  reopened.on("request", request => { if (new URL(request.url()).pathname === "/api/search") searchRequests.push(request.url()); });
  await reopened.goto("/");
  await expect(reopened.getByRole("complementary", { name: "搜索图记录" }).getByRole("listitem")).toHaveCount(2);
  await expect(reopened.locator(".react-flow__node")).toHaveCount(4);
  await expect(reopened.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  expect(searchRequests).toEqual([]);
  await reopened.close();
});

/** 纯手动编辑走真实界面和持久化，禁止把编辑误接成搜索或模型调用。 */
test("手动节点与资源支持编辑、全图去重定位、拖拽排序和撤销恢复", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  await addNode("资料节点");
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.getByRole("textbox", { name: "节点标题", exact: true }).fill("主要资料");
  await page.getByRole("textbox", { name: "节点说明", exact: true }).fill("用户自行整理的网页");
  await page.getByRole("button", { name: "保存节点", exact: true }).click();
  await expect(page.getByRole("heading", { name: "主要资料", exact: true })).toHaveCount(2);

  for (let index = 0; index < 7; index += 1) {
    await page.getByRole("textbox", { name: "资源 URL", exact: true }).fill(`https://resource-${index}.example.com/page`);
    await page.getByRole("button", { name: "添加资源", exact: true }).click();
  }
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  const resourceList = page.getByRole("list", { name: "节点资源" });
  const cards = resourceList.getByRole("listitem");
  await expect(cards).toHaveCount(7);
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await cards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("我的首个链接");
  await cards.first().getByRole("textbox", { name: "网页说明", exact: true }).fill("我写的网页说明");
  await cards.first().getByRole("textbox", { name: "选用理由", exact: true }).fill("适合当前研究主题");
  await cards.first().getByRole("button", { name: "保存资源", exact: true }).click();
  await expect(cards.first().getByText("我写的网页说明", { exact: true })).toBeVisible();
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await cards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("未保存的草稿");
  await cards.first().getByRole("textbox", { name: "网页说明", exact: true }).fill("取消的说明");
  await cards.first().getByRole("button", { name: "取消编辑", exact: true }).click();
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await expect(cards.first().getByRole("textbox", { name: "资源标题", exact: true })).toHaveValue("我的首个链接");
  await expect(cards.first().getByRole("textbox", { name: "网页说明", exact: true })).toHaveValue("我写的网页说明");
  await cards.first().getByRole("button", { name: "取消编辑", exact: true }).click();

  await addNode("另一个节点");
  await page.getByRole("textbox", { name: "资源 URL", exact: true }).fill("https://resource-0.example.com/page?utm_source=test#section");
  await page.getByRole("button", { name: "添加资源", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("主要资料");
  await page.getByRole("button", { name: "定位已有资源所在节点", exact: true }).click();
  await expect(page.getByRole("heading", { name: "主要资料", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  await expect(cards).toHaveCount(7);

  // 使用浏览器原生拖拽；撤销与重做只恢复数组顺序，不调用搜索。
  const grip = cards.first().locator(".resource-card__drag-handle");
  await grip.scrollIntoViewIfNeeded();
  const gripBounds = await grip.boundingBox();
  if (gripBounds === null) throw new Error("拖拽起点不可见");
  await page.mouse.move(gripBounds.x + gripBounds.width / 2, gripBounds.y + gripBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBounds.x + gripBounds.width / 2 + 12, gripBounds.y + gripBounds.height / 2, { steps: 5 });
  // 长资源卡片位于滚动面板中；拖动保持按下，滚动到真实目标后再释放。
  const dropHeader = cards.nth(1).locator(".resource-card__header");
  await dropHeader.evaluate(element => element.scrollIntoView({ block: "center" }));
  const dropBounds = await dropHeader.boundingBox();
  if (dropBounds === null) throw new Error("拖拽目标不可见");
  await page.mouse.move(dropBounds.x + dropBounds.width / 2, dropBounds.y + dropBounds.height / 2, { steps: 8 });
  await page.mouse.move(dropBounds.x + dropBounds.width / 2 + 1, dropBounds.y + dropBounds.height / 2);
  await page.mouse.up();
  await expect(cards.nth(0).getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await expect(cards.nth(1).getByRole("heading", { level: 3 })).toHaveText("我的首个链接");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("我的首个链接");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await cards.last().getByRole("button", { name: "删除资源", exact: true }).click();
  await expect(cards).toHaveCount(6);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cards).toHaveCount(7);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "主要资料", exact: true }) }).click();
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  await expect(cards).toHaveCount(7);
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await expect(cards.nth(1).getByText("我写的网页说明", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "删除节点", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 布局与关系走真实画布手势；临时拖动只形成一次可撤销提交。 */
test("节点拖动与连线编辑可撤销并持久保存，相关可成环而推荐顺序不可成环", async ({ page }) => {
  const pageErrors: string[] = [];
  const flowWarnings: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "warning" && message.text().includes("[React Flow]")) flowWarnings.push(message.text()); });
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  await addNode("布局甲");
  await addNode("布局乙");
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("布局图");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  const firstNode = page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "布局甲", exact: true }) });
  const secondNode = page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "布局乙", exact: true }) });
  const before = await firstNode.evaluate(element => getComputedStyle(element).transform);
  const heading = firstNode.getByRole("heading", { name: "布局甲", exact: true });
  await heading.scrollIntoViewIfNeeded();
  const bounds = await heading.boundingBox();
  if (bounds === null) throw new Error("节点拖动起点不可见");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 50, { steps: 12 });
  await page.mouse.up();
  await expect(firstNode).not.toHaveCSS("transform", before);
  const after = await firstNode.evaluate(element => getComputedStyle(element).transform);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", before);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", after);
  // 方向键不触发指针 DragStop，也必须保存为独立一步并可恢复。
  await firstNode.focus();
  await firstNode.press("ArrowRight");
  await expect(firstNode).not.toHaveCSS("transform", after);
  const keyboardAfter = await firstNode.evaluate(element => getComputedStyle(element).transform);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", after);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);

  // 同类端口通过原生指针拖线；编辑既有边仍使用相同的确定性关系规则。
  await firstNode.locator('[data-handleid="main-source"]').dragTo(secondNode.locator('[data-handleid="main-target"]'));
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".graph-edge--recommended")).toHaveCount(1);
  await secondNode.locator('[data-handleid="related-source"]').dragTo(firstNode.locator('[data-handleid="related-target"]'));
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const edgeEditor = page.locator(".workspace-edge-editor");
  await edgeEditor.locator("summary").click();
  const edgeSelector = edgeEditor.getByRole("combobox", { name: "选择连线", exact: true });
  const firstEdgeId = await edgeSelector.locator("option").nth(1).getAttribute("value");
  if (firstEdgeId === null) throw new Error("缺少测试连线");
  await edgeSelector.selectOption(firstEdgeId);
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("related_to");
  await edgeEditor.getByRole("button", { name: "保存连线", exact: true }).click();
  await expect(page.locator(".graph-edge--related")).toHaveCount(2);
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("recommended_next");
  await edgeEditor.getByRole("button", { name: "保存连线", exact: true }).click();
  await expect(page.locator(".graph-edge--recommended")).toHaveCount(1);

  await edgeSelector.selectOption("");
  await edgeEditor.getByRole("combobox", { name: "起点节点", exact: true }).selectOption({ label: "布局乙" });
  await edgeEditor.getByRole("combobox", { name: "终点节点", exact: true }).selectOption({ label: "布局甲" });
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("recommended_next");
  await edgeEditor.getByRole("button", { name: "添加连线", exact: true }).click();
  await expect(edgeEditor.getByRole("alert")).toContainText("推荐下一步不能形成环");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await edgeSelector.selectOption(firstEdgeId);
  await edgeEditor.getByRole("button", { name: "删除连线", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  // 原生 Delete 键不绕过显式删除入口，不允许画布与保存的数据出现两套内容。
  await firstNode.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await addNode("其他记录节点");
  await sidebar.getByRole("button", { name: "布局图", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.reload();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  expect(pageErrors).toEqual([]);
  expect(flowWarnings).toEqual([]);
});

/** 引擎覆盖只影响下一次请求，偏好与资源实际来源分开，所有响应均为本地固定样例。 */
test("引擎随语言默认且可独立覆盖，节点偏好保存而旧资源来源不变", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await expect(page.getByRole("combobox", { name: "搜索引擎", exact: true })).toHaveValue("baidu");
  await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("en-US");
  const globalEngine = page.getByRole("combobox", { name: "Search engine", exact: true });
  await expect(globalEngine).toHaveValue("google");
  await globalEngine.selectOption("baidu");
  await expect(page.getByRole("note")).toHaveText("Baidu does not guarantee regional targeting.");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  await page.getByRole("searchbox", { name: "Search any topic" }).fill("Engine fixture");
  await page.getByRole("searchbox", { name: "Search any topic" }).press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ language: "en-US", engine: "baidu" });
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  const firstCard = page.getByRole("list", { name: "Node resources" }).getByRole("listitem").first();
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  await globalEngine.selectOption("google");
  await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en-US");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  const nodeEngine = page.getByRole("combobox", { name: "Node search engine", exact: true });
  await expect(nodeEngine).toHaveValue("google");
  await nodeEngine.selectOption("baidu");
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await expect(page.getByRole("complementary", { name: "Search graphs", exact: true }).getByRole("status")).toHaveText("Saved in this browser");

  await page.reload();
  await expect(globalEngine).toHaveValue("google");
  await page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  await expect(nodeEngine).toHaveValue("baidu");
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});


/** 缺少显式引擎的人工图撤销后恢复语言默认，不能泄漏空页偏好。 */
test("手动图引擎选择撤销后全局与节点均恢复语言默认", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("未选引擎节点");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  const globalEngine = page.getByRole("combobox", { name: "搜索引擎", exact: true });
  const nodeEngine = page.getByRole("combobox", { name: "节点搜索引擎", exact: true });
  await expect(globalEngine).toHaveValue("baidu");
  await expect(nodeEngine).toHaveValue("baidu");
  await globalEngine.selectOption("google");
  await expect(nodeEngine).toHaveValue("google");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(globalEngine).toHaveValue("baidu");
  await expect(nodeEngine).toHaveValue("baidu");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 重搜全链路仍用同一可控 NDJSON 流，旧工作图只在明确应用时更新。 */
test("重搜预览支持弃用取消失败、追加和替换，完整旧图可撤销并刷新恢复", async ({ page }) => {
  const events = createJourneyEvents();
  const indexes = events.map((_event, index) => index);
  const completeIndex = events.findIndex(event => event.type === "complete");
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const working = page.locator(".graph-section");
  const preview = page.getByRole("region", { name: "重搜预览", exact: true });
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  const addUrl = async (url: string): Promise<void> => {
    await working.getByRole("textbox", { name: "资源 URL", exact: true }).fill(url);
    await working.getByRole("button", { name: "添加资源", exact: true }).click();
  };
  const researchNode = async (index: number): Promise<void> => {
    await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
    await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(index + 1);
  };
  const finish = async (index: number): Promise<void> => {
    await emitFixtureEvents(page, index, indexes);
    await page.evaluate(target => window.__WAYFINDER_E2E__.close(target), index);
    await expect(preview.getByRole("button", { name: "应用替换", exact: true })).toBeVisible();
  };
  await addNode("重搜主题");
  const targetNode = working.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "重搜主题", exact: true }) });
  const targetId = await targetNode.getAttribute("data-id");
  await addUrl("https://original.example.com/");
  await working.getByRole("combobox", { name: "节点搜索引擎", exact: true }).selectOption("google");
  await addNode("保留节点");
  const otherNode = working.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "保留节点", exact: true }) });
  await addUrl("https://keep.example.com/");
  await targetNode.click();
  const oldCards = working.getByRole("list", { name: "节点资源" }).getByRole("listitem");

  await researchNode(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ query: "重搜主题", engine: "google", language: "zh-CN", nodeSearch: { node: { id: targetId, title: "重搜主题", description: "" }, analysis: null } });
  await expect(oldCards).toHaveCount(1);
  await preview.getByRole("button", { name: "取消重搜", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ aborted: true, cancelled: true });
  await expect(preview).toHaveCount(0);
  await researchNode(1);
  await page.evaluate(() => window.__WAYFINDER_E2E__.fail(1));
  await expect(preview.getByRole("alert")).toContainText("当前图保持不变");
  await expect(oldCards).toHaveCount(1);
  await preview.getByRole("button", { name: "弃用新结果", exact: true }).click();

  await researchNode(2);
  await emitFixtureEvents(page, 2, [completeIndex], 0);
  await expect(preview.getByRole("button", { name: "取消重搜", exact: true })).toBeVisible();
  await finish(2);
  await expect(oldCards).toHaveCount(1);
  // 即使绕过原生长度限制，完整输入校验也应保留已就绪的旧预览，而不是取消后才拒绝。
  const topicField = page.getByRole("textbox", { name: "搜索主题", exact: true });
  await topicField.evaluate(element => element.removeAttribute("maxlength"));
  await topicField.fill("长".repeat(2001));
  await page.getByRole("button", { name: "重新搜索全图", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "搜索主题须为 1 至 2000 个字符" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "应用替换", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(3);
  expect((await readFixtureSnapshots(page))[2]?.aborted).toBe(false);
  await topicField.fill("");
  await topicField.evaluate(element => element.setAttribute("maxlength", "2000"));
  const duplicateIds = await page.locator("[id]").evaluateAll(elements => {
    const ids = elements.map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);
  await preview.getByRole("button", { name: "弃用新结果", exact: true }).click();
  await expect(oldCards).toHaveCount(1);

  await researchNode(3);
  await finish(3);
  await preview.getByRole("button", { name: "追加到此节点", exact: true }).click();
  await working.getByRole("button", { name: "显示更多（2）", exact: true }).click();
  await expect(oldCards).toHaveCount(5);
  await researchNode(4);
  await finish(4);
  await preview.getByRole("button", { name: "追加到此节点", exact: true }).click();
  await expect(oldCards).toHaveCount(9);
  await oldCards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await oldCards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("人工改写的旧资源");
  await oldCards.first().getByRole("button", { name: "保存资源", exact: true }).click();
  await researchNode(5);
  await finish(5);
  // 预览之后又在其他节点加入候选 URL，应用时必须重新去重。
  await otherNode.click();
  await addUrl("https://node-5.example.com/resource-0");
  await preview.getByRole("button", { name: "应用替换", exact: true }).click();
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  await expect(working.getByRole("heading", { name: "人工改写的旧资源", exact: true })).toHaveCount(0);
  await expect(oldCards.getByRole("heading", { level: 3 })).toHaveText(["Node result 5-1", "Node result 5-2", "Node result 5-3"]);
  await expect(page.getByRole("definition").filter({ hasText: "已完成" })).toHaveCount(1);

  const edgeEditor = page.locator(".workspace-edge-editor");
  await edgeEditor.locator("summary").click();
  await edgeEditor.getByRole("button", { name: "添加连线", exact: true }).click();
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  const position = await targetNode.evaluate(element => getComputedStyle(element).transform);
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("完整重搜主题");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("button", { name: "重新搜索全图", exact: true })).toBeDisabled();
  expect(await readFixtureSnapshots(page)).toHaveLength(6);
  await page.getByRole("textbox", { name: "搜索主题", exact: true }).fill("明确填写的全图主题");
  await page.getByRole("button", { name: "重新搜索全图", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(7);
  expect((await readFixtureSnapshots(page))[6]?.nodeSearch).toBeUndefined();
  expect((await readFixtureSnapshots(page))[6]?.query).toBe("明确填写的全图主题");
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await finish(6);
  await expect(preview.getByRole("button", { name: "追加到此节点", exact: true })).toHaveCount(0);
  await expect(preview.locator(".react-flow__node")).toHaveCount(4);
  await preview.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  expect(await page.locator("[id]").evaluateAll(elements => {
    const ids = elements.map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);
  await preview.getByRole("button", { name: "应用替换", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(4);
  await expect(targetNode).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  await expect(targetNode).toHaveCSS("transform", position);
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  await expect(working.getByRole("combobox", { name: "节点搜索引擎", exact: true })).toHaveValue("google");
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.reload();
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  await expect(targetNode).toHaveCSS("transform", position);
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 删除目标或离开所属记录立即中止临时请求，不把晚到结果写入新记录。 */
test("重搜期间删除目标或切换记录会取消请求且不复活旧节点", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("取消目标");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("原图");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  const working = page.locator(".graph-section");
  const preview = page.getByRole("region", { name: "重搜预览", exact: true });
  await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await working.getByRole("button", { name: "删除节点", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ aborted: true, cancelled: true });
  await expect(working.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(1);
  await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]).toMatchObject({ aborted: true, cancelled: true });
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("别的图");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(1);
  await expect(working.getByRole("heading", { name: "别的图", exact: true })).toHaveCount(2);
  await sidebar.getByRole("button", { name: "原图", exact: true }).click();
  await expect(working.getByRole("heading", { name: "取消目标", exact: true })).toHaveCount(2);
  await expect(working.getByRole("list", { name: "节点资源" })).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(2);
});
