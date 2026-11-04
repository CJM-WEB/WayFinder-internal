/**
 * 模块职责：将统一输入确定性路由为安全 URL、搜索请求或明确拒绝。
 * 复用边界：墨迹产品与内部评估共用协议校验；此层不加载 React 表单或评估样式。
 */
import { SearchEngineSchema, SearchRequestSchema, type SearchEngine, type SearchLanguage, type SearchRequest } from "@wayfinder/contracts";
import { resolveSafeHttpUrl } from "./url.js";

export type StartOmniboxSearch = (
  input: Pick<SearchRequest, "query" | "language" | "engine">,
) => Promise<void>;
export type OpenOmniboxUrl = (url: string) => boolean;

export type InvalidOmniboxInputReason =
  | "query"
  | "invalid_url"
  | "unsupported_protocol";

export type OmniboxSubmission =
  | Readonly<{
      kind: "invalid";
      reason: InvalidOmniboxInputReason;
    }>
  | Readonly<{
      kind: "direct";
      url: string;
    }>
  | Readonly<{
      kind: "ai_search";
      query: string;
      completion: Promise<void>;
    }>;

const EXPLICIT_HTTP_URL_PATTERN = /^https?:\/\//i;
const URI_SCHEME_PATTERN = /^([a-z][a-z\d+.-]*):/i;
const KNOWN_NON_HTTP_SCHEMES = new Set([
  "about",
  "blob",
  "chrome",
  "data",
  "edge",
  "file",
  "ftp",
  "javascript",
  "mailto",
  "sms",
  "tel",
  "vbscript",
]);

/**
 * 任意 `word:` 都判为协议会误伤 `site:github.com` 等合法搜索语法。
 * 因此只拒绝带 `://` 的显式协议，以及无需双斜线也可执行的已知非 HTTP 协议。
 */
const classifyRejectedProtocol = (
  input: string,
): InvalidOmniboxInputReason | null => {
  const match = URI_SCHEME_PATTERN.exec(input);
  const scheme = match?.[1]?.toLowerCase();
  const matchedPrefix = match?.[0];

  if (scheme === undefined || matchedPrefix === undefined) {
    return null;
  }

  if (scheme === "http" || scheme === "https") {
    // HTTP(S) 缺少 `//` 时不能交给 URL 解析器猜测或补全。
    return "invalid_url";
  }

  const remainder = input.slice(matchedPrefix.length);
  return remainder.startsWith("//") || KNOWN_NON_HTTP_SCHEMES.has(scheme)
    ? "unsupported_protocol"
    : null;
};

/**
 * 确定性提交边界供组件与单测共用：Direct 与拒绝路径均不会创建 Search Run，
 * 只有普通文本恰好调用一次搜索入口。
 */
export function startOmniboxSubmission(
  rawInput: string,
  startSearch: StartOmniboxSearch,
  openDirectUrl: OpenOmniboxUrl,
  language: SearchLanguage = "zh-CN",
  engine?: SearchEngine,
): OmniboxSubmission {
  const input = rawInput.trim();

  if (input.length === 0) {
    return { kind: "invalid", reason: "query" };
  }

  if (EXPLICIT_HTTP_URL_PATTERN.test(input)) {
    const safeUrl = resolveSafeHttpUrl(input);

    if (safeUrl === null || !openDirectUrl(safeUrl)) {
      return { kind: "invalid", reason: "invalid_url" };
    }

    return { kind: "direct", url: safeUrl };
  }

  const rejectedProtocol = classifyRejectedProtocol(input);
  if (rejectedProtocol !== null) {
    return { kind: "invalid", reason: rejectedProtocol };
  }

  const parsedQuery = SearchRequestSchema.shape.query.safeParse(input);
  if (!parsedQuery.success) {
    return { kind: "invalid", reason: "query" };
  }

  return {
    kind: "ai_search",
    query: parsedQuery.data,
    completion: startSearch({ query: parsedQuery.data, language, ...(engine === undefined ? {} : { engine: SearchEngineSchema.parse(engine) }) }),
  };
}
