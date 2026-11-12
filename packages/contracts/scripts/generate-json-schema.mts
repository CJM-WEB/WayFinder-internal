/**
 * 模块职责：从固定公共 Zod 根 Schema 生成确定性的 JSON Schema 字节。
 *
 * 关键约束：Zod 是唯一事实来源；JSON Schema 只表达转换器可表示的输入侧结构投影。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  AccountActionSchema,
  AccountResponseSchema,
  AccountErrorResponseSchema,
  AccountKeyActionSchema,
  AccountKeysResponseSchema,
  AccountKeysErrorResponseSchema,
  CloudWorkspaceResponseSchema,
  CloudWorkspaceImportRequestSchema,
  CloudGraphWriteRequestSchema,
  CloudGraphWriteResponseSchema,
  CloudWorkspaceErrorResponseSchema,
  CredentialsErrorResponseSchema,
  EditableGraphSchema,
  ExperienceInviteRequestSchema,
  ExperienceStatusResponseSchema,
  GraphPlanSchema,
  H2EvaluationArtifactSchema,
  QueryAnalysisSchema,
  ResultGraphSchema,
  SearchCredentialsSchema,
  SearchRequestSchema,
  SettingsPublicResponseSchema,
  StreamEventSchema,
  StoredGraphHistorySchema,
  UserIdSchema,
  AccountProfileActionSchema,
  AccountProfileResponseSchema,
  GroupActionSchema,
  GroupActionResponseSchema,
  GroupListResponseSchema,
  GroupErrorResponseSchema,
  GroupGraphHistorySchema,
  GroupWorkspaceResponseSchema,
  GroupGraphActionSchema,
  GroupGraphWriteResponseSchema,
  GroupSyncEventSchema,
  GroupReadQuerySchema,
  GroupDetailsSchema,
} from "../src/index.ts";

export interface JsonSchemaArtifact {
  readonly fileName: string;
  readonly content: string;
}

export interface SchemaDriftIssue {
  readonly kind: "missing" | "changed" | "unexpected";
  readonly fileName: string;
}

interface JsonSchemaRoot {
  readonly schemaName: string;
  readonly fileName: `${string}.schema.json`;
  readonly schema: z.ZodType;
}

interface SchemaDirectoryEntry {
  readonly fileName: string;
  readonly isRegularFile: boolean;
}

/**
 * Manifest（发布清单）只保存根 Schema 引用和稳定文件名。
 * 固定顺序同时决定生成顺序与漂移诊断顺序，不能通过遍历导出自动扩大发布面。
 */
const jsonSchemaRoots = [
  {
    schemaName: "SearchRequestSchema",
    fileName: "search-request.schema.json",
    schema: SearchRequestSchema,
  },
  {
    schemaName: "QueryAnalysisSchema",
    fileName: "query-analysis.schema.json",
    schema: QueryAnalysisSchema,
  },
  {
    schemaName: "GraphPlanSchema",
    fileName: "graph-plan.schema.json",
    schema: GraphPlanSchema,
  },
  {
    schemaName: "StreamEventSchema",
    fileName: "stream-event.schema.json",
    schema: StreamEventSchema,
  },
  {
    schemaName: "ResultGraphSchema",
    fileName: "result-graph.schema.json",
    schema: ResultGraphSchema,
  },
  {
    schemaName: "H2EvaluationArtifactSchema",
    fileName: "h2-evaluation-artifact.schema.json",
    schema: H2EvaluationArtifactSchema,
  },
  {
    schemaName: "EditableGraphSchema",
    fileName: "editable-graph.schema.json",
    schema: EditableGraphSchema,
  },
  {
    schemaName: "SearchCredentialsSchema",
    fileName: "search-credentials.schema.json",
    schema: SearchCredentialsSchema,
  },
  {
    schemaName: "SettingsPublicResponseSchema",
    fileName: "settings-public-response.schema.json",
    schema: SettingsPublicResponseSchema,
  },
  {
    schemaName: "ExperienceInviteRequestSchema",
    fileName: "experience-invite-request.schema.json",
    schema: ExperienceInviteRequestSchema,
  },
  {
    schemaName: "ExperienceStatusResponseSchema",
    fileName: "experience-status-response.schema.json",
    schema: ExperienceStatusResponseSchema,
  },
  {
    schemaName: "CredentialsErrorResponseSchema",
    fileName: "credentials-error-response.schema.json",
    schema: CredentialsErrorResponseSchema,
  },
  {
    schemaName: "UserIdSchema",
    fileName: "user-id.schema.json",
    schema: UserIdSchema,
  },
  { schemaName: "AccountActionSchema", fileName: "account-action.schema.json", schema: AccountActionSchema },
  { schemaName: "AccountResponseSchema", fileName: "account-response.schema.json", schema: AccountResponseSchema },
  { schemaName: "AccountErrorResponseSchema", fileName: "account-error-response.schema.json", schema: AccountErrorResponseSchema },
  { schemaName: "AccountKeyActionSchema", fileName: "account-key-action.schema.json", schema: AccountKeyActionSchema },
  { schemaName: "AccountKeysResponseSchema", fileName: "account-keys-response.schema.json", schema: AccountKeysResponseSchema },
  { schemaName: "AccountKeysErrorResponseSchema", fileName: "account-keys-error-response.schema.json", schema: AccountKeysErrorResponseSchema },
  {
    schemaName: "StoredGraphHistorySchema",
    fileName: "stored-graph-history.schema.json",
    schema: StoredGraphHistorySchema,
  },
  { schemaName: "CloudWorkspaceResponseSchema", fileName: "cloud-workspace-response.schema.json", schema: CloudWorkspaceResponseSchema },
  { schemaName: "CloudWorkspaceImportRequestSchema", fileName: "cloud-workspace-import-request.schema.json", schema: CloudWorkspaceImportRequestSchema },
  { schemaName: "CloudGraphWriteRequestSchema", fileName: "cloud-graph-write-request.schema.json", schema: CloudGraphWriteRequestSchema },
  { schemaName: "CloudGraphWriteResponseSchema", fileName: "cloud-graph-write-response.schema.json", schema: CloudGraphWriteResponseSchema },
  { schemaName: "CloudWorkspaceErrorResponseSchema", fileName: "cloud-workspace-error-response.schema.json", schema: CloudWorkspaceErrorResponseSchema },
  { schemaName: "AccountProfileActionSchema", fileName: "account-profile-action.schema.json", schema: AccountProfileActionSchema },
  { schemaName: "AccountProfileResponseSchema", fileName: "account-profile-response.schema.json", schema: AccountProfileResponseSchema },
  { schemaName: "GroupActionSchema", fileName: "group-action.schema.json", schema: GroupActionSchema },
  { schemaName: "GroupActionResponseSchema", fileName: "group-action-response.schema.json", schema: GroupActionResponseSchema },
  { schemaName: "GroupListResponseSchema", fileName: "group-list-response.schema.json", schema: GroupListResponseSchema },
  { schemaName: "GroupErrorResponseSchema", fileName: "group-error-response.schema.json", schema: GroupErrorResponseSchema },
  { schemaName: "GroupGraphHistorySchema", fileName: "group-graph-history.schema.json", schema: GroupGraphHistorySchema },
  { schemaName: "GroupWorkspaceResponseSchema", fileName: "group-workspace-response.schema.json", schema: GroupWorkspaceResponseSchema },
  { schemaName: "GroupGraphActionSchema", fileName: "group-graph-action.schema.json", schema: GroupGraphActionSchema },
  { schemaName: "GroupGraphWriteResponseSchema", fileName: "group-graph-write-response.schema.json", schema: GroupGraphWriteResponseSchema },
  { schemaName: "GroupSyncEventSchema", fileName: "group-sync-event.schema.json", schema: GroupSyncEventSchema },
  { schemaName: "GroupReadQuerySchema", fileName: "group-read-query.schema.json", schema: GroupReadQuerySchema },
  { schemaName: "GroupDetailsSchema", fileName: "group-details.schema.json", schema: GroupDetailsSchema },
] as const satisfies readonly JsonSchemaRoot[];

const defaultOutputDirectory = fileURLToPath(
  new URL("../json-schema/", import.meta.url),
);

export function renderJsonSchema(
  schemaName: string,
  schema: z.ZodType,
): string {
  try {
    const jsonSchema = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "throw",
      reused: "inline",
    });

    return `${JSON.stringify(jsonSchema, null, 2)}\n`;
  } catch (error: unknown) {
    throw new Error(`无法从 ${schemaName} 生成 JSON Schema`, {
      cause: error,
    });
  }
}

export function createJsonSchemaArtifacts(): readonly JsonSchemaArtifact[] {
  return jsonSchemaRoots.map(root => ({
    fileName: root.fileName,
    content: renderJsonSchema(root.schemaName, root.schema),
  }));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * 列出所有 Schema 后缀条目，而不跟随符号链接。
 * 非普通条目必须保留到预检阶段，否则同名链接可能让后续写入越过输出目录边界。
 */
async function listSchemaEntries(
  directory: string,
): Promise<readonly SchemaDirectoryEntry[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.name.toLowerCase().endsWith(".schema.json"))
      .map(entry => ({
        fileName: entry.name,
        isRegularFile: entry.isFile(),
      }))
      .sort((left, right) => {
        if (left.fileName < right.fileName) {
          return -1;
        }
        return left.fileName > right.fileName ? 1 : 0;
      });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

function findUnexpectedSchemaEntries(
  actualEntries: readonly SchemaDirectoryEntry[],
  artifacts: readonly JsonSchemaArtifact[],
): readonly SchemaDirectoryEntry[] {
  const expected = new Set(artifacts.map(artifact => artifact.fileName));
  return actualEntries.filter(entry => !expected.has(entry.fileName));
}

/**
 * 只读比较内存期望字节与目录内容；问题按 Manifest 顺序后接已排序的额外文件。
 * 精确名称判断防止 Windows/macOS 把大小写错误的文件当成合法目标。
 */
export async function findJsonSchemaDrift(
  outputDirectory = defaultOutputDirectory,
): Promise<readonly SchemaDriftIssue[]> {
  const artifacts = createJsonSchemaArtifacts();
  const actualEntries = await listSchemaEntries(outputDirectory);
  const actualEntryByName = new Map(
    actualEntries.map(entry => [entry.fileName, entry]),
  );
  const issues: SchemaDriftIssue[] = [];

  for (const artifact of artifacts) {
    const actualEntry = actualEntryByName.get(artifact.fileName);
    if (actualEntry === undefined) {
      issues.push({ kind: "missing", fileName: artifact.fileName });
      continue;
    }

    if (!actualEntry.isRegularFile) {
      issues.push({ kind: "changed", fileName: artifact.fileName });
      continue;
    }

    try {
      const actual = await fs.readFile(
        path.join(outputDirectory, artifact.fileName),
      );
      if (!actual.equals(Buffer.from(artifact.content, "utf8"))) {
        issues.push({ kind: "changed", fileName: artifact.fileName });
      }
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        issues.push({ kind: "missing", fileName: artifact.fileName });
        continue;
      }
      throw error;
    }
  }

  const unexpected = findUnexpectedSchemaEntries(
    actualEntries,
    artifacts,
  );
  issues.push(...unexpected.map(entry => ({
    kind: "unexpected" as const,
    fileName: entry.fileName,
  })));
  return issues;
}

/**
 * 写入前先生成全部期望内容并检查额外或非普通 Schema；拒绝发生在首个写操作之前。
 * 普通非 Schema 文件不属于本工具的管理范围，必须原样保留。
 */
export async function writeJsonSchemaArtifacts(
  outputDirectory = defaultOutputDirectory,
): Promise<void> {
  const artifacts = createJsonSchemaArtifacts();
  const actualEntries = await listSchemaEntries(outputDirectory);
  const expectedFileNames = new Set(
    artifacts.map(artifact => artifact.fileName),
  );
  const unsafeEntries = actualEntries.filter(
    entry =>
      !expectedFileNames.has(entry.fileName) || !entry.isRegularFile,
  );
  if (unsafeEntries.length > 0) {
    throw new Error(
      `拒绝写入：存在额外或非普通 JSON Schema 条目：${unsafeEntries
        .map(entry => entry.fileName)
        .join(", ")}`,
    );
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  for (const artifact of artifacts) {
    await fs.writeFile(
      path.join(outputDirectory, artifact.fileName),
      artifact.content,
      "utf8",
    );
  }
}

type CliMode = "write" | "check";

const cliUsage =
  "用法: node scripts/generate-json-schema.mts <--write|--check>";

export function parseCliMode(args: readonly string[]): CliMode {
  if (args.length === 1 && args[0] === "--write") {
    return "write";
  }
  if (args.length === 1 && args[0] === "--check") {
    return "check";
  }
  throw new Error(cliUsage);
}

function formatDriftIssue(issue: SchemaDriftIssue): string {
  const labels = {
    missing: "缺失",
    changed: "内容不同",
    unexpected: "额外产物",
  } as const;
  return `- packages/contracts/json-schema/${issue.fileName}: ${labels[issue.kind]}`;
}

export async function runJsonSchemaCli(args: readonly string[]): Promise<void> {
  const mode = parseCliMode(args);
  if (mode === "write") {
    await writeJsonSchemaArtifacts();
    console.log(`已生成 ${jsonSchemaRoots.length} 个 JSON Schema 产物。`);
    return;
  }

  const issues = await findJsonSchemaDrift();
  if (issues.length > 0) {
    throw new Error([
      "JSON Schema 与 Zod Contract 不一致：",
      ...issues.map(formatDriftIssue),
      "请先审核 Zod 改动，再显式运行 pnpm run schema:generate。",
    ].join("\n"));
  }

  console.log("JSON Schema 漂移检查通过。");
}

if (import.meta.main) {
  runJsonSchemaCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
