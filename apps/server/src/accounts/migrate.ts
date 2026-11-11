/** 显式迁移入口：只由命令行调用，不由应用导入、构建或普通 CI 自动执行。 */
import process from "node:process";
import { AccountDatabase, loadDatabaseConfig, databaseOperation, migrateAccountData } from "./database.js";

const raw = process.env.WAYFINDER_DATABASE_URL;
if (!raw) {
  console.error("缺少 WAYFINDER_DATABASE_URL，未执行迁移");
  // 不打印配置或原始异常；命令失败必须反馈非零状态。
  process.exitCode = 1;
} else {
  let database: AccountDatabase | undefined;
  try {
    database = new AccountDatabase(await loadDatabaseConfig(process.env));
    await migrateAccountData(database, databaseOperation(new AbortController().signal));
    console.info("账号数据基础迁移完成");
  } catch {
    console.error("账号数据基础迁移失败，请检查私有配置与数据库连接");
    process.exitCode = 1;
  } finally { await database?.close(); }
}
