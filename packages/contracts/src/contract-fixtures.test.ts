/**
 * 测试职责：验证 WAY-26 的固定 JSON Fixture 覆盖公共协议正向形状与关键失败边界。
 *
 * 关键约束：
 * - Fixture 必须作为 unknown 读取，并经过对应 Zod Schema 校验后才能使用。
 * - 负例只锁定 issue code 与 path，不把错误文案或 issue 顺序升级为公共 Contract。
 * - 跨对象关系必须由 ResultGraphSchema 的运行时校验负责，不能误用生成的 JSON Schema。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GraphPlanSchema,
  ResourceSchema,
  ResultGraphNodeSchema,
  ResultGraphSchema,
  SearchPlanSchema,
  StreamEventSchema,
} from "./index.js";

const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/contracts/", import.meta.url),
);

const expectedStreamEventTypes = [
  "query.analysis",
  "graph.plan",
  "node.status",
  "node.ready",
  "node.partial",
  "node.failed",
  "complete",
  "run.failed",
] as const;

const expectedNegativeCaseNames = [
  "empty-provider-hints",
  "unsafe-resource-url",
  "duplicate-resource-id",
  "duplicate-resource-rank",
  "duplicate-resource-across-nodes",
  "bad-edge-target",
  "invalid-result-node-status",
  "wrong-meta-partial",
] as const;

const validResultGraphFixturesSchema = z.strictObject({
  ready: ResultGraphSchema,
  partial: ResultGraphSchema,
  failed: ResultGraphSchema,
});

const invalidContractCaseSchema = z.strictObject({
  name: z.enum(expectedNegativeCaseNames),
  schema: z.enum([
    "searchPlan",
    "resource",
    "resultGraphNode",
    "resultGraph",
  ]),
  expectedIssue: z.strictObject({
    code: z.string().min(1),
    path: z.array(z.union([z.string(), z.number().int()])),
  }),
  input: z.record(z.string(), z.unknown()),
});

const invalidContractFixturesSchema = z.array(invalidContractCaseSchema);

const boundarySchemas = {
  searchPlan: SearchPlanSchema,
  resource: ResourceSchema,
  resultGraphNode: ResultGraphNodeSchema,
  resultGraph: ResultGraphSchema,
} as const;

async function readJsonFixture(fileName: string): Promise<unknown> {
  const content = await readFile(path.join(fixtureDirectory, fileName), "utf8");
  return JSON.parse(content) as unknown;
}

describe("正向 Contract Fixture", () => {
  it("接受完整 GraphPlan", async () => {
    const fixture = await readJsonFixture("graph-plan.valid.json");
    expect(GraphPlanSchema.parse(fixture)).toEqual(fixture);
  });

  it("接受分别表达 ready、partial 与 failed 的 ResultGraph", async () => {
    const fixture = await readJsonFixture("result-graphs.valid.json");
    const resultGraphs = validResultGraphFixturesSchema.parse(fixture);

    expect(resultGraphs.ready.graph.nodes.map(node => node.status))
      .toEqual(["ready"]);
    expect(resultGraphs.partial.graph.nodes.map(node => node.status))
      .toEqual(["partial"]);
    expect(resultGraphs.failed.graph.nodes.map(node => node.status))
      .toEqual(["failed"]);
  });

  it("接受八种且仅八种 StreamEvent", async () => {
    const fixture = await readJsonFixture("stream-events.valid.json");
    const events = z.array(StreamEventSchema).parse(fixture);

    expect(events.map(event => event.type)).toEqual(expectedStreamEventTypes);
  });
});

describe("负向 Contract Fixture", () => {
  it("在各自 Schema 的预期 issue path 拒绝非法输入", async () => {
    const fixture = await readJsonFixture("contract-cases.invalid.json");
    const cases = invalidContractFixturesSchema.parse(fixture);

    expect(cases.map(testCase => testCase.name))
      .toEqual(expectedNegativeCaseNames);

    for (const testCase of cases) {
      const result = boundarySchemas[testCase.schema].safeParse(testCase.input);
      expect(result.success, testCase.name).toBe(false);

      if (!result.success) {
        expect(result.error.issues, testCase.name).toEqual(
          expect.arrayContaining([
            expect.objectContaining(testCase.expectedIssue),
          ]),
        );
      }
    }
  });
});
