/**
 * 组件职责：把一个浏览器式文本输入确定性路由为 Direct、AI Search 或明确拒绝。
 *
 * 关键约束：
 * - 只使用 form 的 submit 事件承接 Enter 与按钮点击，避免同一次 Enter 重复创建 Run；
 * - Direct 与协议拒绝在 SearchRequest 之外完成，只有 AI Search 复用公共 Query Contract；
 * - 搜索期间保持输入可用，新 Query 的取消与 Run 所有权继续由搜索协调器负责。
 */
import { type FormEvent, useRef, useState } from "react";
import {
  SearchLanguageSchema,
  SearchRequestSchema,
  type SearchLanguage,
  type SearchRequest,
} from "@wayfinder/contracts";

import { resolveSafeHttpUrl } from "../../lib/url.js";

export type StartOmniboxSearch = (
  input: Pick<SearchRequest, "query" | "language">,
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
    completion: startSearch({ query: parsedQuery.data, language }),
  };
}

export type OmniboxProps = Readonly<{
  startSearch: StartOmniboxSearch;
  openDirectUrl: OpenOmniboxUrl;
}>;

/** 统一 Omnibox 不暴露模式、熟练度或其他搜索前置表单。 */
export function Omnibox({ startSearch, openDirectUrl }: OmniboxProps) {
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<SearchLanguage>("zh-CN");
  const [feedback, setFeedback] = useState<string | null>(null);
  const latestSubmission = useRef(0);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    // 每次提交先更新本地世代，防止旧请求的迟到错误覆盖当前输入反馈。
    const submissionNumber = ++latestSubmission.current;
    let submission: OmniboxSubmission;

    try {
      submission = startOmniboxSubmission(
        input,
        startSearch,
        openDirectUrl,
        language,
      );
    } catch {
      setFeedback("无法处理当前输入，请稍后重试。");
      return;
    }

    if (submission.kind === "invalid") {
      setFeedback(
        submission.reason === "query"
          ? "请输入 1 至 2000 个字符的搜索内容。"
          : submission.reason === "invalid_url"
            ? "网址格式无效，请使用完整的 http:// 或 https:// 地址。"
            : "不支持此网址协议，仅支持 http:// 或 https://。",
      );
      return;
    }

    if (submission.kind === "direct") {
      setInput(submission.url);
      setFeedback(null);
      return;
    }

    // 输入框同步显示 Contract 规范化后的 Query，避免 UI 与 Search Run 文本不一致。
    setInput(submission.query);
    setFeedback(null);

    void submission.completion.catch(() => {
      if (latestSubmission.current === submissionNumber) {
        // 不展示底层错误对象，避免把网络或 Provider 细节泄漏到 UI。
        setFeedback("搜索启动失败，请稍后重试。");
      }
    });
  };

  return (
    <form
      aria-label="WayFinder 搜索"
      className="omnibox"
      role="search"
      onSubmit={handleSubmit}
    >
      <label htmlFor="wayfinder-query">搜索任意主题</label>
      <div className="omnibox__controls">
        <input
          id="wayfinder-query"
          name="query"
          type="search"
          value={input}
          placeholder="输入网址、关键词或自然语言，按 Enter"
          aria-describedby="wayfinder-query-feedback"
          autoComplete="off"
          onChange={event => {
            setInput(event.currentTarget.value);
            setFeedback(null);
          }}
        />
        <div className="omnibox__language">
          <label htmlFor="wayfinder-language">language</label>
          <select
            id="wayfinder-language"
            name="language"
            value={language}
            onChange={event => {
              // Select 值仍经过公共 Contract，禁止 DOM 或未来 Option 绕过语言门禁。
              setLanguage(SearchLanguageSchema.parse(event.currentTarget.value));
            }}
          >
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
        <button type="submit">搜索</button>
      </div>
      <p
        id="wayfinder-query-feedback"
        className={feedback === null ? "omnibox__hint" : "omnibox__error"}
        aria-live="polite"
      >
        {feedback ?? "明确的 HTTP(S) 网址将直接打开，其他输入进入 AI Search。"}
      </p>
    </form>
  );
}
