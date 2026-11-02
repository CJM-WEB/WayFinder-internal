/**
 * 页面职责：独立承载墨迹揭字视觉试验，复用项目现有 React 与 Vite。
 * 隔离边界：不挂载工作区、不初始化本地记录、不调用搜索；原应用仍位于首页。
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SearchLanguage } from "@wayfinder/contracts";

import { resolveEntryLanguage } from "../i18n/entry-language.js";
import { getMessages } from "../i18n/messages.js";
import { createInkReveal } from "./ink-reveal.js";
import "./ink-study.css";

const AUTHOR_EMAIL = "cjmweb@outlook.com";

function InkStudy() {
  const stage = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const languageControl = useRef<HTMLDivElement>(null);
  const languageButton = useRef<HTMLButtonElement>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [language, setLanguage] = useState<SearchLanguage>(
    () => resolveEntryLanguage(window.location.search) ?? "zh-CN",
  );
  const messages = getMessages(language);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const copyEmail = async (): Promise<void> => {
    setCopyStatus("idle");
    try {
      // 只在人员点击后写入邮箱；权限或安全上下文不满足时明确反馈，不假报成功。
      await navigator.clipboard.writeText(AUTHOR_EMAIL);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  useEffect(() => {
    if (!languageOpen) return;
    // 展开层只监听存续期间的外部点击；键盘移出与 Esc 则由控件自身收起。
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !languageControl.current?.contains(event.target)) {
        setLanguageOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [languageOpen]);

  useEffect(() => {
    if (canvas.current === null || stage.current === null || heading.current === null) return;
    const effect = createInkReveal(canvas.current, stage.current, heading.current);

    // WebGL 不可用时仍保留标题与探索入口；系统减弱动态偏好由渲染器处理。
    return () => {
      effect?.destroy();
    };
  }, []);

  useEffect(() => {
    // 展示页语言与进入搜索的初值共用同一受校验值，不增加后端语言设置接口。
    document.documentElement.lang = language;
    document.title = messages.inkStudy.pageTitle;
  }, [language, messages.inkStudy.pageTitle]);

  return (
    <main className="ink-study">
      <section className="ink-study__stage" id="ink-stage" ref={stage} aria-label={messages.inkStudy.stageAria}>
        <h1 className="ink-study__wordmark" ref={heading}>WAYFINDER</h1>
        <canvas className="ink-study__canvas" ref={canvas} aria-hidden="true" />
        <p className="ink-study__tagline">{messages.inkStudy.tagline}</p>

        <header className="ink-study__intro">
          <p className="ink-study__statement">{messages.inkStudy.statement}</p>
          <a className="ink-study__pill ink-study__explore" href={`/?language=${language}`}>
            {messages.inkStudy.explore} <span aria-hidden="true">↗</span>
          </a>
        </header>

        {/* 披露面板使用普通按钮与自然 Tab 顺序，避免模拟系统下拉框或改变语言协议。 */}
        <div className="ink-study__language" ref={languageControl} data-ink-control
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setLanguageOpen(false);
          }}
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setLanguageOpen(false);
            languageButton.current?.focus();
          }}>
          <button type="button" className="ink-study__pill" ref={languageButton}
            aria-label={messages.omnibox.languageLabel} aria-expanded={languageOpen}
            aria-controls="ink-language-options" onClick={() => setLanguageOpen(open => !open)}>
            <span>language</span>
            <svg className="ink-study__chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
              <path d="m1 1 4 4 4-4" />
            </svg>
          </button>
          {languageOpen && (
            <div className="ink-study__language-options" id="ink-language-options" role="group"
              aria-label={messages.omnibox.languageLabel}>
              {(["zh-CN", "en-US"] as const).map(option => (
                <button type="button" key={option} aria-pressed={language === option}
                  onClick={() => {
                    setLanguage(option);
                    setLanguageOpen(false);
                    languageButton.current?.focus();
                  }}>
                  <span>{messages.omnibox.languageOptions[option]}</span>
                  <span aria-hidden="true">{language === option ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 悬浮或聚焦展示邮箱；点击仅复制，反馈独立于展开状态并在短暂停留后消失。 */}
        <div className="ink-study__contact-area" data-ink-control>
          <button type="button" className="ink-study__pill ink-study__contact"
            aria-label={messages.inkStudy.contact} aria-describedby="ink-contact-feedback"
            onClick={() => { void copyEmail(); }}>
            <span>{messages.inkStudy.contact}</span>
            <span className="ink-study__contact-email">{AUTHOR_EMAIL}</span>
          </button>
          {/* 状态区常驻按钮外，避免按钮后代语义被扁平化而漏掉辅助技术播报。 */}
          <span className="ink-study__contact-feedback" id="ink-contact-feedback" role="status">
            {copyStatus === "copied" ? messages.inkStudy.emailCopied
              : copyStatus === "failed" ? messages.inkStudy.emailCopyFailed : ""}
          </span>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("墨迹试验页面缺少 React 根容器");
createRoot(root).render(<StrictMode><InkStudy /></StrictMode>);
