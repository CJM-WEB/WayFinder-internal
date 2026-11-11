/** 认证池适配只用驱动假连接：验证作用域隔离、剩余期限和唯一归还权，不连接数据库。 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import { createAuthDatabase } from "./auth-database.js";
import { AccountDatabase, type DatabaseOperation } from "./database.js";

const operation = (): DatabaseOperation => ({ signal: new AbortController().signal, deadline: Date.now() + 5000 });

function fixture() {
  const release = vi.fn(), queries: Array<{ lease: number; sql: string; timeout: number }> = [];
  let lease = 0;
  const database = {
    pool: { pool: {} },
    withConnection: async <T>(input: DatabaseOperation, action: (connection: PoolConnection, signal: AbortSignal) => Promise<T>): Promise<T> => {
      const id = ++lease;
      const raw = { release,
        query: (options: { sql: string; timeout: number }, _parameters: unknown[], callback: (error: unknown, rows: unknown) => void) => {
          queries.push({ lease: id, sql: options.sql, timeout: options.timeout });
          callback(null, [{ lease: id }]);
          return {};
        } };
      // 外部驱动接缝只需原生连接；测试不会伪造认证结果或实际 SQL 能力。
      return action({ connection: raw } as unknown as PoolConnection, input.signal);
    },
  } as unknown as AccountDatabase;
  return { database, release, queries };
}

describe("认证连接作用域", () => {
  it("无作用域立即拒绝，不能绕过有限期连接管理", () => {
    const { database } = fixture(), scoped = createAuthDatabase(database);
    scoped.pool.pool.getConnection(error => { expect(error).toMatchObject({ message: "DATABASE_UNAVAILABLE" }); });
    expect(() => scoped.signal()).toThrow("DATABASE_UNAVAILABLE");
  });
  it("并行请求各持一个连接，库内release不提前归还，查询继承剩余期限", async () => {
    const { database, release, queries } = fixture(), scoped = createAuthDatabase(database);
    const execute = (sql: string) => new Promise<void>((resolve, reject) => {
      scoped.pool.pool.getConnection((error, connection) => {
        if (error) { reject(error); return; }
        connection.query(sql, [], failure => {
          connection.release();
          if (failure) reject(failure); else resolve();
        });
      });
    });
    await Promise.all([
      scoped.run(operation(), async () => { await execute("begin"); await Promise.resolve(); await execute("commit"); }),
      scoped.run(operation(), async () => { await execute("begin B"); await execute("rollback B"); }),
    ]);
    expect(queries.filter(query => query.lease === 1).map(query => query.sql)).toEqual(["begin", "commit"]);
    expect(queries.filter(query => query.lease === 2).map(query => query.sql)).toEqual(["begin B", "rollback B"]);
    expect(queries.every(query => query.timeout > 0 && query.timeout <= 5000)).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
  it("取消后不能追加SQL；嵌套操作不能重置预算", async () => {
    const { database, queries } = fixture(), scoped = createAuthDatabase(database), controller = new AbortController();
    const input = { signal: controller.signal, deadline: Date.now() + 5000 };
    await scoped.run(input, async () => {
      controller.abort();
      expect(() => scoped.signal()).toThrow("DATABASE_CANCELLED");
      await expect(scoped.run(operation(), async () => undefined)).rejects.toThrow("DATABASE_CANCELLED");
    });
    expect(queries).toEqual([]);
  });
});
