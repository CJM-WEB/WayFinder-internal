/**
 * 测试职责：冻结 WAY-86 Live CLI、工件脱敏与本地私有写入边界。
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualityEvalArtifactSafety,
  createQualityEvalPrivateOutputDirectory,
  initializeQualityEvalPrivateOutput,
  parseQualityEvalCliArgs,
  writeQualityEvalPrivateJson,
} from "./run-quality-eval.js";

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

  it("只创建内部 Run ID 的私有目录与 0600 JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-quality-eval-"));
    const runId = "2026-10-23T00-00-00-000Z-11111111-1111-4111-8111-111111111111";
    const outputDirectory = await createQualityEvalPrivateOutputDirectory(
      root,
      runId,
      root,
    );
    const outputFile = join(outputDirectory, "report.json");
    await writeQualityEvalPrivateJson(outputFile, { status: "ok" });

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({
      status: "ok",
    });
    if (process.platform !== "win32") {
      expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    }
    await expect(
      createQualityEvalPrivateOutputDirectory(root, "../../escape", root),
    ).rejects.toThrow("Run ID 格式无效");
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
