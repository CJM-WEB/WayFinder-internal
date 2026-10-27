/**
 * 测试职责：证明本地 Sink 只写仓库固定的 data/runs、可完全关闭，并使用私有权限。
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalRunLogSink,
  RUN_LOG_RELATIVE_DIRECTORY,
} from "./local-run-log-writer.js";
import { RunLogRecordSchema, type RunLogRecord } from "./run-log.js";

const createdRoots: string[] = [];

function createRecord(): RunLogRecord {
  return RunLogRecordSchema.parse({
    schemaVersion: "run-log.v2",
    createdAt: "2026-10-22T00:00:00.000Z",
    identifiers: {
      logId: "00000000-0000-4000-8000-000000000001",
      queryId: "00000000-0000-4000-8000-000000000002",
      planId: null,
    },
    outcome: "failed",
    timingsMs: {
      planning: null,
      nodeProcessing: null,
      total: 0,
      provider: { search: 0, extract: 0, llm: 0 },
    },
    counts: {
      plannedNodes: 0,
      edges: 0,
      resources: 0,
      readyNodes: 0,
      partialNodes: 0,
      failedNodes: 0,
      logicalSearchCalls: 0,
      logicalExtractCalls: 0,
      extractUrlCount: 0,
      logicalLlmCalls: 0,
      searchResultCount: 0,
      extractedPageCount: 0,
      searchHttpAttempts: 0,
      extractHttpAttempts: 0,
    },
    warningCodes: [],
    errorCodes: ["UNKNOWN"],
    versions: {
      protocol: "0.1",
      resultGraph: "0.1",
      plannerPrompt: "graph-planner.v1",
      reviserPrompt: "graph-reviser.v1",
      rerankerPrompt: "resource-reranker.v1",
      rankFusion: "rank-fusion.v1",
    },
    providers: { search: "fake-search", llm: "fake-llm" },
    cache: {
      search: { hitCount: 0, missCount: 0 },
      extract: { hitCount: 0, missCount: 0 },
    },
    ranking: {
      llmSuccess: {
        nodeCount: 0,
        finalCandidateCount: 0,
        providerTop1OverrideCount: 0,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 0,
        heuristicTop3FinalOverlapCount: 0,
        top3ComparisonSlots: 0,
      },
      fallback: {
        nodeCount: 0,
        finalCandidateCount: 0,
        providerTop1OverrideCount: 0,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 0,
        heuristicTop3FinalOverlapCount: 0,
        top3ComparisonSlots: 0,
      },
    },
    tokens: {
      status: "not_used",
      observations: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    estimatedCost: {
      status: "unavailable",
      reason: "pricing_not_frozen",
    },
  });
}

async function createRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wayfinder-run-log-"));
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Local Run Log Sink", () => {
  it("关闭时不创建 data/runs 或其他文件", async () => {
    const root = await createRepositoryRoot();
    const sink = createLocalRunLogSink({ repositoryRoot: root, enabled: false });

    await sink.write(createRecord());

    expect(await readdir(root)).toEqual([]);
  });

  it("只用安全 logId 在 data/runs 写入严格 JSON", async () => {
    const root = await createRepositoryRoot();
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory, { mode: 0o755 });
    const sink = createLocalRunLogSink({ repositoryRoot: root, enabled: true });
    const record = createRecord();

    await sink.write(record);

    const runDirectory = join(root, RUN_LOG_RELATIVE_DIRECTORY);
    const files = await readdir(runDirectory);
    expect(files).toEqual([`${record.identifiers.logId}.json`]);
    const filePath = join(runDirectory, files[0]!);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(record);
    if (process.platform !== "win32") {
      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o755);
      expect((await stat(runDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("额外的 Query、Header 或客户端路径字段在创建目录前被拒绝", async () => {
    const root = await createRepositoryRoot();
    const sink = createLocalRunLogSink({ repositoryRoot: root, enabled: true });
    const unsafe = {
      ...createRecord(),
      runId: "../../outside",
      query: "Authorization: Bearer secret",
      cookie: "session=private",
    } as unknown as RunLogRecord;

    await expect(sink.write(unsafe)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("拒绝 data 符号链接，不能把日志写到仓库外", async () => {
    if (process.platform === "win32") return;
    const root = await createRepositoryRoot();
    const outside = await createRepositoryRoot();
    await symlink(outside, join(root, "data"), "dir");
    const sink = createLocalRunLogSink({ repositoryRoot: root, enabled: true });

    await expect(sink.write(createRecord())).rejects.toThrow(
      "Run Log 路径必须是仓库内真实目录",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("拒绝 data/runs 符号链接，不能把日志写到仓库外", async () => {
    if (process.platform === "win32") return;
    const root = await createRepositoryRoot();
    const outside = await createRepositoryRoot();
    await mkdir(join(root, "data"));
    await symlink(outside, join(root, RUN_LOG_RELATIVE_DIRECTORY), "dir");
    const sink = createLocalRunLogSink({ repositoryRoot: root, enabled: true });

    await expect(sink.write(createRecord())).rejects.toThrow(
      "Run Log 路径必须是仓库内真实目录",
    );
    expect(await readdir(outside)).toEqual([]);
  });
});
