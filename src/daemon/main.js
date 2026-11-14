#!/usr/bin/env node
// @ts-check
// Daemon entry point. BROWSERCTL_PORT (default 8765), BROWSERCTL_HOME (default ~/.browserctl).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./app.js";
import { CdpLane } from "./cdp/lane.js";
import { startServer } from "./server.js";
import { tools } from "./tools/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

export async function main() {
  const port = Number(process.env.BROWSERCTL_PORT ?? 8765);
  const home = process.env.BROWSERCTL_HOME ?? path.join(os.homedir(), ".browserctl");
  fs.mkdirSync(home, { recursive: true });
  const daemon = new Daemon({ home, version, tools });
  /** @type {any} */ (daemon).cdp = new CdpLane(daemon, { idleMs: Number(process.env.BROWSERCTL_DETACH_IDLE ?? 30) * 1000 });
  const server = await startServer(daemon, { port });
  fs.writeFileSync(path.join(home, `daemon-${port}.json`), JSON.stringify({ pid: process.pid, port, version, startedAt: Date.now() }));
  const stop = () => {
    server.close();
    daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { daemon, server };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`browserctl daemon: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
