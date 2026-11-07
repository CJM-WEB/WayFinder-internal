/**
 * 命令职责：只从受保护输入文件更新作者公告 / 邀请码，不接受命令行秘密。
 * 直接执行才运行；成功仅输出固定确认，不输出生成码、签名材料或配置路径。
 */
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readProtectedJson, updateExperienceConfig } from "./experience-config.js";

export async function configureExperience(
  args: readonly string[],
  configPath: string | undefined,
): Promise<void> {
  if (configPath === undefined || configPath.trim() === "" ||
    args.length !== 2 || args[0] !== "--input" || !args[1]) {
    throw new Error("请设置 EXPERIENCE_CONFIG_PATH，并提供 --input 受保护的更新文件");
  }
  await updateExperienceConfig(configPath, await readProtectedJson(resolve(args[1])));
}

const entryFile = process.argv[1];
if (entryFile !== undefined && resolve(entryFile) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await configureExperience(process.argv.slice(2), process.env.EXPERIENCE_CONFIG_PATH);
    process.stdout.write("作者体验配置已原子更新；邀请码变更将撤销旧资格\n");
  } catch {
    process.stderr.write("作者体验配置更新失败；请检查输入、权限、配置路径或写锁\n");
    process.exitCode = 1;
  }
}
