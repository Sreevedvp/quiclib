import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  args: process.env.CERT_SPKI
    ? [`--ignore-certificate-errors-spki-list=${process.env.CERT_SPKI}`]
    : [],
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const result = [];
const diag = () => page.evaluate(() => window.fleetDiagnostics);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.goto("http://127.0.0.1:3100");
  if (process.env.TRANSPORT === "websocket")
    await page.selectOption("#transport", "websocket");
  await page.click("#connect");
  await page.waitForFunction(
    () => window.fleetDiagnostics?.connected,
    {},
    { timeout: 20000 },
  );
  await wait(1500);
  let a = await diag();
  assert.equal(a.cars.length, 32);
  assert.equal(new Set(a.cars.map((c) => c.streamId)).size, 32);
  assert(a.cars.every((c) => c.received > 10));
  result.push("32 distinct stream/channel IDs receive server telemetry");
  await wait(500);
  let b = await diag();
  assert(
    b.cars.some(
      (c, i) =>
        c.sample.x !== a.cars[i].sample.x || c.sample.y !== a.cars[i].sample.y,
    ),
  );
  result.push("Cars move using received positions");
  await page.click("#slowCar");
  await wait(2500);
  a = await diag();
  await wait(1000);
  b = await diag();
  assert(b.cars[0].sample.coalesced > 0);
  assert(b.cars[0].sample.queued <= 32);
  assert(
    b.cars[1].received - a.cars[1].received >
      3 * (b.cars[0].received - a.cars[0].received),
  );
  result.push(
    "Delayed stream coalesces within queue bound while peers keep running",
  );
  await page.click("#pauseCar");
  await wait(500);
  a = await diag();
  await wait(500);
  b = await diag();
  assert.equal(a.cars[0].received, b.cars[0].received);
  assert(b.cars[1].received > a.cars[1].received);
  await page.click("#pauseCar");
  await wait(500);
  assert((await diag()).cars[0].received > b.cars[0].received);
  result.push("Per-car pause and resume isolate the selected stream");
  await page.click("#slowCar");
  await page.click("#pauseAll");
  await wait(500);
  a = await diag();
  await wait(500);
  b = await diag();
  assert.equal(a.total, b.total);
  await page.click("#pauseAll");
  await wait(500);
  assert((await diag()).total > b.total);
  result.push("Fleet pause and resume");
  await page.selectOption("#size", "64");
  await page.waitForFunction(
    () =>
      window.fleetDiagnostics?.connected &&
      window.fleetDiagnostics.cars.length === 64,
  );
  await page.locator("#rate").fill("100");
  await page.locator("#rate").dispatchEvent("change");
  await wait(1500);
  a = await diag();
  await wait(2000);
  b = await diag();
  const measured = (b.total - a.total) / 2;
  assert(measured > 3000);
  assert.equal(new Set(b.cars.map((c) => c.streamId)).size, 64);
  assert(b.cars.every((c) => c.sample.queued <= 32));
  result.push(
    `64-stream load test: ${Math.round(measured)} received messages/sec at 100 Hz target`,
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
  result.push("Mobile layout fits 390 px viewport");
  await page.click("#connect");
  await page.waitForFunction(() => !window.fleetDiagnostics.connected);
  a = await diag();
  await wait(500);
  b = await diag();
  assert.equal(a.total, b.total);
  result.push("Disconnect stops incoming messages");
  assert.deepEqual(errors, []);
  result.push("No uncaught browser errors");
  await writeFile(
    "artifacts/browser-results.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
