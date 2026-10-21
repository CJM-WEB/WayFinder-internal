/**
 * 模块职责：在 Hard Filter（硬过滤）之后、Heuristic Ranking（启发式排序）之前，
 * 从系统生成的 Query 上下文与候选 hostname 产生可复现的官方/风险来源信号。
 *
 * 安全边界：候选标题、摘要、pathname 与 Query 参数均为 Untrusted Input（不可信输入），
 * 本模块不会读取它们来证明官方身份。该阶段不计算分数、不裁剪候选，也不改变顺序。
 */
import type {
  CandidateSearchHit,
  GraphNodeCore,
  QueryAnalysis,
} from "@wayfinder/contracts";
import { domainToASCII } from "node:url";

export const OFFICIAL_SOURCE_SIGNAL_ORDER = [
  "SITE_HOST_MATCH",
  "ENTITY_HOST_TOKEN_MATCH",
  "KNOWN_RISKY_DOWNLOAD_HOST",
] as const;

export type OfficialSourceSignal =
  (typeof OFFICIAL_SOURCE_SIGNAL_ORDER)[number];

export type OfficialSourcePolicy = {
  /**
   * 只接受人员批准的精确 hostname。子域通过边界匹配继承风险属性；
   * 调用方没有获批名单时必须传空数组，检测函数不维护隐式全局名单。
   */
  knownRiskyDownloadDomains: readonly string[];
};

export type OfficialSourceAssessment = {
  candidate: CandidateSearchHit;
  queryKind: "download" | "documentation" | "other";
  classification: "official" | "risky" | "unknown";
  signals: OfficialSourceSignal[];
};

type QueryKind = OfficialSourceAssessment["queryKind"];

const DOWNLOAD_WORDS = new Set([
  "download",
  "downloads",
  "install",
  "installer",
  "setup",
]);

const DOCUMENTATION_WORDS = new Set([
  "docs",
  "documentation",
  "manual",
  "reference",
]);

const DOWNLOAD_PHRASES = ["下载", "安装"] as const;
const DOCUMENTATION_PHRASES = ["文档", "手册", "参考"] as const;

/** 意图词和域名基础设施词不能被重复解释为实体-domain 一致。 */
const ENTITY_STOP_WORDS = new Set([
  ...DOWNLOAD_WORDS,
  ...DOCUMENTATION_WORDS,
  "api",
  "official",
  "site",
  "website",
  "www",
  "com",
  "org",
  "net",
]);

const ENTITY_STOP_PHRASES = [
  ...DOWNLOAD_PHRASES,
  ...DOCUMENTATION_PHRASES,
  "官方",
] as const;

const SITE_OPERATOR_PATTERN = /(?:^|\s)site:([^\s]+)/giu;

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function extractWords(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hasAnyPhrase(value: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => value.includes(phrase));
}

/** 下载优先于文档，避免 “download API docs” 的风险站检查被弱化。 */
function classifyQueryKind(contextValues: readonly string[]): QueryKind {
  const normalizedContext = normalizeText(contextValues.join(" "));
  const words = new Set(extractWords(normalizedContext));

  if (
    Array.from(DOWNLOAD_WORDS).some(word => words.has(word)) ||
    hasAnyPhrase(normalizedContext, DOWNLOAD_PHRASES)
  ) {
    return "download";
  }

  if (
    Array.from(DOCUMENTATION_WORDS).some(word => words.has(word)) ||
    hasAnyPhrase(normalizedContext, DOCUMENTATION_PHRASES)
  ) {
    return "documentation";
  }

  return "other";
}

function trimTrailingDot(hostname: string): string {
  return hostname.replace(/\.+$/u, "").toLowerCase();
}

/**
 * Policy 是可信配置，因此非法项应立即失败，不能被静默忽略后形成看似生效的安全规则。
 * 这里只接受 hostname；scheme、port、path、Query 和 fragment 都会扩大或模糊配置语义。
 */
function normalizePolicyHostname(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    /[%\s\p{Cc}\p{Cf}:/@?#\\]/u.test(value) ||
    value.endsWith("..")
  ) {
    throw new TypeError(
      "knownRiskyDownloadDomains must contain hostnames only",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw new TypeError(
      "knownRiskyDownloadDomains must contain hostnames only",
    );
  }

  const hostname = trimTrailingDot(parsed.hostname);
  const valueWithoutTrailingDot = value.endsWith(".")
    ? value.slice(0, -1)
    : value;
  const asciiHostname = domainToASCII(valueWithoutTrailingDot).toLowerCase();
  const labels = hostname.split(".");
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    asciiHostname !== hostname ||
    labels.some(
      label =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      "knownRiskyDownloadDomains must contain hostnames only",
    );
  }

  return hostname;
}

/** site: 来自系统生成 Search Plan；非法 Hint 只是不提供证据，不使整批候选失败。 */
function tryNormalizeSiteHostname(value: string): string | null {
  try {
    return normalizePolicyHostname(value);
  } catch {
    return null;
  }
}

function extractSiteHostnames(queries: readonly string[]): Set<string> {
  const hostnames = new Set<string>();

  for (const query of queries) {
    for (const match of query.matchAll(SITE_OPERATOR_PATTERN)) {
      const token = match[1];
      if (token === undefined) {
        continue;
      }

      const hostname = tryNormalizeSiteHostname(token);
      if (hostname !== null) {
        hostnames.add(hostname);
      }
    }
  }

  return hostnames;
}

function hostnameMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

/**
 * 重新解析 canonicalUrl 并核对 domain，防止绕过 WAY-49 调用本模块时把冲突字段
 * 错当成可信 hostname。失败候选仍保留位置，但不会得到任何官方或风险信号。
 */
function parseCandidateHostname(candidate: CandidateSearchHit): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate.canonicalUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const hostname = trimTrailingDot(parsed.hostname);
  return hostname === trimTrailingDot(candidate.domain) ? hostname : null;
}

function removeEntityControlText(value: string): string {
  let normalized = normalizeText(value).replace(SITE_OPERATOR_PATTERN, " ");

  for (const phrase of ENTITY_STOP_PHRASES) {
    normalized = normalized.replaceAll(phrase, " ");
  }

  return normalized;
}

/**
 * 除单词外生成相邻二元、三元拼接，处理 `Visual Studio` → `visualstudio`
 * 与 `Node JS` → `nodejs`；只作为弱 Hint，不承担官方身份证明。
 */
function extractEntityTokens(contextValues: readonly string[]): Set<string> {
  const tokens = new Set<string>();

  for (const value of contextValues) {
    const words = extractWords(removeEntityControlText(value)).filter(
      word =>
        Array.from(word).length >= 2 && !ENTITY_STOP_WORDS.has(word),
    );

    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (word === undefined) {
        continue;
      }
      tokens.add(word);

      for (const width of [2, 3] as const) {
        const group = words.slice(index, index + width);
        if (group.length === width) {
          tokens.add(group.join(""));
        }
      }
    }
  }

  return tokens;
}

/** hostname 只按 dot/hyphen 边界生成 token，不读取 pathname 或 Query 参数。 */
function extractHostnameTokens(hostname: string): Set<string> {
  const tokens = new Set<string>();

  for (const label of hostname.split(".")) {
    const parts = extractWords(label);
    for (const part of parts) {
      tokens.add(part);
    }
    if (parts.length > 1) {
      tokens.add(parts.join(""));
    }
  }

  return tokens;
}

function hasEntityHostnameMatch(
  entityTokens: ReadonlySet<string>,
  hostname: string,
): boolean {
  const hostnameTokens = extractHostnameTokens(hostname);
  return Array.from(entityTokens).some(token => hostnameTokens.has(token));
}

/**
 * 每个候选独立结算并复用原对象引用。信号按公开常量顺序追加，确保日志、测试与
 * 后续 WAY-51 Heuristic（启发式评分）可以稳定解释同一批输入。
 */
export function detectOfficialSourceSignals(
  analysis: QueryAnalysis,
  node: GraphNodeCore,
  candidates: readonly CandidateSearchHit[],
  policy: OfficialSourcePolicy,
): OfficialSourceAssessment[] {
  const contextValues = [
    analysis.topic,
    node.title,
    node.description,
    ...node.searchPlan.queries,
  ];
  const queryKind = classifyQueryKind(contextValues);
  const riskyDomains = policy.knownRiskyDownloadDomains.map(
    normalizePolicyHostname,
  );
  const siteHostnames = extractSiteHostnames(node.searchPlan.queries);
  const entityTokens = extractEntityTokens(contextValues);

  return candidates.map(candidate => {
    const signals: OfficialSourceSignal[] = [];
    const hostname = parseCandidateHostname(candidate);

    if (queryKind === "other" || hostname === null) {
      return {
        candidate,
        queryKind,
        classification: "unknown",
        signals,
      };
    }

    const hasSiteHostMatch = Array.from(siteHostnames).some(siteHostname =>
      hostnameMatches(hostname, siteHostname),
    );
    const hasEntityMatch = hasEntityHostnameMatch(entityTokens, hostname);
    const hasRiskMatch =
      queryKind === "download" &&
      riskyDomains.some(riskyDomain =>
        hostnameMatches(hostname, riskyDomain),
      );

    if (hasSiteHostMatch) {
      signals.push("SITE_HOST_MATCH");
    }
    if (hasEntityMatch) {
      signals.push("ENTITY_HOST_TOKEN_MATCH");
    }
    if (hasRiskMatch) {
      signals.push("KNOWN_RISKY_DOWNLOAD_HOST");
    }

    return {
      candidate,
      queryKind,
      classification: hasRiskMatch
        ? "risky"
        : hasSiteHostMatch
          ? "official"
          : "unknown",
      signals,
    };
  });
}
