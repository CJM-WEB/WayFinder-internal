/**
 * 模块职责：仅为组图正文协商gzip，不改变JSON／NDJSON协议字段或其他路由。
 * 流式边界：持续压缩器每个事件完整flush后才交给HTTP写入；调用方仍等待真实写入回调。
 * 资源边界：只保留当前事件的压缩块，不排队后续事件；断连时显式销毁，拒绝尚未完成的压缩。
 */
import { constants, createGzip } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "../groups/errors.js";

/** 显式gzip条目优先于通配符；无请求头、无效权重或q=0均不能擅自压缩。 */
export function acceptsGroupGzip(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  const entries = (Array.isArray(value) ? value.join(",") : value).toLowerCase().split(",");
  const quality = (entry: string): number => {
    const parameters = entry.split(";").slice(1).map(part => part.trim());
    if (parameters.length === 0) return 1;
    if (parameters.length !== 1 || !/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(parameters[0] ?? "")) return 0;
    return Number(parameters[0]?.slice(2));
  };
  const explicit = entries.filter(entry => entry.split(";", 1)[0]?.trim() === "gzip");
  const selected = explicit.length > 0 ? explicit : entries.filter(entry => entry.split(";", 1)[0]?.trim() === "*");
  // 重复且互相矛盾的条目按较严格权重处理，不能越过显式拒绝。
  return selected.length > 0 && selected.every(entry => quality(entry) > 0);
}

function assertEncodingOperation(operation: DatabaseOperation): void {
  if (operation.signal.aborted) throw new GroupAccessError("GROUP_OFFLINE");
  if (Date.now() >= operation.deadline) throw new GroupAccessError("GROUP_UNAVAILABLE");
}

export async function sendGroupWorkspaceJson(request: FastifyRequest, reply: FastifyReply, value: unknown, operation: DatabaseOperation): Promise<FastifyReply> {
  reply.header("Vary", "Accept-Encoding");
  assertEncodingOperation(operation);
  if (!acceptsGroupGzip(request.headers["accept-encoding"])) return reply.send(value);
  const encoder = createGroupEventEncoder();
  try {
    // JSON压缩沿用查询／写入原本的绝对期限；同步序列化耗时也不能换取新的预算。
    const body = await finishGroupEncoding(encoder, operation, JSON.stringify(value));
    assertEncodingOperation(operation);
    return reply.header("Content-Type", "application/json; charset=utf-8").header("Content-Encoding", "gzip").send(body);
  } finally { encoder.destroy(); }
}

/** 单一gzip成员跨事件保持字典；flush不结束成员，浏览器可立即读取每条完整NDJSON。 */
export function createGroupEventEncoder() {
  const stream = createGzip();
  let chunks: Buffer[] = [], failure: Error | undefined;
  let pending: { reject: (error: Error) => void } | undefined;
  stream.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  const fail = (error: Error): void => { failure = error; pending?.reject(error); pending = undefined; };
  stream.on("error", fail);
  const take = (): Buffer => { const result = Buffer.concat(chunks); chunks = []; return result; };
  return {
    encode: (line: string): Promise<Buffer> => new Promise((resolve, reject) => {
      if (failure !== undefined) { reject(failure); return; }
      if (pending !== undefined) { reject(new Error("小组压缩事件不能并发")); return; }
      const token = { reject }; pending = token;
      stream.write(line);
      stream.flush(constants.Z_SYNC_FLUSH, () => {
        if (pending !== token) return;
        pending = undefined; resolve(take());
      });
    }),
    finish: (body?: string): Promise<Buffer> => new Promise((resolve, reject) => {
      if (failure !== undefined) { reject(failure); return; }
      if (pending !== undefined) { reject(new Error("小组压缩事件尚未写完")); return; }
      const token = { reject }; pending = token;
      stream.once("end", () => { if (pending === token) { pending = undefined; resolve(take()); } });
      stream.end(body);
    }),
    destroy: (error = new Error("小组压缩已取消")): void => { fail(error); chunks = []; stream.destroy(); },
  };
}

/** JSON完整正文与NDJSON尾部共用原期限；取消会销毁压缩器，迟到结果不能继续发送。 */
export async function finishGroupEncoding(encoder: ReturnType<typeof createGroupEventEncoder>, operation: DatabaseOperation,
  body?: string): Promise<Buffer> {
  assertEncodingOperation(operation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const stop = (error: GroupAccessError): void => { encoder.destroy(error); reject(error); };
      abort = () => stop(new GroupAccessError("GROUP_OFFLINE"));
      operation.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop(new GroupAccessError("GROUP_UNAVAILABLE")), Math.max(0, operation.deadline - Date.now()));
      if (operation.signal.aborted) abort();
    });
    const result = await Promise.race([encoder.finish(body), cancelled]);
    assertEncodingOperation(operation);
    return result;
  } finally {
    clearTimeout(timer);
    if (abort !== undefined) operation.signal.removeEventListener("abort", abort);
  }
}
