# QUIC versus encrypted WebSocket: measured fleet comparison

Measured 2026-09-14T16:53:53.469Z. Both transports ran the same server-generated car workload and canvas frontend.

## Result

At 64 cars × 1,000 updates/s, the median achieved rate was 63,999 for QUIC and 63,996 for WSS, with approximately 60 fps for both. WSS used 40.4% less backend CPU. QUIC used 18.9% less renderer main-thread time. Both had a median p95 message age of 2 ms. These findings describe this implementation on this machine; neither protocol was pushed to its maximum capacity.

The tables show the achieved rate against the requested load, including 1,000 updates per second per car. A matching rate is not a maximum-throughput measurement: the simulation is deliberately capped. The per-car application-delay test also worked on both transports. It does not establish a QUIC-specific advantage.

## Environment and method

- Apple M4; 10 logical CPUs; darwin 25.6.0.
- Chromium 149.0.7827.55; Node v25.9.0; optimized Rust release build.
- 3 trials per transport/scenario, 2 s warm-up and at least 8 s measured per trial.
- Fresh server process and fresh Chromium process for every trial.
- Browser viewport 1512 × 1100; identical rendering, trails, JSON schema, envelope and per-car producer/queue code.
- 127.0.0.1 loopback; no artificial packet loss or RTT. Both transports encrypted; the test browser permits only the exact temporary local certificate public key. No system trust settings changed.
- Fresh processes prevent earlier connections from affecting subsequent resource measurements. Each row below is the median of the trial statistics, not a percentile pooled across all trials. All trial values are preserved in [results.json](results.json). Three repetitions describe repeatability; they are not a statistical significance study.

## Throughput, latency and backend CPU

| Scenario | Transport | Target msg/s | Messages/s | Target achieved | Age p95 (ms) | Control RTT p95 (ms) | Backend CPU (%) | FPS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 64 cars × 100 Hz | QUIC | 6400 | 6401 | 100.0% | 3 | 0.50 | 32.0 | 60.0 |
| 64 cars × 100 Hz | WSS | 6400 | 6400 | 100.0% | 3 | 0.60 | 15.4 | 60.0 |
| 64 cars × 100 Hz; car 1 delayed 180 ms | QUIC | 6400 | 6304 | 98.5% | 2 | 0.40 | 27.9 | 60.0 |
| 64 cars × 100 Hz; car 1 delayed 180 ms | WSS | 6400 | 6305 | 98.5% | 2 | 0.50 | 14.2 | 60.0 |
| 1 cars × 1000 Hz | QUIC | 1000 | 1000 | 100.0% | 2 | 0.50 | 7.9 | 60.0 |
| 1 cars × 1000 Hz | WSS | 1000 | 1000 | 100.0% | 2 | 0.50 | 5.5 | 60.0 |
| 16 cars × 1000 Hz | QUIC | 16000 | 15999 | 100.0% | 2 | 1.90 | 58.3 | 60.0 |
| 16 cars × 1000 Hz | WSS | 16000 | 16000 | 100.0% | 1 | 0.80 | 31.7 | 60.1 |
| 32 cars × 1000 Hz | QUIC | 32000 | 31998 | 100.0% | 2 | 0.60 | 91.6 | 60.0 |
| 32 cars × 1000 Hz | WSS | 32000 | 31999 | 100.0% | 1 | 1.00 | 52.7 | 60.0 |
| 64 cars × 1000 Hz | QUIC | 64000 | 63999 | 100.0% | 2 | 1.10 | 145.8 | 60.0 |
| 64 cars × 1000 Hz | WSS | 64000 | 63996 | 100.0% | 2 | 2.10 | 86.8 | 60.0 |

Age samples are collected throughout the measurement window, subsampling every Nth received message at high rates to bound browser measurement overhead; the sampling interval is recorded in results.json. Message age is server generation to browser delivery at **1 ms resolution** on the same host. It includes application queueing and browser scheduling, not just the network. RTT uses the browser monotonic clock and includes server/application scheduling. CPU is process CPU time divided by wall time; 100% equals one logical core.

## Repeatability and rendering resources

| Scenario | Transport | Msg/s min–max | CPU min–max (%) | Main-thread task time (%) | JS heap snapshot (MiB) | Frame time p95 (ms) |
|---|---|---:|---:|---:|---:|---:|
| 64 cars × 100 Hz | QUIC | 6400–6402 | 28.4–32.7 | 27.3 | 2.3 | 17.50 |
| 64 cars × 100 Hz | WSS | 6399–6401 | 14.2–16.0 | 26.8 | 9.8 | 17.60 |
| 64 cars × 100 Hz; car 1 delayed 180 ms | QUIC | 6304–6305 | 27.8–31.7 | 21.6 | 15.0 | 17.50 |
| 64 cars × 100 Hz; car 1 delayed 180 ms | WSS | 6305–6306 | 13.9–15.2 | 22.5 | 10.8 | 17.60 |
| 1 cars × 1000 Hz | QUIC | 1000–1000 | 7.7–8.0 | 19.9 | 4.0 | 17.40 |
| 1 cars × 1000 Hz | WSS | 1000–1000 | 4.6–5.6 | 17.2 | 4.1 | 17.50 |
| 16 cars × 1000 Hz | QUIC | 15998–16000 | 54.5–67.7 | 24.6 | 11.8 | 17.60 |
| 16 cars × 1000 Hz | WSS | 15999–16000 | 31.3–33.5 | 26.7 | 4.4 | 17.60 |
| 32 cars × 1000 Hz | QUIC | 31973–32002 | 83.7–92.3 | 32.6 | 5.6 | 17.60 |
| 32 cars × 1000 Hz | WSS | 31996–32001 | 52.2–53.8 | 37.0 | 7.3 | 17.60 |
| 64 cars × 1000 Hz | QUIC | 63996–64006 | 142.5–147.2 | 45.3 | 2.7 | 17.60 |
| 64 cars × 1000 Hz | WSS | 63994–63998 | 85.7–91.6 | 55.8 | 10.1 | 17.80 |

Renderer task time is not total browser CPU. Heap snapshots depend on garbage collection and include the benchmark arrays. The recorded backend peak RSS is a process high-water mark, not a steady-state memory measurement. No memory-efficiency winner is claimed.

## One delayed car

The delay is an application sleep of 180 ms per delivery on car 1, before writing to either transport. Each car has a 32-slot queue, dropping the oldest unsent sample when full.

| Transport | Delayed car msg/s | Other 63 cars msg/s | Delayed car age p95 (ms) | Max observed queue | Coalesced during window |
|---|---:|---:|---:|---:|---:|
| QUIC | 5.48 | 6299 | 319 | 31 | 753 |
| WSS | 5.47 | 6299 | 320 | 31 | 753 |

A reported queue length of 31 can mean the 32-slot queue was full immediately before the writer popped one message. With 100 generated updates/s, the oldest retained position is roughly 310–320 ms old. This queueing policy explains that age; it is not network latency. The same queue policy can be used with either transport.

## Shutdown checks

All 36 trials reported zero active car tasks after disconnect. The maximum observed idle backend CPU was 0.17% of one logical core. Test servers and browsers were stopped after their trials.

## What was and was not confirmed

- Confirmed with real browser connections: both implementations deliver real car telemetry; both support car/fleet pause and resume, delayed-car queue isolation, bounded queues, reconnect and disconnect.
- The tests compare **one WebSocket connection with logical car channels** against **one QUIC connection with native car streams**. They do not compare 64 independent WebSockets or alternative batch/scheduling optimizations. WSS adds a five-byte channel prefix; its shared writer acknowledges send completion so queues remain bounded.
- No artificial packet loss, limited link capacity, WAN RTT, migration or blocked UDP was tested. Therefore this run does **not** empirically confirm QUIC's head-of-line advantage under packet loss. Sleeping before a write is not a substitute for dropping packets on the network.
- QUIC permits delivery on unaffected streams while another stream awaits missing data; streams still share congestion control and connection limits. This is a protocol property described in [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html#section-2.2), not a loss-test result from this app.
- WebTransport supports reliable streams and optional datagrams, while WebSockets offers a simpler, broadly supported API. See [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API) and [MDN WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API). This comparison uses reliable delivery only.

## Recommendation for this app

Choose based on the measured implementation cost and required features. A single WSS connection is a valid option for the current small position-update workload. Keep QUIC when native stream isolation or future datagram delivery is valuable, but do not advertise it as faster from these capped loopback results. A deployment decision should next use identical network-level packet-loss, delay and bandwidth profiles on both transports in an isolated test environment.

## Reproduce

See the root README. Run `pnpm build:benchmark`, `pnpm compare`, then `node scripts/report.mjs`. The runner shuts down its test browser and server. Raw per-message samples remain in ignored `artifacts/comparison/`; this report and compact trial summaries are retained in `comparison/`.
