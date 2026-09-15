/**
 * @quiclib/protocol — Channel ID Constants
 *
 * Each channel represents a logical communication domain within
 * a single QUIC connection. Streams are mapped to channels so
 * the server can route frames to the appropriate handler.
 */

/** Control channel for connection management, keepalive, and negotiation. */
export const CHANNEL_CONTROL = 0x0001;

/** Authentication channel for login/token exchange. */
export const CHANNEL_AUTH = 0x0002;

/** Echo channel used for latency benchmarking. */
export const CHANNEL_ECHO = 0x0010;

/** Chat channel for real-time messaging. */
export const CHANNEL_CHAT = 0x0020;

/** File transfer channel for reliable bulk data. */
export const CHANNEL_FILE_TRANSFER = 0x0030;

/** Server-sent events channel (unidirectional from server). */
export const CHANNEL_EVENTS = 0x0040;

/** Datagram channel for unreliable real-time data. */
export const CHANNEL_DATAGRAM = 0x00ff;

/** Benchmark control channel for coordinating test runs. */
export const CHANNEL_BENCHMARK = 0x0100;

/**
 * Human-readable channel names for logging and debugging.
 */
export const CHANNEL_NAMES: Record<number, string> = {
  [CHANNEL_CONTROL]: "control",
  [CHANNEL_AUTH]: "auth",
  [CHANNEL_ECHO]: "echo",
  [CHANNEL_CHAT]: "chat",
  [CHANNEL_FILE_TRANSFER]: "file-transfer",
  [CHANNEL_EVENTS]: "events",
  [CHANNEL_DATAGRAM]: "datagram",
  [CHANNEL_BENCHMARK]: "benchmark",
};

/**
 * Returns the human-readable name for a channel ID, or "unknown(0xNNNN)".
 */
export function channelName(channelId: number): string {
  return (
    CHANNEL_NAMES[channelId] ??
    `unknown(0x${channelId.toString(16).padStart(4, "0")})`
  );
}
