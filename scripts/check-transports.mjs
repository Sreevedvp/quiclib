import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { X509Certificate, createHash } from "node:crypto";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await fetch("http://127.0.0.1:3100/api/health");
  throw Error("Port 3100 is occupied; stop the existing app first");
} catch (e) {
  if (e.message.includes("occupied")) throw e;
}
const server = spawn("./target/release/quic-fleet-live", ["--production"], {
  cwd: "server",
  stdio: "inherit",
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Server did not start");
    try {
      if ((await fetch("http://127.0.0.1:3100/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!ready) throw Error("Startup timeout");
  const certificate = new X509Certificate(
    await readFile("server/certs/cert.pem"),
  );
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  for (const transport of ["webtransport", "websocket"])
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/browser-test.mjs"], {
        stdio: "inherit",
        env: { ...process.env, TRANSPORT: transport, CERT_SPKI: spki },
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`${transport} tests failed: ${code}`)),
      );
    });
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => {
    if (server.exitCode !== null) return r();
    server.once("exit", r);
  });
}
