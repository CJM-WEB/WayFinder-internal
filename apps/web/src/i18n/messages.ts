/**
 * 模块职责：集中维护正式 Web App 的用户可见文案，并用公共 Contract 约束语言与枚举覆盖范围。
 *
 * 关键边界：
 * - 本表只翻译 WayFinder 自产的界面文案，不翻译 Provider 或网页提供的标题、URL 与域名；
 * - Node 标题、AI 摘要和入选原因由服务端按 Run 语言生成，前端只原样展示；
 * - 函数型文案统一处理计数、资源标题等动态内容，避免组件自行拼接不同语言的句子。
 */
import type {
  AppErrorCode,
  EditableNode,
  GraphEdge,
  NodeType,
  NodeWarningCode,
  PresentationMode,
  SearchLanguage,
  StreamNodeStatus,
} from "@wayfinder/contracts";

export type Messages = Readonly<{
  workspace: Readonly<{
    records: string;
    newSearch: string;
    rename: string;
    delete: string;
    saveTitle: string;
    cancel: string;
    titleLabel: string;
    restoreDeleted: string;
    emptyRecords: string;
    loading: string;
    saving: string;
    saved: string;
    loadFailure: string;
    saveFailure: string;
    retry: string;
  }>;
  app: Readonly<{
    slogan: string;
    summaryAria: string;
    currentQuery: string;
    notStarted: string;
    searchStatus: string;
    searchState: Readonly<Record<"idle" | "searching" | "complete", string>>;
    nodeCount: string;
    searchResults: string;
    resultInstructions: Readonly<Record<PresentationMode, string>>;
  }>;
  omnibox: Readonly<{
    formAria: string;
    queryLabel: string;
    placeholder: string;
    languageLabel: string;
    searchButton: string;
    hint: string;
    inputFailure: string;
    invalidQuery: string;
    invalidUrl: string;
    unsupportedProtocol: string;
    searchFailure: string;
    languageOptions: Readonly<Record<SearchLanguage, string>>;
  }>;
  graph: Readonly<{
    empty: string;
    canvasAria: Readonly<Record<PresentationMode, string>>;
    nodeTypeLabels: Readonly<Record<NodeType, string>>;
    statusLabels: Readonly<Record<StreamNodeStatus | EditableNode["status"], string>>;
    statusDetails: Readonly<
      Record<StreamNodeStatus | EditableNode["status"], (resourceCount: number) => string>
    >;
    edgeLabels: Readonly<Record<GraphEdge["type"], string>>;
    edgeAria: Readonly<Record<GraphEdge["type"], string>>;
    nodeAria: (title: string, statusLabel: string) => string;
    nodeSelectionDescription: string;
    edgeDescription: string;
    controlsAria: string;
    zoomInAria: string;
    zoomOutAria: string;
    fitViewAria: string;
  }>;
  resourcePanel: Readonly<{
    selectedNode: string;
    resourceCount: (count: number) => string;
    resourceListAria: string;
    domain: string;
    sourceType: string;
    aiSummary: string;
    whySelected: string;
    open: string;
    openAria: (title: string) => string;
    invalidUrl: string;
    showMore: (count: number) => string;
    panelName: string;
    chooseNode: string;
    chooseNodeHint: string;
    processing: string;
    emptyNode: string;
    partialTitle: string;
    failedTitle: string;
    warningMessages: Readonly<Record<NodeWarningCode, string>>;
    errorMessages: Readonly<Record<AppErrorCode, string>>;
  }>;
}>;

/**
 * 两种语言保持完全相同的键结构；公共枚举新增值时，Record 会在编译期要求同步补齐文案。
 * English 的资源计数在这里处理单复数，组件无需知道具体语言规则。
 */
export const MESSAGES: Record<SearchLanguage, Messages> = {
  "zh-CN": {
    workspace: {
      records: "搜索图记录", newSearch: "新建搜索", rename: "重命名", delete: "删除记录",
      saveTitle: "保存名称", cancel: "取消", titleLabel: "记录名称", restoreDeleted: "撤销删除记录",
      emptyRecords: "搜索后会在此保存记录。", loading: "正在读取本地记录…", saving: "正在保存…",
      saved: "已保存到本浏览器", loadFailure: "无法读取本地记录，请重试；暂未覆盖已有数据。",
      saveFailure: "本次更改未能保存，请重试。", retry: "重试保存或读取",
    },
    app: {
      slogan: "Graph 即搜索结果页",
      summaryAria: "搜索摘要",
      currentQuery: "当前查询",
      notStarted: "尚未开始",
      searchStatus: "搜索状态",
      searchState: {
        idle: "待搜索",
        searching: "搜索中",
        complete: "已完成",
      },
      nodeCount: "节点数量",
      searchResults: "搜索结果",
      resultInstructions: {
        graph: "滚轮缩放 · 拖动画布 · 选择节点查看资源",
        compact: "紧凑结果 · 选择节点查看资源",
      },
    },
    omnibox: {
      formAria: "WayFinder 搜索",
      queryLabel: "搜索任意主题",
      placeholder: "输入网址、关键词或自然语言，按 Enter",
      languageLabel: "语言",
      searchButton: "搜索",
      hint: "明确的 HTTP(S) 网址将直接打开，其他输入进入 AI Search。",
      inputFailure: "无法处理当前输入，请稍后重试。",
      invalidQuery: "请输入 1 至 2000 个字符的搜索内容。",
      invalidUrl: "网址格式无效，请使用完整的 http:// 或 https:// 地址。",
      unsupportedProtocol: "不支持此网址协议，仅支持 http:// 或 https://。",
      searchFailure: "搜索启动失败，请稍后重试。",
      languageOptions: {
        "zh-CN": "简体中文",
        "en-US": "English",
      },
    },
    graph: {
      empty: "暂无可展示的搜索结果。",
      canvasAria: {
        graph: "探索式搜索结果图",
        compact: "紧凑搜索结果图",
      },
      nodeTypeLabels: {
        primary: "主路径",
        related: "相关主题",
        disambiguation: "消歧分支",
      },
      statusLabels: {
        empty: "空节点",
        edited: "已编辑",
        planned: "等待检索",
        searching: "检索中",
        filtering: "筛选中",
        ready: "已就绪",
        partial: "部分完成",
        failed: "失败",
      },
      statusDetails: {
        empty: () => "可以添加资源",
        edited: count => `${count} 条资源 · 已编辑`,
        planned: () => "等待开始",
        searching: () => "正在检索网页",
        filtering: () => "正在筛选结果",
        ready: resourceCount => `${resourceCount} 条可用资源`,
        partial: resourceCount => `${resourceCount} 条可用资源 · 含降级`,
        failed: () => "没有可用资源",
      },
      edgeLabels: {
        recommended_next: "推荐下一步",
        related_to: "相关",
      },
      edgeAria: {
        recommended_next: "推荐下一步",
        related_to: "相关主题",
      },
      nodeAria: (title, statusLabel) => `${title}，状态：${statusLabel}`,
      nodeSelectionDescription: "按回车或空格选择节点。",
      edgeDescription: "图中的节点关系。",
      controlsAria: "图视图控制",
      zoomInAria: "放大",
      zoomOutAria: "缩小",
      fitViewAria: "显示全部节点",
    },
    resourcePanel: {
      selectedNode: "已选节点",
      resourceCount: count => `${count} 条可用资源`,
      resourceListAria: "节点资源",
      domain: "域名",
      sourceType: "来源类型",
      aiSummary: "AI 摘要",
      whySelected: "入选原因",
      open: "打开",
      openAria: title => `在新标签页打开 ${title}`,
      invalidUrl: "链接不可用：仅支持有效的 HTTP(S) 地址。",
      showMore: count => `显示更多（${count}）`,
      panelName: "资源面板",
      chooseNode: "选择一个节点",
      chooseNodeHint: "你可以自由查看任意节点，不必沿箭头顺序浏览。",
      processing: "该节点仍在处理，资源准备完成后将在此显示。",
      emptyNode: "该节点尚无资源，可以添加链接或重新搜索。",
      partialTitle: "结果部分降级",
      failedTitle: "节点处理失败",
      warningMessages: {
        SEARCH_PROVIDER_PARTIAL: "部分搜索来源暂时不可用，现有结果仍可浏览。",
        EXTRACTION_FAILED: "部分网页正文读取失败，相关内容使用搜索摘要。",
        RERANK_FAILED: "智能排序暂时不可用，当前结果使用基础排序。",
      },
      errorMessages: {
        PLANNER_FAILED: "未能生成可用的检索计划。",
        INVALID_GRAPH: "检索计划无效，未能执行该节点。",
        SEARCH_PROVIDER_FAILED: "未能获取可用的搜索结果。",
        NO_UNIQUE_RESOURCE_AVAILABLE: "该节点的可用结果已在图中其他节点展示。",
        EXTRACTION_FAILED: "未能读取可用的网页内容。",
        RERANK_FAILED: "未能完成结果排序。",
        RUN_DEADLINE_EXCEEDED: "该节点未能在本轮时限内完成。",
        REQUEST_ABORTED: "该节点处理已中止。",
        UNKNOWN: "该节点处理失败，暂无可用结果。",
      },
    },
  },
  "en-US": {
    workspace: {
      records: "Search graphs", newSearch: "New search", rename: "Rename", delete: "Delete record",
      saveTitle: "Save name", cancel: "Cancel", titleLabel: "Record name", restoreDeleted: "Undo record deletion",
      emptyRecords: "Your searches will be saved here.", loading: "Loading local records…", saving: "Saving…",
      saved: "Saved in this browser", loadFailure: "Unable to load local records. Retry to continue; existing data has not been overwritten.",
      saveFailure: "Your latest changes could not be saved. Please retry.", retry: "Retry saving or loading",
    },
    app: {
      slogan: "The Graph is the search results page",
      summaryAria: "Search summary",
      currentQuery: "Current query",
      notStarted: "Not started",
      searchStatus: "Search status",
      searchState: {
        idle: "Ready to search",
        searching: "Searching",
        complete: "Complete",
      },
      nodeCount: "Node count",
      searchResults: "Search results",
      resultInstructions: {
        graph: "Scroll to zoom · Drag the canvas · Select a node to view resources",
        compact: "Compact results · Select a node to view resources",
      },
    },
    omnibox: {
      formAria: "WayFinder search",
      queryLabel: "Search any topic",
      placeholder: "Enter a URL, keywords, or a question, then press Enter",
      languageLabel: "Language",
      searchButton: "Search",
      hint: "Complete HTTP(S) URLs open directly; all other input starts an AI Search.",
      inputFailure: "Unable to process this input. Please try again.",
      invalidQuery: "Enter between 1 and 2,000 characters to search.",
      invalidUrl: "Invalid URL. Use a complete http:// or https:// address.",
      unsupportedProtocol: "Unsupported URL protocol. Only http:// and https:// are allowed.",
      searchFailure: "Unable to start the search. Please try again.",
      languageOptions: {
        "zh-CN": "简体中文",
        "en-US": "English",
      },
    },
    graph: {
      empty: "No search results to display yet.",
      canvasAria: {
        graph: "Exploratory search results graph",
        compact: "Compact search results graph",
      },
      nodeTypeLabels: {
        primary: "Main path",
        related: "Related topic",
        disambiguation: "Disambiguation",
      },
      statusLabels: {
        empty: "Empty",
        edited: "Edited",
        planned: "Waiting",
        searching: "Searching",
        filtering: "Filtering",
        ready: "Ready",
        partial: "Partially complete",
        failed: "Failed",
      },
      statusDetails: {
        empty: () => "Add resources to this node",
        edited: count => `${count} resources · Edited`,
        planned: () => "Waiting to start",
        searching: () => "Searching the web",
        filtering: () => "Filtering results",
        ready: resourceCount =>
          `${resourceCount} available ${resourceCount === 1 ? "resource" : "resources"}`,
        partial: resourceCount =>
          `${resourceCount} available ${resourceCount === 1 ? "resource" : "resources"} · Degraded`,
        failed: () => "No resources available",
      },
      edgeLabels: {
        recommended_next: "Recommended next",
        related_to: "Related",
      },
      edgeAria: {
        recommended_next: "Recommended next",
        related_to: "Related topic",
      },
      nodeAria: (title, statusLabel) => `${title}, status: ${statusLabel}`,
      nodeSelectionDescription: "Press Enter or Space to select a node.",
      edgeDescription: "Relationship between nodes in the graph.",
      controlsAria: "Graph view controls",
      zoomInAria: "Zoom in",
      zoomOutAria: "Zoom out",
      fitViewAria: "Fit all nodes",
    },
    resourcePanel: {
      selectedNode: "Selected node",
      resourceCount: count =>
        `${count} available ${count === 1 ? "resource" : "resources"}`,
      resourceListAria: "Node resources",
      domain: "Domain",
      sourceType: "Source type",
      aiSummary: "AI summary",
      whySelected: "Why it was selected",
      open: "Open",
      openAria: title => `Open ${title} in a new tab`,
      invalidUrl: "Link unavailable: only valid HTTP(S) addresses are supported.",
      showMore: count => `Show more (${count})`,
      panelName: "Resource panel",
      chooseNode: "Select a node",
      chooseNodeHint: "You can view any node without following the arrows in order.",
      processing: "This node is still processing. Resources will appear here when ready.",
      emptyNode: "This node has no resources yet. Add a link or search again.",
      partialTitle: "Results partially degraded",
      failedTitle: "Node processing failed",
      warningMessages: {
        SEARCH_PROVIDER_PARTIAL: "Some search sources are temporarily unavailable. Existing results remain available.",
        EXTRACTION_FAILED: "Some webpages could not be read. Their search snippets are being used instead.",
        RERANK_FAILED: "Smart ranking is temporarily unavailable. Basic ranking is being used.",
      },
      errorMessages: {
        PLANNER_FAILED: "Unable to create a usable search plan.",
        INVALID_GRAPH: "The search plan was invalid, so this node could not run.",
        SEARCH_PROVIDER_FAILED: "No usable search results could be retrieved.",
        NO_UNIQUE_RESOURCE_AVAILABLE: "This node's usable results are already shown in other nodes.",
        EXTRACTION_FAILED: "No usable webpage content could be read.",
        RERANK_FAILED: "Unable to rank the results.",
        RUN_DEADLINE_EXCEEDED: "This node did not finish within the run deadline.",
        REQUEST_ABORTED: "Processing for this node was stopped.",
        UNKNOWN: "This node failed and has no usable results.",
      },
    },
  },
};

/** 调用方必须提供已通过公共 Contract 的语言，不在前端静默猜测或降级。 */
export const getMessages = (language: SearchLanguage): Messages =>
  MESSAGES[language];
