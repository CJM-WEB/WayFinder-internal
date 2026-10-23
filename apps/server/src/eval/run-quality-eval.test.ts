/**
 * 测试职责：冻结 WAY-86 Live CLI、工件脱敏与本地私有写入边界。
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualityEvalArtifactSafety,
  createQualityEvalPrivateOutputDirectory,
  initializeQualityEvalPrivateOutput,
  parseQualityEvalCliArgs,
  writeQualityEvalFinalArtifacts,
  writeQualityEvalPrivateJson,
  writeQualityEvalPrivateText,
} from "./run-quality-eval.js";

type FinalArtifact =
  | "report"
  | "operatingSummary"
  | "humanReview"
  | "completed";

function createFinalArtifactWriters(
  write: (artifact: FinalArtifact) => Promise<void>,
) {
  return {
    writeReport: () => write("report"),
    writeOperatingSummary: () => write("operatingSummary"),
    writeHumanReview: () => write("humanReview"),
    writeCompletedState: () => write("completed"),
  };
}

describe("WAY-86 Quality Eval Live 闸门", () => {
  it.each([
    { args: [] },
    { args: ["--live"] },
    { args: ["--dataset=golden"] },
    { args: ["--live", "--dataset=unknown"] },
    { args: ["--live", "--dataset=full", "--extra"] },
  ])("拒绝参数 $args", ({ args }) => {
    expect(() => parseQualityEvalCliArgs(args)).toThrow(
      "Quality Eval 仅接受",
    );
  });

  it("用同一入口选择 Golden 或 Full", () => {
    expect(parseQualityEvalCliArgs(["--live", "--dataset=golden"])).toEqual({
      dataset: "golden",
    });
    expect(
      parseQualityEvalCliArgs(["--", "--dataset=full", "--live"]),
    ).toEqual({ dataset: "full" });
  });
});

describe("WAY-86 Quality Eval 工件安全", () => {
  it("拒绝禁止字段与实际 Secret 值", () => {
    expect(() =>
      assertQualityEvalArtifactSafety({ rawMetadata: {} }, []),
    ).toThrow("禁止字段");
    expect(() =>
      assertQualityEvalArtifactSafety({ safe: "prefix-secret-value" }, [
        "secret-value",
      ]),
    ).toThrow("敏感值");
    expect(() =>
      assertQualityEvalArtifactSafety(
        {
          topResources: [
            {
              title: "公开标题",
              canonicalUrl: "https://example.com/resource",
              summary: "公开产品摘要",
              whySelected: "公开选择理由",
            },
          ],
        },
        [],
      ),
    ).not.toThrow();
    expect(() =>
      assertQualityEvalArtifactSafety(
        { url: "https://alice:password@example.com/resource" },
        [],
      ),
    ).toThrow("userinfo");
    expect(() =>
      assertQualityEvalArtifactSafety(
        { url: "https://example.com/resource?access_token=sensitive" },
        [],
      ),
    ).toThrow("Quality Eval 工件");
    expect(() =>
      assertQualityEvalArtifactSafety(
        { summary: "Authorization: Bearer sensitive" },
        [],
      ),
    ).toThrow("凭据形态文本");
    expect(() =>
      assertQualityEvalArtifactSafety(
        { summary: "password: enumerable-value" },
        [],
      ),
    ).toThrow("凭据形态文本");
  });

  it("只创建内部 Run ID 的私有目录与 0600 JSON / Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-quality-eval-"));
    const runId = "2026-10-23T00-00-00-000Z-11111111-1111-4111-8111-111111111111";
    const outputDirectory = await createQualityEvalPrivateOutputDirectory(
      root,
      runId,
      root,
    );
    const outputFile = join(outputDirectory, "report.json");
    const reviewFile = join(outputDirectory, "human-review.md");
    await writeQualityEvalPrivateJson(outputFile, { status: "ok" });
    await writeQualityEvalPrivateText(reviewFile, "# 人工评审\n");

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({
      status: "ok",
    });
    expect(await readFile(reviewFile, "utf8")).toBe("# 人工评审\n");
    if (process.platform !== "win32") {
      expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
      expect((await stat(reviewFile)).mode & 0o777).toBe(0o600);
    }
    await expect(
      createQualityEvalPrivateOutputDirectory(root, "../../escape", root),
    ).rejects.toThrow("Run ID 格式无效");
  });

  it.runIf(process.platform !== "win32")(
    "覆盖已有文件时仍把权限收紧为 0600",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "wayfinder-quality-mode-"));
      const outputFile = join(root, "human-review.md");
      await writeFile(outputFile, "旧内容", "utf8");
      await chmod(outputFile, 0o644);

      await writeQualityEvalPrivateText(outputFile, "新内容");

      expect(await readFile(outputFile, "utf8")).toBe("新内容");
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    },
  );

  it.each(["report", "operatingSummary", "humanReview"] as const)(
    "%s 写入失败时立即停止后续工件",
    async failedArtifact => {
      const calls: string[] = [];
      const write = (artifact: string): Promise<void> => {
        calls.push(artifact);
        return artifact === failedArtifact
          ? Promise.reject(new Error("固定测试错误"))
          : Promise.resolve();
      };

      await expect(
        writeQualityEvalFinalArtifacts(
          createFinalArtifactWriters(write),
          new AbortController().signal,
        ),
      ).rejects.toThrow("固定测试错误");
      const expectedCalls = {
        report: ["report"],
        operatingSummary: ["report", "operatingSummary"],
        humanReview: ["report", "operatingSummary", "humanReview"],
      } as const;
      expect(calls).toEqual(expectedCalls[failedArtifact]);
    },
  );

  it("开始写入前已取消时不创建最终工件", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeQualityEvalFinalArtifacts(
        createFinalArtifactWriters(artifact => {
          calls.push(artifact);
          return Promise.resolve();
        }),
        controller.signal,
      ),
    ).rejects.toThrow("Quality Eval 已取消");
    expect(calls).toEqual([]);
  });

  it("最终工件写入期间取消时不写 completed 状态", async () => {
    const calls: string[] = [];
    const controller = new AbortController();

    await expect(
      writeQualityEvalFinalArtifacts(
        createFinalArtifactWriters(artifact => {
          calls.push(artifact);
          if (artifact === "humanReview") controller.abort();
          return Promise.resolve();
        }),
        controller.signal,
      ),
    ).rejects.toThrow("Quality Eval 已取消");
    expect(calls).toEqual(["report", "operatingSummary", "humanReview"]);
  });

  it("运行摘要写入期间取消时不继续写人工表或 completed", async () => {
    const calls: string[] = [];
    const controller = new AbortController();

    await expect(
      writeQualityEvalFinalArtifacts(
        createFinalArtifactWriters(artifact => {
          calls.push(artifact);
          if (artifact === "operatingSummary") controller.abort();
          return Promise.resolve();
        }),
        controller.signal,
      ),
    ).rejects.toThrow("Quality Eval 已取消");
    expect(calls).toEqual(["report", "operatingSummary"]);
  });

  it("completed 写入期间取消时把控制权交回取消状态路径", async () => {
    const calls: string[] = [];
    const controller = new AbortController();

    await expect(
      writeQualityEvalFinalArtifacts(
        createFinalArtifactWriters(artifact => {
          calls.push(artifact);
          if (artifact === "completed") controller.abort();
          return Promise.resolve();
        }),
        controller.signal,
      ),
    ).rejects.toThrow("Quality Eval 已取消");
    expect(calls).toEqual([
      "report",
      "operatingSummary",
      "humanReview",
      "completed",
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "拒绝结果根目录或其父级通过符号链接逃逸",
    async () => {
      const anchor = await mkdtemp(join(tmpdir(), "wayfinder-quality-anchor-"));
      const external = await mkdtemp(join(tmpdir(), "wayfinder-quality-external-"));
      const runId = "2026-10-23T00-00-00-000Z-22222222-2222-4222-8222-222222222222";

      const directLink = join(anchor, "direct-link");
      await symlink(external, directLink, "dir");
      await expect(
        createQualityEvalPrivateOutputDirectory(directLink, runId, anchor),
      ).rejects.toThrow("不得包含符号链接");

      const parentLink = join(anchor, "parent-link");
      await symlink(external, parentLink, "dir");
      await expect(
        createQualityEvalPrivateOutputDirectory(
          join(parentLink, "eval-results", "way-86"),
          runId,
          anchor,
        ),
      ).rejects.toThrow("不得包含符号链接");
      expect(await readdir(external)).toEqual([]);

      // 正常的真实目录仍可递归创建，避免把安全检查变成不可用门禁。
      const safeRoot = join(anchor, "data", "eval-results", "way-86");
      await mkdir(join(anchor, "data"));
      await expect(
        createQualityEvalPrivateOutputDirectory(safeRoot, runId, anchor),
      ).resolves.toBe(join(safeRoot, runId));
    },
  );

  it("把包含个人路径的底层初始化错误收口为固定文案", async () => {
    const sensitivePath = "/Users/private-person/eval-output";
    const result = initializeQualityEvalPrivateOutput(
      () => Promise.reject(new Error(`mkdir ${sensitivePath}`)),
      () => Promise.resolve(),
    );

    await expect(result).rejects.toThrow("无法创建 Quality Eval 私有输出目录");
    await expect(result).rejects.not.toThrow(sensitivePath);
  });
});
