/**
 * 模块职责：在生产组装时防止作者配置误放进公开静态目录。
 * 路径尚不存在时解析最近既有祖先；不要求配置内容有效，因此自带 Key 仍可启动使用。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

async function resolveExistingAncestor(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function assertPrivateConfigLocation(configPath: string | null, publicDirectory: string): Promise<void> {
  if (configPath === null) return;
  try {
    const [config, root] = await Promise.all([
      resolveExistingAncestor(configPath), resolveExistingAncestor(publicDirectory),
    ]);
    const relative = path.relative(root, config);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("配置位于公开目录");
    }
  } catch {
    // 不保留底层异常，避免服务日志暴露配置路径。
    throw new Error("作者体验配置必须位于公开静态目录之外，且路径必须可安全解析");
  }
}
