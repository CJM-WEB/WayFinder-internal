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
  CredentialService,
  CredentialsErrorCode,
  EditableNode,
  GraphEdge,
  NodeType,
  NodeWarningCode,
  PresentationMode,
  SearchLanguage,
  SearchEngine,
  StreamNodeStatus,
} from "@wayfinder/contracts";

export type Messages = Readonly<{
  settings: Readonly<{
    title: string; own: string; experience: string; key: string; save: string; saved: string;
    show: string; hide: string; clear: string; cancel: string; confirm: string; announcement: string;
    invite: string; experienceTitle: string; sharedWarning: string; loading: string; authorized: string;
    unavailable: string; readFailure: string; saveFailure: string; retry: string; open: string;
    ownHint: string; getKey: Readonly<Record<CredentialService, string>>;
    problems: Readonly<Record<CredentialsErrorCode, string>>;
  }>;
  inkStudy: Readonly<{
    statement: string; tagline: string; explore: string; contact: string; stageAria: string; pageTitle: string;
    emailCopied: string; emailCopyFailed: string;
    searchFailed: string; graphLoadFailed: string; panelLoadFailed: string;
    backHome: string; searchHistory: string; newGraph: string;
    closeResources: string; showResourceDetails: string; hideResourceDetails: string;
    actionMenu: string; closePanel: string; undoHistory: string; emptyUndo: string;
    undoHint: string; undoDependency: string; undoConstraint: string; undoUnavailable: string; restoreGraph: string;
    graphResultApplied: string; nodeResultApplied: string;
  }>;
  research: Readonly<{
    startGraph: string; startNode: string; preview: string; searching: string;
    failure: string; cancel: string; dismiss: string; append: string; replace: string;
    fullHint: string; nodeHint: string; queryLabel: string; topicLabel: string; topicHint: string; invalidInput: string; missingTarget: string;
  }>;
  searchEngine: Readonly<{
    label: string; nodeLabel: string; sourceLabel: string; unknownSource: string;
    labels: Readonly<Record<SearchEngine, string>>; baiduRegionNotice: string;
  }>;
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
  editor: Readonly<{
    toolbar: string; newNodeTitle: string; addNode: string; editNode: string; deleteNode: string;
    nodeTitle: string; nodeDescription: string; saveNode: string; cancel: string;
    addResource: string; resourceUrl: string; resourceTitle: string; resourceSummary: string;
    whySelected: string; editResource: string; saveResource: string; deleteResource: string;
    moveUp: string; moveDown: string; dragResource: string; undo: string; redo: string;
    manualSource: string; manualGraphTitle: string; duplicateUrl: (nodeTitle: string) => string;
    locateDuplicate: string; invalidUrl: string; editFailure: string;
    connections: (count: number) => string; selectConnection: string; newConnection: string;
    sourceNode: string; targetNode: string; relationType: string; addConnection: string;
    saveConnection: string; deleteConnection: string; invalidConnection: string; graphInstructions: string;
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
    settings: {
      title: "设置", own: "自己的 API Key", experience: "体验 APIKEY", key: "API Key", save: "保存设置", saved: "已保存到本浏览器",
      show: "显示", hide: "隐藏", clear: "清除", cancel: "取消", confirm: "确认使用", announcement: "作者公告",
      invite: "邀请码", experienceTitle: "使用作者 APIKEY 体验", loading: "正在读取体验信息…", authorized: "本浏览器已有有效体验资格，无需再次输入邀请码。",
      sharedWarning: "使用作者APIKEY之后额度共享，费用全由作者承担，但也可能出现额度不足导致搜索失败",
      unavailable: "作者体验暂不可用。", readFailure: "设置读取失败，请重试；当前不会覆盖旧设置。", saveFailure: "设置保存失败，请重试。", retry: "重试读取", open: "打开设置",
      ownHint: "Key 长期保存在当前浏览器；搜索时发送到本应用后端代调用，服务端不持久保存；保存不会发起付费测试。",
      getKey: { deepseek: "获取DeepSeek API KEY", serpapi: "获取SerpAPI KEY" },
      problems: { CREDENTIALS_REQUIRED: "请先配置 API Key。", CREDENTIALS_INVALID: "凭据配置无效，请检查设置。", INVITE_CODE_INVALID: "邀请码无效，请检查后重试。", EXPERIENCE_REVOKED: "体验资格已失效，请输入当前邀请码。", EXPERIENCE_UNAVAILABLE: "作者体验暂不可用，请稍后重试。" },
    },
    inkStudy: {
      statement: "让每个好奇，\n都有去处。", tagline: "打造属于自己的互联网", explore: "开始探索", contact: "联系作者",
      emailCopied: "邮箱已复制", emailCopyFailed: "复制失败，请手动复制邮箱",
      searchFailed: "本次搜索未完成，请重试。",
      graphLoadFailed: "搜索图暂时无法显示，请重新打开。",
      panelLoadFailed: "操作面板暂时无法显示，请收起后重新打开。",
      backHome: "返回首页", searchHistory: "搜索历史", newGraph: "新建搜索图",
      closeResources: "收起资源", showResourceDetails: "展开详情", hideResourceDetails: "收起详情",
      actionMenu: "图操作菜单", closePanel: "收起面板", undoHistory: "撤销记录", emptyUndo: "暂无可撤销操作",
      undoHint: "仅撤销选中的操作，保留后续独立修改。",
      undoDependency: "后续内容依赖此操作，请先处理依赖项。", undoConstraint: "撤销会破坏当前图约束，请先处理冲突。",
      undoUnavailable: "此操作已发生变化，请重新选择。", restoreGraph: "恢复搜索图",
      graphResultApplied: "应用全图结果", nodeResultApplied: "应用节点结果",
      stageAria: "WAYFINDER 墨迹漫游", pageTitle: "WAYFINDER — 墨迹漫游",
    },
    research: {
      startGraph: "重新搜索全图", startNode: "重新搜索此节点", preview: "重搜预览", searching: "正在重新搜索，当前图保持不变。",
      failure: "没有可应用的新结果，当前图保持不变。", cancel: "取消重搜", dismiss: "弃用新结果", append: "追加到此节点", replace: "应用替换",
      fullHint: "全图只能整体替换；应用后可撤销恢复旧图。", nodeHint: "追加保留旧资源；替换覆盖此节点的全部旧资源，包括人工编辑。", queryLabel: "本次查询", topicLabel: "搜索主题", topicHint: "此图暂无原始查询，请先填写全图搜索主题。", invalidInput: "搜索主题须为 1 至 2000 个字符，节点标题不能为空。", missingTarget: "搜索图或目标节点已不存在，请重新选择。",
    },
    searchEngine: {
      label: "搜索引擎", nodeLabel: "节点搜索引擎", sourceLabel: "实际搜索引擎", unknownSource: "未记录",
      labels: { baidu: "百度", google: "Google" }, baiduRegionNotice: "百度不保证地区定位。",
    },
    workspace: {
      records: "搜索图记录", newSearch: "新建搜索", rename: "重命名", delete: "删除记录",
      saveTitle: "保存名称", cancel: "取消", titleLabel: "记录名称", restoreDeleted: "撤销删除记录",
      emptyRecords: "搜索后会在此保存记录。", loading: "正在读取本地记录…", saving: "正在保存…",
      saved: "已保存到本浏览器", loadFailure: "无法读取本地记录，请重试；暂未覆盖已有数据。",
      saveFailure: "本次更改未能保存，请重试。", retry: "重试保存或读取",
    },
    editor: {
      toolbar: "图编辑", newNodeTitle: "新节点标题", addNode: "新建节点", editNode: "编辑节点", deleteNode: "删除节点",
      nodeTitle: "节点标题", nodeDescription: "节点说明", saveNode: "保存节点", cancel: "取消编辑",
      addResource: "添加资源", resourceUrl: "资源 URL", resourceTitle: "资源标题", resourceSummary: "网页说明",
      whySelected: "选用理由", editResource: "编辑资源", saveResource: "保存资源", deleteResource: "删除资源",
      moveUp: "上移资源", moveDown: "下移资源", dragResource: "可上下拖拽调整资源顺序", undo: "撤销", redo: "重做",
      manualSource: "用户添加", manualGraphTitle: "未命名搜索图", duplicateUrl: title => `此 URL 已存在于「${title}」节点中。`,
      connections: count => `节点关系（${count}）`, selectConnection: "选择连线", newConnection: "新增连线",
      sourceNode: "起点节点", targetNode: "终点节点", relationType: "关系类型", addConnection: "添加连线",
      saveConnection: "保存连线", deleteConnection: "删除连线",
      invalidConnection: "连线无效：请连接现有节点的同类端口；推荐下一步不能形成环。",
      graphInstructions: "拖动节点调整位置；上下端口连接推荐顺序，左右端口连接相关主题。",
      locateDuplicate: "定位已有资源所在节点", invalidUrl: "请输入有效的完整 HTTP(S) 地址。", editFailure: "无法保存此次编辑，请检查输入。",
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
    settings: {
      title: "Settings", own: "Your API key", experience: "Author trial", key: "API key", save: "Save settings", saved: "Saved in this browser",
      show: "Show", hide: "Hide", clear: "Clear", cancel: "Cancel", confirm: "Confirm trial", announcement: "Author announcement",
      invite: "Invitation code", experienceTitle: "Try the author's API keys", loading: "Loading trial information…", authorized: "This browser has valid trial access. You do not need to enter the invitation code again.",
      sharedWarning: "The author's API quota is shared and all costs are paid by the author. Searches may fail if the quota runs out.",
      unavailable: "The author's trial is unavailable.", readFailure: "Settings could not be read. Retry before replacing existing settings.", saveFailure: "Settings could not be saved. Please retry.", retry: "Retry loading", open: "Open settings",
      ownHint: "Keys are saved in this browser long term and sent to this app’s backend for searches. The server does not persist them. Saving does not run a paid test.",
      getKey: { deepseek: "Get a DeepSeek API key", serpapi: "Get a SerpAPI key" },
      problems: { CREDENTIALS_REQUIRED: "Configure your API keys first.", CREDENTIALS_INVALID: "The credential settings are invalid. Check your settings.", INVITE_CODE_INVALID: "The invitation code is invalid. Check it and retry.", EXPERIENCE_REVOKED: "Trial access has expired. Enter the current invitation code.", EXPERIENCE_UNAVAILABLE: "The author's trial is unavailable. Please retry later." },
    },
    inkStudy: {
      statement: "Every curiosity,\na place to go.", tagline: "BUILD YOUR OWN INTERNET", explore: "Start exploring", contact: "Contact author",
      emailCopied: "Email copied", emailCopyFailed: "Could not copy. Please copy the email manually.",
      searchFailed: "The search could not be completed. Please try again.",
      graphLoadFailed: "The search graph could not be displayed. Please open it again.",
      panelLoadFailed: "The panel could not be displayed. Close it and open it again.",
      backHome: "Back to home", searchHistory: "Search history", newGraph: "New search graph",
      closeResources: "Close resources", showResourceDetails: "Show details", hideResourceDetails: "Hide details",
      actionMenu: "Graph actions", closePanel: "Close panel", undoHistory: "Undo history", emptyUndo: "No edits to undo",
      undoHint: "Undo one edit while keeping later independent changes.",
      undoDependency: "Later content depends on this edit. Resolve those dependencies first.", undoConstraint: "Undo would violate the current graph constraints. Resolve the conflict first.",
      undoUnavailable: "This edit has changed. Please select it again.", restoreGraph: "Restore search graph",
      graphResultApplied: "Apply graph results", nodeResultApplied: "Apply node results",
      stageAria: "WAYFINDER ink exploration", pageTitle: "WAYFINDER — Ink in motion",
    },
    research: {
      startGraph: "Search entire graph again", startNode: "Search this node again", preview: "Search preview", searching: "Searching again. Your current graph is unchanged.",
      failure: "No new results can be applied. Your current graph is unchanged.", cancel: "Cancel search", dismiss: "Discard new results", append: "Append to this node", replace: "Apply replacement",
      fullHint: "The entire graph will be replaced. Undo restores the previous graph.", nodeHint: "Append keeps existing resources. Replacement overwrites all resources in this node, including your edits.", queryLabel: "Search query", topicLabel: "Search topic", topicHint: "This graph has no original query. Enter a topic before searching the entire graph.", invalidInput: "Enter a search topic between 1 and 2,000 characters and a non-empty node title.", missingTarget: "The graph or target node is no longer available. Select it again.",
    },
    searchEngine: {
      label: "Search engine", nodeLabel: "Node search engine", sourceLabel: "Actual search engine", unknownSource: "Not recorded",
      labels: { baidu: "Baidu", google: "Google" }, baiduRegionNotice: "Baidu does not guarantee regional targeting.",
    },
    workspace: {
      records: "Search graphs", newSearch: "New search", rename: "Rename", delete: "Delete record",
      saveTitle: "Save name", cancel: "Cancel", titleLabel: "Record name", restoreDeleted: "Undo record deletion",
      emptyRecords: "Your searches will be saved here.", loading: "Loading local records…", saving: "Saving…",
      saved: "Saved in this browser", loadFailure: "Unable to load local records. Retry to continue; existing data has not been overwritten.",
      saveFailure: "Your latest changes could not be saved. Please retry.", retry: "Retry saving or loading",
    },
    editor: {
      toolbar: "Graph editing", newNodeTitle: "New node title", addNode: "Add node", editNode: "Edit node", deleteNode: "Delete node",
      nodeTitle: "Node title", nodeDescription: "Node description", saveNode: "Save node", cancel: "Cancel editing",
      addResource: "Add resource", resourceUrl: "Resource URL", resourceTitle: "Resource title", resourceSummary: "Page description",
      whySelected: "Selection reason", editResource: "Edit resource", saveResource: "Save resource", deleteResource: "Delete resource",
      moveUp: "Move resource up", moveDown: "Move resource down", dragResource: "Drag to reorder resources", undo: "Undo", redo: "Redo",
      manualSource: "Added by you", manualGraphTitle: "Untitled search graph", duplicateUrl: title => `This URL already exists in the “${title}” node.`,
      connections: count => `Node connections (${count})`, selectConnection: "Select connection", newConnection: "New connection",
      sourceNode: "Source node", targetNode: "Target node", relationType: "Relation type", addConnection: "Add connection",
      saveConnection: "Save connection", deleteConnection: "Delete connection",
      invalidConnection: "Invalid connection. Use matching ports on existing nodes; recommended-next connections cannot form a cycle.",
      graphInstructions: "Drag nodes to move them. Top/bottom ports define recommended order; side ports connect related topics.",
      locateDuplicate: "Go to the existing resource's node", invalidUrl: "Enter a valid, complete HTTP(S) address.", editFailure: "Unable to save this edit. Check the input.",
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
