// @ts-check
// Client of the daemon's HTTP API, shared by the MCP server and the CLI: finds or starts the
// daemon, lists tools, calls them (specs/interface.md).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon/main.js");

export const port = Number(process.env.BROWSERCTL_PORT ?? 8765);
export const base = `http://127.0.0.1:${port}`;
export const home = process.env.BROWSERCTL_HOME ?? path.join(os.homedir(), ".browserctl");

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

export async function health() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Starts the daemon detached from this process. */
export function spawnDaemon() {
  fs.mkdirSync(home, { recursive: true });
  const log = fs.openSync(path.join(home, "daemon.log"), "a");
  const child = spawn(process.execPath, [DAEMON_MAIN], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, BROWSERCTL_PORT: String(port), BROWSERCTL_HOME: home },
  });
  child.unref();
}

export async function ensureDaemon() {
  if (await health()) return;
  if (process.env.BROWSERCTL_AUTO_START === "manual") throw new Error(`the browserctl daemon is not running on ${base}; start it with: browserctl daemon start`);
  spawnDaemon();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await health()) return;
  }
  throw new Error(`the browserctl daemon did not start on ${base}; see ${path.join(home, "daemon.log")}`);
}

/** @returns {Promise<{name: string, description: string, inputSchema: any}[]>} */
export async function listTools() {
  await ensureDaemon();
  const res = await fetch(`${base}/v1/tools`);
  return (await res.json()).tools;
}

/**
 * @param {string} tool @param {object} params @param {{session: string, client: string}} who
 * @returns {Promise<any>}
 */
export async function callTool(tool, params, who) {
  const send = () =>
    fetch(`${base}/v1/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-browserctl-session": who.session, "x-browserctl-client": who.client },
      body: JSON.stringify(params ?? {}),
    }).then((r) => r.json());
  try {
    return await send();
  } catch {
    // The daemon went away: start it again once.
    await ensureDaemon();
    return send();
  }
}

/** @param {string} session */
export async function endSession(session) {
  try {
    await fetch(`${base}/v1/sessions/${encodeURIComponent(session)}`, { method: "DELETE", signal: AbortSignal.timeout(2000) });
  } catch {
    // the daemon is gone already
  }
}
