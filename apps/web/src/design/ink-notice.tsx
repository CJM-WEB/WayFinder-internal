/** 模块职责：提示随真实问题进入/退出，退场期间不可操作；不靠计时器伪造问题已经解决。 */
import type { ReactNode } from "react";
import { useInkPresence } from "./ink-presence.js";

type Notice = Readonly<{ message: string; action?: ReactNode }>;
export function InkNotice({ notice }: Readonly<{ notice: Notice | null }>) {
  const present = useInkPresence(notice);
  return present.value === null ? null : <div className="ink-workspace-notice" role="alert" data-open={present.open}
    inert={!present.open} aria-hidden={!present.open} data-ink-overlay data-ink-control>
    <span>{present.value.message}</span>{present.value.action}
  </div>;
}
