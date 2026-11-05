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
  type SearchLanguage,
} from "@wayfinder/contracts";

import { getMessages } from "../../i18n/messages.js";
import { startOmniboxSubmission, type StartOmniboxSearch, type OpenOmniboxUrl, type InvalidOmniboxInputReason, type OmniboxSubmission } from "../../lib/omnibox-submission.js";

export type OmniboxProps = Readonly<{
  startSearch: StartOmniboxSearch;
  openDirectUrl: OpenOmniboxUrl;
  /** 下一次搜索使用的受控语言。 */
  language: SearchLanguage;
  /** 当前页面唯一展示语言；已有 Run 时可能与下一次搜索语言不同。 */
  renderLanguage: SearchLanguage;
  onLanguageChange: (language: SearchLanguage) => void;
}>;

type OmniboxFeedback =
  | InvalidOmniboxInputReason
  | "input_failure"
  | "search_failure";

/**
 * 统一 Omnibox 不暴露模式、熟练度或其他搜索前置表单。
 * 仅内部评估使用此表单；language 由评估容器持有，不能改变墨迹产品的即时切换规则。
 */
export function Omnibox({
  startSearch,
  openDirectUrl,
  language,
  renderLanguage,
  onLanguageChange,
}: OmniboxProps) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<OmniboxFeedback | null>(null);
  const latestSubmission = useRef(0);
  const messages = getMessages(renderLanguage).omnibox;

  /** Feedback 只保存稳定原因，切换语言时由当前文案表重新呈现，避免残留混语。 */
  const feedbackMessage =
    feedback === null
      ? null
      : feedback === "query"
        ? messages.invalidQuery
        : feedback === "invalid_url"
          ? messages.invalidUrl
          : feedback === "unsupported_protocol"
            ? messages.unsupportedProtocol
            : feedback === "input_failure"
              ? messages.inputFailure
              : messages.searchFailure;

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
      setFeedback("input_failure");
      return;
    }

    if (submission.kind === "invalid") {
      setFeedback(submission.reason);
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
        setFeedback("search_failure");
      }
    });
  };

  return (
    <form
      aria-label={messages.formAria}
      className="omnibox"
      role="search"
      onSubmit={handleSubmit}
    >
      <label htmlFor="wayfinder-query">{messages.queryLabel}</label>
      <div className="omnibox__controls">
        <input
          id="wayfinder-query"
          name="query"
          type="search"
          value={input}
          placeholder={messages.placeholder}
          aria-describedby="wayfinder-query-feedback"
          autoComplete="off"
          onChange={event => {
            setInput(event.currentTarget.value);
            setFeedback(null);
          }}
        />
        <div className="omnibox__language">
          <label htmlFor="wayfinder-language">{messages.languageLabel}</label>
          <select
            id="wayfinder-language"
            name="language"
            value={language}
            onChange={event => {
              // Select 值仍经过公共 Contract，禁止 DOM 或未来 Option 绕过语言门禁。
              onLanguageChange(
                SearchLanguageSchema.parse(event.currentTarget.value),
              );
            }}
          >
            <option value="zh-CN">{messages.languageOptions["zh-CN"]}</option>
            <option value="en-US">{messages.languageOptions["en-US"]}</option>
          </select>
        </div>
        <button type="submit">{messages.searchButton}</button>
      </div>
      <p
        id="wayfinder-query-feedback"
        className={feedback === null ? "omnibox__hint" : "omnibox__error"}
        aria-live="polite"
      >
        {feedbackMessage ?? messages.hint}
      </p>
    </form>
  );
}
