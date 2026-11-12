/** 小组界面使用账号统一昵称与纯文本提示；固定错误码不展示服务端正文或内部字段。 */
import type { GroupConnectionState, GroupErrorCode, SearchLanguage } from "@wayfinder/contracts";
const zh = {
  title: "小组", create: "创建小组", join: "加入小组", name: "小组名称", description: "小组说明",
  nickname: "账号昵称", saveNickname: "保存昵称", nicknameHint: "昵称在所有小组通用，创建或加入前请先填写。",
  login: "登录后可以创建或加入小组。", settings: "前往设置登录", invitation: "邀请码", copyCode: "复制邀请码",
  copied: "已复制", copyFailed: "复制失败，请选择邀请码手动复制", open: "进入小组", members: "小组成员", owner: "创建者",
  edit: "编辑小组", save: "保存", cancel: "取消", leave: "退出小组", dissolve: "解散小组",
  dissolveConfirm: "解散后全部组图和历史将删除，不自动备份。请先手动复制需要保留的图。确定解散？",
  empty: "还没有小组，可以创建自己的小组或用邀请码加入。", working: "处理中…", refresh: "刷新列表", reconnect: "重新连接",
  personal: "返回个人图", newSearch: "小组新搜索", newGraph: "新建组图", graphName: "组图名称", emptyGraphs: "组内还没有图。",
  copyOut: "复制到个人", copyIn: "复制个人图到小组", source: "选择个人图", noSource: "没有可复制的个人图",
  renameGraph: "重命名组图", deleteGraph: "删除组图", restoreGraph: "恢复最近删除的组图",
  retry: "重试原操作", confirmResult: "核对上次结果", keepMine: "确认保留我的修改", discard: "取消待处理修改", pending: "有尚未确认的修改，请先处理。",
  conflictConfirm: "其他成员已修改当前内容。确定在最新内容上应用你保留的修改？",
  searchConfirm: "其他成员已修改这张图。确定将预览结果应用到当前内容？",
  groupTag: "所属小组", success: "操作已完成", unknown: "操作结果尚未确认，请查看同步状态或重试原操作。",
};
const en: typeof zh = {
  title: "Groups", create: "Create group", join: "Join group", name: "Group name", description: "Group description",
  nickname: "Nickname", saveNickname: "Save nickname", nicknameHint: "Your nickname is shared across groups. Fill it in before creating or joining.",
  login: "Sign in to create or join a group.", settings: "Open settings to sign in", invitation: "Invitation code", copyCode: "Copy invitation code",
  copied: "Copied", copyFailed: "Copy failed. Select the code and copy it manually.", open: "Open group", members: "Group members", owner: "Creator",
  edit: "Edit group", save: "Save", cancel: "Cancel", leave: "Leave group", dissolve: "Dissolve group",
  dissolveConfirm: "All group graphs and history will be deleted, without an automatic backup. Copy anything you want to keep first. Dissolve this group?",
  empty: "No groups yet. Create one or join with an invitation code.", working: "Working…", refresh: "Refresh groups", reconnect: "Reconnect",
  personal: "Personal graphs", newSearch: "New group search", newGraph: "New group graph", graphName: "Group graph name", emptyGraphs: "This group has no graphs yet.",
  copyOut: "Copy to personal", copyIn: "Copy personal graph to group", source: "Choose a personal graph", noSource: "No personal graphs to copy",
  renameGraph: "Rename group graph", deleteGraph: "Delete group graph", restoreGraph: "Restore last deleted group graph",
  retry: "Retry original action", confirmResult: "Check previous result", keepMine: "Confirm my changes", discard: "Discard pending changes", pending: "Resolve the unconfirmed action first.",
  conflictConfirm: "Another member changed this content. Apply your retained changes to the latest content?",
  searchConfirm: "Another member changed this graph. Apply the preview to the current content?",
  groupTag: "Group", success: "Action completed", unknown: "The action is unconfirmed. Check the connection or retry the original action.",
};
export function getGroupMessages(language: SearchLanguage) { return language === "zh-CN" ? zh : en; }
export function groupConnectionLabel(state: GroupConnectionState, language: SearchLanguage): string {
  const labels: Record<GroupConnectionState, string> = language === "zh-CN"
    ? { connecting: "正在连接，暂不可操作", syncing: "正在对齐，暂不可操作", online: "已连接，操作实时同步", offline: "连接已断开，暂不可操作", reconnecting: "正在重连，暂不可操作", closed: "小组连接已关闭" }
    : { connecting: "Connecting · read only", syncing: "Catching up · read only", online: "Connected · changes sync immediately", offline: "Disconnected · read only", reconnecting: "Reconnecting · read only", closed: "Group connection closed" };
  return labels[state];
}
export function groupErrorMessage(code: string, language: SearchLanguage): string {
  const errors: Record<GroupErrorCode, string> = language === "zh-CN" ? {
    ACCOUNT_REQUIRED: "登录状态已失效，请重新登录。", GROUP_INVALID: "请检查填写的内容。", GROUP_NOT_FOUND: "小组或目标已不存在。",
    GROUP_FORBIDDEN: "你已没有此小组的操作权限。", GROUP_CONFLICT: "内容已变化，已保留你的修改，请核对后再确认。",
    GROUP_UNAVAILABLE: "暂时无法完成操作，请检查连接并确认上次结果。", NICKNAME_REQUIRED: "请先保存账号昵称。",
    GROUP_OFFLINE: "连接尚未追平，暂不可操作。", GROUP_DEPENDENCY: "此操作依赖其他成员的内容，无法直接撤回。", GROUP_CONSTRAINT: "修改不符合图的约束，原内容已保留。",
  } : {
    ACCOUNT_REQUIRED: "Your session expired. Sign in again.", GROUP_INVALID: "Check the entered information.", GROUP_NOT_FOUND: "The group or target no longer exists.",
    GROUP_FORBIDDEN: "You no longer have access to this group.", GROUP_CONFLICT: "Content changed. Your changes are retained for review.",
    GROUP_UNAVAILABLE: "The action could not be confirmed. Check the connection and original result.", NICKNAME_REQUIRED: "Save your nickname first.",
    GROUP_OFFLINE: "Wait for the connection to catch up.", GROUP_DEPENDENCY: "This action depends on another member’s content and cannot be undone directly.", GROUP_CONSTRAINT: "The change violates graph constraints. Original content is retained.",
  };
  return code in errors ? errors[code as GroupErrorCode] : errors.GROUP_UNAVAILABLE;
}
