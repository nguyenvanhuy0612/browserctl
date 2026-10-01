// The bridge's multi-connection handshake and routing, against the real bridge/server.js: many
// extensions connect to one port, each command is routed to the browser it names or to a
// resolved default, and a disconnect anywhere never disturbs another browser's pending command.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TABLESS_ACTIONS } from "../../bridge/routing.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "browserctl-multi-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.COMMAND_TIMEOUT_MS = "3000";
process.env.HEARTBEAT_MS = "100";
process.env.FANOUT_TIMEOUT_MS = "300";
// Must stay well below HEARTBEAT_MS: several tests below make a holder stop answering any
// message at all, including the heartbeat's own ping, so the heartbeat's independent
// terminate() would otherwise race the clone probe's own close and sometimes win it.
process.env.CLONE_PROBE_MS = "40";
const CLONE_PROBE_MS = Number(process.env.CLONE_PROBE_MS);
const CALL_LOG = join(TEST_HOME, "calls.jsonl");
process.env.BROWSERCTL_CALL_LOG = CALL_LOG;

const { server, wss } = await import("../../bridge/server.js");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/extension`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(() => r()));
  await new Promise((r) => server.close(() => r()));
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// Every fake extension in this file gets its own never-repeated instanceId, so the alias each
// one is given (permanent for that id, for the life of the shared registry) never collides with
// another test's expectations.
let uid = 0;
const freshId = () => `id-${++uid}`;

// A stand-in extension: answers ping, and answers each command with its own name unless
// `hold` is set, in which case it keeps the command unanswered (a command in flight).
function fakeExtension(name, { hello, hold = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.received = [];
    ws.closeInfo = new Promise((r) =>
      ws.once("close", (code, reason) => r({ code, reason: reason.toString() }))
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      ws.received.push(msg);
      if (!hold) ws.send(JSON.stringify({ id: msg.id, ok: true, result: { by: name } }));
    });
    ws.once("open", () => {
      if (hello !== undefined) ws.send(JSON.stringify({ type: "hello", ...hello }));
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

async function status() {
  return (await fetch(`${BASE}/status`)).json();
}

async function aliasOf(instanceId) {
  const s = await status();
  const e = s.browsers.find((b) => b.instanceId === instanceId);
  return e ? e.alias : null;
}

// A tab command must name its tab, so one that names none here is sent to tab 1: these tests are
// about which browser a command reaches, not which tab.
const withTab = (action, params) =>
  TABLESS_ACTIONS.has(action) || params.tabId != null || params.id != null
    ? params
    : { ...params, tabId: 1 };

function command(action, params = {}, browser) {
  const p = withTab(action, params);
  return fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      browser === undefined ? { action, params: p } : { action, params: p, browser }
    ),
  }).then((r) => r.json());
}

async function closeAll(...sockets) {
  for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.close();
  await Promise.all(sockets.map((s) => s.closeInfo));
  await sleep(30);
}

test("many browsers connect at once", async () => {
  const i1 = freshId(),
    i2 = freshId(),
    i3 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome", focused: false },
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "chrome", focused: false },
  });
  const c = await fakeExtension("C", {
    hello: { instanceId: i3, browserType: "edge", focused: false },
  });
  await sleep(30);
  const s = await status();
  const aliasesByType = { chrome: 0, edge: 0 };
  for (const e of s.browsers)
    if (e.instanceId === i1 || e.instanceId === i2 || e.instanceId === i3)
      aliasesByType[e.browserType]++;
  assert.equal(aliasesByType.chrome, 2);
  assert.equal(aliasesByType.edge, 1);
  assert.equal(a.readyState, WebSocket.OPEN);
  assert.equal(b.readyState, WebSocket.OPEN);
  assert.equal(c.readyState, WebSocket.OPEN);
  await closeAll(a, b, c);
});

test("routing by browser selector", async () => {
  const i1 = freshId(),
    i2 = freshId(),
    i3 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome", focused: false },
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "chrome", focused: false },
  });
  const c = await fakeExtension("C", {
    hello: { instanceId: i3, browserType: "edge", focused: false },
  });
  await sleep(30);
  const edgeAlias = await aliasOf(i3);
  const reply = await command("current_tab", {}, edgeAlias);
  assert.equal(reply.result.by, "C");
  assert.equal(reply.browser, edgeAlias);
  assert.equal(a.received.length, 0);
  assert.equal(b.received.length, 0);
  assert.equal(c.received.length, 1);
  await closeAll(a, b, c);
});

test("no selector, one browser", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome", focused: false },
  });
  await sleep(30);
  const alias = await aliasOf(i1);
  const reply = await command("current_tab");
  assert.equal(reply.ok, true);
  assert.equal(reply.result.by, "A");
  assert.equal(reply.browser, alias);
  await closeAll(a);
});

test("no selector, many browsers, no focus info", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome", focused: false },
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge", focused: false },
  });
  await sleep(30);
  const reply = await command("list_windows");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "NEEDS_BROWSER");
  assert.equal(reply.data.browsers.length, 2);
  await closeAll(a, b);
});

test("no selector, many browsers: a focused window never routes the call", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome", focused: false },
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge", focused: false },
  });
  await sleep(30);
  a.send(JSON.stringify({ type: "focus", focused: true }));
  await sleep(20);
  const reply = await command("list_windows");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "NEEDS_BROWSER");
  assert.equal(a.received.length, 0, "the focused browser received nothing");
  assert.equal(b.received.length, 0);
  await closeAll(a, b);
});

test("pending isolation: a disconnect elsewhere never fails this browser's command", async () => {
  const iA = freshId(),
    iB = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: iA, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", { hello: { instanceId: iB, browserType: "edge" } });
  await sleep(30);
  const aliasA = await aliasOf(iA);
  const inFlight = command("current_tab", {}, aliasA);
  await sleep(50);
  assert.equal(a.received.length, 1);
  b.close();
  await b.closeInfo;
  await sleep(50);
  a.send(JSON.stringify({ id: a.received[0].id, ok: true, result: { by: "A" } }));
  const reply = await inFlight;
  assert.equal(reply.ok, true);
  assert.equal(reply.result.by, "A");
  await closeAll(a);
});

test("closing A fails only A's in-flight commands", async () => {
  const iA = freshId(),
    iB = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: iA, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", { hello: { instanceId: iB, browserType: "edge" } });
  await sleep(30);
  const aliasA = await aliasOf(iA);
  const aliasB = await aliasOf(iB);
  const inFlight = command("current_tab", {}, aliasA);
  await sleep(50);
  const started = Date.now();
  a.close();
  const reply = await inFlight;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /extension disconnected/);
  assert.ok(Date.now() - started < 200);
  const reply2 = await command("current_tab", {}, aliasB);
  assert.equal(reply2.result.by, "B");
  await closeAll(b);
});

test("same instanceId reconnect replaces only itself", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  const b = await fakeExtension("B", { hello: { instanceId: i2, browserType: "chrome" } });
  await sleep(30);
  const alias1 = await aliasOf(i1);
  a.removeAllListeners("message"); // A stops answering pings; the clone probe finds it stale
  const a2 = await fakeExtension("A2", { hello: { instanceId: i1, browserType: "chrome" } });
  const closeEv = await a.closeInfo;
  assert.equal(closeEv.code, 1000);
  await sleep(30);
  assert.equal(b.readyState, WebSocket.OPEN);
  const reply = await command("current_tab", {}, alias1);
  assert.equal(reply.result.by, "A2");
  await closeAll(b, a2);
});

test("a same-instance takeover fails the old socket's command in flight at once, and ignores its late reply", async () => {
  const iSame = freshId();
  const old = await fakeExtension("old", {
    hello: { instanceId: iSame, browserType: "chrome" },
    hold: true,
  });
  await sleep(30);

  const inFlight = command("current_tab");
  await sleep(50);
  assert.equal(old.received.length, 1, "the command reached the old socket");
  const heldId = old.received[0].id;

  old.removeAllListeners("message"); // old stops answering pings; the clone probe finds it stale
  const started = Date.now();
  const fresh = await fakeExtension("fresh", {
    hello: { instanceId: iSame, browserType: "chrome" },
  });
  const reply = await inFlight;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /extension disconnected/);
  assert.ok(Date.now() - started < 1000, "the command must fail at takeover, not at its timeout");

  // A reply the old socket sends after losing its slot must not be taken as an answer.
  if (old.readyState === WebSocket.OPEN) {
    old.send(JSON.stringify({ id: heldId, ok: true, result: { by: "old-late" } }));
  }
  const next = await command("current_tab");
  assert.equal(next.result.by, "fresh");

  await closeAll(old, fresh);
});

test("clone gets a new id", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  const b = await fakeExtension("B", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(CLONE_PROBE_MS + 200);
  const welcome = b.received.find((m) => m.type === "welcome");
  assert.ok(welcome, "B receives a welcome frame");
  assert.notEqual(welcome.instanceId, i1);
  const s = await status();
  const aliasA = s.browsers.find((e) => e.instanceId === i1)?.alias;
  const aliasB = s.browsers.find((e) => e.instanceId === welcome.instanceId)?.alias;
  assert.ok(aliasA, "A is still listed under i1");
  assert.ok(aliasB, "B is listed under its new id");
  assert.notEqual(aliasA, aliasB);
  await closeAll(a, b);
});

test("two clones racing in against one live holder both get distinct fresh ids", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  const [b, c] = await Promise.all([
    fakeExtension("B", { hello: { instanceId: i1, browserType: "chrome" } }),
    fakeExtension("C", { hello: { instanceId: i1, browserType: "chrome" } }),
  ]);
  await sleep(CLONE_PROBE_MS + 200);
  const welcomeB = b.received.find((m) => m.type === "welcome");
  const welcomeC = c.received.find((m) => m.type === "welcome");
  assert.ok(welcomeB, "B receives a welcome frame");
  assert.ok(welcomeC, "C receives a welcome frame");
  assert.notEqual(welcomeB.instanceId, i1);
  assert.notEqual(welcomeC.instanceId, i1);
  assert.notEqual(welcomeB.instanceId, welcomeC.instanceId);
  assert.equal(a.readyState, WebSocket.OPEN, "the live holder is never closed by a probe");
  const aliasA = await aliasOf(i1);
  const reply = await command("current_tab", {}, aliasA);
  assert.equal(reply.result.by, "A", "the holder still answers under its own id");
  await closeAll(a, b, c);
});

test("stale holder is replaced", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  a.removeAllListeners("message"); // A stops answering pings
  const started = Date.now();
  const b = await fakeExtension("B", { hello: { instanceId: i1, browserType: "chrome" } });
  const closeEv = await a.closeInfo;
  assert.ok(Date.now() - started < CLONE_PROBE_MS + 200);
  assert.equal(closeEv.code, 1000);
  await sleep(30);
  const alias1 = await aliasOf(i1);
  const reply = await command("current_tab", {}, alias1);
  assert.equal(reply.result.by, "B");
  await closeAll(b);
});

test("helloField bounds instanceId/browserType/label and strips control characters before they reach /status", async () => {
  const longId = "i".repeat(5000);
  const a = await fakeExtension("A", {
    hello: { instanceId: longId, browserType: "x".repeat(5000), label: "l".repeat(5000) },
  });
  await sleep(30);
  const s = await status();
  assert.equal(s.browsers.length, 1);
  const [entry] = s.browsers;
  assert.ok(entry.instanceId.length <= 64);
  assert.ok(entry.browserType.length <= 32);
  assert.ok(entry.label.length <= 40);
  await closeAll(a);

  const iForged = freshId();
  const b = await fakeExtension("B", { hello: { instanceId: `${iForged}\nforged log line` } });
  await sleep(30);
  const s2 = await status();
  const entryB = s2.browsers.find((e) => e.instanceId.startsWith(iForged));
  assert.ok(!/[\r\n]/.test(entryB.instanceId));
  await closeAll(b);
});

test("legacy socket admitted alongside identified ones", async () => {
  const i1 = freshId();
  const legacy = await fakeExtension("legacy");
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  const s = await status();
  const legacyEntry = s.browsers.find((e) => e.legacy);
  assert.ok(legacyEntry, "the legacy connection is listed");
  assert.match(legacyEntry.alias, /^legacy-\d+$/);
  const reply = await command("current_tab", {}, legacyEntry.alias);
  assert.equal(reply.result.by, "legacy");
  await closeAll(legacy, a);
});

test("unknown selector", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  const reply = await command("current_tab", {}, "firefox-9");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "UNKNOWN_BROWSER");
  assert.ok(Array.isArray(reply.data.browsers));
  await closeAll(a);
});

test("heartbeat drops a dead connection only", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  const b = await fakeExtension("B", { hello: { instanceId: i2, browserType: "edge" } });
  await sleep(30);
  const aliasB = await aliasOf(i2);
  a.removeAllListeners("message"); // A stops answering ping
  await sleep(250);
  const s = await status();
  assert.deepEqual(
    s.browsers.map((e) => e.instanceId),
    [i2]
  );
  assert.equal(s.browsers[0].alias, aliasB);
  await closeAll(b);
});

test("call log attributes the serving browser", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const before = existsSync(CALL_LOG)
    ? readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  const b = await fakeExtension("B", { hello: { instanceId: i2, browserType: "edge" } });
  await sleep(30);
  const alias1 = await aliasOf(i1);
  const alias2 = await aliasOf(i2);
  await command("current_tab", {}, alias1);
  await command("current_tab", {}, alias2);
  const lines = readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const added = lines.slice(before);
  assert.deepEqual(
    added.map((e) => e.instanceId),
    [i1, i2]
  );
  assert.deepEqual(
    added.map((e) => e.browser),
    [alias1, alias2]
  );
  await closeAll(a, b);
});

// ---- fan-out ----

function listTabsReply(ws, tabs) {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (msg.action === "list_tabs")
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { tabs } }));
  });
}

test("fan-out merges and tags", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge" },
    hold: true,
  });
  await sleep(30);
  const alias1 = await aliasOf(i1);
  listTabsReply(a, [{ id: 1 }, { id: 2 }]);
  listTabsReply(b, [{ id: 3 }]);
  const reply = await command("list_tabs");
  assert.equal(reply.ok, true);
  assert.equal(reply.result.tabs.length, 3);
  assert.ok(reply.result.tabs.every((t) => typeof t.browser === "string"));
  assert.equal(reply.result.browsers[alias1].ok, true);
  await closeAll(a, b);
});

test("fan-out timeout", async () => {
  const i1 = freshId(),
    i2 = freshId(),
    i3 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge" },
    hold: true,
  });
  const c = await fakeExtension("C", {
    hello: { instanceId: i3, browserType: "opera" },
    hold: true,
  });
  await sleep(30);
  const aliasC = await aliasOf(i3);
  listTabsReply(a, [{ id: 1 }]);
  listTabsReply(b, [{ id: 2 }]);
  // c never answers list_tabs
  const started = Date.now();
  const reply = await command("list_tabs");
  assert.ok(Date.now() - started < 800);
  assert.equal(reply.result.tabs.length, 2);
  assert.equal(reply.result.browsers[aliasC].ok, false);
  assert.match(reply.result.browsers[aliasC].error, /timed out/);
  await closeAll(a, b, c);
});

test("fan-out with 100 connections", async () => {
  const fakes = [];
  const ids = [];
  for (let i = 0; i < 100; i++) {
    const id = freshId();
    ids.push(id);
    const f = await fakeExtension(`F${i}`, {
      hello: { instanceId: id, browserType: "chrome" },
      hold: true,
    });
    listTabsReply(f, [{ id: i }]);
    fakes.push(f);
  }
  await sleep(200);
  const started = Date.now();
  const reply = await command("list_tabs");
  assert.ok(Date.now() - started < 2000);
  assert.equal(reply.result.tabs.length, 100);
  assert.equal(Object.keys(reply.result.browsers).length, 100);
  await closeAll(...fakes);
});

test("explicit browser on list_tabs", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge" },
    hold: true,
  });
  await sleep(30);
  const alias2 = await aliasOf(i2);
  listTabsReply(a, [{ id: 1 }, { id: 2 }]);
  listTabsReply(b, [{ id: 3 }]);
  const reply = await command("list_tabs", {}, alias2);
  assert.equal(reply.result.tabs.length, 1);
  assert.equal(reply.result.tabs[0].browser, alias2);
  await closeAll(a, b);
});

test("no selector, one browser: list_tabs is served like any other command, not merged", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  await sleep(30);
  const alias = await aliasOf(i1);
  const inFlight = command("list_tabs");
  await sleep(30);
  assert.equal(a.received.length, 1);
  a.send(
    JSON.stringify({ id: a.received[0].id, ok: true, result: { tabs: [{ id: 1 }], pinned: 1 } })
  );
  const reply = await inFlight;
  assert.equal(reply.ok, true);
  assert.equal(reply.browser, alias);
  assert.equal(reply.result.pinned, 1, "the extension's own pinned field survives untouched");
  assert.equal(reply.result.tabs[0].browser, alias);
  await closeAll(a);
});

test("single-target list_tabs uses the normal per-command timeout, not the fan-out timeout", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  await sleep(30);
  const alias = await aliasOf(i1);
  const inFlight = command("list_tabs", {}, alias);
  // Outlast FANOUT_TIMEOUT_MS (300ms) while still comfortably under COMMAND_TIMEOUT_MS (3000ms).
  await sleep(500);
  assert.equal(a.received.length, 1, "the command must not have timed out yet");
  a.send(JSON.stringify({ id: a.received[0].id, ok: true, result: { tabs: [{ id: 1 }] } }));
  const reply = await inFlight;
  assert.equal(reply.ok, true);
  await closeAll(a);
});

test("a single-target list_tabs extension-side error answers 400, not a buried ok:true", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  await sleep(30);
  const alias = await aliasOf(i1);
  const inFlight = command("list_tabs", {}, alias);
  await sleep(30);
  a.send(JSON.stringify({ id: a.received[0].id, ok: false, code: "SOME_ERROR", error: "boom" }));
  const reply = await inFlight;
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "SOME_ERROR");
  assert.equal(reply.browser, alias);
  await closeAll(a);
});

test("a single-target list_tabs call is call-logged like any other command", async () => {
  const i1 = freshId();
  const before = existsSync(CALL_LOG)
    ? readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  await sleep(30);
  const alias = await aliasOf(i1);
  const inFlight = command("list_tabs", {}, alias);
  await sleep(30);
  a.send(JSON.stringify({ id: a.received[0].id, ok: true, result: { tabs: [] } }));
  await inFlight;
  const lines = readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const added = lines.slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].action, "list_tabs");
  assert.equal(added[0].instanceId, i1);
  assert.equal(added[0].browser, alias);
  assert.equal(added[0].ok, true);
  await closeAll(a);
});

test("a fan-out list_tabs call logs one call-log entry per browser reached", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const before = existsSync(CALL_LOG)
    ? readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  const a = await fakeExtension("A", {
    hello: { instanceId: i1, browserType: "chrome" },
    hold: true,
  });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge" },
    hold: true,
  });
  await sleep(30);
  const alias1 = await aliasOf(i1);
  const alias2 = await aliasOf(i2);
  listTabsReply(a, [{ id: 1 }]);
  listTabsReply(b, [{ id: 2 }]);
  await command("list_tabs");
  const lines = readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const added = lines.slice(before);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((e) => e.browser).sort(), [alias1, alias2].sort());
  assert.ok(added.every((e) => e.fanout === true));
  assert.equal(added[0].seq, added[1].seq, "both lines share the one HTTP request's seq");
  await closeAll(a, b);
});

// ---- final-review fixes ----

function post(body) {
  const params = body.params ? withTab(body.action, body.params) : body.params;
  return fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, params }),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
}

function callLogLines() {
  return existsSync(CALL_LOG)
    ? readFileSync(CALL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
}

// A holder that answers ping too late for a clone probe (so the probe finds it stale), soon
// enough for the heartbeat, and answers commands.
function slowHolder(name, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.closeInfo = new Promise((r) => ws.once("close", (code) => r({ code })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        setTimeout(() => ws.send(JSON.stringify({ type: "pong" })), CLONE_PROBE_MS + 20);
        return;
      }
      if (!msg.id) return;
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { by: name } }));
    });
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "hello", ...hello }));
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

async function waitNoBrowsers() {
  for (let i = 0; i < 100 && (await status()).browsers.length; i++) await sleep(20);
}

test("a connection that closes during its clone probe leaves no registry entry behind", async () => {
  const i1 = freshId();
  const holder = await slowHolder("holder", { instanceId: i1, browserType: "chrome" });
  await sleep(30);
  const alias = await aliasOf(i1);
  const newcomer = await fakeExtension("newcomer", {
    hello: { instanceId: i1, browserType: "chrome" },
  });
  newcomer.close();
  await newcomer.closeInfo;
  await sleep(CLONE_PROBE_MS + 100);
  const entries = (await status()).browsers.filter((b) => b.instanceId.startsWith(i1));
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(holder.readyState, WebSocket.OPEN, "the holder is not replaced by a closed socket");
  const reply = await command("current_tab", {}, alias);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.result.by, "holder");
  await closeAll(holder);
});

test("a hello from a socket already replaced registers nothing", async () => {
  const i1 = freshId();
  const old = await fakeExtension("old", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  // The old socket stops reading: it answers no ping and never sees the server's close frame,
  // so it stays open on its side while the bridge has already dropped it
  old._socket.pause();
  const fresh = await fakeExtension("fresh", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(CLONE_PROBE_MS + 100);
  old.send(JSON.stringify({ type: "hello", instanceId: i1, browserType: "chrome" }));
  old.send(JSON.stringify({ type: "hello", instanceId: freshId(), browserType: "edge" }));
  await sleep(CLONE_PROBE_MS + 100);
  const s = await status();
  const mine = s.browsers.filter((b) => b.instanceId.startsWith(i1));
  assert.deepEqual(
    mine.map((b) => b.instanceId),
    [i1]
  );
  assert.equal(s.browsers.length, 1, JSON.stringify(s.browsers));
  const reply = await command("current_tab", {}, mine[0].alias);
  assert.equal(reply.result.by, "fresh");
  old.terminate();
  await closeAll(fresh);
});

test("an internal command is logged with internal:true, and an agent command without it", async () => {
  const i1 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  await sleep(30);
  const before = callLogLines().length;
  await post({ action: "current_tab", client: { session: "s1", source: "mcp", internal: true } });
  await post({ action: "snapshot", client: { session: "s1", source: "mcp" } });
  const added = callLogLines().slice(before);
  assert.deepEqual(
    added.map((e) => [e.action, e.internal]),
    [
      ["current_tab", true],
      ["snapshot", undefined],
    ]
  );
  await closeAll(a);
});

test("list_tabs with fanOut:false and no browser, several connected, is NEEDS_BROWSER", async () => {
  const i1 = freshId(),
    i2 = freshId();
  const a = await fakeExtension("A", { hello: { instanceId: i1, browserType: "chrome" } });
  const b = await fakeExtension("B", {
    hello: { instanceId: i2, browserType: "edge", focused: true },
  });
  await sleep(30);
  const reply = await post({ action: "list_tabs", params: {}, fanOut: false });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "NEEDS_BROWSER");
  assert.equal(a.received.length, 0);
  assert.equal(b.received.length, 0);
  await closeAll(a, b);
});

test("list_tabs across every browser with none connected is NO_BROWSER", async () => {
  await waitNoBrowsers();
  const reply = await post({ action: "list_tabs", params: {}, browser: "*" });
  assert.equal(reply.status, 409);
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "NO_BROWSER");
});
