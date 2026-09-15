import type {
  FastTransport,
  ConnectionOptions,
  TransportStream,
} from "@quiclib/protocol";
import { TransportEvents } from "./events.js";

/** Explicit comparison adapter: logical streams share TCP; datagrams are reliable. */
export class WebSocketTransport
  extends TransportEvents
  implements FastTransport
{
  private ws: WebSocket | null = null;
  private counter = 0;
  private streams = new Map<
    number,
    { name: string; controller: ReadableStreamDefaultController<Uint8Array> }
  >();
  private cancelConnect: (() => void) | null = null;
  async connect(options: ConnectionOptions): Promise<void> {
    if (["connected", "connecting", "closing"].includes(this._state))
      throw new Error(`Cannot connect while ${this._state}`);
    if (options.protocolVersion !== undefined && options.protocolVersion !== 1)
      throw new Error("Only protocol version 1 is supported");
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Connection timeout must be positive");
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelConnect = null;
        if (this.ws === socket) this.ws = null;
        this.setState("failed");
        reject(error);
        try {
          socket?.close();
        } catch {
          /* Constructor failed. */
        }
      };
      const timer = setTimeout(
        () => fail(new Error("WebSocket connection timed out")),
        timeoutMs,
      );
      this.cancelConnect = () => fail(new Error("Connection cancelled"));
      try {
        socket = new WebSocket(
          options.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
        );
        this.ws = socket;
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          if (settled) {
            socket.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.cancelConnect = null;
          this.setState("connected");
          resolve();
        };
        socket.onerror = () => {
          if (!settled) fail(new Error("WebSocket connection failed"));
          else if (this.ws === socket) {
            this.failStreams();
            this.setState("failed");
            socket.close();
          }
        };
        socket.onclose = () => {
          if (!settled) {
            fail(new Error("WebSocket closed before connecting"));
            return;
          }
          if (this.ws === socket) {
            this.ws = null;
            this.failStreams();
            this.setState("closed");
          }
        };
        socket.onmessage = (event) => {
          if (this.ws !== socket || !(event.data instanceof ArrayBuffer))
            return;
          const data = new Uint8Array(event.data);
          if (data[0] === 1 && data.byteLength >= 5) {
            const id = new DataView(data.buffer, data.byteOffset).getUint32(1);
            this.streams.get(id)?.controller.enqueue(data.slice(5));
          } else if (data[0] === 2) this.emitDatagram(data.slice(1));
        };
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async openStream(name: string): Promise<TransportStream> {
    const ws = this.ws;
    if (!ws || this._state !== "connected")
      throw new Error("Transport is not connected");
    if (
      !name ||
      [...this.streams.values()].some((stream) => stream.name === name)
    )
      throw new Error("Stream name must be nonempty and unique");
    if (this.streams.size >= 64)
      throw new Error("At most 64 streams may be open");
    const id = ++this.counter;
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      const record = this.streams.get(id);
      this.streams.delete(id);
      try {
        record?.controller.close();
      } catch {
        /* Cancelled. */
      }
      if (ws.readyState === WebSocket.OPEN) {
        const close = new Uint8Array(5);
        close[0] = 3;
        new DataView(close.buffer).setUint32(1, id);
        ws.send(close);
      }
    };
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.streams.set(id, { name, controller });
      },
      cancel: remove,
    });
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!active || ws !== this.ws || ws.readyState !== WebSocket.OPEN)
          throw new Error("Stream is closed");
        while (ws.bufferedAmount > 262144) {
          await new Promise((resolve) => setTimeout(resolve, 4));
          if (!active || ws !== this.ws || ws.readyState !== WebSocket.OPEN)
            throw new Error("Connection closed during write");
        }
        const data = new Uint8Array(chunk.byteLength + 5);
        data[0] = 1;
        new DataView(data.buffer).setUint32(1, id);
        data.set(chunk, 5);
        ws.send(data);
      },
      close: remove,
      abort: remove,
    });
    return {
      readable,
      writable,
      close: async () => {
        remove();
      },
    };
  }
  async sendDatagram(data: Uint8Array): Promise<void> {
    if (!this.ws || this._state !== "connected")
      throw new Error("Transport is not connected");
    if (this.ws.bufferedAmount > 1048576)
      throw new Error("WebSocket send buffer is full");
    const prefixed = new Uint8Array(data.byteLength + 1);
    prefixed[0] = 2;
    prefixed.set(data, 1);
    this.ws.send(prefixed);
  }
  async close(): Promise<void> {
    this.cancelConnect?.();
    this.cancelConnect = null;
    const ws = this.ws;
    this.ws = null;
    this.setState("closing");
    this.failStreams();
    ws?.close(1000, "Client closing");
    this.setState("closed");
  }
  private failStreams(): void {
    for (const stream of this.streams.values()) {
      try {
        stream.controller.error(new Error("Connection closed"));
      } catch {
        /* Already closed. */
      }
    }
    this.streams.clear();
  }
}
