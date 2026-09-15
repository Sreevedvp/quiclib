/**
 * @quiclib/web
 *
 * WebTransport browser adapter for QUIC-native transport.
 */

export { BrowserQuicTransport } from "./browser-transport.js";
export { WebSocketTransport } from "./websocket-transport.js";
export { FastClient, StreamHandle, createFastClient } from "./client.js";
export {
  measureLatency,
  measureThroughput,
  measureHOLBlocking,
  measureDatagrams,
  type LatencyResult,
  type ThroughputResult,
  type HOLBlockingResult,
  type DatagramResult,
  type BenchmarkResult,
  type BenchmarkProgress,
  type ProgressCallback,
} from "./benchmark.js";
