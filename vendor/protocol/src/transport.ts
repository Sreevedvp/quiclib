/**
 * @quiclib/protocol — Transport Interface
 *
 * This is the core abstraction. Application code programs against
 * FastTransport and does not know whether the underlying connection
 * uses WebTransport, native QUIC, or any other transport.
 */

/**
 * Connection states for a FastTransport.
 */
export type TransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "closing"
  | "closed"
  | "failed";

/**
 * Options for establishing a connection.
 */
export interface ConnectionOptions {
  /** The URL of the QUIC/WebTransport endpoint (e.g., "https://api.example.com:4433"). */
  url: string;

  /** Protocol version for negotiation. */
  protocolVersion?: number;

  /**
   * SHA-256 certificate hashes for self-signed certificates (dev mode).
   * Each hash is a Uint8Array of 32 bytes.
   */
  serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }>;

  /** Connection timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
}

/**
 * A bidirectional byte stream.
 */
export interface TransportStream {
  /** The readable side of the stream. */
  readable: ReadableStream<Uint8Array>;

  /** The writable side of the stream. */
  writable: WritableStream<Uint8Array>;

  /** Close this individual stream. */
  close(): Promise<void>;
}

/**
 * Transport-independent interface for QUIC-based communication.
 *
 * Implementations exist for:
 * - WebTransport (browser)
 * - Native QUIC (Node.js / desktop / mobile)
 * - WebSocket (benchmark-only comparison, NOT a fallback)
 */
export interface FastTransport {
  /**
   * Establish a connection to the server.
   * Resolves when the transport is ready to send/receive.
   */
  connect(options: ConnectionOptions): Promise<void>;

  /**
   * Open a new bidirectional stream.
   * The name is used locally to track streams; it is not sent over the wire.
   */
  openStream(name: string): Promise<TransportStream>;

  /**
   * Send an unreliable datagram. May be lost.
   * The benchmark WebSocket adapter emulates this with reliable messages.
   */
  sendDatagram(data: Uint8Array): Promise<void>;

  /**
   * Register a callback for incoming datagrams.
   */
  onDatagram(callback: (data: Uint8Array) => void): () => void;

  /**
   * Close the connection gracefully.
   */
  close(): Promise<void>;

  /** Current connection state. */
  readonly state: TransportState;

  /**
   * Register a callback for state changes.
   */
  onStateChange(callback: (state: TransportState) => void): () => void;
}

/**
 * High-level client that wraps a FastTransport with frame-level messaging.
 */
export interface FastClientOptions {
  /** Server URL. */
  url: string;

  /** Which transport to use. */
  transport: "webtransport" | "websocket";

  /** Protocol version. Default: 1. */
  protocolVersion?: number;

  /** Connection timeout in milliseconds. */
  timeoutMs?: number;

  /** Dev-mode certificate hashes. */
  serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }>;
}
