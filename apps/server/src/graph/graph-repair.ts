/**
 * 模块职责：按批准的稳定阶段删除 GraphPlan 中可安全修复的结构缺陷。
 *
 * 修复边界：
 * - 只过滤已有 Node / Edge，不改写 Analysis、Node、SearchPlan 或 Edge 内容。
 * - 不生成 Node、Query、URL、Resource，也不调用 LLM 或创建 compact fallback。
 * - 不修复主观语义、数量不足、重复 Node ID、断连或缺少 anchor；最终 Validator
 *   会保留这些 Finding，供 WAY-39 决定 retry / fallback。
 */
import type { GraphPlan } from "@wayfinder/contracts";

import {
  validateGraphPlan,
  type GraphPlanFindingCode,
  type GraphPlanValidationResult,
} from "./graph-validator.js";

export type GraphPlanRepairResult = Readonly<{
  plan: GraphPlan;
  repaired: boolean;
  validation: GraphPlanValidationResult;
}>;

type RepairStageResult = Readonly<{
  plan: GraphPlan;
  removed: boolean;
}>;

const DUPLICATE_EDGE_FINDING_CODES = new Set<GraphPlanFindingCode>([
  "DUPLICATE_EDGE_ID",
  "DUPLICATE_RECOMMENDED_EDGE",
  "DUPLICATE_RELATED_EDGE",
]);

const DANGLING_EDGE_FINDING_CODES = new Set<GraphPlanFindingCode>([
  "DANGLING_EDGE_SOURCE",
  "DANGLING_EDGE_TARGET",
]);

const CYCLE_EDGE_FINDING_CODES = new Set<GraphPlanFindingCode>([
  "RECOMMENDED_NEXT_CYCLE",
]);

/** Finding 的数量 metadata 由 Validator 产生；缺失时不猜测另一套上限。 */
function findMaximum(
  validation: GraphPlanValidationResult,
  code: GraphPlanFindingCode,
): number | undefined {
  const finding = validation.findings.find(item => item.code === code);
  const maximum = finding?.metadata?.max;
  return typeof maximum === "number" ? maximum : undefined;
}

/**
 * 保留匹配类型中靠前的 maximum 项；其他类型与剩余项的相对顺序保持不变。
 * maximum 只来自 Validator 的数字 metadata，避免 Repair 与 Validator 数量漂移。
 */
function trimNodeType(
  plan: GraphPlan,
  nodeType: GraphPlan["nodes"][number]["nodeType"],
  maximum: number,
): RepairStageResult {
  let retainedCount = 0;
  let removed = false;
  const nodes = plan.nodes.filter(node => {
    if (node.nodeType !== nodeType) {
      return true;
    }

    retainedCount += 1;
    if (retainedCount <= maximum) {
      return true;
    }

    removed = true;
    return false;
  });

  return removed ? { plan: { ...plan, nodes }, removed } : { plan, removed };
}

/** compact 的数量上限作用于全部剩余 Node，而不是某一种 Node 类型。 */
function trimCompactNodes(
  plan: GraphPlan,
  maximum: number,
): RepairStageResult {
  if (plan.nodes.length <= maximum) {
    return { plan, removed: false };
  }

  return {
    plan: { ...plan, nodes: plan.nodes.slice(0, maximum) },
    removed: true,
  };
}

/**
 * Node trim 的内部稳定顺序：先 Related，再处理展示模式数量。
 * Related 优先可避免 compact 截断时让第三个 Related 挤掉仍有用的 Primary。
 * 总 Node > 8 已由 WAY-36 Schema 拒绝，不在这里绕过 Parser 修复。
 */
function trimOverLimitNodes(plan: GraphPlan): RepairStageResult {
  let currentPlan = plan;
  let removed = false;

  const initialValidation = validateGraphPlan(currentPlan);
  const relatedMaximum = findMaximum(
    initialValidation,
    "RELATED_NODE_COUNT_EXCEEDED",
  );
  if (relatedMaximum !== undefined) {
    const result = trimNodeType(currentPlan, "related", relatedMaximum);
    currentPlan = result.plan;
    removed ||= result.removed;
  }

  // Related 删除会改变 compact 总数，因此模式上限必须基于新的当前计划重新判断。
  const modeValidation = validateGraphPlan(currentPlan);
  if (currentPlan.analysis.presentationMode === "compact") {
    const compactMaximum = findMaximum(
      modeValidation,
      "COMPACT_NODE_COUNT_OUT_OF_RANGE",
    );
    if (compactMaximum !== undefined) {
      const result = trimCompactNodes(currentPlan, compactMaximum);
      currentPlan = result.plan;
      removed ||= result.removed;
    }
  } else {
    const disambiguationMaximum = findMaximum(
      modeValidation,
      "HIGH_AMBIGUITY_DISAMBIGUATION_COUNT_OUT_OF_RANGE",
    );
    if (disambiguationMaximum !== undefined) {
      const result = trimNodeType(
        currentPlan,
        "disambiguation",
        disambiguationMaximum,
      );
      currentPlan = result.plan;
      removed ||= result.removed;
    } else {
      const primaryMaximum = findMaximum(
        modeValidation,
        "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE",
      );
      if (primaryMaximum !== undefined) {
        const result = trimNodeType(
          currentPlan,
          "primary",
          primaryMaximum,
        );
        currentPlan = result.plan;
        removed ||= result.removed;
      }
    }
  }

  // compact 修复后恰为单节点时，空 Edge 是已批准的确定性硬规则。
  if (
    currentPlan.analysis.presentationMode === "compact" &&
    currentPlan.nodes.length === 1 &&
    currentPlan.edges.length > 0
  ) {
    currentPlan = { ...currentPlan, edges: [] };
    removed = true;
  }

  return { plan: currentPlan, removed };
}

/** 从稳定 Finding path 读取当前阶段 Edge index；异常路径不会触发猜测性删除。 */
function collectEdgeIndexes(
  validation: GraphPlanValidationResult,
  codes: ReadonlySet<GraphPlanFindingCode>,
): ReadonlySet<number> {
  const indexes = new Set<number>();

  for (const finding of validation.findings) {
    if (!codes.has(finding.code)) {
      continue;
    }

    const edgeIndex = finding.path[1];
    if (typeof edgeIndex === "number" && Number.isSafeInteger(edgeIndex)) {
      indexes.add(edgeIndex);
    }
  }

  return indexes;
}

/** 每个 Edge 阶段都基于当前计划重新验证，避免前序过滤导致 index 漂移。 */
function removeEdgesByFindings(
  plan: GraphPlan,
  codes: ReadonlySet<GraphPlanFindingCode>,
): RepairStageResult {
  const validation = validateGraphPlan(plan);
  const indexes = collectEdgeIndexes(validation, codes);
  if (indexes.size === 0) {
    return { plan, removed: false };
  }

  return {
    plan: {
      ...plan,
      edges: plan.edges.filter((_, edgeIndex) => !indexes.has(edgeIndex)),
    },
    removed: true,
  };
}

/**
 * 执行一次有界本地 Repair；固定阶段顺序属于行为约束，不能按输入临时重排：
 * Node trim → duplicate Edge → dangling Edge → cycle → 最终 Validator。
 */
export function repairGraphPlan(plan: GraphPlan): GraphPlanRepairResult {
  let currentPlan = plan;
  let repaired = false;

  const nodeResult = trimOverLimitNodes(currentPlan);
  currentPlan = nodeResult.plan;
  repaired ||= nodeResult.removed;

  const duplicateResult = removeEdgesByFindings(
    currentPlan,
    DUPLICATE_EDGE_FINDING_CODES,
  );
  currentPlan = duplicateResult.plan;
  repaired ||= duplicateResult.removed;

  const danglingResult = removeEdgesByFindings(
    currentPlan,
    DANGLING_EDGE_FINDING_CODES,
  );
  currentPlan = danglingResult.plan;
  repaired ||= danglingResult.removed;

  const cycleResult = removeEdgesByFindings(
    currentPlan,
    CYCLE_EDGE_FINDING_CODES,
  );
  currentPlan = cycleResult.plan;
  repaired ||= cycleResult.removed;

  return {
    plan: currentPlan,
    repaired,
    validation: validateGraphPlan(currentPlan),
  };
}
