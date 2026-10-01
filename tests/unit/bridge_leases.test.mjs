// Session isolation in the bridge, against the real bridge/server.js: a session's target tab is
// leased to it, another session can read that tab but not act on it, the CLI keeps its own
// sticky target in the bridge, and no command leaves the bridge without a tab id.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "browserctl-leases-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.COMMAND_TIMEOUT_MS = "3000";
process.env.LEASE_TTL_MS = "300";
process.env.LEASE_BUSY_MS = "150";
const CALL_LOG = join(TEST_HOME, "calls.jsonl");
process.env.BROWSERCTL_CALL_LOG = CALL_LOG;

const { server, wss } = await import("../../bridge/server.js");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const WS_URL = `ws://127.0.0.1:${server.address().port}/extension`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(() => r()));
  await new Promise((r) => server.close(() => r()));
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let uid = 0;

// A stand-in extension with tabs 5 (the one the user sees) and 6, or the ids given. Every command
// is recorded; a tab command answers with the tab it was sent to.
const TITLES = { 5: "Five", 6: "Six" };
async function browser(type = "chrome", instanceId = `lease-${++uid}`, tabIds = [5, 6]) {
  const ws = new WebSocket(WS_URL);
  ws.received = [];
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (!msg.id) return;
    ws.received.push({ action: msg.action, params: msg.params });
    if (msg.action === "wait_for" && ws.hold) {
      ws.held = () => ws.send(JSON.stringify({ id: msg.id, ok: true, result: {} }));
      return;
    }
    const named = msg.params.id ?? msg.params.tabId;
    if (ws.badIds?.has(named)) {
      return ws.send(JSON.stringify({ id: msg.id, ok: false, error: `No tab with id: ${named}.` }));
    }
    if (ws.closedTabs?.has(msg.params.tabId)) {
      return ws.send(
        JSON.stringify({ id: msg.id, ok: false, error: `tab ${msg.params.tabId} not found` })
      );
    }
    let result;
    if (msg.action === "list_tabs") {
      result = {
        tabs: tabIds.map((id, i) => ({
          id,
          url: `https://t${id}/`,
          title: TITLES[id] || `Tab ${id}`,
          active: i === 0,
          ...(i === 0 ? { focusedWindow: true } : {}),
        })),
      };
    } else if (msg.action === "new_tab") {
      result = { id: 99, url: msg.params.url || "about:blank", title: "" };
    } else {
      result = { action: msg.action, tabId: msg.params.tabId ?? msg.params.id };
    }
    ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
  });
  ws.send(JSON.stringify({ type: "hello", instanceId, browserType: type, tabs: tabIds }));
  await sleep(30);
  return ws;
}

async function close(ws) {
  ws.close();
  await sleep(30);
}

async function post(body) {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

const mcp = (session, lease = true) => ({ session, source: "mcp", ...(lease ? { lease } : {}) });
const cli = (session = "cli") => ({ session, source: "cli", sticky: true });
const sentTo = (ws, action) => ws.received.filter((c) => c.action === action);

test("a tab another session leased: its claiming call is TAB_OWNED and never sent", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: A })).ok, true);
  const r = await post({ action: "click", params: { tabId: 5 }, client: B });
  assert.equal(r.status, 409);
  assert.equal(r.code, "TAB_OWNED");
  assert.match(r.error, new RegExp(A.session));
  assert.ok(r.recoveryHint);
  assert.equal(sentTo(b, "click").length, 1, "only A's click reached the browser");
  await close(b);
});

test("another session's tab can be read with an explicit tabId, but not acted on", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`, false);
  await post({ action: "snapshot", params: { tabId: 5 }, client: A });
  assert.equal((await post({ action: "snapshot", params: { tabId: 5 }, client: B })).ok, true);
  assert.equal((await post({ action: "get_text", params: { tabId: 5 }, client: B })).ok, true);
  for (const action of ["click", "navigate", "type", "eval_js", "close_tab", "some_new_action"]) {
    const params = action === "close_tab" ? { id: 5 } : { tabId: 5 };
    const r = await post({ action, params, client: B });
    assert.equal(r.code, "TAB_OWNED", `${action} into A's tab`);
  }
  assert.equal(sentTo(b, "click").length, 0);
  assert.equal(sentTo(b, "close_tab").length, 0);
  await close(b);
});

test("a caller that names no tab and keeps no target is NEEDS_TAB", async () => {
  const b = await browser();
  const r = await post({ action: "click", params: {}, client: mcp(`X${uid}`, false) });
  assert.equal(r.code, "NEEDS_TAB");
  assert.equal(b.received.length, 0);
  await close(b);
});

test("the CLI resolves the tab the user sees, keeps it, and reuses it without a lookup", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  const first = await post({ action: "click", params: {}, client: C });
  assert.equal(first.ok, true);
  assert.equal(first.result.tabId, 5);
  const second = await post({ action: "snapshot", params: {}, client: C });
  assert.equal(second.result.tabId, 5);
  assert.equal(sentTo(b, "list_tabs").length, 1, "one lookup, on the first call only");
  await close(b);
});

test("the CLI never lands in a tab an MCP session holds", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`);
  await post({ action: "switch_tab", params: { id: 5 }, client: A });
  const r = await post({
    action: "navigate",
    params: { url: "https://x/" },
    client: cli(`cli${uid}`),
  });
  assert.equal(r.code, "TAB_OWNED");
  assert.equal(sentTo(b, "navigate").length, 0);
  await close(b);
});

test("a CLI switch_tab moves the CLI target, and new_tab makes the new tab its target", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  await post({ action: "switch_tab", params: { id: 6 }, client: C });
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 6);
  await post({ action: "new_tab", params: { url: "https://n/" }, client: C });
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 99);
  const r = await post({ action: "click", params: { tabId: 99 }, client: mcp(`B${uid}`) });
  assert.equal(r.code, "TAB_OWNED", "the new tab is leased to the CLI session");
  await close(b);
});

test("with several browsers the CLI goes where its target is; before it has one, NEEDS_TARGET lists the tabs", async () => {
  const chrome = await browser("chrome");
  const edge = await browser("edge");
  const C = cli(`cli${uid}`);
  const r = await post({ action: "click", params: {}, client: C });
  assert.equal(r.code, "NEEDS_TARGET");
  assert.match(r.error, / tab 5 "Five"/);
  assert.equal(sentTo(chrome, "click").length + sentTo(edge, "click").length, 0);
  const status = await (await fetch(`${BASE}/status`)).json();
  const edgeAlias = status.browsers.find((x) => x.browserType === "edge").alias;
  await post({ action: "click", params: {}, client: C, browser: edgeAlias });
  const again = await post({ action: "click", params: {}, client: C });
  assert.equal(again.browser, edgeAlias);
  assert.equal(sentTo(chrome, "click").length, 0);
  await close(chrome);
  await close(edge);
});

test("list_tabs marks the tabs other sessions hold with heldBy, not the caller's own", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`);
  await post({ action: "switch_tab", params: { id: 5 }, client: A });
  const other = await post({ action: "list_tabs", params: {}, client: mcp(`B${uid}`, false) });
  const five = other.result.tabs.find((t) => t.id === 5);
  assert.equal(five.heldBy, `mcp:${A.session}`);
  assert.equal(other.result.tabs.find((t) => t.id === 6).heldBy, undefined);
  const own = await post({ action: "list_tabs", params: {}, client: mcp(A.session, false) });
  assert.equal(own.result.tabs.find((t) => t.id === 5).heldBy, undefined);
  await close(b);
});

test("a heartbeat keeps a quiet session's lease; without one it lapses", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    Q = mcp(`Q${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await post({ action: "click", params: { tabId: 6 }, client: Q });
  for (let i = 0; i < 4; i++) {
    await sleep(120);
    await fetch(`${BASE}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: A }),
    });
  }
  assert.equal(
    (await post({ action: "click", params: { tabId: 5 }, client: B })).code,
    "TAB_OWNED"
  );
  assert.equal((await post({ action: "click", params: { tabId: 6 }, client: B })).ok, true);
  await close(b);
});

test("release frees the session's tab at once, and closing its own tab frees it", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await fetch(`${BASE}/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: A }),
  });
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: B })).ok, true);
  await post({ action: "close_tab", params: { id: 5 }, client: B });
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: A })).ok, true);
  await close(b);
});

test("a refused call is call-logged with the lease outcome and the holder", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  const since = existsSync(CALL_LOG) ? statSync(CALL_LOG).size : 0;
  await post({ action: "click", params: { tabId: 5 }, client: B });
  const lines = readFileSync(CALL_LOG)
    .subarray(since)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const refused = lines.find((l) => l.session === B.session);
  assert.equal(refused.ok, false);
  assert.equal(refused.lease, "refused");
  assert.equal(refused.holder, `mcp:${A.session}`);
  await close(b);
});

test("a CLI target the user closed by hand is dropped: the next command looks up a tab again", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 5);
  b.closedTabs = new Set([5]);
  const gone = await post({ action: "click", params: {}, client: C });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /tab 5 not found/);
  b.closedTabs = new Set();
  await post({ action: "switch_tab", params: { id: 6 }, client: mcp(`A${uid}`) });
  const lookups = sentTo(b, "list_tabs").length;
  const again = await post({ action: "click", params: {}, client: C });
  assert.equal(sentTo(b, "list_tabs").length, lookups + 1, "the dead target was not reused");
  assert.equal(again.result.tabId, 5);
  await close(b);
});

test("a CLI hold never lapses: a quiet CLI keeps its tab past the lease ttl", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  await post({ action: "click", params: {}, client: C });
  await sleep(450);
  const r = await post({ action: "click", params: { tabId: 5 }, client: mcp(`B${uid}`) });
  assert.equal(r.code, "TAB_OWNED");
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 5);
  await close(b);
});

test("a tab given as tabId to switch_tab or close_tab is the tab they act on (CLI -t)", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  await post({ action: "click", params: {}, client: C });
  await post({ action: "switch_tab", params: { tabId: 6 }, client: C });
  assert.equal(sentTo(b, "switch_tab")[0].params.id, 6);
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 6);
  await post({ action: "close_tab", params: { tabId: 5 }, client: C });
  assert.equal(sentTo(b, "close_tab")[0].params.id, 5);
  await close(b);
});

test("reads that change another session's tab are refused: a clearing read, a debugger attach", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`, false);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  const read = await post({ action: "get_console_logs", params: { tabId: 5 }, client: B });
  assert.equal(read.ok, true);
  const clear = await post({
    action: "get_console_logs",
    params: { tabId: 5, clear: true },
    client: B,
  });
  assert.equal(clear.code, "TAB_OWNED");
  for (const action of ["a11y_snapshot", "capture_screenshot", "element_screenshot", "audit"]) {
    const r = await post({ action, params: { tabId: 5 }, client: B });
    assert.equal(r.code, "TAB_OWNED", action);
  }
  await close(b);
});

test("a failed move leaves the session's target and hold where they were", async () => {
  const b = await browser();
  b.badIds = new Set([77]);
  const C = cli(`cli${uid}`);
  await post({ action: "click", params: {}, client: C });
  const bad = await post({ action: "switch_tab", params: { id: 77 }, client: C });
  assert.equal(bad.ok, false);
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 5);
  const B = mcp(`B${uid}`);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: B })).code, "TAB_OWNED");
  await close(b);
});

test("a tab the user closes by hand frees its hold", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  b.send(JSON.stringify({ type: "tab_closed", tabId: 5 }));
  await sleep(30);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: B })).ok, true);
  await close(b);
});

test("a reconnect that still has the tabs (a service-worker restart) keeps holds and CLI targets", async () => {
  const instanceId = `lease-${++uid}`;
  const b = await browser("chrome", instanceId, [5, 6]);
  const A = mcp(`A${uid}`),
    C = cli(`cli${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await post({ action: "switch_tab", params: { id: 6 }, client: C });
  await close(b);
  const again = await browser("chrome", instanceId, [5, 6]);
  const r = await post({ action: "click", params: { tabId: 5 }, client: mcp(`B${uid}`) });
  assert.equal(r.code, "TAB_OWNED", "A still holds its tab");
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 6);
  await close(again);
});

test("a reconnect whose tabs are gone (a browser restart) drops their holds and CLI targets", async () => {
  const instanceId = `lease-${++uid}`;
  const b = await browser("chrome", instanceId, [5, 6]);
  const A = mcp(`A${uid}`),
    C = cli(`cli${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await post({ action: "switch_tab", params: { id: 6 }, client: C });
  await close(b);
  const again = await browser("chrome", instanceId, [7]);
  const r = await post({ action: "click", params: { tabId: 5 }, client: mcp(`B${uid}`) });
  assert.notEqual(r.code, "TAB_OWNED", "the old hold is gone");
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 7);
  await close(again);
});

test("reload_extension waits only while another session is acting in that browser", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`, false);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  const r = await post({ action: "reload_extension", params: {}, client: B });
  assert.equal(r.code, "BROWSER_BUSY");
  assert.match(r.recoveryHint, /again in \d+s/);
  assert.equal(sentTo(b, "reload_extension").length, 0);
  await sleep(200);
  assert.equal((await post({ action: "reload_extension", params: {}, client: B })).ok, true);
  await close(b);
});

test("a tab opened with new is held with the opener's pid", async () => {
  const b = await browser();
  const dead = { ...mcp(`A${uid}`), pid: 2 ** 22 + 54321 };
  await post({ action: "new_tab", params: { url: "https://n/" }, client: dead });
  const r = await post({ action: "click", params: { tabId: 99 }, client: mcp(`B${uid}`) });
  assert.equal(r.ok, true, "the opener's process is gone, so the tab is free");
  await close(b);
});

// ---- taking a tab another session holds

const take = (client, id, force) =>
  post({ action: "switch_tab", params: { id, ...(force ? { force: true } : {}) }, client });

test("taking a busy tab is TAB_BUSY, even with force, and says how long to wait", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  const r = await take(B, 5, true);
  assert.equal(r.code, "TAB_BUSY");
  assert.ok(r.diagnostics.retryInMs > 0 && r.diagnostics.retryInMs <= 150);
  assert.equal(sentTo(b, "switch_tab").length, 0);
  await close(b);
});

test("a command in flight keeps the tab busy however long it runs", async () => {
  const b = await browser();
  b.hold = true;
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  const slow = post({ action: "wait_for", params: { tabId: 5 }, client: A });
  await sleep(300);
  assert.equal((await take(B, 5, true)).code, "TAB_BUSY");
  b.held();
  await slow;
  await close(b);
});

test("taking an idle tab asks to confirm; force takes it, and the holder is told once", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await sleep(200);
  const ask = await take(B, 5);
  assert.equal(ask.code, "TAKE_CONFIRM");
  assert.match(ask.error, new RegExp(A.session));
  assert.match(ask.recoveryHint, /force: true/);
  assert.equal(sentTo(b, "switch_tab").length, 0);
  const took = await take(B, 5, true);
  assert.equal(took.ok, true);
  assert.equal(took.result.took.from, `mcp:${A.session}`);
  assert.match(took.result.warning, /took tab 5/);
  assert.equal(sentTo(b, "switch_tab")[0].params.force, undefined, "force stays in the bridge");
  const told = await post({ action: "click", params: { tabId: 5 }, client: A });
  assert.equal(told.code, "TARGET_TAKEN");
  assert.match(told.error, new RegExp(B.session));
  const after = await post({ action: "click", params: { tabId: 5 }, client: A });
  assert.equal(after.code, "TAB_OWNED", "the notice is given once");
  await close(b);
});

test("a yielded tab is taken without confirmation; the holder is still told", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  assert.equal((await post({ action: "yield_tab", params: {}, client: A })).result.yielding, true);
  await sleep(200);
  const took = await take(B, 5);
  assert.equal(took.ok, true);
  assert.equal(took.result.took.forced, false);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: A })).code, "TARGET_TAKEN");
  await close(b);
});

test("release_tab frees the session's tab for anyone, with no confirmation", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    B = mcp(`B${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  assert.equal((await post({ action: "release_tab", params: {}, client: A })).ok, true);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: B })).ok, true);
  await close(b);
});

test("a holder whose process has exited frees its tab at once", async () => {
  const b = await browser();
  const dead = { ...mcp(`A${uid}`), pid: 2 ** 22 + 12345 };
  const alive = { ...mcp(`L${uid}`), pid: process.pid };
  await post({ action: "click", params: { tabId: 5 }, client: dead });
  await post({ action: "click", params: { tabId: 6 }, client: alive });
  const B = mcp(`B${uid}`);
  assert.equal((await post({ action: "click", params: { tabId: 5 }, client: B })).ok, true);
  assert.equal((await post({ action: "click", params: { tabId: 6 }, client: B })).code, "TAB_OWNED");
  await close(b);
});

test("the CLI takes with force too, and its target moves to the taken tab", async () => {
  const b = await browser();
  const A = mcp(`A${uid}`),
    C = cli(`cli${uid}`);
  await post({ action: "click", params: { tabId: 5 }, client: A });
  await sleep(200);
  assert.equal((await take(C, 5)).code, "TAKE_CONFIRM");
  assert.equal((await take(C, 5, true)).ok, true);
  assert.equal((await post({ action: "click", params: {}, client: C })).result.tabId, 5);
  await close(b);
});

test("the call log records the tab a command actually went to, including one the bridge chose", async () => {
  const b = await browser();
  const C = cli(`cli${uid}`);
  const since = existsSync(CALL_LOG) ? statSync(CALL_LOG).size : 0;
  await post({ action: "click", params: {}, client: C });
  const line = readFileSync(CALL_LOG)
    .subarray(since)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((l) => l.session === C.session && l.action === "click");
  assert.equal(line.tabId, 5);
  const since2 = statSync(CALL_LOG).size;
  await post({ action: "new_tab", params: { url: "https://n/" }, client: C });
  const opened = readFileSync(CALL_LOG)
    .subarray(since2)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((l) => l.session === C.session && l.action === "new_tab");
  assert.equal(opened.tabId, 99, "the new tab's id is logged");
  await close(b);
});

// ---- a tab named by id alone

test("a tab named by id and no browser reaches the one browser that has it; the next uses what was learned", async () => {
  const chrome = await browser("chrome", `lease-${++uid}`, [5, 6]);
  const edge = await browser("edge", `lease-${++uid}`, [15, 16]);
  const B = mcp(`B${uid}`, false);
  const r = await post({ action: "snapshot", params: { tabId: 15 }, client: B });
  assert.equal(r.ok, true, r.error);
  assert.equal(sentTo(edge, "snapshot")[0].params.tabId, 15);
  const lookups = sentTo(chrome, "list_tabs").length + sentTo(edge, "list_tabs").length;
  assert.equal((await post({ action: "snapshot", params: { tabId: 16 }, client: B })).ok, true);
  assert.equal(
    sentTo(chrome, "list_tabs").length + sentTo(edge, "list_tabs").length,
    lookups,
    "the owner was already known"
  );
  assert.equal(sentTo(chrome, "snapshot").length, 0);
  await close(chrome);
  await close(edge);
});

test("an id open in two browsers is AMBIGUOUS_TAB naming both; one open nowhere is TAB_NOT_FOUND", async () => {
  const chrome = await browser("chrome", `lease-${++uid}`, [5]);
  const edge = await browser("edge", `lease-${++uid}`, [5]);
  const B = mcp(`B${uid}`, false);
  const two = await post({ action: "click", params: { tabId: 5 }, client: B });
  assert.equal(two.code, "AMBIGUOUS_TAB");
  const status = await (await fetch(`${BASE}/status`)).json();
  for (const b of status.browsers) assert.match(two.error, new RegExp(b.alias));
  const none = await post({ action: "click", params: { tabId: 99 }, client: B });
  assert.equal(none.code, "TAB_NOT_FOUND");
  assert.equal(sentTo(chrome, "click").length + sentTo(edge, "click").length, 0);
  await close(chrome);
  await close(edge);
});

test("a closed tab is forgotten, and the CLI's -t reaches a browser other than its target's", async () => {
  const chrome = await browser("chrome", `lease-${++uid}`, [5, 6]);
  const edge = await browser("edge", `lease-${++uid}`, [15, 16]);
  const status = await (await fetch(`${BASE}/status`)).json();
  const chromeAlias = status.browsers.find((x) => x.browserType === "chrome").alias;
  const C = cli(`cli${uid}`);
  await post({ action: "click", params: {}, client: C, browser: chromeAlias });
  const r = await post({ action: "click", params: { tabId: 15 }, client: C });
  assert.equal(r.ok, true, r.error);
  assert.equal(sentTo(edge, "click")[0].params.tabId, 15);
  edge.send(JSON.stringify({ type: "tab_closed", tabId: 15 }));
  await sleep(30);
  const before = sentTo(edge, "list_tabs").length;
  await post({ action: "click", params: { tabId: 15 }, client: C });
  assert.equal(sentTo(edge, "list_tabs").length, before + 1, "looked up again");
  assert.equal((await post({ action: "click", params: {}, client: C })).browser, chromeAlias);
  await close(chrome);
  await close(edge);
});
