/**
 * @quiclib/protocol — Message Type Constants
 *
 * Each message type is a 16-bit identifier used in the frame header.
 * Message types are scoped per-channel but we use globally unique IDs
 * for simplicity in the initial version.
 */

// ── Control Messages ──────────────────────────────────────────────

/** Keepalive ping request. Payload: 8-byte timestamp. */
export const MSG_PING = 0x0001;

/** Keepalive pong response. Payload: echoed 8-byte timestamp. */
export const MSG_PONG = 0x0002;

/** Protocol version negotiation. Payload: version string. */
export const MSG_HELLO = 0x0003;

/** Graceful shutdown notification. */
export const MSG_GOODBYE = 0x0004;

// ── Auth Messages ─────────────────────────────────────────────────

/** Authentication request. Payload: credentials. */
export const MSG_AUTH_REQUEST = 0x0010;

/** Authentication response. Payload: result + token. */
export const MSG_AUTH_RESPONSE = 0x0011;

// ── Echo Messages (Benchmark) ─────────────────────────────────────

/** Echo request. Server must echo back with ECHO_RESPONSE. */
export const MSG_ECHO_REQUEST = 0x0020;

/** Echo response. Payload mirrors the request. */
export const MSG_ECHO_RESPONSE = 0x0021;

// ── Data Messages ─────────────────────────────────────────────────

/** Generic data frame. */
export const MSG_DATA = 0x0030;

/** Acknowledgement of a data frame. */
export const MSG_ACK = 0x0031;

// ── Benchmark Control ─────────────────────────────────────────────

/** Start a benchmark run. Payload: benchmark config (JSON or binary). */
export const MSG_BENCHMARK_START = 0x0040;

/** Report benchmark results. Payload: results data. */
export const MSG_BENCHMARK_RESULT = 0x0041;

/** End a benchmark run. */
export const MSG_BENCHMARK_END = 0x0042;

// ── Error Messages ────────────────────────────────────────────────

/** Error response. Payload: error code (2 bytes) + error message. */
export const MSG_ERROR = 0x00ff;

/**
 * Human-readable message type names.
 */
export const MESSAGE_TYPE_NAMES: Record<number, string> = {
  [MSG_PING]: "PING",
  [MSG_PONG]: "PONG",
  [MSG_HELLO]: "HELLO",
  [MSG_GOODBYE]: "GOODBYE",
  [MSG_AUTH_REQUEST]: "AUTH_REQUEST",
  [MSG_AUTH_RESPONSE]: "AUTH_RESPONSE",
  [MSG_ECHO_REQUEST]: "ECHO_REQUEST",
  [MSG_ECHO_RESPONSE]: "ECHO_RESPONSE",
  [MSG_DATA]: "DATA",
  [MSG_ACK]: "ACK",
  [MSG_BENCHMARK_START]: "BENCHMARK_START",
  [MSG_BENCHMARK_RESULT]: "BENCHMARK_RESULT",
  [MSG_BENCHMARK_END]: "BENCHMARK_END",
  [MSG_ERROR]: "ERROR",
};

/**
 * Returns the human-readable name for a message type, or "UNKNOWN(0xNNNN)".
 */
export function messageTypeName(type: number): string {
  return (
    MESSAGE_TYPE_NAMES[type] ??
    `UNKNOWN(0x${type.toString(16).padStart(4, "0")})`
  );
}
