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
      signal: AbortSignal;
      controller: ReadableStreamDefaultController<Uint8Array>;
      aborted: boolean;
      cancelled: boolean;
    };

    const runs: BrowserRun[] = [];
    const openCalls: BrowserOpenCall[] = [];
    const encoder = new TextEncoder();

    const eventForRun = (template: StreamEvent, run: BrowserRun): StreamEvent =>
      template.type === "complete"
        ? {
            ...template,
            runId: run.runId,
            data: {
              ...template.data,
              result: {
                ...template.data.result,
                runId: run.runId,
                query: {
                  ...template.data.result.query,
                  raw: run.query,
                  normalized: run.query,
                  language: run.language,
                },
              },
            },
          }
        : { ...template, runId: run.runId };

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
      snapshots: () =>
        runs.map(run => ({
          runId: run.runId,
          query: run.query,
          language: run.language,
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
      const signal = init.signal;
      if (
        typeof runId !== "string" ||
        typeof query !== "string" ||
        (language !== "zh-CN" && language !== "en-US") ||
        !(signal instanceof AbortSignal)
      ) {
        throw new Error("E2E Search Request 不符合 Fixture 边界");
      }

      let run: BrowserRun | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          run = {
            runId,
            query,
            language,
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
