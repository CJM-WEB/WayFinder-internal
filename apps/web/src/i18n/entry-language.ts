/**
 * 模块职责：校验正式入口的初始界面语言，仍以公共 SearchLanguage Schema（语言校验）为准。
 * 边界：设置界面与下一次搜索的选择初值，不修改已有图或运行结果；缺失、非法及重复值均忽略。
 */
import { SearchLanguageSchema, type SearchLanguage } from "@wayfinder/contracts";

export function resolveEntryLanguage(search: string): SearchLanguage | null {
  const values = new URLSearchParams(search).getAll("language");
  if (values.length !== 1) return null;
  const parsed = SearchLanguageSchema.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}
