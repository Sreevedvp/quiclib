# Lane — live QUIC fleet

A standalone frontend and Rust backend that turns every simulated car into an independent native WebTransport/QUIC bidirectional stream. The server generates positions; the canvas displays received telemetry. A selectable encrypted WebSocket implementation runs the same workload for comparison. No map service, API key or database is required; transport choice is explicit, with no automatic fallback.

## Run

Requires Node.js 22.12+ (tested with 25.9), Rust 1.88+ (tested with 1.96), and Chromium with WebTransport support.

```sh
npx --yes pnpm@9.12.0 install --frozen-lockfile
npx --yes pnpm@9.12.0 dev
```

Open http://127.0.0.1:3100 and click **Connect fleet**. Development uses HTTP 3100, backend HTTP 9101, QUIC UDP 4434 and encrypted WebSocket TCP 4445. Ports 3000, 8080 and 4433 remain available to other projects.

```sh
# Build and serve the bundled frontend directly from Rust:
npx --yes pnpm@9.12.0 build
npx --yes pnpm@9.12.0 start
```

Stop development mode before starting production mode; both use the same ports. Production mode here means serving the built assets; this is a loopback-only simulation lab, not a public fleet tracking service.

## Explore

- Choose 1, 16, 32 or 64 cars; changing fleet size starts a fresh session.
- Set 10–1,000 messages/second per car. The large message counter measures actual incoming messages, not the requested rate.
- Click a car on the canvas or in the searchable vehicle list. Inspect its native QUIC stream ID, sequence, speed, queue and coalesced updates.
- Slow a selected stream by 180 ms per delivery. Its queue fills while other streams continue normally.
- Pause/resume one vehicle or the whole fleet. Scroll to zoom, use Fit map to reset, and toggle trails.
- Export the observed session as JSON.

## Architecture

`frontend/` is a TypeScript/Vite canvas app. `server/` uses Tokio, Axum and wtransport 0.7.2. `vendor/` contains a source snapshot of the user's quic-mordern-library protocol and web packages. Workspace dependencies consume those packages directly; no absolute source paths are required.

One QUIC session contains one bidirectional stream per car. Browser control frames and server telemetry use the library's 12-byte big-endian envelope (payload length, channel, type, request ID) and UTF-8 JSON payloads. Channel is 0x0200; subscribe/config/telemetry/ack types are 0x1000–0x1003. Unsolicited telemetry uses request ID zero; control acknowledgments correlate their request IDs and return the native stream ID.

Each car has concurrent control, producer and writer futures. Its bounded 32-entry queue drops the oldest unsent position when full; coalescing is application behavior, not QUIC packet loss. Producer timing skips missed ticks. The client retains at most 80 trail points per car. Disconnect cancels the per-car futures. Each transport caps sessions at eight and car tasks at 64 per session, validates controls and limits their payloads to 4 KiB.

TLS uses a short-lived certificate generated at startup, with the exact certificate's SHA-256 pin fetched from the local HTTP configuration endpoint. No browser certificate bypass flags are needed. The server accepts only local frontend origins. Certificates/private keys, dependency folders and build outputs are ignored by Git. For deployment beyond loopback, add trusted HTTPS provisioning, authentication, quotas and an explicit allowed-origin configuration.

## Verification

```sh
npx --yes pnpm@9.12.0 test
cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings
# With the app running on 3100:
npx --yes pnpm@9.12.0 exec playwright install chromium
npx --yes pnpm@9.12.0 test:browser
```

The browser suite verifies distinct native streams, movement, queue isolation, pause/resume, reconnect through fleet-size changes, 64-stream load, mobile overflow and disconnect. Screenshots and JSON results are written to ignored `artifacts/`. Optional `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` environment variables support an existing browser runtime.

Local validation on September 14, 2026: 28 library tests and three original backend tests passed; build and Clippy passed. A Chromium loopback run measured approximately 6,418 messages/second for 64 cars at a 100 Hz target, with 60 fps observed in the desktop capture. These are local measurements, not internet performance guarantees.

## Project layout

- `frontend/src/main.ts`: live transport, controls and canvas rendering
- `frontend/src/style.css`: responsive dashboard
- `server/src/main.rs`: stream handling, queues and simulation
- `server/src/certs.rs`: exact-certificate pin generation
- `scripts/dev.mjs`: local development launcher
- `scripts/browser-test.mjs`: real Chromium integration checks
- `.github/workflows/ci.yml`: build, library/backend tests and lint

The vehicle positions are synthetic, not real GPS data. The app intentionally has no persistent storage. Vendored package manifests identify their license as MIT; see `vendor/PROVENANCE.md` for source provenance.

## QUIC versus WebSocket comparison

Select **QUIC** or **WebSocket (TLS)** in the header. QUIC uses a native stream per car; WebSocket multiplexes logical car channels over one TCP connection. Both call the **same** Rust car function, share the same serializer and use the same 32-entry per-car queue. The WebSocket connection has a bounded 64-frame outgoing channel and waits for socket send completion. TCP_NODELAY is enabled. No compression, batching or unreliable datagrams are used.

The existing WebSocket adapter adds five bytes per message for channel routing. The application-byte metric excludes that adapter prefix and all WebSocket/QUIC/TLS/IP overhead; it is not a measurement of wire bandwidth.

```sh
npx --yes pnpm@9.12.0 build:benchmark
npx --yes pnpm@9.12.0 exec playwright install chromium
# Stop any running fleet app first; the runners own their local servers.
npx --yes pnpm@9.12.0 compare
npx --yes pnpm@9.12.0 test:transports
```

The comparison starts the release backend, opens a real Chromium browser, runs three repetitions of six scenarios for each transport (36 trials), including 1,000 Hz per car, saves raw measurements to `artifacts/comparison/` (or `RESULT_DIR`), and stops the browser and server. Trial order reverses on the second repetition. Each trial uses a fresh backend process and fresh Chromium process, two seconds of warm-up and at least eight seconds of measurement. Control round trips are sampled approximately every 200 ms without resetting the car producer. The renderer runs the same map and trails for both transports.

Optional environment variables: `CHROMIUM_PATH`, `REPETITIONS`, `MEASURE_MS`, `RESULT_DIR`. The committed `comparison/results.json` contains the measured summary of the documented run; `comparison/REPORT.md` explains conclusions and limits. Regenerate the report with `node scripts/report.mjs` after a full comparison.

### Local WSS certificate

WebSocket has no browser API equivalent to WebTransport's certificate hash option. For a local comparison, the runners allow only the generated certificate's public-key fingerprint in a temporary Chromium process. Encryption stays enabled; no system trust store is changed and no global certificate-validation bypass is used. For manually trying both modes, start the app and run:

```sh
npx --yes pnpm@9.12.0 open:comparison
```

This opens a temporary visible Chromium window trusting that one local key. Close it when done. In a regular browser, WSS requires trusting the development certificate separately. A real deployment should use a publicly trusted certificate.

### Reading the measurements

- Message age: server generation to browser receipt on this same host. Both use the OS wall clock at **one-millisecond resolution**; it includes the application queue, server scheduling and browser dispatch. It is not pure network latency. Sub-millisecond differences cannot be resolved.
- RTT: browser monotonic time around a control request and acknowledgment. It includes application scheduling, not just network propagation.
- Server CPU: difference in process `getrusage` CPU time divided by elapsed time; 100% means one fully used logical core. The same release binary serves both transports, with a fresh process for every trial.
- Renderer task time: Chromium's main-thread TaskDuration, not total browser CPU. JavaScript heap is a GC-dependent snapshot and includes measurement arrays.
- Backend peak RSS: a process-lifetime high-water mark. It includes startup and warm-up and is not a steady-state memory-efficiency measurement.
- Rates are deliberately capped at the requested car frequency. Matching the target does not establish a transport's maximum capacity.

These are loopback tests of these particular implementations. No network packet loss, constrained bandwidth, mobile network or connection migration is tested. The delayed-car scenario sleeps before the transport write on one car; it demonstrates application queue isolation, not packet-loss head-of-line behavior. All QUIC streams still share connection congestion control and connection-level limits.

The final stress run also checks that the backend reports zero active car tasks after disconnect and measures idle CPU before shutting down each trial. The original shared-server preliminary results are not used for the final resource comparison.
# quic-lib
