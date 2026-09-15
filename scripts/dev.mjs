import { spawn } from "node:child_process";
const children = [];
async function run(cmd, args, cwd) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`)),
    );
  });
}
await run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-b",
  "vendor/protocol",
  "vendor/web",
]);
await run("cargo", ["build", "--manifest-path", "server/Cargo.toml"]);
children.push(
  spawn("./target/debug/quic-fleet-live", [], {
    cwd: "server",
    stdio: "inherit",
  }),
);
children.push(
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "frontend"], {
    stdio: "inherit",
  }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill("SIGTERM");
}
for (const p of children) {
  p.on("error", (e) => {
    console.error(e);
    stop();
    process.exitCode = 1;
  });
  p.on("exit", (c) => {
    if (!stopping) {
      process.exitCode = c || 1;
      stop();
    }
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
