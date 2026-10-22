/**
 * 模块职责：注册 Fastify Search NDJSON Route，并只管理 HTTP 传输生命周期。
 *
 * 关键边界：
 * - SearchRequest 必须在 hijack 与 Streaming Header 前完成校验；
 * - Run Event Writer 在本 Route 内把 Payload 补齐为完整 Event；底层函数只做物理 NDJSON；
 * - 正常完成与上层已写入的 run.failed 都干净结束，断连与未知服务端错误只关闭物理流；
 * - 本层不判断 Analysis 顺序、Node exactly-once 或 Run 终态是否合法。
 */
import { once } from "node:events";
import type { Writable } from "node:stream";

import {
  SearchRequestSchema,
  StreamEventSchema,
  type SearchRequest,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";

import {
  createRunEventWriter,
  type RunEventWriter,
} from "../streaming/run-event-writer.js";

export type SearchStreamHandlerInput = Readonly<{
  input: SearchRequest;
  signal: AbortSignal;
  /** 调用方必须等待 Emit，使 NDJSON Backpressure 与传输失败进入同一控制流。 */
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

export type SearchStreamHandler = (
  input: SearchStreamHandlerInput,
) => Promise<void>;

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

/**
 * 校验并写入一条固定 LF（换行符）结尾的 NDJSON Event。
 * 该函数只等待物理背压，不持有 WAY-68 才引入的 sequence 或语义 closed 状态。
 */
export async function writeNdjsonEvent(
  response: Writable,
  signal: AbortSignal,
  event: StreamEvent,
): Promise<void> {
  const validatedEvent = StreamEventSchema.parse(event);
  if (signal.aborted) {
    throw signal.reason;
  }
  if (response.destroyed || response.writableEnded) {
    throw new Error("NDJSON 响应已经关闭");
  }

  const line = `${JSON.stringify(validatedEvent)}\n`;
  if (!response.write(line, "utf8")) {
    // 断连会中止同一个 Signal，使 drain 等待及时拒绝并自动移除监听器。
    await once(response, "drain", { signal });
  }
}

/** 注册单一路由；真实 Handler 的组合属于完整 Orchestrator Composition Root。 */
export function registerSearchRoute(
  server: FastifyInstance,
  handleSearch: SearchStreamHandler,
): void {
  server.post("/api/search", async (request, reply) => {
    const parsedRequest = SearchRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      // Run 尚未开始，不能用 run.failed 伪装 HTTP 输入错误，也不扩张公共 Error Contract。
      await reply.code(400).send();
      return;
    }

    const controller = new AbortController();
    const onClose = (): void => {
      // 正常 end 后同样可能触发 close；writableEnded 保证不会误报用户取消。
      if (!reply.raw.writableEnded) {
        controller.abort();
      }
    };
    const onError = (error: Error): void => {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    };

    // 只有合法请求才接管底层响应；从此刻开始 Route 必须自行关闭所有错误路径。
    reply.hijack();
    let eventWriter: RunEventWriter | undefined;

    try {
      reply.raw.once("close", onClose);
      reply.raw.once("error", onError);
      // Node 自行选择 Transfer-Encoding，禁止固定 Content-Length。
      reply.raw.writeHead(200, NDJSON_HEADERS);
      reply.raw.flushHeaders();

      // close 可能早于 Route 获得执行权；状态复核避免把未取消的 Signal 交给 Handler。
      if (
        controller.signal.aborted ||
        reply.raw.destroyed ||
        reply.raw.closed
      ) {
        throw controller.signal.reason ?? new Error("NDJSON 响应已经关闭");
      }

      eventWriter = createRunEventWriter({
        runId: parsedRequest.data.runId,
        connectionSignal: controller.signal,
        writeEvent: event =>
          writeNdjsonEvent(reply.raw, controller.signal, event),
      });

      await handleSearch({
        input: parsedRequest.data,
        signal: controller.signal,
        emit: eventWriter.emit,
      });
      // Handler 返回不代表底层 Backpressure 已解除；必须先排空所有已接受事件。
      await eventWriter.close();

      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch (error: unknown) {
      // 200 Header 已发送，不能再交回 Fastify 拼接 JSON，也不能擅自生成 run.failed。
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      eventWriter?.dispose();
      reply.raw.removeListener("close", onClose);
      reply.raw.removeListener("error", onError);
    }
  });
}
