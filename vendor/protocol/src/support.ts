/**
 * @quiclib/protocol — Platform Support Detection
 *
 * Provides explicit support detection rather than silent fallbacks.
 * If the platform doesn't support WebTransport, the application
 * should show a clear error — NOT fall back to WebSocket.
 */

/**
 * Returns true if the current environment supports WebTransport.
 * This is the minimum requirement for browser-based QUIC communication.
 */
export function supportsFastQuic(): boolean {
  return typeof globalThis !== "undefined" && "WebTransport" in globalThis;
}

/**
 * Returns true if the ReadableStream / WritableStream APIs are available.
 * Required for stream-based communication.
 */
export function supportsStreams(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    "ReadableStream" in globalThis &&
    "WritableStream" in globalThis
  );
}

/**
 * Returns a diagnostic object describing the platform's capabilities.
 */
export function getPlatformDiagnostics(): PlatformDiagnostics {
  return {
    webTransport: supportsFastQuic(),
    streams: supportsStreams(),
    performanceApi:
      typeof performance !== "undefined" &&
      typeof performance.now === "function",
    cryptoApi:
      typeof crypto !== "undefined" &&
      typeof crypto.getRandomValues === "function",
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    runtime: detectRuntime(),
  };
}

export interface PlatformDiagnostics {
  webTransport: boolean;
  streams: boolean;
  performanceApi: boolean;
  cryptoApi: boolean;
  userAgent: string;
  runtime: "browser" | "node" | "deno" | "bun" | "unknown";
}

function detectRuntime(): PlatformDiagnostics["runtime"] {
  if (typeof globalThis !== "undefined") {
    // Check for Deno
    if ("Deno" in globalThis) return "deno";
    // Check for Bun
    if ("Bun" in globalThis) return "bun";
    // Check for Node.js
    if (
      (globalThis as { process?: { versions?: { node?: string } } }).process
        ?.versions?.node
    )
      return "node";
    // Check for browser
    if (typeof window !== "undefined" || typeof document !== "undefined")
      return "browser";
  }
  return "unknown";
}
