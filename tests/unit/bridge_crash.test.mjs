// An uncaught exception in the bridge is logged and reported as `degraded` in /status; the bridge
// keeps serving. Runs the real bridge/server.js in a child process.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOME = mkdtempSync(join(tmpdir(), "browserctl-crash-test-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(
  process.execPath,
  ["--import", join(ROOT, "tests/unit/children/crash-preload.mjs"), join(ROOT, "bridge/server.js")],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      HOME,
      USERPROFILE: HOME,
      COMMAND_TIMEOUT_MS: "10000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }
);
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
let exited = null;
child.once("exit", (code) => (exited = code));

after(() => {
  child.kill("SIGKILL");
  rmSync(HOME, { recursive: true, force: true });
});

async function status() {
  return (await fetch(`${BASE}/status`)).json();
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      return await status();
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("bridge did not come up");
}

test("a healthy bridge reports degraded: null", async () => {
  const s = await waitUp();
  assert.equal(s.degraded, null);
});

test("an uncaught exception marks the bridge degraded; a command in flight still completes", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/extension`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  // The fake extension holds the command's reply until the fault has been observed.
  let held;
  const arrived = new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping" || msg.id == null) return;
      held = msg.id;
      resolve();
    });
  });

  const inFlight = fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "eval_js", params: { expression: "1", tabId: 1 } }),
  }).then((r) => r.json());
  await arrived;

  child.stdin.write("go\n");
  let s;
  for (let i = 0; i < 100; i++) {
    s = await status();
    if (s.degraded) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(s.degraded?.count, 1);
  assert.equal(s.degraded.lastError, "planted uncaught exception");
  assert.match(s.degraded.lastAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(stderr, /uncaught exception/);
  assert.equal(exited, null, "the bridge is still running");

  ws.send(JSON.stringify({ id: held, ok: true, result: { still: "serving" } }));
  const reply = await inFlight;
  assert.equal(reply.ok, true, "the command in flight when the fault hit is not failed");
  ws.close();
});
