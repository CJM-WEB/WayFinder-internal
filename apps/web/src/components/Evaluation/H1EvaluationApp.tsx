/**
 * 组件职责：仅承载内部 H1 呈现评估，Graph 与纵向列表消费同一份运行及资源。
 * 隔离边界：不读取工作区记录、不保存评估结果，不作为正式产品入口。
 * 实验约束：保持原有 Graph 条件、Run 语言锁定及资源面板，避免改版引入额外变量。
 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";

import { startStreamingSearch } from "../../api/search.js";
import type { H1EvaluationCondition, H1EvaluationRoute } from "../../evaluation/h1-route.js";
import { getMessages } from "../../i18n/messages.js";
import { requestSafeUrlOpen } from "../../lib/url.js";
import { graphStore, selectSelectedNode } from "../../stores/graph-store.js";
import { GraphView } from "../Graph/GraphView.js";
import { Omnibox } from "../Omnibox/Omnibox.js";
import { buildResourcePanelModel, ResourcePanelView } from "../ResourcePanel/ResourcePanel.js";
import { H1StructuredFlatList } from "./H1StructuredFlatList.js";

/** 只保留内部实验的语言锁定；正式墨迹产品使用即时界面语言，不能共用这一策略。 */
export const resolveH1RenderLanguage = (
  runLanguage: SearchLanguage | null,
  selectedLanguage: SearchLanguage,
): SearchLanguage => runLanguage ?? selectedLanguage;

export function H1EvaluationApp({ initialCondition = "graph" }: Partial<H1EvaluationRoute> = {}) {
  const runtime = useStore(graphStore, state => state);
  const selectedNode = useStore(graphStore, selectSelectedNode);
  const [selectedLanguage, setSelectedLanguage] = useState<SearchLanguage>(runtime.language ?? "zh-CN");
  const [condition, setCondition] = useState<H1EvaluationCondition>(initialCondition);
  const language = resolveH1RenderLanguage(runtime.language, selectedLanguage);
  const messages = getMessages(language);
  const searchState = runtime.isSearching ? "searching" : runtime.query.length > 0 ? "complete" : "idle";

  useEffect(() => { document.documentElement.lang = language; }, [language]);

  return <main className="app-shell">
    <header className="app-header">
      <div className="app-header__intro"><p>{messages.app.slogan}</p><h1>WayFinder</h1></div>
      <dl className="app-summary" aria-label={messages.app.summaryAria}>
        <div><dt>{messages.app.currentQuery}</dt><dd>{runtime.query || messages.app.notStarted}</dd></div>
        <div><dt>{messages.app.searchStatus}</dt><dd>{messages.app.searchState[searchState]}</dd></div>
        <div><dt>{messages.app.nodeCount}</dt><dd>{runtime.nodes.length}</dd></div>
      </dl>
    </header>
    <Omnibox startSearch={startStreamingSearch}
      openDirectUrl={url => requestSafeUrlOpen(url, (safe, target, features) => window.open(safe, target, features))}
      language={selectedLanguage} renderLanguage={language} onLanguageChange={setSelectedLanguage} />
    <section className="h1-evaluation" aria-labelledby="h1-evaluation-title">
      <div><p className="h1-evaluation__eyebrow">Evaluation only</p><h2 id="h1-evaluation-title">H1 呈现评估</h2>
        <p>两个条件共享同一份 Node、Edge、Resource 与 Resource Panel。</p></div>
      <div className="h1-evaluation__conditions" role="group" aria-label="H1 呈现条件">
        <button type="button" aria-pressed={condition === "graph"} onClick={() => setCondition("graph")}>Graph View</button>
        <button type="button" aria-pressed={condition === "structured-flat-list"} onClick={() => setCondition("structured-flat-list")}>Structured Flat List</button>
      </div>
    </section>
    {/* H1 的 Graph 条件始终固定为 graph，不能让 Planner 的 compact 模式改变实验条件。 */}
    <section className="graph-section graph-section--graph" aria-labelledby="graph-title">
      <div className="graph-section__header"><h2 id="graph-title">{messages.app.searchResults}</h2>
        <p>{condition === "graph" ? "H1 评估 · Graph View · 选择节点查看资源" : "H1 评估 · Structured Flat List · 选择节点查看资源"}</p></div>
      <div className={`graph-workspace${condition === "structured-flat-list" ? " graph-workspace--structured-flat-list" : ""}`}
        data-evaluation-condition={condition}>
        {condition === "structured-flat-list" ? <H1StructuredFlatList /> : <GraphView presentationMode="graph" language={language} />}
        <ResourcePanelView model={buildResourcePanelModel(selectedNode, language)} />
      </div>
    </section>
  </main>;
}
