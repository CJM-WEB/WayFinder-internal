/**
 * 模块职责：把认证库的回调式 MySQL 池接入已有的有限期连接管理。
 * 每次认证操作独占一个租用连接；库内事务复用该连接，只有外层负责归还。
 * 取消或超时后禁止追加 SQL，销毁连接由 AccountDatabase 统一执行；不存在隐式默认范围。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool as NativePool, PoolConnection as NativeConnection } from "mysql2";
import type { Pool } from "mysql2/promise";

import { AccountDatabase, DatabaseError, type DatabaseOperation } from "./database.js";

type AuthDatabaseScope = Readonly<{ connection: NativeConnection; signal: AbortSignal; deadline: number }>;

export function createAuthDatabase(database: AccountDatabase) {
  const storage = new AsyncLocalStorage<AuthDatabaseScope>();
  const current = (): AuthDatabaseScope => {
    const scope = storage.getStore();
    if (scope === undefined) throw new DatabaseError("DATABASE_UNAVAILABLE");
    if (scope.signal.aborted) throw new DatabaseError("DATABASE_CANCELLED");
    if (scope.deadline <= Date.now()) throw new DatabaseError("DATABASE_TIMEOUT");
    return scope;
  };

  // mysql2/promise 的 .pool 才是 Kysely 实际使用的原生回调池；不能只拦 Promise API。
  const nativePool = new Proxy(database.pool.pool, {
    get(target, property, receiver): unknown {
      if (property === "getConnection") return (callback: (error: unknown, connection?: NativeConnection) => void): void => {
        let connection: NativeConnection;
        try { connection = current().connection; }
        catch (error: unknown) { callback(error); return; }
        callback(null, connection);
      };
      // 共享池的生命周期归 AccountDatabase；库的清理不能关闭其他请求使用的池。
      if (property === "end") return (callback?: (error: unknown) => void): void => { callback?.(null); };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) satisfies NativePool;
  const pool = new Proxy(database.pool, {
    get(target, property, receiver): unknown {
      if (property === "pool") return nativePool;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) satisfies Pool;

  const run = async <T>(operation: DatabaseOperation, action: () => Promise<T>): Promise<T> => {
    if (storage.getStore() !== undefined) { current(); return action(); }
    return database.withConnection(operation, async (connection, signal) => {
      // 驱动声明把原生连接写成 Promise Connection；这里只在外部适配边界收窄为其实际原生类型。
      const raw = connection.connection as unknown as NativeConnection;
      const scopedConnection = new Proxy(raw, {
        get(target, property, receiver): unknown {
          if (property === "release") return (): void => {};
          if (property === "query") return (
            sql: string, parameters: unknown[], callback: (error: unknown, result: unknown) => void,
          ) => {
            const scope = current();
            return target.query({ sql, timeout: Math.max(1, scope.deadline - Date.now()) }, parameters,
              (error, result) => callback(error, result));
          };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return storage.run({ connection: scopedConnection, signal, deadline: operation.deadline }, action);
    });
  };
  return { pool, run, signal: (): AbortSignal => current().signal };
}
