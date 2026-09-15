/**
 * @quiclib/protocol
 *
 * Shared binary protocol definitions for QUIC-native transport.
 * Zero dependencies. Used by all platform adapters.
 */

// ── Frame Format ──────────────────────────────────────────────────
export {
  FRAME_HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  type Frame,
  encodeFrame,
  decodeFrame,
  tryDecodeFrame,
} from "./frame.js";

// ── Channel IDs ───────────────────────────────────────────────────
export {
  CHANNEL_CONTROL,
  CHANNEL_AUTH,
  CHANNEL_ECHO,
  CHANNEL_CHAT,
  CHANNEL_FILE_TRANSFER,
  CHANNEL_EVENTS,
  CHANNEL_DATAGRAM,
  CHANNEL_BENCHMARK,
  CHANNEL_NAMES,
  channelName,
} from "./channels.js";

// ── Message Types ─────────────────────────────────────────────────
export {
  MSG_PING,
  MSG_PONG,
  MSG_HELLO,
  MSG_GOODBYE,
  MSG_AUTH_REQUEST,
  MSG_AUTH_RESPONSE,
  MSG_ECHO_REQUEST,
  MSG_ECHO_RESPONSE,
  MSG_DATA,
  MSG_ACK,
  MSG_BENCHMARK_START,
  MSG_BENCHMARK_RESULT,
  MSG_BENCHMARK_END,
  MSG_ERROR,
  MESSAGE_TYPE_NAMES,
  messageTypeName,
} from "./messages.js";

// ── Transport Interface ───────────────────────────────────────────
export {
  type TransportState,
  type ConnectionOptions,
  type TransportStream,
  type FastTransport,
  type FastClientOptions,
} from "./transport.js";

// ── Codec Utilities ───────────────────────────────────────────────
export {
  encodeText,
  decodeText,
  timestampMicros,
  encodeTimestamp,
  decodeTimestamp,
  concatBytes,
  randomBytes,
  nextRequestId,
} from "./codec.js";

// ── Platform Support ──────────────────────────────────────────────
export {
  supportsFastQuic,
  supportsStreams,
  getPlatformDiagnostics,
  type PlatformDiagnostics,
} from "./support.js";
