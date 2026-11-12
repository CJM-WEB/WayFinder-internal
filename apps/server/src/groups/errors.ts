/** 小组错误统一投影为固定协议码；SQL、邀请码、邮箱和内部异常不得进入公共响应。 */
import type { GroupErrorResponse } from "@wayfinder/contracts";

export class GroupAccessError extends Error {
  constructor(readonly code: GroupErrorResponse["code"]) { super(code); this.name = "GroupAccessError"; }
}
