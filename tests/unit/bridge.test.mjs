// Unit tests for the bridge HTTP+WS relay (bridge/server.js). No Chrome/extension
// involved — a small fake WebSocket client stands in for the real extension so we
// can drive every code path (correlation, timeout, disconnect, oversized payload,
// socket replacement) fast and deterministically.
//
// Run: npm test (from bridge/), or: node --test tests/unit/  (from the repo root)

import { test, after } from "node:test";
import assert from "node:assert/strict";
// Reuse the bridge's own "ws" dependency (no new npm deps) via a direct relative
// path into bridge/node_modules — tests/unit has no node_modules of its own to
// resolve the bare "ws" specifier from.
import { WebSocket } from "../../bridge/node_modules/ws/wrapper.mjs";

// Small, test-only overrides so timeout/payload-cap behavior can be exercised in
// milliseconds/kilobytes instead of real minutes/megabytes. Must be set before
// server.js is imported: it reads these into module-level constants at load time.
const TEST_COMMAND_TIMEOUT_MS = 250;
const TEST_MAX_WS_PAYLOAD_BYTES = 4096;
process.env.PORT = "0"; // OS-assigned free port, so tests never collide with a real bridge
process.env.COMMAND_TIMEOUT_MS = String(TEST_COMMAND_TIMEOUT_MS);
process.env.MAX_WS_PAYLOAD_BYTES = String(TEST_MAX_WS_PAYLOAD_BYTES);

const { server, wss, computeTimeoutMs } = await import("../../bridge/server.js");

if (!server.listening) {
  // Race the error against the success: a listen failure (e.g. PORT ignored and 8765
  // already taken) otherwise never resolves, and `node --test` buffers a file's output
  // until it finishes — so the whole suite hung with zero output and no clue why.
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (err) =>
      reject(new Error(`bridge failed to listen (${err.code}): ${err.message}`))
    );
  });
}
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/extension`;

async function post(action, params) {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function connectFakeExtension() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

after(async () => {
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((resolve) => wss.close(() => resolve()));
  await new Promise((resolve) => server.close(() => resolve()));
});

// ---- computeTimeoutMs: pure logic, no server round-trip needed ----

test("computeTimeoutMs: default action uses the (overridable) command timeout", () => {
  assert.equal(computeTimeoutMs("click", {}), TEST_COMMAND_TIMEOUT_MS);
});

test("computeTimeoutMs: wait_for/wait_network_idle honor caller timeoutMs + buffer", () => {
  assert.equal(computeTimeoutMs("wait_for", { timeoutMs: 60_000 }), 65_000);
  assert.equal(computeTimeoutMs("wait_network_idle", { timeoutMs: 1_000 }), 6_000);
});

test("computeTimeoutMs: wait action without a caller timeoutMs falls back to the default", () => {
  assert.equal(computeTimeoutMs("wait_for", {}), TEST_COMMAND_TIMEOUT_MS);
});

test("computeTimeoutMs: export_har gets a higher cap than the default", () => {
  assert.equal(computeTimeoutMs("export_har", {}), 120_000);
});

test("computeTimeoutMs: replay keeps its existing higher cap", () => {
  assert.equal(computeTimeoutMs("replay", {}), 120_000);
});

test("computeTimeoutMs: clamps to the hard max even for a huge caller timeoutMs", () => {
  assert.equal(computeTimeoutMs("wait_for", { timeoutMs: 10_000_000 }), 300_000);
});

// ---- HTTP-level validation, no extension needed ----

test("POST /command with no action -> 400", async () => {
  const { status, data } = await post(undefined, {});
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test("POST /command with invalid JSON body -> 400", async () => {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 400);
  assert.match(data.error, /invalid JSON/);
});

test("POST /command with an oversized HTTP body -> 400 too large", async () => {
  const body = JSON.stringify({ action: "click", params: { note: "a".repeat(5_100_000) } });
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 400);
  assert.match(data.error, /too large/);
});

test("no extension connected -> 503 'extension not connected'", async () => {
  const { status, data } = await post("click", {});
  assert.equal(status, 503);
  assert.equal(data.ok, false);
  assert.match(data.error, /not connected/);
});

// ---- WS correlation / timeout / disconnect, with a fake extension client ----

// Each test below opens its OWN fake extension connection rather than sharing one
// across test() blocks. The bridge only ever has a single live extension socket,
// so isolating state per test (instead of chaining off whatever a previous test
// left connected) keeps the tests deterministic and independently rerunnable.

// Send `action`, capture the message the (single) extension receives, reply with
// `result`, and return the still-pending HTTP promise for the caller to await.
function roundTrip(ws, action, params, result) {
  const p = post(action, params);
  return nextMessage(ws).then((msg) => {
    ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    return p;
  });
}

test("connecting a fake extension makes it serve commands", async () => {
  const ext = await connectFakeExtension();
  const { data } = await roundTrip(ext, "eval_js", { expression: "0" }, { value: 0 });
  assert.equal(data.ok, true);
  ext.close();
});

test("request/reply correlate by id", async () => {
  const ext = await connectFakeExtension();
  const p = post("eval_js", { expression: "1+1" });
  const msg = await nextMessage(ext);
  assert.ok(msg.id, "message missing id");
  assert.equal(msg.action, "eval_js");
  ext.send(JSON.stringify({ id: msg.id, ok: true, result: { value: 2 } }));
  const { status, data } = await p;
  assert.equal(status, 200);
  assert.deepEqual(data.result, { value: 2 });
  ext.close();
});

test("unknown reply id is ignored without affecting later commands", async () => {
  const ext = await connectFakeExtension();
  ext.send(JSON.stringify({ id: "no-such-id", ok: true, result: {} }));
  const { data } = await roundTrip(ext, "eval_js", { expression: "2+2" }, { value: 4 });
  assert.equal(data.result.value, 4);
  ext.close();
});

test("a late duplicate reply for an already-resolved id is ignored", async () => {
  const ext = await connectFakeExtension();
  const p = post("eval_js", { expression: "3+3" });
  const msg = await nextMessage(ext);
  ext.send(JSON.stringify({ id: msg.id, ok: true, result: { value: 6 } }));
  const { data } = await p;
  assert.equal(data.result.value, 6);
  // replaying the same id after it already resolved must not throw or resurface elsewhere
  assert.doesNotThrow(() => ext.send(JSON.stringify({ id: msg.id, ok: true, result: { value: 999 } })));
  // server is still healthy afterward
  const r2 = await roundTrip(ext, "eval_js", { expression: "4+4" }, { value: 8 });
  assert.equal(r2.data.result.value, 8);
  ext.close();
});

test("per-request timeout fires when the extension never replies", async () => {
  const ext = await connectFakeExtension();
  const { status, data } = await post("click", {}); // ext receives it but this test never replies
  assert.equal(status, 504);
  assert.equal(data.ok, false);
  assert.match(data.error, /timed out/);
  ext.close();
});

test("extension close rejects a pending request as 'extension disconnected'", async () => {
  const ext = await connectFakeExtension();
  const p = post("click", {});
  await nextMessage(ext); // sent, now in flight
  ext.close();
  const { data } = await p;
  assert.equal(data.ok, false);
  assert.match(data.error, /extension disconnected/);
});

test("socket replacement rejects pending requests on the old socket", async () => {
  const extA = await connectFakeExtension();
  const p = post("click", {});
  await nextMessage(extA); // extA has it in flight, will never reply
  const extB = await connectFakeExtension(); // supersedes extA
  const { data } = await p;
  assert.equal(data.ok, false);
  assert.match(data.error, /extension disconnected/);

  // the new socket is live and serves new commands
  const p2 = post("eval_js", { expression: "5+5" });
  const msg2 = await nextMessage(extB);
  extB.send(JSON.stringify({ id: msg2.id, ok: true, result: { value: 10 } }));
  assert.equal((await p2).data.result.value, 10);
  extB.close();
});

test("oversized inbound WS message is closed with a friendly 'payload too large' reply", async () => {
  const big = await connectFakeExtension();
  const p = post("click", {});
  const msg = await nextMessage(big);
  const huge = "x".repeat(TEST_MAX_WS_PAYLOAD_BYTES + 1000);
  big.send(JSON.stringify({ id: msg.id, ok: true, result: { huge } }));
  const { data } = await p;
  assert.equal(data.ok, false);
  assert.match(data.error, /payload too large/);
});
