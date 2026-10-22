/**
 * 模块职责：把同一次 Run 的业务 Payload 串行写成带稳定 Envelope 的 StreamEvent。
 *
 * 关键边界：
 * - sequence 按事件被接受的同步顺序从 1 严格递增，物理写入由单一 FIFO 队列串行；
 * - complete、run.failed、连接关闭或首次写入失败都会关闭接纳入口；
 * - 关闭后的迟到 Payload 安全丢弃，不再校验、读取时钟、分配 sequence 或访问网络；
 * - 本模块不判断事件业务顺序、Node exactly-once 或 Run 终态是否应该产生。
 */
import {
  StreamEventPayloadSchema,
  StreamEventSchema,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";

export type CreateRunEventWriterInput = Readonly<{
  /** 必须来自已校验 SearchRequest，Writer 不生成或改写 Run 身份。 */
  runId: string;
  /** 只表示 HTTP 连接生命周期，不能传入会因 Run Deadline 中止的 Signal。 */
  connectionSignal: AbortSignal;
  writeEvent: (event: StreamEvent) => Promise<void>;
  /** 可注入时钟只用于确定性测试；跨事件顺序始终以 sequence 为准。 */
  now?: () => number;
}>;

export type RunEventWriter = Readonly<{
  /** 关闭后返回已完成 Promise，表示该迟到 Payload 已被安全丢弃。 */
  emit: (payload: StreamEventPayload) => Promise<void>;
  /** 同步停止接纳新事件，再等待已经接纳的 FIFO 队列完成。 */
  close: () => Promise<void>;
  /** 异常退出时立即丢弃尚未开始的队列项并释放 Signal Listener。 */
  dispose: () => void;
}>;

function isTerminalPayload(payload: StreamEventPayload): boolean {
  return payload.type === "complete" || payload.type === "run.failed";
}

function toIsoTimestamp(now: () => number): string {
  const timestampMs = now();
  if (!Number.isFinite(timestampMs)) {
    throw new TypeError("StreamEvent 时钟必须返回有限数字");
  }
  return new Date(timestampMs).toISOString();
}

/**
 * 创建单次 Run 唯一的 Event Writer。
 *
 * emit() 在返回 Promise 前同步完成接纳判定与 Envelope 分配；因此终态即使仍在等待
 * Backpressure（背压），同一轮随后到达的 Provider 结果也无法越过 closed Guard。
 */
export function createRunEventWriter(
  input: CreateRunEventWriterInput,
): RunEventWriter {
  const now = input.now ?? (() => Date.now());
  let nextSequence = 1;
  let closed = false;
  let connectionClosed = false;
  let listenerAttached = false;
  let hasWriteError = false;
  let firstWriteError: unknown;
  let writeTail: Promise<void> = Promise.resolve();

  const removeConnectionListener = (): void => {
    if (!listenerAttached) return;
    input.connectionSignal.removeEventListener("abort", onConnectionAbort);
    listenerAttached = false;
  };

  const closeFromConnection = (): void => {
    connectionClosed = true;
    closed = true;
    removeConnectionListener();
  };

  function onConnectionAbort(): void {
    closeFromConnection();
  }

  const recordWriteError = (error: unknown): void => {
    if (!hasWriteError) {
      hasWriteError = true;
      firstWriteError = error;
    }
    closed = true;
    removeConnectionListener();
  };

  if (input.connectionSignal.aborted) {
    closeFromConnection();
  } else {
    input.connectionSignal.addEventListener("abort", onConnectionAbort, {
      once: true,
    });
    listenerAttached = true;
    // 封闭首次检查与 Listener 注册之间的连接关闭竞态。
    if (input.connectionSignal.aborted) {
      closeFromConnection();
    }
  }

  const emit = (payload: StreamEventPayload): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }

    const parsedPayload = StreamEventPayloadSchema.parse(payload);
    // Payload getter 或校验代码可能触发外部取消；Envelope 分配前必须再次守门。
    if (closed) {
      return Promise.resolve();
    }

    const event = StreamEventSchema.parse({
      runId: input.runId,
      sequence: nextSequence,
      protocolVersion: "0.1",
      timestamp: toIsoTimestamp(now),
      ...parsedPayload,
    });
    nextSequence += 1;

    if (isTerminalPayload(parsedPayload)) {
      // 终态接纳与关门在第一个 await 前原子发生，但终态本身仍保留在 FIFO 中。
      closed = true;
    }

    const writeTask = writeTail.then(async () => {
      // Connection close 与写失败会丢弃此前已排队但尚未开始的 Event。
      if (connectionClosed || hasWriteError) return;
      await input.writeEvent(event);
    });

    // 内部 Tail 始终观察 rejection，避免调用方稍后才 await 时出现未处理拒绝。
    writeTail = writeTask.catch(recordWriteError);
    return writeTask;
  };

  const close = async (): Promise<void> => {
    closed = true;
    await writeTail;
    removeConnectionListener();
    if (hasWriteError) {
      throw firstWriteError;
    }
  };

  const dispose = (): void => {
    closed = true;
    connectionClosed = true;
    removeConnectionListener();
  };

  return Object.freeze({ emit, close, dispose });
}
