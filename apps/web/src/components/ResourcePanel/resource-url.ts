/**
 * 模块职责：在浏览器打开 Resource 前重新校验并规范化不可信 URL。
 *
 * 关键约束：只允许显式绝对 HTTP(S)；不能依赖上游 Contract 校验替代点击边界的防御。
 */
import { ResourceSchema } from "@wayfinder/contracts";

export type ResourceUrlOpener = (
  url: string,
  target: "_blank",
  features: "noopener,noreferrer",
) => WindowProxy | null;

export const resolveSafeResourceUrl = (value: unknown): string | null => {
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
    // 不可信输入解析失败属于可预期拒绝路径，不能让异常中断整个 Resource Panel。
    return null;
  }
};

/**
 * 只有用户点击路径会调用此函数。校验失败时不会触碰 opener；校验成功时也只调用一次，
 * 即使浏览器因弹窗策略返回 null，也不能自动重试并制造额外页面。
 */
export const requestResourceOpen = (
  value: unknown,
  opener: ResourceUrlOpener,
): boolean => {
  const safeUrl = resolveSafeResourceUrl(value);

  if (safeUrl === null) {
    return false;
  }

  opener(safeUrl, "_blank", "noopener,noreferrer");
  return true;
};
