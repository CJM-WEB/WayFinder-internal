/**
 * 模块职责：提供显式创建的 MySQL 连接池、有限期事务和最小用户归属数据访问。
 * 失败边界：连接参数及驱动原始错误绝不进入公共错误；取消或超时销毁连接，避免迟到写入继续执行。
 * 导入本模块不会连接数据库或迁移；生产迁移必须由独立命令显式调用。
 */
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { UserIdSchema } from "@wayfinder/contracts";

/** 数据迁移配置独立于搜索运行配置，普通搜索启动不会因此自动接入数据库。 */
export const DATABASE_ENVIRONMENT_VARIABLES = Object.freeze(["WAYFINDER_DATABASE_URL", "WAYFINDER_DATABASE_CA_FILE"]);

export const DatabaseConfigSchema = z.strictObject({
  host: z.string().min(1), port: z.number().int().min(1).max(65535).default(3306),
  user: z.string().min(1), password: z.string(), database: z.string().regex(/^[a-zA-Z0-9_]+$/),
  connectionLimit: z.number().int().min(1).max(8).default(4),
  timeoutMs: z.number().int().min(1).max(30_000).default(5_000),
  /** 远端 TLS 只能传可信 CA，禁止以关闭证书校验绕过信任问题。 */
  ca: z.string().min(1).optional(),
}).refine(value => ["localhost", "127.0.0.1", "::1"].includes(value.host) || value.ca !== undefined);
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type DatabaseOperation = Readonly<{ signal: AbortSignal; deadline: number }>;
type SqlValue = string | number | boolean | Date | Buffer | null;

export class DatabaseError extends Error {
  constructor(readonly code: "DATABASE_UNAVAILABLE" | "DATABASE_CANCELLED" | "DATABASE_TIMEOUT") {
    super(code);
    this.name = "DatabaseError";
  }
}

/** URL 只在私有配置入口解析；失败不携带 URL、用户、密码或驱动 cause。 */
export function databaseConfigFromUrl(raw: string, ca?: string): DatabaseConfig {
  try {
    const url = new URL(raw);
    if (url.protocol !== "mysql:" || url.search || url.hash) throw new Error();
    return DatabaseConfigSchema.parse({
      host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ...(ca === undefined ? {} : { ca }),
    });
  } catch { throw new DatabaseError("DATABASE_UNAVAILABLE"); }
}

/** CA 文件由部署环境显式提供；远端配置缺 CA 时拒绝，不能静默降级到明文。 */
export async function loadDatabaseConfig(environment: Readonly<Record<string, string | undefined>>): Promise<DatabaseConfig> {
  try {
    const raw = environment.WAYFINDER_DATABASE_URL;
    if (!raw) throw new Error();
    const caFile = environment.WAYFINDER_DATABASE_CA_FILE;
    const ca = caFile ? await readFile(caFile, { encoding: "utf8", signal: AbortSignal.timeout(5_000) }) : undefined;
    return databaseConfigFromUrl(raw, ca);
  } catch { throw new DatabaseError("DATABASE_UNAVAILABLE"); }
}

/** 每次操作沿用调用方绝对期限；分阶段查询不得重新获得一整段时间预算。 */
export function databaseOperation(signal: AbortSignal, timeoutMs = 5_000): DatabaseOperation {
  return { signal, deadline: Date.now() + timeoutMs };
}

export class AccountDatabase {
  readonly pool: Pool;
  private readonly active = new Set<PoolConnection>();
  private readonly discarded = new WeakSet<PoolConnection>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(rawConfig: DatabaseConfig) {
    let config: DatabaseConfig;
    try { config = DatabaseConfigSchema.parse(rawConfig); }
    catch { throw new DatabaseError("DATABASE_UNAVAILABLE"); }
    this.timeoutMs = config.timeoutMs;
    this.pool = createPool({
      host: config.host, port: config.port, user: config.user, password: config.password,
      database: config.database, connectionLimit: config.connectionLimit,
      maxIdle: config.connectionLimit, idleTimeout: 30_000, waitForConnections: true, queueLimit: 16,
      connectTimeout: config.timeoutMs, charset: "utf8mb4", timezone: "Z", multipleStatements: false,
      ...(config.ca === undefined ? {} : { ssl: { ca: config.ca, rejectUnauthorized: true, verifyIdentity: true } }),
    });
  }

  /**
   * 查询和事务共用一个租用连接。取消时销毁连接会让未提交事务由 MySQL 回滚；
   * 连接排队期间取消则销毁迟到连接，不能把已拒绝的操作重新启动。
   */
  async withConnection<T>(operation: DatabaseOperation, action: (connection: PoolConnection, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new DatabaseError("DATABASE_UNAVAILABLE");
    const remaining = Math.min(this.timeoutMs, operation.deadline - Date.now());
    if (operation.signal.aborted) throw new DatabaseError("DATABASE_CANCELLED");
    if (remaining <= 0) throw new DatabaseError("DATABASE_TIMEOUT");
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(remaining)]);
    let connection: PoolConnection | undefined;
    const pending = this.pool.getConnection().then(value => {
      if (signal.aborted || this.closed) { value.destroy(); throw new DatabaseError("DATABASE_CANCELLED"); }
      connection = value;
      this.active.add(value);
      return action(value, signal);
    });
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => {
          connection?.destroy();
          reject(new DatabaseError(operation.signal.aborted ? "DATABASE_CANCELLED" : "DATABASE_TIMEOUT"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } catch (error: unknown) {
      if (error instanceof DatabaseError) throw error;
      if (operation.signal.aborted) throw new DatabaseError("DATABASE_CANCELLED");
      if (signal.aborted || Date.now() >= operation.deadline ||
          (typeof error === "object" && error !== null && "code" in error && error.code === "PROTOCOL_SEQUENCE_TIMEOUT")) {
        connection?.destroy();
        if (connection !== undefined) this.discarded.add(connection);
        throw new DatabaseError("DATABASE_TIMEOUT");
      }
      throw new DatabaseError("DATABASE_UNAVAILABLE");
    } finally {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
      if (connection !== undefined) {
        this.active.delete(connection);
        if (!signal.aborted && !this.closed && !this.discarded.has(connection)) connection.release(); else connection.destroy();
      }
    }
  }

  /** SQL 内容只来自工程常量，值始终参数化；调用方不能传入外部 SQL。 */
  async query(operation: DatabaseOperation, sql: string, values: SqlValue[] = []): Promise<unknown> {
    return this.withConnection(operation, async connection => {
      const [result] = await connection.query({ sql, values, timeout: Math.max(1, operation.deadline - Date.now()) });
      return result;
    });
  }

  async transaction<T>(operation: DatabaseOperation, action: (query: (sql: string, values?: SqlValue[]) => Promise<unknown>) => Promise<T>): Promise<T> {
    return this.withConnection(operation, async (connection, signal) => {
      const query = async (sql: string, values: SqlValue[] = []): Promise<unknown> => {
        signal.throwIfAborted();
        const [result] = await connection.query({ sql, values, timeout: Math.max(1, operation.deadline - Date.now()) });
        signal.throwIfAborted();
        return result;
      };
      await query("START TRANSACTION");
      try {
        const result = await action(query);
        await query("COMMIT");
        return result;
      } catch (error: unknown) {
        // 取消已经销毁连接，不能再排队 rollback；其他错误先回滚再复用连接。
        if (!signal.aborted) {
          try { await query("ROLLBACK"); }
          catch {
            this.discarded.add(connection);
            connection.destroy();
            throw new DatabaseError("DATABASE_UNAVAILABLE");
          }
        }
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.active) connection.destroy();
    this.active.clear();
    try { await this.pool.end(); }
    catch { throw new DatabaseError("DATABASE_UNAVAILABLE"); }
  }
}

/** 首版只建立最小数据访问基座；认证库表由下一步认证接入迁移，不能重复手写。 */
export async function migrateAccountData(database: AccountDatabase, operation: DatabaseOperation): Promise<void> {
  await database.query(operation, `CREATE TABLE IF NOT EXISTS wf_user_data (
    userId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recordId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (userId, recordId)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}

/** 可信身份在 DAL 边界固定；recordId 相同的其他用户记录不能被读取或修改。 */
export function userDataAccess(database: AccountDatabase, trustedUserId: string) {
  const userId = UserIdSchema.parse(trustedUserId);
  const recordIdSchema = UserIdSchema;
  return {
    async put(operation: DatabaseOperation, recordId: string, payload: unknown): Promise<void> {
      const serialized = JSON.stringify(z.json().parse(payload));
      await database.query(operation, "INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = ?",
        [userId, recordIdSchema.parse(recordId), serialized, serialized]);
    },
    async read(operation: DatabaseOperation, recordId: string): Promise<unknown | null> {
      const raw = await database.query(operation, "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?", [userId, recordIdSchema.parse(recordId)]);
      const rows = z.array(z.object({ payload: z.unknown() })).parse(raw);
      const row = rows[0]?.payload;
      if (row === undefined) return null;
      return z.json().parse(typeof row === "string" ? JSON.parse(row) as unknown : row);
    },
    async remove(operation: DatabaseOperation, recordId: string): Promise<void> {
      await database.query(operation, "DELETE FROM wf_user_data WHERE userId = ? AND recordId = ?", [userId, recordIdSchema.parse(recordId)]);
    },
  };
}
