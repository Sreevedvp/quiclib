import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { X509Certificate, createHash } from "node:crypto";
const response = await fetch("http://127.0.0.1:3100/api/health");
if (!response.ok) throw Error("Start the fleet app first");
const cert = new X509Certificate(await readFile("server/certs/cert.pem"));
const spki = createHash("sha256")
  .update(cert.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
const browser = await chromium.launch({
  headless: false,
  args: [`--ignore-certificate-errors-spki-list=${spki}`],
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
await page.goto("http://127.0.0.1:3100");
await new Promise((resolve) => browser.on("disconnected", resolve));
