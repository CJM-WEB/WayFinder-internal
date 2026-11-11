/** 根组件按身份代际重挂既有页面，执行旧页面取消/清理，不让旧草稿或异步弹窗跨账号。 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { accountStore } from "../stores/account.js";
import InkApp from "./ink-study.js";

export function AccountApp() {
  const epoch = useStore(accountStore, state => state.epoch);
  useEffect(() => {
    const refresh = (): void => {
      if (!accountStore.getState().busy) void accountStore.getState().refresh().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return <InkApp key={epoch} />;
}
