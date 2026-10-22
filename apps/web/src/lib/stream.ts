/**
 * 模块职责：把 HTTP Response 的任意字节块增量解码为经过 Contract 校验的 StreamEvent。
 *
 * 关键边界：
 * - 本模块只负责传输解码、单事件校验与 Reader 生命周期，不负责 runId、sequence 或终态状态机；
 *   旧 Run、重复/乱序事件和 complete 后封闭由 WAY-72 的 Store Reducer 处理。
 * - closeRun 由调用层按本次 runId 注入，避免旧 Reader 结束时误关闭后来启动的新 Run。
 * - AbortSignal 只用于及时停止当前 Reader 并保留原始取消 reason；Controller 生命周期属于 WAY-73。
 */
import {
  StreamEventSchema,
  type StreamEvent,
} from "@wayfinder/contracts";

/** 使用 ArrayBufferLike 同时兼容浏览器 Response 与测试中的标准 ReadableStream。 */
type SearchStreamResponse = Readonly<{
  body: ReadableStream<Uint8Array<ArrayBufferLike>> | null;
  ok: boolean;
  status: number;
}>;

export type ReadSearchEventStreamOptions = Readonly<{
  response: SearchStreamResponse;
  onEvent: (event: StreamEvent) => void | Promise<void>;
  closeRun: () => void;
  signal?: AbortSignal;
}>;

/** 从已经中止的 Signal 读取原始 reason，避免把用户取消改写为网络或协议错误。 */
const getAbortReason = (signal: AbortSignal): unknown => {
  try {
    signal.throwIfAborted();
  } catch (reason) {
    return reason;
  }

  throw new Error("AbortSignal 尚未中止");
};

/** Reader 取消属于 best-effort 清理；清理错误不能覆盖最先发生的业务错误。 */
const cancelReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  reason: unknown,
): Promise<void> => {
  try {
    await reader.cancel(reason);
  } catch {
    // 原始读取、解析或取消错误更有诊断价值，因此这里只吸收二次清理失败。
  }
};

/**
 * 逐行解析 NDJSON Response。
 *
 * 正常 EOF、网络失败、畸形事件和用户取消都会在退出前调用一次 closeRun。
 * 调用层仍会收到原始错误；关闭 UI 加载态不等于把失败伪装成成功或 run.failed。
 */
export async function readSearchEventStream(
  options: ReadSearchEventStreamOptions,
): Promise<void> {
  const { closeRun, onEvent, response, signal } = options;
  let reader:
    | ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
    | undefined;
  let abortCancellation: Promise<void> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let cleanupError: unknown;
  let runClosed = false;

  const preferAbortReason = (error: unknown): unknown =>
    signal?.aborted === true ? getAbortReason(signal) : error;

  /** UI 关闭必须先于可能长期等待的底层 cancel，并且所有路径至多执行一次。 */
  const closeRunOnce = (): void => {
    if (runClosed) return;
    runClosed = true;

    try {
      closeRun();
    } catch (error) {
      cleanupError ??= error;
    }
  };

  try {
    signal?.throwIfAborted();

    if (!response.ok) {
      throw new Error(`搜索流请求返回 HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error("搜索流响应缺少可读取的正文");
    }

    reader = response.body.getReader();

    const handleAbort = (): void => {
      if (reader === undefined || signal === undefined) return;
      closeRunOnce();
      abortCancellation ??= cancelReader(reader, getAbortReason(signal));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      // fatal 模式拒绝损坏或截断的 UTF-8，不能把它静默替换成仍可能通过 Schema 的字符。
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";

      /** 每条非空行先作为 unknown 解析，再交给公共根 Schema。 */
      const emitLine = async (line: string): Promise<void> => {
        if (!line.trim()) return;

        const rawEvent: unknown = JSON.parse(line);
        const event = StreamEventSchema.parse(rawEvent);
        signal?.throwIfAborted();

        const consumer = Promise.resolve(onEvent(event));
        if (signal === undefined) {
          await consumer;
          return;
        }

        let handleConsumerAbort = (): void => undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          handleConsumerAbort = () => reject(getAbortReason(signal));
          if (signal.aborted) {
            handleConsumerAbort();
          } else {
            signal.addEventListener("abort", handleConsumerAbort, {
              once: true,
            });
          }
        });

        try {
          // Promise.race 会观察消费者迟到的拒绝，避免取消后形成 unhandled rejection。
          await Promise.race([consumer, aborted]);
        } finally {
          signal.removeEventListener("abort", handleConsumerAbort);
        }
        signal?.throwIfAborted();
      };

      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        // cancel() 可能把 pending read 唤醒为 done；必须在 flush residual 前再次检查。
        signal?.throwIfAborted();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          await emitLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      }

      // EOF 时必须 flush Decoder，再处理无结尾换行的 residual。
      signal?.throwIfAborted();
      buffer += decoder.decode();
      await emitLine(buffer);
      signal?.throwIfAborted();
    } catch (error) {
      primaryError = preferAbortReason(error);
      hasPrimaryError = true;
      closeRunOnce();
      abortCancellation ??= cancelReader(reader, primaryError);
    } finally {
      signal?.removeEventListener("abort", handleAbort);
    }
  } catch (error) {
    if (!hasPrimaryError) {
      primaryError = preferAbortReason(error);
      hasPrimaryError = true;
    }
    closeRunOnce();
  } finally {
    if (reader !== undefined) {
      try {
        reader.releaseLock();
      } catch (error) {
        cleanupError = error;
      }
    }

    closeRunOnce();
  }

  // reader.cancel() 可同步触发上层取消；最终抛出前再让用户 reason 获得优先级。
  if (hasPrimaryError) throw preferAbortReason(primaryError);
  if (cleanupError !== undefined) throw cleanupError;
}
