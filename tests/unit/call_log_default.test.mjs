// The call log is on unless turned off: a bridge started with no BROWSERCTL_CALL_LOG writes to
// ~/.browserctl/calls.jsonl, and BROWSERCTL_CALL_LOG=0 is the only way to silence it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const homes = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Starts a bridge on a free port under a fresh HOME and answers its /status, then stops it.
async function statusOfBridge(extraEnv) {
  const home = mkdtempSync(join(tmpdir(), "browserctl-calllog-"));
  homes.push(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PORT: String(await freePort()),
    HOST: "127.0.0.1",
  };
  delete env.BROWSERCTL_CALL_LOG;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [join(ROOT, "bridge", "server.js")], { env });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`bridge did not start: ${out}`)), 5000);
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/bridge listening on (http:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    return { home, status: await (await fetch(`${url}/status`)).json() };
  } finally {
    child.kill();
  }
}

test("with BROWSERCTL_CALL_LOG unset, the bridge logs to ~/.browserctl/calls.jsonl", async () => {
  const { home, status } = await statusOfBridge({});
  assert.equal(status.callLog, join(home, ".browserctl", "calls.jsonl"));
});

test("BROWSERCTL_CALL_LOG=0 turns the call log off", async () => {
  const { status } = await statusOfBridge({ BROWSERCTL_CALL_LOG: "0" });
  assert.equal(status.callLog, null);
});
