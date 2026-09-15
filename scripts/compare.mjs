import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { X509Certificate, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { cpus, platform, release } from "node:os";
import assert from "node:assert/strict";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(s.length * q) - 1)] : null;
};
const reps = Number(process.env.REPETITIONS || 3),
  measureMs = Number(process.env.MEASURE_MS || 8000),
  warmupMs = 2000;
const scenarios = [
  { name: "64 cars × 100 Hz", cars: 64, hz: 100, slow: false },
  {
    name: "64 cars × 100 Hz; car 1 delayed 180 ms",
    cars: 64,
    hz: 100,
    slow: true,
  },
  ...[1, 16, 32, 64].map((cars) => ({
    name: `${cars} cars × 1000 Hz`,
    cars,
    hz: 1000,
    slow: false,
  })),
];
const out = process.env.RESULT_DIR || "artifacts/comparison";
await mkdir(out, { recursive: true });
// Refuse to benchmark an unrelated server or reuse someone else's session.
try {
  await fetch("http://127.0.0.1:3100/api/health");
  throw Error(
    "Port 3100 already serves HTTP. Stop it before running comparison.",
  );
} catch (e) {
  if (e.message.includes("already serves")) throw e;
}
let server, browser;
let log = "",
  browserVersion = "";
const rows = [];
async function stopTrial() {
  await browser?.close();
  browser = undefined;
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => {
      if (server.exitCode !== null) return r();
      server.once("exit", r);
    });
    server = undefined;
  }
}
async function startTrial() {
  server = spawn("./target/release/quic-fleet-live", ["--production"], {
    cwd: "server",
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (b) => {
    log += b;
  });
  server.stderr.on("data", (b) => {
    log += b;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Server failed: " + log);
    try {
      const r = await fetch("http://127.0.0.1:3100/api/health");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!ready) throw Error("Server startup timeout: " + log);
  const certificate = new X509Certificate(
    await readFile("server/certs/cert.pem"),
  );
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  browser = await chromium.launch({
    headless: true,
    args: [`--ignore-certificate-errors-spki-list=${spki}`],
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  browserVersion = browser.version();
}
try {
  for (let rep = 0; rep < reps; rep++)
    for (const scenario of scenarios) {
      // Reverse order on alternate repetitions to reduce systematic warm-up/order bias.
      for (const transport of rep % 2
        ? ["websocket", "webtransport"]
        : ["webtransport", "websocket"]) {
        await startTrial();
        const context = await browser.newContext({
          viewport: { width: 1512, height: 1100 },
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto("http://127.0.0.1:3100");
          const setup = await page.evaluate(
            async ({ transport, scenario }) =>
              window.fleetBenchmark.configure(
                transport,
                scenario.cars,
                scenario.hz,
                scenario.slow,
              ),
            { transport, scenario },
          );
          assert.equal(new Set(setup.ids).size, scenario.cars);
          await sleep(warmupMs);
          const cdp = await context.newCDPSession(page);
          await cdp.send("Performance.enable");
          const beforeBrowser = await cdp.send("Performance.getMetrics");
          const start = performance.now();
          const beforeServer = await fetch(
            "http://127.0.0.1:3100/api/metrics",
          ).then((r) => r.json());
          const raw = await page.evaluate(async (ms) => {
            window.fleetBenchmark.start();
            const rtts = [];
            const deadline = performance.now() + ms;
            while (performance.now() < deadline) {
              rtts.push(await window.fleetBenchmark.ping());
              await new Promise((r) => setTimeout(r, 200));
            }
            return { ...window.fleetBenchmark.stop(), rtts };
          }, measureMs);
          const afterServer = await fetch(
            "http://127.0.0.1:3100/api/metrics",
          ).then((r) => r.json());
          const wallMs = performance.now() - start;
          const afterBrowser = await cdp.send("Performance.getMetrics");
          const metric = (response, name) =>
            response.metrics.find((m) => m.name === name)?.value ?? 0;
          const received = raw.counts.reduce((a, b) => a + b, 0),
            coalesced = raw.coalesced.reduce((a, b) => a + b, 0);
          const row = {
            repetition: rep + 1,
            scenario: scenario.name,
            transport,
            requestedHz: scenario.hz,
            cars: scenario.cars,
            slow: scenario.slow,
            setupMs: setup.setupMs,
            elapsedMs: raw.elapsedMs,
            messages: received,
            targetMessagesPerSecond: scenario.cars * scenario.hz,
            targetAchievedPercent:
              (received /
                (raw.elapsedMs / 1000) /
                (scenario.cars * scenario.hz)) *
              100,
            ageSamplingEvery: raw.sampleEvery,
            messagesPerSecond: received / (raw.elapsedMs / 1000),
            applicationMiBPerSecond:
              raw.bytes / (raw.elapsedMs / 1000) / 1048576,
            ageP50Ms: quantile(raw.ages, 0.5),
            ageP95Ms: quantile(raw.ages, 0.95),
            ageP99Ms: quantile(raw.ages, 0.99),
            carZeroAgeP95Ms: quantile(raw.carZeroAges, 0.95),
            rttP50Ms: quantile(raw.rtts, 0.5),
            rttP95Ms: quantile(raw.rtts, 0.95),
            fps: raw.frameIntervals.length / (raw.elapsedMs / 1000),
            frameP95Ms: quantile(raw.frameIntervals, 0.95),
            serverCpuPercent:
              ((afterServer.cpuMs - beforeServer.cpuMs) / wallMs) * 100,
            serverLifetimePeakMiB: afterServer.processLifetimeMaxRssKiB / 1024,
            rendererTaskPercent:
              ((metric(afterBrowser, "TaskDuration") -
                metric(beforeBrowser, "TaskDuration")) /
                (wallMs / 1000)) *
              100,
            rendererHeapMiB: metric(afterBrowser, "JSHeapUsedSize") / 1048576,
            maxObservedQueue: Math.max(...raw.maxQueues),
            coalesced,
            carZeroMessagesPerSecond: raw.counts[0] / (raw.elapsedMs / 1000),
            otherCarsMessagesPerSecond:
              raw.counts.slice(1).reduce((a, b) => a + b, 0) /
              (raw.elapsedMs / 1000),
            maxObservedGapMs: Math.max(...raw.maxGaps),
            invalidAges: raw.invalidAges,
            errors,
          };
          assert.deepEqual(errors, []);
          assert.equal(raw.invalidAges, 0);
          assert(raw.counts.every((n) => n > 0));
          assert(row.maxObservedQueue <= 32);
          if (scenario.slow) {
            assert(row.coalesced > 0);
            assert(row.carZeroMessagesPerSecond < 8);
            assert(
              row.otherCarsMessagesPerSecond >
                scenario.hz * (scenario.cars - 1) * 0.9,
            );
          } // Throughput shortfalls under stress are results, not test failures.
          rows.push(row);
          await writeFile(
            `${out}/raw-${rep + 1}-${scenario.cars}-${scenario.hz}-${scenario.slow ? "slow" : "normal"}-${transport}.json`,
            JSON.stringify(raw),
          );
          if (rep === 0 && scenario.slow)
            await page.screenshot({
              path: `${out}/${transport}.png`,
              fullPage: true,
            });
          console.log(
            `${rep + 1} ${transport} ${scenario.name}: ${row.messagesPerSecond.toFixed(0)} msg/s, age p95 ${row.ageP95Ms.toFixed(2)} ms, CPU ${row.serverCpuPercent.toFixed(1)}%, coalesced ${coalesced}`,
          );
          await page.evaluate(() => window.fleetBenchmark.disconnect());
          await context.close();
          await browser.close();
          browser = undefined;
          await sleep(500);
          const idleBefore = await fetch(
            "http://127.0.0.1:3100/api/metrics",
          ).then((r) => r.json());
          const idleAt = performance.now();
          await sleep(750);
          const idleAfter = await fetch(
            "http://127.0.0.1:3100/api/metrics",
          ).then((r) => r.json());
          row.activeCarsAfterDisconnect = idleAfter.activeCars;
          row.idleServerCpuPercent =
            ((idleAfter.cpuMs - idleBefore.cpuMs) /
              (performance.now() - idleAt)) *
            100;
          assert.equal(row.activeCarsAfterDisconnect, 0);
          console.log(
            `  idle CPU ${row.idleServerCpuPercent.toFixed(2)}%; remaining car tasks ${row.activeCarsAfterDisconnect}`,
          );
          await writeFile(
            `${out}/partial-results.json`,
            JSON.stringify(rows, null, 2),
          );
        } finally {
          await context.close();
          await stopTrial();
        }
        await sleep(250);
      }
    }
  const result = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: platform(),
      osRelease: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      node: process.version,
      chromium: browserVersion,
      isolation:
        "Fresh server process and fresh Chromium process for every trial",
      serverBuild: "cargo --release",
      viewport: "1512 × 1100",
      network: "127.0.0.1 loopback; no artificial packet loss or RTT",
      tls: "QUIC and WSS encrypted; exact local certificate SPKI allowed in test browser",
      warmupMs,
      measureMs,
      repetitions: reps,
    },
    rows,
  };
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  console.log(`Saved ${rows.length} trials to ${out}/results.json`);
} finally {
  await stopTrial();
  await writeFile(`${out}/server.log`, log);
}
