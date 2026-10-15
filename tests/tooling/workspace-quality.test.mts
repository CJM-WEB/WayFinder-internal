/**
 * 测试职责：防止 WAY-16 的质量门禁退化为缺包、缺脚本或宽松配置下的绿色空跑。
 *
 * 关键约束：测试只读取仓库配置，不依赖被忽略的本地文档，也不修改文件或 Git 状态。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const workspaces = [
  { directory: "packages/contracts", name: "@wayfinder/contracts" },
  { directory: "apps/web", name: "@wayfinder/web" },
  { directory: "apps/server", name: "@wayfinder/server" },
] as const;

const qualityScriptNames = ["lint", "typecheck", "test", "build"] as const;

const forbiddenScriptFragments = ["--if-present", "--passWithNoTests"] as const;

const strictSubOptions = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
] as const satisfies readonly (keyof ts.CompilerOptions)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScripts(packageJsonPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    throw new Error(`缺少 scripts 对象：${packageJsonPath}`);
  }

  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.scripts)) {
    if (typeof value === "string") {
      scripts[name] = value;
    }
  }

  return scripts;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )
    .join("\n");
}

/** 使用 TypeScript 官方 API 解析 extends 之后真正生效的编译选项。 */
function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configResult.error) {
    throw new Error(formatDiagnostics([configResult.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configResult.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );

  // 18003 只表示当前还没有源码；任务 1 建配置时允许它，其余配置错误仍必须失败。
  const relevantErrors = parsed.errors.filter(
    (diagnostic) => diagnostic.code !== 18003,
  );

  if (relevantErrors.length > 0) {
    throw new Error(formatDiagnostics(relevantErrors));
  }

  return parsed.options;
}

function normalizedRuleSeverity(rule: unknown): unknown {
  return Array.isArray(rule) ? rule[0] : rule;
}

describe("Workspace 质量脚本", () => {
  it("要求三个 Workspace 都提供四个不可静默跳过的质量脚本", () => {
    for (const workspace of workspaces) {
      const scripts = readScripts(
        path.join(repositoryRoot, workspace.directory, "package.json"),
      );

      for (const scriptName of qualityScriptNames) {
        expect(scripts[scriptName], `${workspace.name} 缺少 ${scriptName}`).toBeTruthy();

        for (const fragment of forbiddenScriptFragments) {
          expect(scripts[scriptName]).not.toContain(fragment);
        }
      }
    }
  });

  it("要求根质量入口精确调用每个 Workspace 并在零匹配时失败", () => {
    const rootScripts = readScripts(path.join(repositoryRoot, "package.json"));

    for (const scriptName of qualityScriptNames) {
      const rootScript = rootScripts[scriptName];
      expect(rootScript, `根目录缺少 ${scriptName}`).toBeTruthy();

      for (const workspace of workspaces) {
        expect(rootScript).toContain(
          `pnpm --filter ${workspace.name} --fail-if-no-match run ${scriptName}`,
        );
      }

      for (const fragment of forbiddenScriptFragments) {
        expect(rootScript).not.toContain(fragment);
      }
    }
  });
});

describe("Workspace TypeScript 配置", () => {
  it("要求完整检查与生产构建配置都启用 strict", () => {
    for (const workspace of workspaces) {
      for (const configName of ["tsconfig.json", "tsconfig.build.json"] as const) {
        const options = readCompilerOptions(
          path.join(repositoryRoot, workspace.directory, configName),
        );

        expect(
          options.strict,
          `${workspace.name}/${configName} 未启用 strict`,
        ).toBe(true);
        for (const optionName of strictSubOptions) {
          expect(
            options[optionName],
            `${workspace.name}/${configName} 显式关闭了 ${optionName}`,
          ).not.toBe(false);
        }
      }
    }
  });

  it("要求生产构建使用 NodeNext 和显式环境白名单", () => {
    for (const workspace of workspaces) {
      const options = readCompilerOptions(
        path.join(repositoryRoot, workspace.directory, "tsconfig.build.json"),
      );

      expect(options.module).toBe(ts.ModuleKind.NodeNext);
      expect(options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
      expect(options.types).toEqual([]);
      expect(
        options.lib?.some(
          (libraryPath) =>
            path.basename(libraryPath).toLowerCase() === "lib.es2023.d.ts",
        ),
      ).toBe(true);
    }
  });
});

describe("ESLint TypeScript 规则", () => {
  it("把显式 any 作为真正的 error 报告", async () => {
    const eslint = new ESLint({ cwd: repositoryRoot });
    const representativeFile = path.join(
      repositoryRoot,
      "packages/contracts/src/index.ts",
    );
    const config = await eslint.calculateConfigForFile(representativeFile);

    expect(
      normalizedRuleSeverity(
        config?.rules?.["@typescript-eslint/no-explicit-any"],
      ),
    ).toBe(2);

    // lintText 在内存中检查测试数据，不会为了测试规则而创建临时源码文件。
    const [result] = await eslint.lintText(
      "export const unsafe: any = 1;\n",
      { filePath: representativeFile },
    );
    expect(result).toBeDefined();
    expect(result?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "@typescript-eslint/no-explicit-any",
          severity: 2,
        }),
      ]),
    );
  });
});
