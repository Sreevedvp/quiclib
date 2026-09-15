import type {
  FastTransport,
  TransportStream,
  TransportState,
  FastClientOptions,
  Frame,
} from "@quiclib/protocol";
import {
  encodeFrame,
  tryDecodeFrame,
  concatBytes,
  MSG_ECHO_REQUEST,
  MSG_ECHO_RESPONSE,
  MSG_PING,
  MSG_PONG,
  MSG_ERROR,
} from "@quiclib/protocol";
import { BrowserQuicTransport } from "./browser-transport.js";
import { WebSocketTransport } from "./websocket-transport.js";

interface PendingRequest {
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  channel: number;
  responseType?: number;
}

export class FastClient {
  private transport: FastTransport;
  private streams = new Map<string, StreamHandle>();
  private opening = new Set<string>();
  constructor(private options: FastClientOptions) {
    this.transport =
      options.transport === "websocket"
        ? new WebSocketTransport()
        : new BrowserQuicTransport();
    this.transport.onStateChange((state) => {
      if (state === "closed" || state === "failed") {
        for (const stream of this.streams.values()) void stream.close();
        this.streams.clear();
      }
    });
  }
  get state(): TransportState {
    return this.transport.state;
  }
  connect(): Promise<void> {
    return this.transport.connect(this.options);
  }
  async openStream(name: string): Promise<StreamHandle> {
    if (this.opening.has(name) || this.streams.has(name))
      throw new Error(`Stream "${name}" already exists`);
    this.opening.add(name);
    try {
      const stream = await this.transport.openStream(name);
      const handle = new StreamHandle(name, stream, undefined, () => {
        if (this.streams.get(name) === handle) this.streams.delete(name);
      });
      this.streams.set(name, handle);
      handle.startReceiveLoop();
      return handle;
    } finally {
      this.opening.delete(name);
    }
  }
  sendDatagram(frame: Frame): Promise<void> {
    return this.transport.sendDatagram(encodeFrame(frame));
  }
  onDatagram(callback: (frame: Frame) => void): () => void {
    return this.transport.onDatagram((data) => {
      try {
        const result = tryDecodeFrame(data);
        if (result && result.bytesConsumed === data.byteLength)
          callback(result.frame);
      } catch {
        /* Malformed or truncated datagrams are dropped as a whole. */
      }
    });
  }
  onStateChange(callback: (state: TransportState) => void): () => void {
    return this.transport.onStateChange(callback);
  }
  async close(): Promise<void> {
    const handles = [...this.streams.values()];
    this.streams.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await this.transport.close();
  }
}

/** Request IDs are scoped to this stream, never shared across unrelated streams. */
export class StreamHandle {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private receiveBuffer: Uint8Array = new Uint8Array();
  private listeners = new Set<(frame: Frame) => void>();
  private pending = new Map<number, PendingRequest>();
  private active = true;
  private closing: Promise<void> | null = null;
  // The third parameter is retained for source compatibility; shared maps are no longer used.
  constructor(
    public readonly name: string,
    private stream: TransportStream,
    _legacyPending?: Map<number, unknown>,
    private onClose?: () => void,
  ) {
    this.writer = stream.writable.getWriter();
  }
  async send(frame: Frame): Promise<void> {
    if (!this.active) throw new Error(`Stream "${this.name}" is closed`);
    await this.writer.write(encodeFrame(frame));
  }
  sendAndReceive(frame: Frame, timeoutMs = 5000): Promise<Frame> {
    if (!this.active)
      return Promise.reject(new Error(`Stream "${this.name}" is closed`));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new RangeError("Timeout must be positive"));
    if (this.pending.has(frame.requestId))
      return Promise.reject(
        new Error(`Request ${frame.requestId} is already pending`),
      );
    this.startReceiveLoop();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(frame.requestId);
        reject(
          new Error(
            `Request ${frame.requestId} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const entry: PendingRequest = {
        resolve,
        reject,
        timeout,
        channel: frame.channelId,
        responseType:
          frame.messageType === MSG_ECHO_REQUEST
            ? MSG_ECHO_RESPONSE
            : frame.messageType === MSG_PING
              ? MSG_PONG
              : undefined,
      };
      this.pending.set(frame.requestId, entry);
      this.send(frame).catch((error) => {
        if (this.pending.get(frame.requestId) === entry) {
          clearTimeout(timeout);
          this.pending.delete(frame.requestId);
          reject(error);
        }
      });
    });
  }
  onFrame(callback: (frame: Frame) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new Error(`Stream "${this.name}" closed`));
    this.closing = (async () => {
      await Promise.allSettled([this.reader?.cancel(), this.writer.abort()]);
      try {
        this.writer.releaseLock();
      } catch {
        /* Already released. */
      }
      await this.stream.close();
      this.listeners.clear();
      this.onClose?.();
    })();
    return this.closing;
  }
  startReceiveLoop(): void {
    if (this.reader || !this.active) return;
    const reader = this.stream.readable.getReader();
    this.reader = reader;
    void (async () => {
      try {
        while (this.active) {
          const { value, done } = await reader.read();
          if (done)
            throw new Error(
              this.receiveBuffer.byteLength
                ? "Stream ended with an incomplete frame"
                : "Peer closed the stream",
            );
          this.receiveBuffer = concatBytes(this.receiveBuffer, value);
          while (this.active) {
            const result = tryDecodeFrame(this.receiveBuffer);
            if (!result) break;
            this.receiveBuffer = this.receiveBuffer.slice(result.bytesConsumed);
            const frame = result.frame;
            const pending = this.pending.get(frame.requestId);
            if (
              pending &&
              pending.channel === frame.channelId &&
              (pending.responseType === undefined ||
                pending.responseType === frame.messageType ||
                frame.messageType === MSG_ERROR)
            ) {
              clearTimeout(pending.timeout);
              this.pending.delete(frame.requestId);
              if (frame.messageType === MSG_ERROR)
                pending.reject(new Error("Server rejected request"));
              else pending.resolve(frame);
            }
            for (const listener of this.listeners) {
              try {
                listener(frame);
              } catch {
                /* Isolate observers. */
              }
            }
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reader.releaseLock();
        this.reader = null;
        // Closing also unregisters the stream and releases its writer.
        void this.close().catch(() => {});
      }
    })();
  }
  private fail(error: Error): void {
    this.active = false;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    this.receiveBuffer = new Uint8Array();
  }
}
export function createFastClient(options: FastClientOptions): FastClient {
  return new FastClient(options);
}
