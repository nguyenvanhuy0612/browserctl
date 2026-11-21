// @ts-check
// Client of the daemon's HTTP API, shared by the MCP server and the CLI: finds or starts the
// daemon, lists tools, calls them (specs/interface.md).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
 * One tool call over node:http, which waits for the answer without a time limit: the tool's own
 * timeout bounds the call, while fetch gives up after 300 s without headers (specs/interface.md).
 * A refused connection is marked `refused`: the daemon never received the call.
 * @param {string} tool @param {object} params @param {{session: string, client: string}} who
 * @returns {Promise<any>}
 */
function post(tool, params, who) {
  const lost = () => new Error(`the daemon closed the connection during ${tool}; the call may have run, so check the page before repeating it`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${base}/v1/tools/${tool}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-browserctl-session": who.session,
          "x-browserctl-client": who.client,
          ...(process.env.BROWSERCTL_CLOSE_TABS === "1" && { "x-browserctl-close-tabs": "1" }),
        },
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("close", () => {
          if (!response.complete) return reject(lost());
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(lost());
          }
        });
      },
    );
    request.on("error", (error) => reject(/** @type {any} */ (error).code === "ECONNREFUSED" ? Object.assign(error, { refused: true }) : lost()));
    request.end(JSON.stringify(params ?? {}));
  });
}

/**
 * Sends a call again only when the daemon refused the connection; a call that may have run is never
 * repeated, since a second click or run acts twice (specs/interface.md).
 * @param {string} tool @param {object} params @param {{session: string, client: string}} who
 * @returns {Promise<any>}
 */
export async function callTool(tool, params, who) {
  try {
    return await post(tool, params, who);
  } catch (error) {
    if (!(/** @type {any} */ (error).refused)) throw error;
    await ensureDaemon();
    return post(tool, params, who);
  }
}

/** Keeps the session alive while its client lives (specs/sessions.md). @param {string} session */
export async function heartbeat(session) {
  try {
    await fetch(`${base}/v1/sessions/${encodeURIComponent(session)}/heartbeat`, { method: "POST", signal: AbortSignal.timeout(2000) });
  } catch {
    // the daemon is down; the next tool call starts it
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
