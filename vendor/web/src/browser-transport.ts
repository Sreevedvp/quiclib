import type {
  FastTransport,
  ConnectionOptions,
  TransportStream,
} from "@quiclib/protocol";
import { TransportEvents } from "./events.js";

/** Browser QUIC transport. Unsupported browsers fail explicitly; no fallback. */
export class BrowserQuicTransport
  extends TransportEvents
  implements FastTransport
{
  private transport: WebTransport | null = null;
  private streams = new Map<string, TransportStream>();
  private opening = new Set<string>();
  private cancelConnect: (() => void) | null = null;
  private datagramReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  async connect(options: ConnectionOptions): Promise<void> {
    if (
      this._state === "connected" ||
      this._state === "connecting" ||
      this._state === "closing"
    )
      throw new Error(`Cannot connect while ${this._state}`);
    if (typeof globalThis.WebTransport !== "function") {
      this.setState("failed");
      throw new Error(
        "WebTransport is unsupported in this browser. No automatic fallback is enabled.",
      );
    }
    if (options.protocolVersion !== undefined && options.protocolVersion !== 1)
      throw new Error("Only protocol version 1 is supported");
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Connection timeout must be positive");
    const hashes = options.serverCertificateHashes?.map((hash) => {
      if (hash.algorithm !== "sha-256" || hash.value.byteLength !== 32)
        throw new RangeError("Certificate pin must be a 32-byte SHA-256 hash");
      return { algorithm: "sha-256", value: new Uint8Array(hash.value).buffer };
    });
    this.setState("connecting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transport: WebTransport | null = null;
    try {
      transport = new WebTransport(options.url, {
        serverCertificateHashes: hashes,
      });
      this.transport = transport;
      // Observe closed immediately: rejection can precede ready on a failed handshake.
      void transport.closed.then(
        () => this.ended(transport!, false),
        () => this.ended(transport!, true),
      );
      await Promise.race([
        transport.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Connection timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
          this.cancelConnect = () => reject(new Error("Connection cancelled"));
        }),
      ]);
      if (this.transport !== transport)
        throw new Error("Connection closed before ready");
      this.datagramWriter = transport.datagrams.writable.getWriter();
      this.readDatagrams(transport);
      this.setState("connected");
    } catch (error) {
      if (this.transport === transport) {
        this.transport = null;
        this.setState("failed");
      }
      try {
        transport?.close();
      } catch {
        /* Failed session. */
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.cancelConnect = null;
    }
  }
  async openStream(name: string): Promise<TransportStream> {
    const transport = this.transport;
    if (!transport || this._state !== "connected")
      throw new Error("Transport is not connected");
    if (!name || this.streams.has(name) || this.opening.has(name))
      throw new Error("Stream name must be nonempty and unique");
    this.opening.add(name);
    try {
      const bidi = await transport.createBidirectionalStream();
      if (this.transport !== transport) {
        await Promise.allSettled([
          bidi.readable.cancel(),
          bidi.writable.abort(),
        ]);
        throw new Error("Connection closed while opening stream");
      }
      const stream: TransportStream = {
        readable: bidi.readable,
        writable: bidi.writable,
        close: async () => {
          this.streams.delete(name);
          await Promise.allSettled([
            !bidi.readable.locked ? bidi.readable.cancel() : undefined,
            !bidi.writable.locked ? bidi.writable.close() : undefined,
          ]);
        },
      };
      this.streams.set(name, stream);
      return stream;
    } finally {
      this.opening.delete(name);
    }
  }
  async sendDatagram(data: Uint8Array): Promise<void> {
    if (!this.transport || !this.datagramWriter || this._state !== "connected")
      throw new Error("Transport is not connected");
    if (data.byteLength > this.transport.datagrams.maxDatagramSize)
      throw new RangeError("Datagram exceeds the negotiated maximum");
    await this.datagramWriter.write(new Uint8Array(data));
  }
  async close(): Promise<void> {
    this.cancelConnect?.();
    const transport = this.transport;
    this.transport = null;
    this.setState("closing");
    try {
      transport?.close();
    } catch {
      /* Already closed. */
    }
    await this.cleanup();
    this.setState("closed");
  }
  private ended(transport: WebTransport, failed: boolean): void {
    if (this.transport !== transport) return;
    this.transport = null;
    this.setState(failed ? "failed" : "closed");
    void this.cleanup();
  }
  private async cleanup(): Promise<void> {
    const reader = this.datagramReader;
    this.datagramReader = null;
    const writer = this.datagramWriter;
    this.datagramWriter = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.allSettled([
      reader?.cancel(),
      writer?.abort(),
      ...streams.map((stream) => stream.close()),
    ]);
    try {
      writer?.releaseLock();
    } catch {
      /* Pending shutdown. */
    }
  }
  private readDatagrams(transport: WebTransport): void {
    const reader = transport.datagrams.readable.getReader();
    this.datagramReader = reader;
    void (async () => {
      try {
        while (this.transport === transport) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.transport === transport) this.emitDatagram(value);
        }
      } catch {
        /* Session closed. */
      } finally {
        reader.releaseLock();
      }
    })();
  }
}
