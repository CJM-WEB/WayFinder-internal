/**
 * 测试职责：冻结 WAY-24 内部 Search 与 Node Job 的 TypeScript 边界。
 *
 * 关键约束：
 * - Provider 原始输入在 Adapter 校验前保持 unknown。
 * - rawMetadata 不得被业务代码当作已知类型读取。
 * - Candidate Hit 通过正向白名单排除 rawMetadata。
 * - Node Job Outcome 通过判别联合隔离 fulfilled、rejected 与 timed_out。
 */
import { describe, expectTypeOf, it } from "vitest";

import type {
  AppErrorCode,
  ExtractedPage,
  NodeJobOutcome,
  NodeSearchOutcome,
  NodeWarningCode,
  NormalizedSearchHit,
  ProviderSearchRequest,
  QuerySearchOutcome,
  ResourceCandidate,
  ResultGraphNode,
  SearchCapability,
} from "./index.js";

const validProviderRequest: ProviderSearchRequest = {
  nodeId: "node-001",
  query: "typescript strict mode",
  maxResults: 8,
  capability: "code",
  freshnessSensitive: false,
};

const consumeNormalizedHit = (hit: NormalizedSearchHit): void => {
  void hit;
};

const verifyUnknownProviderInputIsRejected = (raw: unknown): void => {
  // @ts-expect-error Provider 原始输入未经校验，不能直接进入标准化业务对象。
  consumeNormalizedHit(raw);
};
void verifyUnknownProviderInputIsRejected;

const readUnknownProviderScore = (hit: NormalizedSearchHit): number => {
  // @ts-expect-error rawMetadata 的 value 未经缩窄，不能当作 number 使用。
  return hit.rawMetadata["score"];
};
void readUnknownProviderScore;

type ExpectedCandidateSearchHit = Pick<
  NormalizedSearchHit,
  | "provider"
  | "query"
  | "title"
  | "url"
  | "canonicalUrl"
  | "domain"
  | "snippet"
  | "publishedAt"
  | "providerRank"
  | "providerScore"
>;

const readCandidateRawMetadata = (
  candidate: ResourceCandidate,
): unknown => {
  // @ts-expect-error Candidate Hit 的白名单必须排除 rawMetadata。
  return candidate.hit.rawMetadata;
};
void readCandidateRawMetadata;

// @ts-expect-error exactOptionalPropertyTypes 要求 language 要么省略，要么是 string。
const invalidUndefinedLanguage: ProviderSearchRequest = { ...validProviderRequest, language: undefined };
void invalidUndefinedLanguage;

describe("WAY-24 Provider Search 边界", () => {
  it("冻结 ProviderSearchRequest 字段", () => {
    expectTypeOf<ProviderSearchRequest>().toEqualTypeOf<{
      nodeId: string;
      query: string;
      maxResults: number;
      capability: SearchCapability;
      freshnessSensitive: boolean;
      language?: string;
    }>();
  });

  it("冻结 NormalizedSearchHit 与 opaque metadata", () => {
    expectTypeOf<NormalizedSearchHit>().toEqualTypeOf<{
      provider: string;
      query: string;
      title: string;
      url: string;
      canonicalUrl: string;
      domain: string;
      snippet: string;
      publishedAt?: string | null;
      providerRank?: number;
      providerScore?: number;
      rawMetadata: Record<string, unknown>;
    }>();

    expectTypeOf<
      NormalizedSearchHit["rawMetadata"][string]
    >().toEqualTypeOf<unknown>();
  });
});

describe("WAY-24 Extract 与 Candidate 边界", () => {
  it("冻结 ExtractedPage 的唯一关联键与正文", () => {
    expectTypeOf<ExtractedPage>().toEqualTypeOf<{
      canonicalUrl: string;
      content: string;
    }>();
  });

  it("冻结 ResourceCandidate 的搜索事实与决策字段", () => {
    expectTypeOf<ResourceCandidate>().toEqualTypeOf<{
      candidateId: string;
      hit: ExpectedCandidateSearchHit;
      heuristicScore: number;
      heuristicSignals: Record<string, number>;
      scores?: Record<string, number>;
      summary?: string;
      whySelected?: string;
      sourceType?: string;
    }>();
  });
});

type ExpectedRejectedCode = Exclude<
  AppErrorCode,
  "RUN_DEADLINE_EXCEEDED" | "REQUEST_ABORTED"
>;

type RejectedNodeJobOutcome = Extract<
  NodeJobOutcome,
  { status: "rejected" }
>;

// @ts-expect-error Deadline 只能进入 timed_out，不能伪装成普通 rejected。
const invalidDeadlineRejectedCode: RejectedNodeJobOutcome["error"]["code"] = "RUN_DEADLINE_EXCEEDED";
void invalidDeadlineRejectedCode;

// @ts-expect-error 用户取消必须向上抛出，不能进入普通 rejected。
const invalidAbortedRejectedCode: RejectedNodeJobOutcome["error"]["code"] = "REQUEST_ABORTED";
void invalidAbortedRejectedCode;

const assertNever = (value: never): never => {
  void value;
  throw new Error("Unhandled NodeJobOutcome branch");
};

const verifyNodeJobOutcomeNarrowing = (
  outcome: NodeJobOutcome,
): void => {
  switch (outcome.status) {
    case "fulfilled":
      expectTypeOf(outcome.value).toEqualTypeOf<ResultGraphNode>();
      return;

    case "rejected":
      expectTypeOf(outcome.error).toMatchTypeOf<Error>();
      expectTypeOf(outcome.error.code).toEqualTypeOf<ExpectedRejectedCode>();
      return;

    case "timed_out":
      expectTypeOf(outcome.error.code).toEqualTypeOf<
        "RUN_DEADLINE_EXCEEDED"
      >();
      expectTypeOf(outcome.error.retryable).toEqualTypeOf<true>();
      return;

    default:
      assertNever(outcome);
  }
};
void verifyNodeJobOutcomeNarrowing;

describe("WAY-24 Node 结果边界", () => {
  it("冻结 NodeSearchOutcome", () => {
    expectTypeOf<NodeSearchOutcome>().toEqualTypeOf<{
      hits: NormalizedSearchHit[];
      warnings: NodeWarningCode[];
      queryOutcomes: QuerySearchOutcome[];
    }>();
  });

  it("冻结逐 Query 搜索结果", () => {
    expectTypeOf<QuerySearchOutcome>().toEqualTypeOf<{
      query: string;
      hits: NormalizedSearchHit[];
      warnings: NodeWarningCode[];
    }>();
  });

  it("冻结 fulfilled、rejected 与 timed_out 三个分支", () => {
    expectTypeOf<NodeJobOutcome>().toEqualTypeOf<
      | {
          status: "fulfilled";
          nodeId: string;
          value: ResultGraphNode;
        }
      | {
          status: "rejected";
          nodeId: string;
          error: Error & {
            code: ExpectedRejectedCode;
            retryable: boolean;
          };
        }
      | {
          status: "timed_out";
          nodeId: string;
          error: {
            code: "RUN_DEADLINE_EXCEEDED";
            retryable: true;
          };
        }
    >();
  });
});
