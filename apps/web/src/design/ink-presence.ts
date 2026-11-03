/**
 * 模块职责：让菜单、编辑表单和临时面板保留退场 DOM；新值不会复活已关闭的交互。
 * 生命周期：关闭时立即返回 open=false；动画结束才释放内容，减少动态偏好即时完成。
 */
import { useLayoutEffect, useState } from "react";

export function useInkPresence<T>(value: T | null, duration = 360): Readonly<{ value: T | null; open: boolean }> {
  const [held, setHeld] = useState<T | null>(value);
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, timer = 0;
    const clear = (): void => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
    const update = (): void => {
      clear();
      if (value !== null) {
        setHeld(value);
        if (motion.matches) setShown(true);
        else frame = requestAnimationFrame(() => setShown(true));
      } else {
        setShown(false);
        if (motion.matches) setHeld(null);
        else timer = window.setTimeout(() => setHeld(null), duration);
      }
    };
    update();
    motion.addEventListener("change", update);
    return () => { clear(); motion.removeEventListener("change", update); };
  }, [value, duration]);
  return { value: held, open: value !== null && shown };
}
