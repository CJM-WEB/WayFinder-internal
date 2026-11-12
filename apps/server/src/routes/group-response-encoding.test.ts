/** 压缩回归：协商不能越过q=0；每帧可独立增量读取，同一gzip成员最终可完整解码。 */
import { constants, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptsGroupGzip, createGroupEventEncoder, finishGroupEncoding } from "./group-response-encoding.js";

afterEach(() => { vi.useRealTimers(); });

describe("小组正文压缩边界", () => {
  it.each([
    [undefined, false], ["", false], ["br", false], ["gzip", true], ["GZip ; q=0.5", true],
    ["gzip;q=0", false], ["gzip;q=0, *;q=1", false], ["*;q=1", true],
    ["gzip;q=invalid", false], ["gzip;q=1.001", false], ["gzip;q=1, gzip;q=0", false],
  ] as const)("按显式编码权重协商 %s", (header, expected) => { expect(acceptsGroupGzip(header)).toBe(expected); });

  it("首帧与心跳不等流结束即可解码，尾部结束后逐字节等价", async () => {
    const encoder = createGroupEventEncoder(), lines = [`${JSON.stringify({ type: "snapshot", body: "假数据".repeat(100_000) })}\n`, '{"type":"heartbeat","sequence":1}\n'];
    try {
      const first = await encoder.encode(lines[0] ?? "");
      expect(gunzipSync(first, { finishFlush: constants.Z_SYNC_FLUSH }).toString()).toBe(lines[0]);
      const second = await encoder.encode(lines[1] ?? "");
      expect(gunzipSync(Buffer.concat([first, second]), { finishFlush: constants.Z_SYNC_FLUSH }).toString()).toBe(lines.join(""));
      const trailer = await encoder.finish();
      expect(gunzipSync(Buffer.concat([first, second, trailer])).toString()).toBe(lines.join(""));
      expect(first.length + second.length + trailer.length).toBeLessThan(Buffer.byteLength(lines.join("")) / 10);
    } finally { encoder.destroy(); }
  });

  it("取消在途压缩立即拒绝，不能将迟到flush当成成功", async () => {
    const encoder = createGroupEventEncoder(), pending = encoder.encode("假数据".repeat(100_000));
    const rejected = expect(pending).rejects.toThrow("测试取消");
    encoder.destroy(new Error("测试取消"));
    await rejected;
    await expect(encoder.encode("迟到事件")).rejects.toThrow("测试取消");
  });

  it("已过期预算或已取消操作不得启动压缩", async () => {
    const encoder = createGroupEventEncoder(), finish = vi.spyOn(encoder, "finish"), controller = new AbortController();
    try {
      await expect(finishGroupEncoding(encoder, { signal: controller.signal, deadline: Date.now() - 1 }, "正文")).rejects.toThrow("GROUP_UNAVAILABLE");
      controller.abort();
      await expect(finishGroupEncoding(encoder, { signal: controller.signal, deadline: Date.now() + 1_000 }, "正文")).rejects.toThrow("GROUP_OFFLINE");
      expect(finish).not.toHaveBeenCalled();
    } finally { encoder.destroy(); }
  });

  it.each(["abort", "deadline"])("慢压缩受原预算%s约束，迟到完成无效且清理计时器／监听", async mode => {
    vi.useFakeTimers();
    let resolve!: (value: Buffer) => void;
    const completion = new Promise<Buffer>(done => { resolve = done; });
    // 只替代耗时边界：真实压缩正确性由上方增量解码与路由等价回归覆盖。
    const encoder = { encode: vi.fn(), finish: vi.fn(() => completion), destroy: vi.fn() };
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    const deadline = Date.now() + 20;
    const pending = finishGroupEncoding(encoder, { signal: controller.signal, deadline }, "正文");
    const rejected = expect(pending).rejects.toThrow(mode === "abort" ? "GROUP_OFFLINE" : "GROUP_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(19); expect(encoder.destroy).not.toHaveBeenCalled();
    if (mode === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(encoder.destroy).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    resolve(Buffer.from("迟到正文")); await Promise.resolve();
    await expect(pending).rejects.toThrow(mode === "abort" ? "GROUP_OFFLINE" : "GROUP_UNAVAILABLE");
  });
});
