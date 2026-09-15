/**
 * @quiclib/protocol — Binary Frame Format
 *
 * Wire format:
 * ┌─────────────┬────────────┬──────────────┬────────────┬─────────┐
 * │ Payload Len │ Channel ID │ Message Type │ Request ID │ Payload │
 * │  4 bytes    │  2 bytes   │   2 bytes    │  4 bytes   │ N bytes │
 * └─────────────┴────────────┴──────────────┴────────────┴─────────┘
 *
 * All multi-byte integers are big-endian (network byte order).
 */

/** Size of the frame header in bytes (before payload). */
export const FRAME_HEADER_SIZE = 12;

/** Maximum allowed payload size (16 MB). */
export const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

/**
 * Represents a single protocol frame.
 */
export interface Frame {
  /** Identifies the logical channel (control, auth, echo, chat, etc.). */
  channelId: number;

  /** Identifies the message type within the channel. */
  messageType: number;

  /** Links requests to responses for multiplexed RPC-style communication. */
  requestId: number;

  /** The actual message data. */
  payload: Uint8Array;
}

/**
 * Encodes a Frame into a binary Uint8Array for transmission.
 *
 * @param frame - The frame to encode.
 * @returns The encoded binary data.
 * @throws If the payload exceeds MAX_PAYLOAD_SIZE.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  for (const [name, value, maximum] of [
    ["channelId", frame.channelId, 0xffff],
    ["messageType", frame.messageType, 0xffff],
    ["requestId", frame.requestId, 0xffffffff],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum)
      throw new RangeError(`${name} is outside its unsigned wire range`);
  }
  if (frame.payload.byteLength > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `Payload size ${frame.payload.byteLength} exceeds maximum ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const buffer = new ArrayBuffer(FRAME_HEADER_SIZE + frame.payload.byteLength);
  const view = new DataView(buffer);

  view.setUint32(0, frame.payload.byteLength);
  view.setUint16(4, frame.channelId);
  view.setUint16(6, frame.messageType);
  view.setUint32(8, frame.requestId);

  const bytes = new Uint8Array(buffer);
  bytes.set(frame.payload, FRAME_HEADER_SIZE);

  return bytes;
}

/**
 * Decodes a binary Uint8Array into a Frame.
 *
 * @param data - The raw binary data containing at least one complete frame.
 * @returns The decoded frame.
 * @throws If the data is too short or the payload length is inconsistent.
 */
export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < FRAME_HEADER_SIZE) {
    throw new RangeError(
      `Data too short for frame header: ${data.byteLength} < ${FRAME_HEADER_SIZE}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const payloadLength = view.getUint32(0);
  if (payloadLength > MAX_PAYLOAD_SIZE)
    throw new RangeError("Frame payload exceeds maximum size");
  const channelId = view.getUint16(4);
  const messageType = view.getUint16(6);
  const requestId = view.getUint32(8);

  const expectedTotal = FRAME_HEADER_SIZE + payloadLength;
  if (data.byteLength < expectedTotal) {
    throw new RangeError(
      `Incomplete frame: expected ${expectedTotal} bytes, got ${data.byteLength}`,
    );
  }

  if (payloadLength > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `Payload size ${payloadLength} exceeds maximum ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const payload = data.slice(FRAME_HEADER_SIZE, expectedTotal);

  return { channelId, messageType, requestId, payload };
}

/**
 * Attempts to read a complete frame from a buffer that may contain partial data.
 * Returns the frame and the number of bytes consumed, or null if incomplete.
 */
export function tryDecodeFrame(
  data: Uint8Array,
): { frame: Frame; bytesConsumed: number } | null {
  if (data.byteLength < FRAME_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const payloadLength = view.getUint32(0);
  if (payloadLength > MAX_PAYLOAD_SIZE)
    throw new RangeError("Frame payload exceeds maximum size");
  const expectedTotal = FRAME_HEADER_SIZE + payloadLength;

  if (data.byteLength < expectedTotal) {
    return null;
  }

  const frame = decodeFrame(data.subarray(0, expectedTotal));
  return { frame, bytesConsumed: expectedTotal };
}
