/**
 * 组件职责：把一个浏览器式文本输入收窄为一次合法 AI Search 提交。
 *
 * 关键约束：
 * - 只使用 form 的 submit 事件承接 Enter 与按钮点击，避免同一次 Enter 重复创建 Run；
 * - 输入校验复用公共 SearchRequest Contract，不在 UI 复制长度或 trim 规则；
 * - 搜索期间保持输入可用，新 Query 的取消与 Run 所有权继续由搜索协调器负责。
 */
import { type FormEvent, useRef, useState } from "react";
import { SearchRequestSchema } from "@wayfinder/contracts";

export type StartOmniboxSearch = (query: string) => Promise<void>;

export type OmniboxSubmission =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{
      kind: "started";
      query: string;
      completion: Promise<void>;
    }>;

/**
 * 确定性提交边界供组件与单测共用：非法输入零副作用，合法输入恰好调用一次搜索入口。
 */
export function startOmniboxSubmission(
  rawInput: string,
  startSearch: StartOmniboxSearch,
): OmniboxSubmission {
  const parsedQuery = SearchRequestSchema.shape.query.safeParse(rawInput);

  if (!parsedQuery.success) {
    return { kind: "invalid" };
  }

  return {
    kind: "started",
    query: parsedQuery.data,
    completion: startSearch(parsedQuery.data),
  };
}

export type OmniboxProps = Readonly<{
  startSearch: StartOmniboxSearch;
}>;

/** 统一 Omnibox 不暴露模式、熟练度或其他搜索前置表单。 */
export function Omnibox({ startSearch }: OmniboxProps) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const latestSubmission = useRef(0);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    // 每次提交先更新本地世代，防止旧请求的迟到错误覆盖当前输入反馈。
    const submissionNumber = ++latestSubmission.current;
    let submission: OmniboxSubmission;

    try {
      submission = startOmniboxSubmission(input, startSearch);
    } catch {
      setFeedback("搜索启动失败，请稍后重试。");
      return;
    }

    if (submission.kind === "invalid") {
      setFeedback("请输入 1 至 2000 个字符的搜索内容。");
      return;
    }

    // 输入框同步显示 Contract 规范化后的 Query，避免 UI 与实际 Run 文本不一致。
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
          placeholder="输入关键词或自然语言，按 Enter 搜索"
          aria-describedby="wayfinder-query-feedback"
          autoComplete="off"
          onChange={event => setInput(event.currentTarget.value)}
        />
        <button type="submit">搜索</button>
      </div>
      <p
        id="wayfinder-query-feedback"
        className={feedback === null ? "omnibox__hint" : "omnibox__error"}
        aria-live="polite"
      >
        {feedback ?? "无需选择模式或填写额外信息。"}
      </p>
    </form>
  );
}
