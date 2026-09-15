import { it, expect, vi, afterEach } from "vitest";
import { BrowserQuicTransport } from "../src/browser-transport";
class FakeWebTransport {
  static latest: FakeWebTransport;
  ready: Promise<void>;
  closed: Promise<void>;
  resolveReady!: () => void;
  resolveClosed!: () => void;
  close = vi.fn(() => this.resolveClosed());
  datagrams = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({
      write: async () => {
        await Promise.resolve();
      },
    }),
    maxDatagramSize: 1200,
  };
  constructor(
    public url: string,
    public options: WebTransportOptions,
  ) {
    FakeWebTransport.latest = this;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("pins the exact subarray instead of its backing buffer", async () => {
  vi.stubGlobal("WebTransport", FakeWebTransport);
  const adapter = new BrowserQuicTransport();
  const bytes = new Uint8Array(40);
  bytes.fill(7, 4, 36);
  const connected = adapter.connect({
    url: "https://localhost:4433",
    serverCertificateHashes: [
      { algorithm: "sha-256", value: bytes.subarray(4, 36) },
    ],
  });
  const native = FakeWebTransport.latest;
  expect(
    new Uint8Array(
      native.options.serverCertificateHashes![0].value as ArrayBuffer,
    ),
  ).toEqual(new Uint8Array(32).fill(7));
  native.resolveReady();
  await connected;
  await adapter.close();
});
it("closes timed-out sessions and ignores late readiness", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebTransport", FakeWebTransport);
  const adapter = new BrowserQuicTransport();
  const outcome = expect(
    adapter.connect({ url: "https://localhost:4433", timeoutMs: 10 }),
  ).rejects.toThrow(/timeout/);
  const native = FakeWebTransport.latest;
  await vi.advanceTimersByTimeAsync(11);
  await outcome;
  native.resolveReady();
  await Promise.resolve();
  expect(native.close).toHaveBeenCalled();
  expect(adapter.state).toBe("failed");
});
it("cancels connection attempts and clears timeout timers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebTransport", FakeWebTransport);
  const adapter = new BrowserQuicTransport();
  const pending = expect(
    adapter.connect({ url: "https://localhost:4433" }),
  ).rejects.toThrow(/cancelled/);
  await adapter.close();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("allows simultaneous datagram writes without acquiring the writer twice", async () => {
  vi.stubGlobal("WebTransport", FakeWebTransport);
  const adapter = new BrowserQuicTransport();
  const connected = adapter.connect({ url: "https://localhost:4433" });
  FakeWebTransport.latest.resolveReady();
  await connected;
  await Promise.all([
    adapter.sendDatagram(new Uint8Array([1])),
    adapter.sendDatagram(new Uint8Array([2])),
  ]);
  await expect(adapter.sendDatagram(new Uint8Array(1201))).rejects.toThrow(
    /maximum/,
  );
  await adapter.close();
});
