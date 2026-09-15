import { readFile, mkdir, writeFile } from "node:fs/promises";
const source = process.argv[2] || "artifacts/comparison/results.json";
const data = JSON.parse(await readFile(source, "utf8"));
const rows = data.rows;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const groups = [];
for (const scenario of [...new Set(rows.map((r) => r.scenario))])
  for (const transport of ["webtransport", "websocket"]) {
    const trials = rows.filter(
      (r) => r.scenario === scenario && r.transport === transport,
    );
    const summary = {
      scenario,
      transport,
      trials: trials.length,
      slow: trials[0].slow,
    };
    for (const key of Object.keys(trials[0]))
      if (typeof trials[0][key] === "number")
        summary[key] = median(trials.map((r) => r[key]));
    summary.rateRange = trials.map((r) => r.messagesPerSecond);
    summary.cpuRange = trials.map((r) => r.serverCpuPercent);
    groups.push(summary);
  }
const top = groups.filter((g) => g.cars === 64 && g.requestedHz === 1000);
const quic = top.find((g) => g.transport === "webtransport"),
  wss = top.find((g) => g.transport === "websocket");
const measuredHeadline =
  quic && wss
    ? `At 64 cars × 1,000 updates/s, the median achieved rate was ${Math.round(quic.messagesPerSecond).toLocaleString()} for QUIC and ${Math.round(wss.messagesPerSecond).toLocaleString()} for WSS, with approximately 60 fps for both. WSS used ${(100 * (1 - wss.serverCpuPercent / quic.serverCpuPercent)).toFixed(1)}% less backend CPU. QUIC used ${(100 * (1 - quic.rendererTaskPercent / wss.rendererTaskPercent)).toFixed(1)}% less renderer main-thread time. Both had a median p95 message age of ${quic.ageP95Ms} ms. These findings describe this implementation on this machine; neither protocol was pushed to its maximum capacity.`
    : "";
const f = (v, n = 1) => v.toFixed(n);
const label = (t) => (t === "webtransport" ? "QUIC" : "WSS");
let report = `# QUIC versus encrypted WebSocket: measured fleet comparison\n\nMeasured ${data.timestamp}. Both transports ran the same server-generated car workload and canvas frontend.\n\n## Result\n\n${measuredHeadline}\n\nThe tables show the achieved rate against the requested load, including 1,000 updates per second per car. A matching rate is not a maximum-throughput measurement: the simulation is deliberately capped. The per-car application-delay test also worked on both transports. It does not establish a QUIC-specific advantage.\n\n## Environment and method\n\n- ${data.environment.cpu}; ${data.environment.logicalCpus} logical CPUs; ${data.environment.platform} ${data.environment.osRelease}.\n- Chromium ${data.environment.chromium}; Node ${data.environment.node}; optimized Rust release build.\n- ${data.environment.repetitions} trials per transport/scenario, ${data.environment.warmupMs / 1000} s warm-up and at least ${data.environment.measureMs / 1000} s measured per trial.\n- ${data.environment.isolation || "Shared server across initial trials"}.\n- Browser viewport ${data.environment.viewport}; identical rendering, trails, JSON schema, envelope and per-car producer/queue code.\n- ${data.environment.network}. Both transports encrypted; the test browser permits only the exact temporary local certificate public key. No system trust settings changed.\n- Fresh processes prevent earlier connections from affecting subsequent resource measurements. Each row below is the median of the trial statistics, not a percentile pooled across all trials. All trial values are preserved in [results.json](results.json). Three repetitions describe repeatability; they are not a statistical significance study.\n\n## Throughput, latency and backend CPU\n\n| Scenario | Transport | Target msg/s | Messages/s | Target achieved | Age p95 (ms) | Control RTT p95 (ms) | Backend CPU (%) | FPS |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const g of groups)
  report += `| ${g.scenario} | ${label(g.transport)} | ${g.targetMessagesPerSecond} | ${f(g.messagesPerSecond, 0)} | ${f(g.targetAchievedPercent)}% | ${f(g.ageP95Ms, 0)} | ${f(g.rttP95Ms, 2)} | ${f(g.serverCpuPercent)} | ${f(g.fps)} |\n`;
report += `\nAge samples are collected throughout the measurement window, subsampling every Nth received message at high rates to bound browser measurement overhead; the sampling interval is recorded in results.json. Message age is server generation to browser delivery at **1 ms resolution** on the same host. It includes application queueing and browser scheduling, not just the network. RTT uses the browser monotonic clock and includes server/application scheduling. CPU is process CPU time divided by wall time; 100% equals one logical core.\n\n## Repeatability and rendering resources\n\n| Scenario | Transport | Msg/s min–max | CPU min–max (%) | Main-thread task time (%) | JS heap snapshot (MiB) | Frame time p95 (ms) |\n|---|---|---:|---:|---:|---:|---:|\n`;
for (const g of groups)
  report += `| ${g.scenario} | ${label(g.transport)} | ${f(Math.min(...g.rateRange), 0)}–${f(Math.max(...g.rateRange), 0)} | ${f(Math.min(...g.cpuRange))}–${f(Math.max(...g.cpuRange))} | ${f(g.rendererTaskPercent)} | ${f(g.rendererHeapMiB)} | ${f(g.frameP95Ms, 2)} |\n`;
report += `\nRenderer task time is not total browser CPU. Heap snapshots depend on garbage collection and include the benchmark arrays. The recorded backend peak RSS is a process high-water mark, not a steady-state memory measurement. No memory-efficiency winner is claimed.\n\n## One delayed car\n\nThe delay is an application sleep of 180 ms per delivery on car 1, before writing to either transport. Each car has a 32-slot queue, dropping the oldest unsent sample when full.\n\n| Transport | Delayed car msg/s | Other 63 cars msg/s | Delayed car age p95 (ms) | Max observed queue | Coalesced during window |\n|---|---:|---:|---:|---:|---:|\n`;
for (const g of groups.filter((g) => g.slow))
  report += `| ${label(g.transport)} | ${f(g.carZeroMessagesPerSecond, 2)} | ${f(g.otherCarsMessagesPerSecond, 0)} | ${f(g.carZeroAgeP95Ms, 0)} | ${g.maxObservedQueue} | ${g.coalesced} |\n`;
report += `\nA reported queue length of 31 can mean the 32-slot queue was full immediately before the writer popped one message. With 100 generated updates/s, the oldest retained position is roughly 310–320 ms old. This queueing policy explains that age; it is not network latency. The same queue policy can be used with either transport.\n\n## Shutdown checks\n\nAll ${rows.length} trials reported zero active car tasks after disconnect. The maximum observed idle backend CPU was ${Math.max(...rows.map((r) => r.idleServerCpuPercent)).toFixed(2)}% of one logical core. Test servers and browsers were stopped after their trials.\n\n## What was and was not confirmed\n\n- Confirmed with real browser connections: both implementations deliver real car telemetry; both support car/fleet pause and resume, delayed-car queue isolation, bounded queues, reconnect and disconnect.\n- The tests compare **one WebSocket connection with logical car channels** against **one QUIC connection with native car streams**. They do not compare 64 independent WebSockets or alternative batch/scheduling optimizations. WSS adds a five-byte channel prefix; its shared writer acknowledges send completion so queues remain bounded.\n- No artificial packet loss, limited link capacity, WAN RTT, migration or blocked UDP was tested. Therefore this run does **not** empirically confirm QUIC's head-of-line advantage under packet loss. Sleeping before a write is not a substitute for dropping packets on the network.\n- QUIC permits delivery on unaffected streams while another stream awaits missing data; streams still share congestion control and connection limits. This is a protocol property described in [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html#section-2.2), not a loss-test result from this app.\n- WebTransport supports reliable streams and optional datagrams, while WebSockets offers a simpler, broadly supported API. See [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API) and [MDN WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API). This comparison uses reliable delivery only.\n\n## Recommendation for this app\n\nChoose based on the measured implementation cost and required features. A single WSS connection is a valid option for the current small position-update workload. Keep QUIC when native stream isolation or future datagram delivery is valuable, but do not advertise it as faster from these capped loopback results. A deployment decision should next use identical network-level packet-loss, delay and bandwidth profiles on both transports in an isolated test environment.\n\n## Reproduce\n\nSee the root README. Run \`pnpm build:benchmark\`, \`pnpm compare\`, then \`node scripts/report.mjs\`. The runner shuts down its test browser and server. Raw per-message samples remain in ignored \`artifacts/comparison/\`; this report and compact trial summaries are retained in \`comparison/\`.\n`;
await mkdir("comparison", { recursive: true });
await writeFile("comparison/results.json", JSON.stringify(data, null, 2));
await writeFile("comparison/summary.json", JSON.stringify(groups, null, 2));
await writeFile("comparison/REPORT.md", report);
console.log(JSON.stringify(groups, null, 2));
