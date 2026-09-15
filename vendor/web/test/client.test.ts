import { it, expect } from "vitest";
import { StreamHandle } from "../src/client";
import {
  encodeFrame,
  encodeText,
  decodeText,
  concatBytes,
} from "@quiclib/protocol";
function fixture(name = "test") {
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const sent: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      input = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write: (data) => {
      sent.push(data);
    },
  });
  const stream = new StreamHandle(name, {
    readable,
    writable,
    close: async () => {},
  });
  stream.startReceiveLoop();
  return { stream, input, sent };
}
const request = (id = 1) => ({
  channelId: 16,
  messageType: 32,
  requestId: id,
  payload: encodeText("hello"),
});
const response = (id = 1) => ({ ...request(id), messageType: 33 });
it("reassembles fragmented/coalesced frames and matches out-of-order replies", async () => {
  const { stream, input } = fixture();
  const a = stream.sendAndReceive(request(1));
  const b = stream.sendAndReceive(request(2));
  const bytes = concatBytes(encodeFrame(response(2)), encodeFrame(response(1)));
  input.enqueue(bytes.slice(0, 7));
  input.enqueue(bytes.slice(7));
  expect((await a).requestId).toBe(1);
  expect((await b).requestId).toBe(2);
  await stream.close();
});
it("isolates identical request IDs on distinct streams", async () => {
  const a = fixture("a"),
    b = fixture("b");
  const ap = a.stream.sendAndReceive(request());
  const bp = b.stream.sendAndReceive(request());
  b.input.enqueue(encodeFrame({ ...response(), payload: encodeText("b") }));
  a.input.enqueue(encodeFrame({ ...response(), payload: encodeText("a") }));
  expect(decodeText((await ap).payload)).toBe("a");
  expect(decodeText((await bp).payload)).toBe("b");
  await Promise.all([a.stream.close(), b.stream.close()]);
});
it("does not resolve on an unrelated channel or request message", async () => {
  const { stream, input } = fixture();
  const pending = stream.sendAndReceive(request());
  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  input.enqueue(encodeFrame({ ...response(), channelId: 20 }));
  input.enqueue(encodeFrame(request()));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(resolved).toBe(false);
  input.enqueue(encodeFrame(response()));
  await pending;
  await stream.close();
});
it("rejects duplicate IDs without replacing the existing resolver", async () => {
  const { stream, input } = fixture();
  const pending = stream.sendAndReceive(request());
  await expect(stream.sendAndReceive(request())).rejects.toThrow(
    /already pending/,
  );
  input.enqueue(encodeFrame(response()));
  await pending;
  await stream.close();
});
it("rejects pending work immediately on peer EOF", async () => {
  const { stream, input } = fixture();
  const pending = expect(
    stream.sendAndReceive(request(), 10000),
  ).rejects.toThrow(/Peer closed/);
  input.close();
  await pending;
  await stream.close();
});
it("rejects pending work on malformed framing", async () => {
  const { stream, input } = fixture();
  const pending = expect(stream.sendAndReceive(request())).rejects.toThrow(
    /maximum/,
  );
  const header = new Uint8Array(12);
  new DataView(header.buffer).setUint32(0, 0xffffffff);
  input.enqueue(header);
  await pending;
  await stream.close();
});
it("closes idempotently and rejects future writes", async () => {
  const { stream } = fixture();
  const pending = expect(stream.sendAndReceive(request())).rejects.toThrow(
    /closed/,
  );
  await stream.close();
  await pending;
  await stream.close();
  await expect(stream.send(request())).rejects.toThrow(/closed/);
});
it("times out and allows the same ID after timeout", async () => {
  const { stream, input } = fixture();
  await expect(stream.sendAndReceive(request(), 5)).rejects.toThrow(
    /timed out/,
  );
  const pending = stream.sendAndReceive(request());
  input.enqueue(encodeFrame(response()));
  await pending;
  await stream.close();
});
it("supports unsubscribe without breaking response delivery", async () => {
  const { stream, input } = fixture();
  let calls = 0;
  const off = stream.onFrame(() => {
    calls++;
  });
  off();
  const pending = stream.sendAndReceive(request());
  input.enqueue(encodeFrame(response()));
  await pending;
  expect(calls).toBe(0);
  await stream.close();
});
