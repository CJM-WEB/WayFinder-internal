/**
 * 组件职责：读取严格 H2 本地工件，并用生产 Resource Panel（资源面板）盲显中性 A/B 条件。
 *
 * 实验边界：
 * - 页面不发起 Search/Fetch，不展示 source 或 SearchPlan，也不修改 Product Store；
 * - 两个条件都通过同一 buildResourcePanelModel + ResourcePanelView 路径渲染；
 * - 切换条件会重建面板，确保 Show More 等本地状态在 A/B 间互不污染。
 */
import {
  H2EvaluationArtifactSchema,
  type H2EvaluationArtifact,
  type H2EvaluationConditionId,
} from "@wayfinder/contracts";
import { useState, type ChangeEvent } from "react";

import type { BrowserUrlOpener } from "../../lib/url.js";
import {
  buildResourcePanelModel,
  ResourcePanelView,
} from "../ResourcePanel/ResourcePanel.js";

const MAX_H2_ARTIFACT_SIZE_BYTES = 1_048_576;

/** JSON 先作为 unknown 解析，再由共享 Contract 收窄；错误不回显文件内容或 Schema 细节。 */
export function parseH2EvaluationArtifact(
  text: string,
): H2EvaluationArtifact {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("H2 评估文件不是有效 JSON");
  }

  const parsed = H2EvaluationArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("H2 评估文件不符合当前 Contract");
  }
  return parsed.data;
}

export type H2EvaluationViewProps = Readonly<{
  artifact: H2EvaluationArtifact;
  initialCondition?: H2EvaluationConditionId;
  openResource?: BrowserUrlOpener;
}>;

/** 纯视图入口便于证明两个条件共用同一 Resource Panel，而不依赖文件系统交互。 */
export function H2EvaluationView({
  artifact,
  initialCondition = "A",
  openResource,
}: H2EvaluationViewProps) {
  const [conditionId, setConditionId] = useState(initialCondition);
  const condition = artifact.conditions.find(
    candidate => candidate.id === conditionId,
  );
  if (condition === undefined) {
    throw new Error("H2 工件缺少选定条件");
  }

  return (
    <main className="app-shell h2-evaluation" data-evaluation-condition={condition.id}>
      <header className="app-header">
        <div className="app-header__intro">
          <p>Evaluation only</p>
          <h1>H2 检索评估</h1>
        </div>
        <dl className="app-summary" aria-label="H2 评估摘要">
          <div>
            <dt>评估 Query</dt>
            <dd>{artifact.query}</dd>
          </div>
          <div>
            <dt>评估 Node</dt>
            <dd>{condition.node.title}</dd>
          </div>
          <div>
            <dt>当前条件</dt>
            <dd>条件 {condition.id}</dd>
          </div>
        </dl>
      </header>

      <section className="h2-evaluation__controls" aria-labelledby="h2-evaluation-title">
        <div>
          <h2 id="h2-evaluation-title">Resource 结果比较</h2>
          <p>使用相同面板逐项判断相关性、值得打开程度、重复与排序。</p>
        </div>
        <div className="h2-evaluation__conditions" role="group" aria-label="H2 评估条件">
          {artifact.conditions.map(candidate => (
            <button
              type="button"
              aria-pressed={candidate.id === condition.id}
              key={candidate.id}
              onClick={() => setConditionId(candidate.id)}
            >
              条件 {candidate.id}
            </button>
          ))}
        </div>
      </section>

      <section className="h2-evaluation__panel" aria-label={`条件 ${condition.id} 的资源`}>
        <ResourcePanelView
          key={condition.id}
          model={buildResourcePanelModel(condition.node)}
          {...(openResource === undefined ? {} : { openResource })}
        />
      </section>
    </main>
  );
}

export type H2EvaluationAppProps = Readonly<{
  initialCondition?: H2EvaluationConditionId;
}>;

/** 文件选择是显式本地动作；普通产品不会自动发现、读取或上传 Eval 工件。 */
export function H2EvaluationApp({
  initialCondition = "A",
}: H2EvaluationAppProps) {
  const [artifact, setArtifact] = useState<H2EvaluationArtifact | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;

    if (file.size > MAX_H2_ARTIFACT_SIZE_BYTES) {
      setArtifact(null);
      setErrorMessage("H2 评估文件超过 1 MiB 安全上限");
      input.value = "";
      return;
    }

    try {
      const parsed = parseH2EvaluationArtifact(await file.text());
      setArtifact(parsed);
      setErrorMessage(null);
    } catch (error: unknown) {
      setArtifact(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "无法读取 H2 评估文件",
      );
    } finally {
      // 允许人员修正文件后再次选择同一路径。
      input.value = "";
    }
  };

  if (artifact !== null) {
    return (
      <H2EvaluationView
        artifact={artifact}
        initialCondition={initialCondition}
      />
    );
  }

  return (
    <main className="app-shell h2-evaluation h2-evaluation--loader">
      <section className="h2-evaluation__loader" aria-labelledby="h2-loader-title">
        <p className="h1-evaluation__eyebrow">Evaluation only</p>
        <h1 id="h2-loader-title">载入 H2 评估工件</h1>
        <p>选择受控 Runner 生成的 JSON 文件；文件只在当前浏览器标签内解析。</p>
        <label>
          选择 JSON 文件
          <input
            type="file"
            accept="application/json,.json"
            onChange={event => void handleFileChange(event)}
          />
        </label>
        {errorMessage === null ? null : <p role="alert">{errorMessage}</p>}
      </section>
    </main>
  );
}
