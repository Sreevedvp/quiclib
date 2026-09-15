import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrame,
  tryDecodeFrame,
  MAX_PAYLOAD_SIZE,
  randomBytes,
  encodeText,
  decodeText,
  encodeTimestamp,
  decodeTimestamp,
} from "../src/index";
const frame = {
  channelId: 16,
  messageType: 32,
  requestId: 0xabcdef01,
  payload: encodeText("abc"),
};
describe("binary protocol", () => {
  it("matches the Rust network byte order vector", () => {
    expect([...encodeFrame(frame)]).toEqual([
      0, 0, 0, 3, 0, 16, 0, 32, 171, 205, 239, 1, 97, 98, 99,
    ]);
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
  it("handles fragmented frames and nonzero view offsets", () => {
    const bytes = encodeFrame(frame);
    for (let i = 0; i < bytes.length; i++)
      expect(tryDecodeFrame(bytes.subarray(0, i))).toBeNull();
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 3);
    expect(decodeFrame(padded.subarray(3))).toEqual(frame);
  });
  it("consumes only one of coalesced frames", () => {
    const first = encodeFrame(frame);
    const both = new Uint8Array(first.length * 2);
    both.set(first);
    both.set(first, first.length);
    expect(tryDecodeFrame(both)?.bytesConsumed).toBe(first.length);
  });
  it("rejects oversized declarations before receiving the payload", () => {
    const header = new Uint8Array(12);
    new DataView(header.buffer).setUint32(0, MAX_PAYLOAD_SIZE + 1);
    expect(() => tryDecodeFrame(header)).toThrow(/maximum/);
  });
  it.each([-1, 0x100000000, 1.5, NaN])(
    "rejects invalid request id %s",
    (id) => {
      expect(() => encodeFrame({ ...frame, requestId: id })).toThrow(
        RangeError,
      );
    },
  );
  it("rejects truncated frames", () => {
    expect(() => decodeFrame(encodeFrame(frame).subarray(0, 13))).toThrow(
      /Incomplete/,
    );
  });
  it("generates payloads larger than the Web Crypto per-call quota", () => {
    const bytes = randomBytes(262144);
    expect(bytes.length).toBe(262144);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
  });
  it("roundtrips unicode and 64-bit timestamps", () => {
    expect(decodeText(encodeText("नमस्ते 🚀"))).toBe("नमस्ते 🚀");
    expect(decodeTimestamp(encodeTimestamp(2 ** 40 + 123))).toBe(2 ** 40 + 123);
  });
});
