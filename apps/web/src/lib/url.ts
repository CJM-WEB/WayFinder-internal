/**
 * 模块职责：在浏览器打开外部页面前重新校验并规范化不可信 URL。
 *
 * 关键约束：只允许显式绝对 HTTP(S)；调用方不能依赖上游 Contract 或路由判断
 * 替代最终点击边界的防御。
 */
import { ResourceSchema } from "@wayfinder/contracts";

export type BrowserUrlOpener = (
  url: string,
  target: "_blank",
  features: "noopener,noreferrer",
) => WindowProxy | null;

export const resolveSafeHttpUrl = (value: unknown): string | null => {
  const parsedUrl = ResourceSchema.shape.url.safeParse(value);

  if (!parsedUrl.success) {
    return null;
  }

  try {
    const target = new URL(parsedUrl.data);

    return target.protocol === "http:" || target.protocol === "https:"
      ? target.href
      : null;
  } catch {
    // 不可信输入解析失败属于可预期拒绝路径，不能让异常中断当前页面。
    return null;
  }
};

/**
 * 校验失败时绝不触碰 opener；成功时也只调用一次。浏览器即使因弹窗策略返回 null，
 * 也不能自动重试并制造额外页面。
 */
export const requestSafeUrlOpen = (
  value: unknown,
  opener: BrowserUrlOpener,
): boolean => {
  const safeUrl = resolveSafeHttpUrl(value);

  if (safeUrl === null) {
    return false;
  }

  opener(safeUrl, "_blank", "noopener,noreferrer");
  return true;
};
