import type { FastTransport, Frame } from "@quiclib/protocol";
import {
  encodeFrame,
  tryDecodeFrame,
  nextRequestId,
  randomBytes,
  CHANNEL_ECHO,
  MSG_ECHO_REQUEST,
  MSG_ECHO_RESPONSE,
} from "@quiclib/protocol";
import { StreamHandle } from "./client.js";

// ── Result Types ──────────────────────────────────────────────────

export interface LatencyResult {
  type: "latency";
  transport: string;
  samples: number[]; // Individual RTT in microseconds
  min: number; // Minimum RTT (µs)
  max: number; // Maximum RTT (µs)
  median: number; // Median RTT (µs)
  mean: number; // Mean RTT (µs)
  p95: number; // 95th percentile RTT (µs)
  p99: number; // 99th percentile RTT (µs)
  totalMs: number; // Total test duration (ms)
}

export interface ThroughputResult {
  type: "throughput";
  transport: string;
  bytesSent: number;
  bytesReceived: number;
  durationMs: number;
  sendRateMbps: number; // Megabits per second
  receiveRateMbps: number;
  messagesPerSecond: number;
}

export interface HOLBlockingResult {
  type: "hol-blocking";
  transport: string;
  streamCount: number;
  /** Per-stream completion times in ms */
  streamTimes: number[];
  /** Time for the slowest stream */
  maxStreamTime: number;
  /** Time for the fastest stream */
  minStreamTime: number;
  /** Difference in completion times; does not establish packet-loss HOL behavior. */
  spreadMs: number;
}

export interface DatagramResult {
  type: "datagram";
  transport: string;
  sent: number;
  received: number;
  lossRate: number; // 0-1
  latencies: number[]; // RTT in µs for received datagrams
  medianLatency: number;
  meanLatency: number;
}

export type BenchmarkResult =
  | LatencyResult
  | ThroughputResult
  | HOLBlockingResult
  | DatagramResult;

// ── Progress Callback ─────────────────────────────────────────────

export interface BenchmarkProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: BenchmarkProgress) => void;

function bounded(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be ${min}–${max}`);
}
function frame(payload: Uint8Array): Frame {
  return {
    channelId: CHANNEL_ECHO,
    messageType: MSG_ECHO_REQUEST,
    requestId: nextRequestId(),
    payload,
  };
}
function verify(request: Frame, response: Frame): void {
  if (
    response.payload.length !== request.payload.length ||
    !response.payload.every((byte, index) => byte === request.payload[index])
  )
    throw new Error("Echo payload integrity check failed");
}
async function handle(
  transport: FastTransport,
  prefix: string,
): Promise<StreamHandle> {
  const name = `${prefix}-${nextRequestId()}`;
  const stream = new StreamHandle(name, await transport.openStream(name));
  stream.startReceiveLoop();
  return stream;
}
export async function measureLatency(
  transport: FastTransport,
  transportName: string,
  count = 100,
  payloadSize = 64,
  onProgress?: ProgressCallback,
): Promise<LatencyResult> {
  bounded(count, 1, 10000, "Echo count");
  bounded(payloadSize, 0, 1048576, "Payload size");
  const stream = await handle(transport, "latency");
  const samples: number[] = [];
  const start = performance.now();
  try {
    for (let i = 0; i < count; i++) {
      const request = frame(randomBytes(payloadSize));
      const sent = performance.now();
      const response = await stream.sendAndReceive(request);
      const elapsed = (performance.now() - sent) * 1000;
      verify(request, response);
      samples.push(elapsed);
      onProgress?.({
        phase: "latency",
        current: i + 1,
        total: count,
        message: `Verified echo ${i + 1}/${count}`,
      });
    }
  } finally {
    await stream.close();
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1),
      )
    ]!;
  return {
    type: "latency",
    transport: transportName,
    samples,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    median: percentile(0.5),
    mean: sorted.reduce((a, b) => a + b, 0) / count,
    p95: percentile(0.95),
    p99: percentile(0.99),
    totalMs: performance.now() - start,
  };
}
/** Bounded 16-request window; counts complete verified responses, never read chunks. */
export async function measureThroughput(
  transport: FastTransport,
  transportName: string,
  payloadSize = 4096,
  durationMs = 5000,
  onProgress?: ProgressCallback,
): Promise<ThroughputResult> {
  bounded(payloadSize, 1, 1048576, "Payload size");
  bounded(durationMs, 50, 30000, "Duration");
  const stream = await handle(transport, "throughput");
  const payload = randomBytes(payloadSize);
  const start = performance.now();
  let messages = 0;
  try {
    while (performance.now() - start < durationMs) {
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          const request = frame(payload);
          verify(request, await stream.sendAndReceive(request));
          messages++;
        }),
      );
      onProgress?.({
        phase: "throughput",
        current: Math.min(durationMs, Math.round(performance.now() - start)),
        total: durationMs,
        message: `${messages} verified echoes`,
      });
    }
  } finally {
    await stream.close();
  }
  const elapsed = Math.max(0.001, performance.now() - start);
  const bytes = messages * (payloadSize + 12);
  return {
    type: "throughput",
    transport: transportName,
    bytesSent: bytes,
    bytesReceived: bytes,
    durationMs: elapsed,
    sendRateMbps: (bytes * 8) / (elapsed * 1000),
    receiveRateMbps: (bytes * 8) / (elapsed * 1000),
    messagesPerSecond: (messages * 1000) / elapsed,
  };
}
/** Concurrent mixed-size workload. No packet loss is injected; this is not a HOL proof. */
export async function measureHOLBlocking(
  transport: FastTransport,
  transportName: string,
  streamCount = 4,
  messagesPerStream = 50,
  onProgress?: ProgressCallback,
): Promise<HOLBlockingResult> {
  bounded(streamCount, 1, 16, "Stream count");
  bounded(messagesPerStream, 1, 1000, "Messages per stream");
  let completed = 0;
  const results = await Promise.allSettled(
    Array.from({ length: streamCount }, async (_, index) => {
      const stream = await handle(transport, `parallel-${index}`);
      const start = performance.now();
      try {
        for (let i = 0; i < messagesPerStream; i++) {
          const request = frame(randomBytes(index === 0 ? 8192 : 128));
          verify(request, await stream.sendAndReceive(request));
        }
        onProgress?.({
          phase: "parallel",
          current: ++completed,
          total: streamCount,
          message: `Stream ${index + 1} complete`,
        });
        return performance.now() - start;
      } finally {
        await stream.close();
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const times = results.map(
    (result) => (result as PromiseFulfilledResult<number>).value,
  );
  return {
    type: "hol-blocking",
    transport: transportName,
    streamCount,
    streamTimes: times,
    maxStreamTime: Math.max(...times),
    minStreamTime: Math.min(...times),
    spreadMs: Math.max(...times) - Math.min(...times),
  };
}
/** Counts only unique, matching responses. Always removes the listener before returning. */
export async function measureDatagrams(
  transport: FastTransport,
  transportName: string,
  count = 200,
  onProgress?: ProgressCallback,
): Promise<DatagramResult> {
  bounded(count, 1, 10000, "Datagram count");
  const pending = new Map<number, number>();
  const latencies: number[] = [];
  let received = 0;
  let sent = 0;
  const unsubscribe = transport.onDatagram((data) => {
    try {
      const result = tryDecodeFrame(data);
      if (
        !result ||
        result.bytesConsumed !== data.length ||
        result.frame.channelId !== CHANNEL_ECHO ||
        result.frame.messageType !== MSG_ECHO_RESPONSE
      )
        return;
      const requestId = result.frame.requestId;
      const started = pending.get(requestId);
      if (started === undefined) return;
      pending.delete(requestId);
      received++;
      latencies.push((performance.now() - started) * 1000);
    } catch {
      /* Drop malformed datagrams. */
    }
  });
  try {
    for (let i = 0; i < count; i++) {
      const request = frame(new Uint8Array([1, 2, 3, 4]));
      pending.set(request.requestId, performance.now());
      await transport.sendDatagram(encodeFrame(request));
      sent++;
      onProgress?.({
        phase: "datagram",
        current: i + 1,
        total: count,
        message: `Sent ${sent}; received ${received}`,
      });
      if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const deadline = performance.now() + 2000;
    while (received < sent && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    unsubscribe();
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    type: "datagram",
    transport: transportName,
    sent,
    received,
    lossRate: 1 - received / sent,
    latencies,
    medianLatency: sorted[Math.floor(sorted.length / 2)] ?? 0,
    meanLatency: sorted.length
      ? sorted.reduce((a, b) => a + b, 0) / sorted.length
      : 0,
  };
}
