/**
 * 模块职责：依据一次 Broad Discovery Evidence 修订完整 GraphOutline（图轮廓）。
 *
 * 关键边界：
 * - 最多调用 LLM 一次，不重试、不 repair，也不回退 Initial Outline；
 * - Initial Outline 与网页 Evidence 都是不可信输入，进入 Prompt 前确定性校验/投影；
 * - 输出不得改变 analysis，也不得提前生成 SearchPlan；
 * - 取消与未知程序错误原样传播，预期失败只暴露稳定脱敏分类。
 */
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import type {
  CandidateSearchHit,
  SearchLanguage,
} from "@wayfinder/contracts";
import { z } from "zod";

import { validateGraphOutline } from "../graph/graph-validator.js";
import {
  GraphOutlineSchema,
  GraphOutlineValidationError,
  parseGraphOutlineOutput,
  type GraphOutline,
  type GraphOutlineValidationDiagnostic,
} from "./graph-outline.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { GRAPH_REVISER_SYSTEM_PROMPT } from "./prompts/graph-reviser.v4.js";
import { appendTargetLanguageSystemInstruction } from "./prompts/target-language-system-instruction.js";

/** Prompt 投影上限按批准语义使用 Unicode code point（码点）。 */
export const GRAPH_REVISER_MAX_EVIDENCE_QUERY_CODE_POINTS = 200 as const;
export const GRAPH_REVISER_MAX_TITLE_CODE_POINTS = 200 as const;
export const GRAPH_REVISER_MAX_DOMAIN_CODE_POINTS = 253 as const;
export const GRAPH_REVISER_MAX_SNIPPET_CODE_POINTS = 500 as const;
export const GRAPH_REVISER_MAX_PUBLISHED_AT_CODE_POINTS = 64 as const;
export const GRAPH_REVISER_MAX_PAYLOAD_CODE_POINTS = 32_000 as const;
const GRAPH_REVISER_MAX_EVIDENCE_ITEMS = 15;

const GRAPH_OUTLINE_PROVIDER_SCHEMA: Readonly<Record<string, unknown>> =
  z.toJSONSchema(GraphOutlineSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });

export type GraphRevisionErrorKind =
  | "analysis_changed"
  | "budget_exhausted"
  | "input_too_large"
  | "provider_failure"
  | "schema_validation_failed"
  | "semantic_validation_failed";

/** 错误不保存 cause、Query、Evidence、模型输出或 Validator Finding。 */
export class GraphRevisionError extends Error {
  public readonly kind: GraphRevisionErrorKind;

  public constructor(kind: GraphRevisionErrorKind) {
    super("GRAPH_REVISION_FAILED");
    this.name = "GraphRevisionError";
    this.kind = kind;
  }
}

export type GraphRevisionValidationDiagnostic = Readonly<{
  source: "graph_reviser";
  diagnostic: GraphOutlineValidationDiagnostic;
}>;

export type ReviseGraphOutlineInput = Readonly<{
  query: string;
  /** 与 Initial Outline 同属本次 Run，用于约束修订后的用户可见文本。 */
  language: SearchLanguage;
  /** 必须是已通过 Schema 与 Outline Validator 的 evidence_assisted 初始轮廓。 */
  initialOutline: GraphOutline;
  evidence: readonly CandidateSearchHit[];
  provider: LLMProvider;
  signal: AbortSignal;
  timeoutMs: number;
  now?: () => number;
  onValidationDiagnostic: (
    diagnostic: GraphRevisionValidationDiagnostic,
  ) => void;
}>;

type PromptEvidence = Readonly<{
  query: string;
  title: string;
  domain: string;
  snippet: string;
  publishedAt?: string | null;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 按 Unicode code point 截断，避免拆开代理对。 */
function takeCodePoints(value: string, maximum: number): string {
  let count = 0;
  let endIndex = 0;
  for (const codePoint of value) {
    if (count >= maximum) {
      break;
    }
    count += 1;
    endIndex += codePoint.length;
  }
  return value.slice(0, endIndex);
}

/** 达到上限后立即停止，避免为拒绝超大载荷继续扫描剩余文本。 */
function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  let current = iterator.next();
  while (!current.done) {
    count += 1;
    if (count > maximum) {
      return true;
    }
    current = iterator.next();
  }
  return false;
}

function readRequiredEvidenceText(
  evidence: CandidateSearchHit,
  field: "domain" | "query" | "snippet" | "title",
): string {
  const value: unknown = evidence[field];
  if (typeof value !== "string") {
    throw new TypeError("Graph Reviser Evidence 字段无效");
  }
  return value;
}

/** URL、Provider、Rank、Score 与私有 metadata 均不会进入 Prompt。 */
function projectEvidence(evidence: CandidateSearchHit): PromptEvidence {
  const publishedAt: unknown = evidence.publishedAt;
  if (
    publishedAt !== undefined &&
    publishedAt !== null &&
    typeof publishedAt !== "string"
  ) {
    throw new TypeError("Graph Reviser Evidence publishedAt 无效");
  }

  return {
    query: takeCodePoints(
      readRequiredEvidenceText(evidence, "query"),
      GRAPH_REVISER_MAX_EVIDENCE_QUERY_CODE_POINTS,
    ),
    title: takeCodePoints(
      readRequiredEvidenceText(evidence, "title"),
      GRAPH_REVISER_MAX_TITLE_CODE_POINTS,
    ),
    domain: takeCodePoints(
      readRequiredEvidenceText(evidence, "domain"),
      GRAPH_REVISER_MAX_DOMAIN_CODE_POINTS,
    ),
    snippet: takeCodePoints(
      readRequiredEvidenceText(evidence, "snippet"),
      GRAPH_REVISER_MAX_SNIPPET_CODE_POINTS,
    ),
    ...(publishedAt === undefined
      ? {}
      : {
          publishedAt:
            publishedAt === null
              ? null
              : takeCodePoints(
                  publishedAt,
                  GRAPH_REVISER_MAX_PUBLISHED_AT_CODE_POINTS,
                ),
        }),
  };
}

function parseInitialOutline(initialOutline: GraphOutline): GraphOutline {
  const parsed = GraphOutlineSchema.safeParse(initialOutline);
  if (
    !parsed.success ||
    !validateGraphOutline(parsed.data).valid ||
    parsed.data.analysis.strategy !== "evidence_assisted"
  ) {
    throw new TypeError(
      "Graph Reviser 需要已验证的 evidence_assisted Initial Outline",
    );
  }
  return parsed.data;
}

function createStructuredInput(
  query: string,
  language: SearchLanguage,
  initialOutline: GraphOutline,
  evidence: readonly CandidateSearchHit[],
): StructuredLLMInput {
  if (evidence.length < 1 || evidence.length > GRAPH_REVISER_MAX_EVIDENCE_ITEMS) {
    throw new TypeError("Graph Reviser Evidence 数量必须为 1 到 15");
  }

  const user = JSON.stringify({
    query,
    initialOutline,
    evidence: evidence.map(projectEvidence),
  });
  if (exceedsCodePointLimit(user, GRAPH_REVISER_MAX_PAYLOAD_CODE_POINTS)) {
    throw new GraphRevisionError("input_too_large");
  }

  return {
    system: appendTargetLanguageSystemInstruction(
      GRAPH_REVISER_SYSTEM_PROMPT,
      language,
    ),
    user,
    schemaName: "graph_outline",
    schema: GRAPH_OUTLINE_PROVIDER_SCHEMA,
  };
}

function readRemainingTimeoutMs(
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): number | null {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("Graph Reviser 时钟必须返回有限数字");
  }
  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

/** 返回值是完整、analysis 未变且已经通过确定性校验的 Final Outline。 */
export async function reviseGraphOutline(
  input: ReviseGraphOutlineInput,
): Promise<GraphOutline> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Graph Reviser 时钟必须返回有限数字");
  }
  const deadlineAt = startedAt + input.timeoutMs;
  const initialOutline = parseInitialOutline(input.initialOutline);
  const structuredInput = createStructuredInput(
    input.query,
    input.language,
    initialOutline,
    input.evidence,
  );
  const timeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    input.timeoutMs,
    now,
  );
  if (timeoutMs === null) {
    throw new GraphRevisionError("budget_exhausted");
  }

  let output: unknown;
  try {
    output = await input.provider.structured(structuredInput, {
      signal: input.signal,
      timeoutMs,
    });
  } catch (error: unknown) {
    throwIfAborted(input.signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      throw new GraphRevisionError("provider_failure");
    }
    throw error;
  }

  throwIfAborted(input.signal);
  if (readRemainingTimeoutMs(deadlineAt, input.timeoutMs, now) === null) {
    throw new GraphRevisionError("budget_exhausted");
  }

  let revisedOutline: GraphOutline;
  try {
    revisedOutline = parseGraphOutlineOutput(output);
  } catch (error: unknown) {
    if (error instanceof GraphOutlineValidationError) {
      input.onValidationDiagnostic({
        source: "graph_reviser",
        diagnostic: error.diagnostic,
      });
      throw new GraphRevisionError("schema_validation_failed");
    }
    throw error;
  }

  if (!isDeepStrictEqual(revisedOutline.analysis, initialOutline.analysis)) {
    throw new GraphRevisionError("analysis_changed");
  }
  if (!validateGraphOutline(revisedOutline).valid) {
    throw new GraphRevisionError("semantic_validation_failed");
  }
  return revisedOutline;
}
