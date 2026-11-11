/**
 * 测试职责：锁定公共协议发布面、确定性字节与代表性 JSON Schema 语义。
 *
 * 关键约束：这里验证结构投影，不宣称 JSON Schema 与 Zod Runtime 接受域完全等价。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createJsonSchemaArtifacts,
  findJsonSchemaDrift,
  parseCliMode,
  renderJsonSchema,
  writeJsonSchemaArtifacts,
} from "./generate-json-schema.mts";

const expectedFileNames = [
  "search-request.schema.json",
  "query-analysis.schema.json",
  "graph-plan.schema.json",
  "stream-event.schema.json",
  "result-graph.schema.json",
  "h2-evaluation-artifact.schema.json",
  "editable-graph.schema.json",
  "search-credentials.schema.json",
  "settings-public-response.schema.json",
  "experience-invite-request.schema.json",
  "experience-status-response.schema.json",
  "credentials-error-response.schema.json",
  "user-id.schema.json",
  "account-action.schema.json",
  "account-response.schema.json",
  "account-error-response.schema.json",
  "stored-graph-history.schema.json",
  "cloud-workspace-response.schema.json",
  "cloud-graph-write-request.schema.json",
  "cloud-graph-write-response.schema.json",
  "cloud-workspace-error-response.schema.json",
] as const;

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wayfinder-json-schema-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsRecord(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): boolean {
  if (Array.isArray(value)) {
    return value.some(item => containsRecord(item, predicate));
  }

  if (!isRecord(value)) {
    return false;
  }

  return predicate(value) || Object.values(value).some(
    item => containsRecord(item, predicate),
  );
}

function parseArtifact(fileName: string): Record<string, unknown> {
  const artifact = createJsonSchemaArtifacts().find(
    candidate => candidate.fileName === fileName,
  );
  expect(artifact, `缺少生成物 ${fileName}`).toBeDefined();

  const parsed: unknown = JSON.parse(artifact?.content ?? "null");
  expect(isRecord(parsed)).toBe(true);
  return isRecord(parsed) ? parsed : {};
}

describe("JSON Schema 纯生成", () => {
  it("只按固定顺序发布批准的外部 Wire 根协议", () => {
    expect(createJsonSchemaArtifacts().map(item => item.fileName)).toEqual(
      expectedFileNames,
    );
  });

  it("连续生成两次得到相同字节与固定格式", () => {
    const first = createJsonSchemaArtifacts();
    const second = createJsonSchemaArtifacts();
    expect(second).toEqual(first);

    for (const artifact of first) {
      expect(artifact.content).not.toContain("\r");
      expect(artifact.content.endsWith("\n")).toBe(true);
      expect(artifact.content.endsWith("\n\n")).toBe(false);
      expect(artifact.content).toBe(
        `${JSON.stringify(JSON.parse(artifact.content) as unknown, null, 2)}\n`,
      );
      expect(artifact.content).not.toContain(process.cwd());
      expect(JSON.parse(artifact.content)).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
    }
  });

  it("保留三个代表性公共协议约束", () => {
    const queryAnalysis = parseArtifact("query-analysis.schema.json");
    expect(queryAnalysis.oneOf).toHaveLength(2);

    const resultGraph = parseArtifact("result-graph.schema.json");
    expect(containsRecord(
      resultGraph,
      record =>
        record.format === "uri" &&
        record.pattern === "^[Hh][Tt][Tt][Pp][Ss]?:\\/\\/",
    )).toBe(true);
    expect(containsRecord(
      resultGraph,
      record => record.uniqueItems === true,
    )).toBe(true);

    const streamEvent = parseArtifact("stream-event.schema.json");
    expect(streamEvent.oneOf).toHaveLength(8);
    expect(
      Array.isArray(streamEvent.oneOf) &&
      streamEvent.oneOf.every(
        branch => isRecord(branch) && branch.additionalProperties === false,
      ),
    ).toBe(true);

    const h2Artifact = parseArtifact("h2-evaluation-artifact.schema.json");
    expect(containsRecord(
      h2Artifact,
      record => record.const === "h2-evaluation.v1",
    )).toBe(true);
  });

  it("不可表达类型失败时报告根 Schema 名称", () => {
    expect(() => renderJsonSchema("UnrepresentableSchema", z.date()))
      .toThrow(/UnrepresentableSchema/);
  });

  it("D9 生成物保留显式来源、严格字段和独立前置错误", () => {
    const credentials = parseArtifact("search-credentials.schema.json");
    expect(credentials).toMatchObject({
      additionalProperties: false,
      required: ["deepseek", "serpapi"],
    });
    expect(containsRecord(credentials, record => record.const === "author")).toBe(true);
    expect(containsRecord(credentials, record => record.pattern === "^[\\x20-\\x7E]+$" && record.maxLength === 4096)).toBe(true);
    expect(parseArtifact("experience-invite-request.schema.json")).toMatchObject({
      additionalProperties: false,
      properties: { inviteCode: { minLength: 1, maxLength: 4096 } },
    });
    expect(parseArtifact("credentials-error-response.schema.json")).toMatchObject({
      additionalProperties: false,
      required: ["code"],
    });
  });
});

describe("JSON Schema 文件与 CLI 边界", () => {
  it("写入全部白名单文件且保留普通文件", async () => {
    const directory = await createTemporaryDirectory();
    await fs.writeFile(path.join(directory, "README.txt"), "keep\n", "utf8");

    await writeJsonSchemaArtifacts(directory);

    expect((await fs.readdir(directory)).sort()).toEqual(
      [...expectedFileNames, "README.txt"].sort(),
    );
    expect(await fs.readFile(path.join(directory, "README.txt"), "utf8"))
      .toBe("keep\n");
  });

  it("完全一致时只读检查通过且不改字节", async () => {
    const directory = await createTemporaryDirectory();
    await writeJsonSchemaArtifacts(directory);
    const before = await Promise.all(expectedFileNames.map(
      fileName => fs.readFile(path.join(directory, fileName)),
    ));

    expect(await findJsonSchemaDrift(directory)).toEqual([]);

    const after = await Promise.all(expectedFileNames.map(
      fileName => fs.readFile(path.join(directory, fileName)),
    ));
    expect(after).toEqual(before);
  });

  it("按稳定顺序报告缺失、内容变化和额外产物", async () => {
    const directory = await createTemporaryDirectory();
    await writeJsonSchemaArtifacts(directory);
    await fs.rm(path.join(directory, expectedFileNames[0]));
    await fs.appendFile(path.join(directory, expectedFileNames[1]), " ", "utf8");
    await fs.writeFile(
      path.join(directory, "obsolete.schema.json"),
      "{}\n",
      "utf8",
    );

    expect(await findJsonSchemaDrift(directory)).toEqual([
      { kind: "missing", fileName: expectedFileNames[0] },
      { kind: "changed", fileName: expectedFileNames[1] },
      { kind: "unexpected", fileName: "obsolete.schema.json" },
    ]);
  });

  it("跨平台一致地把大小写错误同时报告为缺失和额外", async () => {
    const directory = await createTemporaryDirectory();
    await writeJsonSchemaArtifacts(directory);
    const expectedPath = path.join(directory, expectedFileNames[0]);
    const renameBuffer = path.join(directory, "rename-buffer.tmp");
    const wronglyCasedName = "Search-request.schema.json";
    await fs.rename(expectedPath, renameBuffer);
    await fs.rename(renameBuffer, path.join(directory, wronglyCasedName));

    expect(await findJsonSchemaDrift(directory)).toEqual([
      { kind: "missing", fileName: expectedFileNames[0] },
      { kind: "unexpected", fileName: wronglyCasedName },
    ]);
  });

  it("检查缺失目录时报告全部缺失项且不创建目录", async () => {
    const root = await createTemporaryDirectory();
    const missingDirectory = path.join(root, "missing");

    expect(await findJsonSchemaDrift(missingDirectory)).toEqual(
      expectedFileNames.map(fileName => ({ kind: "missing", fileName })),
    );
    await expect(fs.access(missingDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("写入前发现额外 Schema 时整体拒绝且不覆盖或删除", async () => {
    const directory = await createTemporaryDirectory();
    const existingTarget = path.join(directory, expectedFileNames[0]);
    const extraTarget = path.join(directory, "obsolete.schema.json");
    await fs.writeFile(existingTarget, "keep target\n", "utf8");
    await fs.writeFile(extraTarget, "keep extra\n", "utf8");
    const entriesBeforeWrite = (await fs.readdir(directory)).sort();

    await expect(writeJsonSchemaArtifacts(directory)).rejects.toThrow(
      /obsolete\.schema\.json/,
    );
    expect((await fs.readdir(directory)).sort()).toEqual(entriesBeforeWrite);
    expect(await fs.readFile(existingTarget, "utf8")).toBe("keep target\n");
    expect(await fs.readFile(extraTarget, "utf8")).toBe("keep extra\n");
  });

  it.each([
    "obsolete.schema.json",
    expectedFileNames[2],
  ])("写入前拒绝非普通 Schema 条目 %s 且保持目录不变", async entryName => {
    const directory = await createTemporaryDirectory();
    await fs.mkdir(path.join(directory, entryName));
    const entriesBeforeWrite = (await fs.readdir(directory)).sort();
    const expectedDriftKind = expectedFileNames.includes(
      entryName as (typeof expectedFileNames)[number],
    )
      ? "changed"
      : "unexpected";

    expect(await findJsonSchemaDrift(directory)).toContainEqual({
      kind: expectedDriftKind,
      fileName: entryName,
    });
    await expect(writeJsonSchemaArtifacts(directory)).rejects.toThrow(
      new RegExp(entryName.replaceAll(".", "\\.")),
    );
    expect((await fs.readdir(directory)).sort()).toEqual(entriesBeforeWrite);
  });

  it("只接受单个 --write 或 --check 参数", () => {
    expect(parseCliMode(["--write"])).toBe("write");
    expect(parseCliMode(["--check"])).toBe("check");

    for (const args of [[], ["--unknown"], ["--write", "--check"]]) {
      expect(() => parseCliMode(args)).toThrow(/用法/);
    }
  });
});
