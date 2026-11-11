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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CredentialsAccessError } from "../settings/experience-authorization.js";
import { sendCredentialsAccessError } from "./experience.js";

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

/** 生产请求先完成凭据解析；普通函数形式保留确定性传输层测试接缝。 */
export type PreparedSearchHandler = Readonly<{
  prepare: (request: FastifyRequest, signal: AbortSignal) => Promise<SearchStreamHandler>;
}>;

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

/**
 * 校验并写入一条固定 LF（换行符）结尾的 NDJSON Event。
 * 该函数只等待物理背压，不持有 Writer 管理的 sequence 或语义 closed 状态。
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
  handleSearch: SearchStreamHandler | PreparedSearchHandler,
): void {
  // 生产凭据入口连框架解析错误也只输出固定投影；静态传输层测试保持原有接口。
  const options = typeof handleSearch === "function" ? {} : {
    errorHandler: (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
      const rawStatus = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : 500;
      const status = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
      return sendCredentialsAccessError(reply, new CredentialsAccessError(
        status < 500 ? "CREDENTIALS_INVALID" : "EXPERIENCE_UNAVAILABLE",
      ), status);
    },
  };
  server.post("/api/search", options, async (request, reply) => {
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

    let eventWriter: RunEventWriter | undefined;
    let handlerStarted = false;

    try {
      reply.raw.once("close", onClose);
      reply.raw.once("error", onError);
      // 凭据准备可能读取动态配置；断连和前置错误不得先发送流式200或启动Provider。
      const preparedHandler = typeof handleSearch === "function" ? handleSearch
        : await handleSearch.prepare(request, controller.signal);
      if (controller.signal.aborted || reply.raw.destroyed || reply.raw.closed) return;
      reply.hijack();
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

      handlerStarted = true;
      await preparedHandler({
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
      if (!reply.sent && !reply.raw.headersSent && !reply.raw.destroyed && !controller.signal.aborted) {
        if (error instanceof CredentialsAccessError) {
          await sendCredentialsAccessError(reply, error);
        } else {
          await reply.code(500).send();
        }
        return;
      }
      // 200 Header 已发送，不能再交回 Fastify 拼接 JSON，也不能擅自生成 run.failed。
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      // prepare 已持有鉴权／期限资源时，流头失败或提前返回也必须终止其父生命周期。
      // 正常 Handler 已写完终态并释放期限后才到此处，不改变已完成的结果。
      if ((!handlerStarted || !reply.raw.writableEnded) && !controller.signal.aborted) controller.abort();
      eventWriter?.dispose();
      reply.raw.removeListener("close", onClose);
      reply.raw.removeListener("error", onError);
    }
  });
}
