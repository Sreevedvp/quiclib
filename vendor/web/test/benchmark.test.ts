import { it, expect } from "vitest";
import {
  measureLatency,
  measureThroughput,
  measureDatagrams,
} from "../src/benchmark";
import { TransportEvents } from "../src/events";
import {
  decodeFrame,
  encodeFrame,
  type FastTransport,
  type TransportStream,
} from "@quiclib/protocol";
class EchoTransport extends TransportEvents implements FastTransport {
  listeners = 0;
  writes = 0;
  closed = 0;
  async connect() {
    this.setState("connected");
  }
  async close() {
    this.setState("closed");
  }
  async openStream(): Promise<TransportStream> {
    let reader!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        reader = controller;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write: (bytes) => {
        this.writes++;
        const request = decodeFrame(bytes);
        const reply = encodeFrame({ ...request, messageType: 33 });
        reader.enqueue(reply.slice(0, 3));
        reader.enqueue(reply.slice(3));
      },
    });
    return {
      readable,
      writable,
      close: async () => {
        this.closed++;
      },
    };
  }
  onDatagram(callback: (bytes: Uint8Array) => void) {
    this.listeners++;
    const off = super.onDatagram(callback);
    return () => {
      this.listeners--;
      off();
    };
  }
  async sendDatagram(bytes: Uint8Array) {
    const request = decodeFrame(bytes);
    const reply = encodeFrame({ ...request, messageType: 33 });
    this.emitDatagram(reply);
    this.emitDatagram(reply);
    this.emitDatagram(
      encodeFrame({ ...request, messageType: 33, requestId: 0 }),
    );
  }
}
it("counts full frames, drains replies and releases benchmark streams", async () => {
  const transport = new EchoTransport();
  const result = await measureThroughput(transport, "test", 32, 50);
  expect(result.bytesSent).toBe(transport.writes * 44);
  expect(result.bytesReceived).toBe(result.bytesSent);
  expect(transport.closed).toBe(1);
});
it("repeated datagram runs discard duplicates/unrelated IDs and unsubscribe", async () => {
  const transport = new EchoTransport();
  for (let i = 0; i < 2; i++) {
    const result = await measureDatagrams(transport, "test", 10);
    expect(result.received).toBe(10);
    expect(result.lossRate).toBe(0);
    expect(transport.listeners).toBe(0);
  }
});
it("validates parameters before opening streams", async () => {
  const transport = new EchoTransport();
  await expect(measureLatency(transport, "test", 0)).rejects.toThrow(
    RangeError,
  );
  await expect(measureThroughput(transport, "test", 32, -1)).rejects.toThrow(
    RangeError,
  );
  expect(transport.closed).toBe(0);
});
it("latency verifies the echo instead of accepting arbitrary bytes", async () => {
  const transport = new EchoTransport();
  const result = await measureLatency(transport, "test", 5);
  expect(result.samples).toHaveLength(5);
  expect(transport.closed).toBe(1);
});
