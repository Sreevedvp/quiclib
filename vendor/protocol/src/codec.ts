/**
 * @quiclib/protocol — Encoding Helpers
 *
 * Utility functions for text encoding, timestamp handling,
 * and byte-level operations used across packages.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a string to UTF-8 bytes.
 */
export function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * Decode UTF-8 bytes to a string.
 */
export function decodeText(data: Uint8Array): string {
  return textDecoder.decode(data);
}

/**
 * Get a high-resolution timestamp in microseconds.
 * Uses performance.now() for sub-millisecond precision.
 */
export function timestampMicros(): number {
  if (typeof performance !== "undefined" && performance.now) {
    return Math.round(performance.now() * 1000);
  }
  return Math.round(Date.now() * 1000);
}

/**
 * Encode a 64-bit timestamp into 8 bytes (big-endian).
 * Since JavaScript doesn't natively support 64-bit integers without BigInt,
 * we split into two 32-bit writes.
 */
export function encodeTimestamp(micros: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  // High 32 bits
  view.setUint32(0, Math.floor(micros / 0x100000000));
  // Low 32 bits
  view.setUint32(4, micros >>> 0);
  return new Uint8Array(buffer);
}

/**
 * Decode an 8-byte big-endian timestamp to microseconds.
 */
export function decodeTimestamp(data: Uint8Array): number {
  if (data.byteLength < 8) {
    throw new RangeError("Timestamp requires 8 bytes");
  }
  const view = new DataView(data.buffer, data.byteOffset, 8);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  return high * 0x100000000 + low;
}

/**
 * Concatenate multiple Uint8Arrays into a single Uint8Array.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

/**
 * Generate a random Uint8Array of the given length.
 * Uses crypto.getRandomValues for secure randomness.
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    for (let offset = 0; offset < length; offset += 65536) {
      crypto.getRandomValues(
        bytes.subarray(offset, Math.min(offset + 65536, length)),
      );
    }
  } else {
    // Fallback for environments without Web Crypto
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

/**
 * Generate a monotonically increasing request ID.
 * Wraps around at 2^32.
 */
let _nextRequestId = 1;
export function nextRequestId(): number {
  const id = _nextRequestId;
  _nextRequestId = (_nextRequestId + 1) >>> 0;
  if (_nextRequestId === 0) _nextRequestId = 1; // Skip 0
  return id;
}
