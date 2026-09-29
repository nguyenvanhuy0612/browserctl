// One use case of the MCP session target, end to end: a real bridge (bridge/server.js on an
// ephemeral port), fake extensions that serve commands from an in-memory tab table, and one or
// two real MCP server processes (mcp/index.js over stdio) driven the way an agent calls them.
// Usage: node browsers-mcp.mjs <case>. Prints OK <case> on success; a failed assertion exits
// non-zero. HOME/USERPROFILE must already point at a temp directory (the parent sets them).
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { WebSocket } from "ws";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASE = process.argv[2];
const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = join(HERE, "..", "..", "..", "mcp", "index.js");
const FANOUT_TIMEOUT_MS = 500;

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.FANOUT_TIMEOUT_MS = String(FANOUT_TIMEOUT_MS);
process.env.COMMAND_TIMEOUT_MS = "5000";
// The call log goes to the temp HOME the parent made for this case
const CALL_LOG = join(process.env.HOME, "calls.jsonl");
process.env.BROWSERCTL_CALL_LOG = CALL_LOG;

const { server: bridge } = await import("../../../bridge/server.js");
if (!bridge.listening) await new Promise((r) => bridge.once("listening", r));
const BASE = `http://127.0.0.1:${bridge.address().port}`;
const WS_URL = `ws://127.0.0.1:${bridge.address().port}/extension`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callLogSize = () => (existsSync(CALL_LOG) ? statSync(CALL_LOG).size : 0);

// The call-log entries the bridge wrote after byte offset `since`
function callLogSince(since) {
  if (!existsSync(CALL_LOG)) return [];
  return readFileSync(CALL_LOG)
    .subarray(since)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function status() {
  return (await fetch(`${BASE}/status`)).json();
}

async function waitFor(pred, what) {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- fake extension

let nextInstance = 0;
let nextTabId = 5000;
const tab = (id, url, title, extra = {}) => ({ id, url, title, active: false, ...extra });

// A stand-in extension. Its tab table is the truth it answers from; `received` records every
// command it was sent, and `pins` every change of its pinned tab with the action that made it.
function fake({ type = "chrome", label, focused = false, tabs = [], legacy = false, hangList }) {
  const f = {
    instanceId: `inst-${++nextInstance}`,
    type,
    tabs: new Map(),
    pin: null,
    received: [],
    pins: [],
    ws: null,
    // With holdList set, list_tabs replies wait in `held` until release()
    holdList: false,
    held: [],
  };
  for (const t of tabs) f.tabs.set(t.id, { ...t });
  if (![...f.tabs.values()].some((t) => t.active) && f.tabs.size) {
    [...f.tabs.values()][0].active = true;
  }
  const setPin = (id, action) => {
    if (f.pin !== id) f.pins.push({ id, action });
    f.pin = id;
  };
  const view = (t) => ({ id: t.id, url: t.url, title: t.title, active: t.active });
  const resolveTab = (params, action) => {
    if (params.tabId != null) {
      const t = f.tabs.get(params.tabId);
      if (!t) throw new Error(`tab ${params.tabId} not found`);
      return t;
    }
    if (f.pin != null && f.tabs.has(f.pin)) return f.tabs.get(f.pin);
    const active = [...f.tabs.values()].find((t) => t.active);
    if (!active) throw new Error("no tab");
    setPin(active.id, action);
    return active;
  };
  const answer = (action, params) => {
    switch (action) {
      case "list_tabs":
        return {
          tabs: [...f.tabs.values()].map((t) => ({
            ...view(t),
            windowId: 1,
            focusedWindow: t.active,
          })),
          pinned: f.pin,
        };
      case "current_tab": {
        const t = resolveTab(params, action);
        return { ...view(t), pinned: true };
      }
      case "new_tab": {
        const t = tab(++nextTabId, params.url || "about:blank", "");
        f.tabs.set(t.id, t);
        if (params.activate) {
          for (const o of f.tabs.values()) o.active = false;
          t.active = true;
        }
        setPin(t.id, action);
        return { id: t.id, url: t.url, title: "", ready: true };
      }
      case "switch_tab": {
        const t = f.tabs.get(params.id);
        if (!t) throw new Error(`No tab with id: ${params.id}.`);
        if (params.activate) {
          for (const o of f.tabs.values()) o.active = false;
          t.active = true;
        }
        setPin(t.id, action);
        return { id: t.id, url: t.url, title: t.title };
      }
      // Like the extension: the tab named in `id`, else the extension's own pin. A tabId in the
      // params is ignored, exactly as groupTab/ungroupTab ignore it.
      case "group_tab": {
        const t = params.id != null ? f.tabs.get(params.id) : resolveTab({}, action);
        if (!t) throw new Error(`No tab with id: ${params.id}.`);
        setPin(t.id, action);
        return { groupId: 1, tabId: t.id, title: params.title || "bctl", color: "blue" };
      }
      case "ungroup_tab": {
        const t = params.id != null ? f.tabs.get(params.id) : resolveTab({}, action);
        if (!t) throw new Error(`No tab with id: ${params.id}.`);
        return { ungrouped: t.id };
      }
      case "close_tab":
        f.tabs.delete(params.id);
        if (f.pin === params.id) f.pin = null;
        return { id: params.id, alreadyClosed: false };
      default: {
        const t = resolveTab(params, action);
        return { by: f.alias, action, tabId: t.id };
      }
    }
  };
  f.connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      f.ws = ws;
      ws.closed = new Promise((r) => ws.once("close", r));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
        if (msg.type === "welcome") return;
        if (!msg.id) return;
        f.received.push({ action: msg.action, params: msg.params || {} });
        if (msg.action === "list_tabs" && hangList) return;
        let reply;
        try {
          reply = { id: msg.id, ok: true, result: answer(msg.action, msg.params || {}) };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message };
        }
        if (msg.action === "list_tabs" && f.holdList) {
          f.held.push(() => ws.send(JSON.stringify(reply)));
          return;
        }
        ws.send(JSON.stringify(reply));
      });
      ws.once("open", () => {
        if (!legacy) {
          const hello = { type: "hello", instanceId: f.instanceId, browserType: type, focused };
          if (label) hello.label = label;
          ws.send(JSON.stringify(hello));
        }
        resolve();
      });
      ws.once("error", reject);
    });
  f.release = () => {
    for (const send of f.held.splice(0)) send();
  };
  f.focus = () => f.ws.send(JSON.stringify({ type: "focus", focused: true }));
  f.close = async () => {
    f.ws.close();
    await f.ws.closed;
    await waitFor(
      async () => !(await status()).browsers.some((b) => b.alias === f.alias),
      `${f.alias} to leave`
    );
  };
  f.served = (action) => f.received.filter((c) => c.action === action);
  return f;
}

// Connects fakes one at a time, so aliases follow the order given (chrome-1 before chrome-2).
async function browsers(...specs) {
  const out = [];
  for (const spec of specs) {
    const f = fake(spec);
    const before = (await status()).browsers.length;
    await f.connect();
    await waitFor(
      async () => (await status()).browsers.length === before + 1,
      `browser ${out.length + 1} to register`
    );
    const s = await status();
    const entry = spec.legacy
      ? s.browsers.find((b) => b.legacy && !out.some((o) => o.alias === b.alias))
      : s.browsers.find((b) => b.instanceId === f.instanceId);
    f.alias = entry.alias;
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- MCP sessions

const sessions = [];

async function session() {
  const env = { ...process.env };
  for (const k of [
    "PORT",
    "HOST",
    "FANOUT_TIMEOUT_MS",
    "COMMAND_TIMEOUT_MS",
    "BROWSERCTL_CALL_LOG",
  ])
    delete env[k];
  env.BROWSERCTL_BRIDGE_URL = BASE;
  env.BROWSERCTL_AUTO_START = "manual";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "browsers-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  sessions.push(client);
  return {
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.[0]?.text ?? "";
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { isError: res.isError === true, text, json };
    },
  };
}

function ok(res, what) {
  assert.equal(res.isError, false, `${what} failed: ${res.text}`);
  return res.json;
}

function failed(res, code, what) {
  assert.equal(res.isError, true, `${what} should have failed: ${res.text}`);
  if (code) assert.match(res.text, new RegExp(`\\[${code}\\]`), `${what}: ${res.text}`);
  return res.text;
}

const actionsOf = (f) => f.received.map((c) => c.action);
const PAGE_ACTIONS = new Set(["snapshot", "click", "fill", "get_page_content"]);
const pageCalls = (f) => f.received.filter((c) => PAGE_ACTIONS.has(c.action));

async function targetOf(s) {
  return ok(await s.call("browser_status", {}), "browser_status").target;
}

// ---------------------------------------------------------------- the cases

const CASES = {
  async "uc-edge"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(11, "https://mail.google.com/", "Gmail")] },
      { type: "edge", tabs: [tab(21, "https://sac.example/", "SAC")] }
    );
    const A = await session();
    const sel = ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    assert.deepEqual(sel.target, {
      browser: "edge-1",
      tabId: 21,
      url: "https://sac.example/",
      title: "SAC",
    });
    const snap = ok(await A.call("browser_snapshot", {}), "snapshot");
    const click = ok(await A.call("browser_click", { target: "abc" }), "click");
    assert.equal(snap.by, "edge-1");
    assert.equal(snap.browser, "edge-1");
    assert.equal(click.by, "edge-1");
    assert.deepEqual(
      pageCalls(edge).map((c) => [c.action, c.params.tabId]),
      [
        ["snapshot", 21],
        ["click", 21],
      ]
    );
    assert.deepEqual(pageCalls(chrome), []);
    assert.equal(edge.served("switch_tab").length, 1);
    assert.notEqual(edge.served("switch_tab")[0].params.activate, true);
    assert.equal(edge.tabs.get(21).active, true, "the only tab stays as it was");
  },

  async "uc-fb-one-profile"() {
    const [c1, c2] = await browsers(
      { type: "chrome", tabs: [tab(11, "https://mail.google.com/", "Gmail")] },
      {
        type: "chrome",
        tabs: [
          tab(31, "https://www.facebook.com/", "Facebook"),
          tab(32, "https://news.example/", "News"),
        ],
      }
    );
    const A = await session();
    const list = ok(await A.call("browser_tabs", { action: "list", query: "facebook" }), "list");
    assert.equal(list.tabs.length, 1);
    assert.equal(list.tabs[0].browser, "chrome-2");
    assert.deepEqual(Object.keys(list.browsers).sort(), ["chrome-1", "chrome-2"]);
    ok(await A.call("browser_tabs", { action: "select", tabId: list.tabs[0].id }), "select");
    ok(await A.call("browser_snapshot", {}), "snapshot");
    ok(await A.call("browser_click", { target: "Like" }), "click");
    assert.deepEqual(
      pageCalls(c2).map((c) => [c.action, c.params.tabId]),
      [
        ["snapshot", 31],
        ["click", 31],
      ]
    );
    assert.deepEqual(
      c2.served("switch_tab").map((c) => c.params.id),
      [31]
    );
    assert.deepEqual(pageCalls(c1), []);
    assert.deepEqual(c1.served("switch_tab"), []);
  },

  async "uc-fb-two-profiles"() {
    const fakes = await browsers(
      { type: "chrome", tabs: [tab(41, "https://www.facebook.com/", "Facebook")] },
      { type: "chrome", tabs: [tab(42, "https://www.facebook.com/groups", "Facebook Groups")] }
    );
    const A = await session();
    const list = ok(await A.call("browser_tabs", { action: "list", query: "FACEBOOK" }), "list");
    assert.equal(list.tabs.length, 2);
    assert.deepEqual(list.tabs.map((t) => t.browser).sort(), ["chrome-1", "chrome-2"]);
    for (const f of fakes) assert.deepEqual(actionsOf(f), ["list_tabs"]);
  },

  async "uc-no-browser-single"() {
    const [chrome] = await browsers({
      type: "chrome",
      tabs: [tab(51, "https://a.example/", "A", { active: true }), tab(52, "https://b/", "B")],
    });
    const A = await session();
    const snapRes = await A.call("browser_snapshot", {});
    const clickRes = await A.call("browser_click", { target: "abc" });
    const snap = ok(snapRes, "snapshot");
    ok(clickRes, "click");
    // Baseline: what the single browser itself answers for the same command on the same tab.
    const expected = { by: "chrome-1", action: "click", tabId: 51 };
    assert.equal(clickRes.text, JSON.stringify(expected), "click result is byte-identical");
    const { target, ...rest } = snap;
    assert.equal(JSON.stringify(rest), JSON.stringify({ ...expected, action: "snapshot" }));
    assert.deepEqual(target, {
      browser: "chrome-1",
      tabId: 51,
      url: "https://a.example/",
      title: "A",
    });
    assert.equal("browser" in snap, false, "one browser: no browser tag");
    assert.deepEqual(
      chrome.received.map((c) => [c.action, c.params.tabId ?? null]),
      [
        ["list_tabs", null],
        ["snapshot", 51],
        ["click", 51],
      ]
    );
  },

  async "uc-no-browser-focus"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(61, "https://c/", "C")] },
      { type: "edge", tabs: [tab(62, "https://e/", "E")] }
    );
    edge.focus();
    await sleep(50);
    const A = await session();
    const snap = ok(await A.call("browser_snapshot", {}), "snapshot");
    ok(await A.call("browser_click", { target: "x" }), "click");
    assert.equal(snap.target.browser, "edge-1");
    assert.equal(snap.target.tabId, 62);
    assert.deepEqual(
      pageCalls(edge).map((c) => [c.action, c.params.tabId]),
      [
        ["snapshot", 62],
        ["click", 62],
      ]
    );
    assert.deepEqual(chrome.received, []);
  },

  async "uc-no-browser-no-focus"() {
    const fakes = await browsers(
      { type: "chrome", tabs: [tab(71, "https://c/", "C")] },
      { type: "edge", tabs: [tab(72, "https://e/", "E")] }
    );
    const A = await session();
    const text = failed(await A.call("browser_snapshot", {}), "NEEDS_BROWSER", "snapshot");
    assert.match(text, /chrome-1/);
    assert.match(text, /edge-1/);
    for (const f of fakes) assert.deepEqual(f.received, []);
    assert.equal(await targetOf(A), null);
  },

  async "uc-sticky-target"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(81, "https://c/", "C")] },
      { type: "edge", tabs: [tab(82, "https://e/", "E")] }
    );
    const A = await session();
    const snap = ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.equal(snap.target.browser, "chrome-1");
    edge.focus();
    await sleep(50);
    ok(await A.call("browser_click", { target: "x" }), "click");
    assert.deepEqual(
      chrome.served("click").map((c) => c.params.tabId),
      [81]
    );
    assert.deepEqual(edge.received, []);
  },

  async "uc-ambiguous-type"() {
    const fakes = await browsers(
      { type: "edge", label: "Work", tabs: [tab(91, "https://w/", "W")] },
      { type: "edge", label: "Test", tabs: [tab(92, "https://t/", "T")] }
    );
    const A = await session();
    const text = failed(
      await A.call("browser_tabs", { action: "select", browser: "edge" }),
      "AMBIGUOUS_BROWSER",
      "select"
    );
    assert.match(text, /Work/);
    assert.match(text, /Test/);
    assert.equal(await targetOf(A), null);
    for (const f of fakes) assert.deepEqual(f.received, []);
  },

  async "uc-new-tab-in-edge"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(101, "https://c/", "C")] },
      { type: "edge", tabs: [tab(102, "https://e/", "E")] }
    );
    const A = await session();
    const created = ok(
      await A.call("browser_tabs", { action: "new", url: "https://new.example/", browser: "edge" }),
      "new"
    );
    const newId = created.id;
    assert.deepEqual(created.target, {
      browser: "edge-1",
      tabId: newId,
      url: "https://new.example/",
      title: "",
    });
    assert.equal(edge.served("new_tab").length, 1);
    assert.notEqual(edge.served("new_tab")[0].params.activate, true);
    assert.equal(edge.tabs.get(newId).active, false);
    ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [newId]
    );
    assert.deepEqual(chrome.received, []);
  },

  async "uc-two-sessions-two-browsers"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(111, "https://c1/", "c1")] },
      { type: "edge", tabs: [tab(112, "https://e1/", "e1")] }
    );
    const [A, B] = await Promise.all([session(), session()]);
    ok(await A.call("browser_tabs", { action: "select", browser: "chrome" }), "A select");
    ok(await B.call("browser_tabs", { action: "select", browser: "edge" }), "B select");
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(A.call("browser_snapshot", {}).then((r) => ["A", ok(r, "A snapshot")]));
      jobs.push(B.call("browser_snapshot", {}).then((r) => ["B", ok(r, "B snapshot")]));
    }
    for (const [who, res] of await Promise.all(jobs)) {
      assert.equal(res.by, who === "A" ? "chrome-1" : "edge-1", `${who} crossed over`);
    }
    assert.deepEqual(
      chrome.served("snapshot").map((c) => c.params.tabId),
      Array(20).fill(111)
    );
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      Array(20).fill(112)
    );
  },

  async "uc-two-sessions-one-browser"() {
    const [edge] = await browsers({
      type: "edge",
      tabs: [tab(121, "https://t1/", "t1", { active: true }), tab(122, "https://t2/", "t2")],
    });
    const [A, B] = await Promise.all([session(), session()]);
    ok(await A.call("browser_tabs", { action: "select", tabId: 121 }), "A select");
    ok(await B.call("browser_tabs", { action: "select", tabId: 122 }), "B select");
    const pinsBefore = edge.pins.length;
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(A.call("browser_snapshot", {}).then((r) => ["A", ok(r, "A snapshot")]));
      jobs.push(B.call("browser_snapshot", {}).then((r) => ["B", ok(r, "B snapshot")]));
    }
    for (const [who, res] of await Promise.all(jobs)) {
      assert.equal(res.tabId, who === "A" ? 121 : 122, `${who} crossed over`);
    }
    const sent = edge.served("snapshot").map((c) => c.params.tabId);
    assert.equal(sent.filter((id) => id === 121).length, 20);
    assert.equal(sent.filter((id) => id === 122).length, 20);
    assert.ok(edge.served("switch_tab").every((c) => c.params.activate !== true));
    assert.equal(edge.pins.length, pinsBefore, "no snapshot moved the extension's pin");
    assert.equal(edge.tabs.get(121).active, true);
  },

  async "uc-other-session-switch"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(131, "https://c/", "C")] },
      { type: "edge", tabs: [tab(132, "https://e/", "E")] }
    );
    const [A, B] = await Promise.all([session(), session()]);
    ok(await A.call("browser_snapshot", {}), "A snapshot");
    ok(await B.call("browser_tabs", { action: "select", browser: "edge" }), "B select");
    ok(await A.call("browser_click", { target: "x" }), "A click");
    assert.deepEqual(
      chrome.served("click").map((c) => c.params.tabId),
      [131]
    );
    assert.deepEqual(edge.served("click"), []);
  },

  async "uc-per-call-tab"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(141, "https://mail.google.com/", "Gmail")] },
      { type: "edge", tabs: [tab(142, "https://portal.example/", "Portal")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 142 }), "select");
    const mail = ok(await A.call("browser_get_content", { tabId: 141 }), "get_content");
    assert.equal(mail.by, "chrome-1");
    ok(await A.call("browser_type", { target: "otp", text: "123456" }), "type");
    assert.deepEqual(
      chrome.served("get_page_content").map((c) => c.params.tabId),
      [141]
    );
    assert.deepEqual(
      edge.served("fill").map((c) => c.params.tabId),
      [142]
    );
    assert.deepEqual(pageCalls(chrome).length, 1);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 142 });
  },

  async "uc-subagent-tabid"() {
    const [chrome] = await browsers({
      type: "chrome",
      tabs: [tab(151, "https://a/", "a", { active: true }), tab(152, "https://b/", "b")],
    });
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 151 }), "select");
    for (let i = 0; i < 3; i++) ok(await A.call("browser_snapshot", { tabId: 152 }), "snapshot b");
    ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.deepEqual(
      chrome.served("snapshot").map((c) => c.params.tabId),
      [152, 152, 152, 151]
    );
    assert.deepEqual(await targetOf(A), { browser: "chrome-1", tabId: 151 });
  },

  async "uc-unknown-tabid-lookup"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(161, "https://c/", "C")] },
      { type: "edge", tabs: [tab(42, "https://e/", "E")] }
    );
    const A = await session();
    const snap = ok(await A.call("browser_snapshot", { tabId: 42 }), "snapshot");
    assert.equal(snap.by, "edge-1");
    assert.deepEqual(actionsOf(chrome), ["list_tabs"]);
    assert.deepEqual(actionsOf(edge), ["list_tabs", "snapshot"]);
    assert.equal(edge.served("snapshot")[0].params.tabId, 42);
    assert.equal(await targetOf(A), null, "a per-call tabId never sets the target");
  },

  async "uc-tab-id-collision"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(7, "https://c/", "C")] },
      { type: "edge", tabs: [tab(7, "https://e/", "E")] }
    );
    const A = await session();
    const text = failed(
      await A.call("browser_tabs", { action: "select", tabId: 7 }),
      "AMBIGUOUS_TAB",
      "select"
    );
    assert.match(text, /chrome-1/);
    assert.match(text, /edge-1/);
    assert.equal(await targetOf(A), null);
    const sel = ok(
      await A.call("browser_tabs", { action: "select", tabId: 7, browser: "edge-1" }),
      "exact select"
    );
    assert.equal(sel.target.browser, "edge-1");
    assert.deepEqual(
      edge.served("switch_tab").map((c) => c.params.id),
      [7]
    );
    assert.deepEqual(chrome.served("switch_tab"), []);
  },

  async "uc-target-closed"() {
    const [edge, chrome] = await browsers(
      {
        type: "edge",
        tabs: [tab(171, "https://t1/", "t1", { active: true }), tab(172, "https://t2/", "t2")],
      },
      { type: "chrome", tabs: [tab(173, "https://c/", "C")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 171 }), "select");
    edge.tabs.delete(171);
    const before = { edge: edge.received.length, chrome: chrome.received.length };
    const text = failed(await A.call("browser_click", { target: "x" }), "TARGET_CLOSED", "click");
    assert.match(text, /172/);
    const after = edge.received.slice(before.edge);
    assert.deepEqual(
      after.map((c) => c.action),
      ["click", "list_tabs"]
    );
    assert.equal(after[0].params.tabId, 171);
    assert.equal(chrome.received.length, before.chrome, "nothing reached another browser");
    assert.equal(await targetOf(A), null);
    // The session stays without a target: later calls naming no tab fail the same way, and
    // nothing page-level reaches either browser
    for (const call of ["second", "third"]) {
      const again = failed(
        await A.call("browser_click", { target: "x" }),
        "TARGET_CLOSED",
        `${call} click`
      );
      assert.match(again, /172/);
    }
    assert.deepEqual(pageCalls(chrome), []);
    assert.deepEqual(
      pageCalls(edge).map((c) => [c.action, c.params.tabId]),
      [["click", 171]]
    );
    // A per-call tabId acts for that call only and leaves the session without a target
    ok(await A.call("browser_snapshot", { tabId: 172 }), "per-call snapshot");
    failed(await A.call("browser_snapshot", {}), "TARGET_CLOSED", "snapshot after per-call");
    // select picks the next target, and calls resume on it
    ok(await A.call("browser_tabs", { action: "select", tabId: 172 }), "select next");
    ok(await A.call("browser_click", { target: "y" }), "click on the new target");
    assert.deepEqual(
      pageCalls(edge).map((c) => [c.action, c.params.tabId]),
      [
        ["click", 171],
        ["snapshot", 172],
        ["click", 172],
      ]
    );
    assert.deepEqual(pageCalls(chrome), []);
  },

  async "uc-target-closed-then-new"() {
    const [edge, chrome] = await browsers(
      { type: "edge", tabs: [tab(176, "https://t1/", "t1", { active: true })] },
      { type: "chrome", focused: true, tabs: [tab(177, "https://c/", "C")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 176 }), "select");
    edge.tabs.delete(176);
    failed(await A.call("browser_snapshot", {}), "TARGET_CLOSED", "snapshot");
    // new with no browser opens in the browser the closed target was in, not the default
    const created = ok(await A.call("browser_tabs", { action: "new", url: "https://n/" }), "new");
    assert.equal(created.target.browser, "edge-1");
    ok(await A.call("browser_snapshot", {}), "snapshot on the new tab");
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [176, created.id]
    );
    assert.deepEqual(pageCalls(chrome), []);
    assert.deepEqual(chrome.served("new_tab"), []);
  },

  async "uc-browser-gone"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(181, "https://c/", "C")] },
      { type: "edge", tabs: [tab(182, "https://e/", "E")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    await edge.close();
    const before = chrome.received.length;
    for (const call of ["first", "second", "third"]) {
      failed(await A.call("browser_snapshot", {}), "BROWSER_DISCONNECTED", `${call} snapshot`);
    }
    failed(await A.call("browser_click", { target: "x" }), "BROWSER_DISCONNECTED", "click");
    assert.equal(chrome.received.length, before, "nothing reached chrome-1");
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 182 });
  },

  async "uc-browser-reconnects-and-resumes"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(186, "https://c/", "C")] },
      { type: "edge", tabs: [tab(187, "https://e/", "E")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    await edge.close();
    failed(await A.call("browser_snapshot", {}), "BROWSER_DISCONNECTED", "snapshot while gone");
    failed(await A.call("browser_snapshot", {}), "BROWSER_DISCONNECTED", "snapshot while gone");
    await edge.connect();
    await waitFor(
      async () => (await status()).browsers.some((b) => b.alias === "edge-1"),
      "edge-1 to come back"
    );
    const snap = ok(await A.call("browser_snapshot", {}), "snapshot after reconnect");
    assert.equal(snap.by, "edge-1");
    assert.equal(snap.tabId, 187);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 187 });
    assert.deepEqual(chrome.received, []);
  },

  async "uc-new-session-after-other-select"() {
    const [chrome] = await browsers({
      type: "chrome",
      tabs: [
        tab(301, "https://visible/", "Visible", { active: true }),
        tab(302, "https://bg/", "BG"),
      ],
    });
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 302 }), "A select");
    assert.equal(chrome.pin, 302, "the extension pin moved to A's background tab");
    const B = await session();
    const snap = ok(await B.call("browser_snapshot", {}), "B snapshot");
    assert.deepEqual(snap.target, {
      browser: "chrome-1",
      tabId: 301,
      url: "https://visible/",
      title: "Visible",
    });
    assert.deepEqual(
      chrome.served("snapshot").map((c) => c.params.tabId),
      [301]
    );
  },

  async "uc-first-call-one-agent-entry"() {
    await browsers(
      { type: "chrome", focused: true, tabs: [tab(311, "https://c/", "C")] },
      { type: "edge", tabs: [tab(312, "https://e/", "E")] }
    );
    const A = await session();
    const since = callLogSize();
    ok(await A.call("browser_snapshot", {}), "first snapshot");
    ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    const entries = callLogSince(since);
    const agentSeqs = new Set(entries.filter((e) => !e.internal).map((e) => e.seq));
    assert.equal(agentSeqs.size, 2, JSON.stringify(entries));
    assert.deepEqual(
      entries.filter((e) => !e.internal).map((e) => e.action),
      ["snapshot", "switch_tab"]
    );
    assert.deepEqual(
      entries.filter((e) => e.internal).map((e) => e.action),
      ["list_tabs", "list_tabs"]
    );
  },

  async "uc-sw-restart"() {
    const [edge] = await browsers({
      type: "edge",
      tabs: [tab(191, "https://t1/", "t1", { active: true }), tab(192, "https://t2/", "t2")],
    });
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 192 }), "select");
    await edge.close();
    await edge.connect();
    await waitFor(
      async () => (await status()).browsers.some((b) => b.alias === "edge-1"),
      "edge-1 to come back"
    );
    const snap = ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.equal(snap.tabId, 192);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 192 });
  },

  async "uc-activate"() {
    const [edge] = await browsers({
      type: "edge",
      tabs: [tab(201, "https://t0/", "t0", { active: true }), tab(202, "https://t1/", "t1")],
    });
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 202, activate: true }), "select");
    assert.equal(edge.served("switch_tab")[0].params.activate, true);
    assert.equal(edge.tabs.get(202).active, true);
  },

  async "uc-browser-action"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(211, "https://c/", "C")] },
      { type: "edge", tabs: [tab(212, "https://e/", "E")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 212 }), "select");
    const res = ok(
      await A.call("browser_action", { action: "click", params: { target: "abc" } }),
      "action"
    );
    assert.equal(res.by, "edge-1");
    assert.deepEqual(
      edge.served("click").map((c) => c.params.tabId),
      [212]
    );
    assert.deepEqual(chrome.served("click"), []);
  },

  async "uc-100-profiles"() {
    const specs = [];
    for (let i = 1; i <= 100; i++) {
      specs.push({
        type: "chrome",
        tabs: [
          i === 57
            ? tab(1000 + i, "https://www.facebook.com/", "Facebook")
            : tab(1000 + i, `https://site${i}.example/`, `Site ${i}`),
        ],
      });
    }
    await browsers(...specs);
    const A = await session();
    const t0 = Date.now();
    const list = ok(await A.call("browser_tabs", { action: "list", query: "facebook" }), "list");
    const elapsed = Date.now() - t0;
    assert.equal(list.tabs.length, 1);
    assert.equal(list.tabs[0].browser, "chrome-57");
    assert.equal(Object.keys(list.browsers).length, 100);
    assert.ok(elapsed < 3000, `list took ${elapsed} ms`);
  },

  async "uc-hung-browser"() {
    await browsers(
      { type: "chrome", tabs: [tab(221, "https://c/", "C")] },
      { type: "chrome", hangList: true, tabs: [tab(222, "https://h/", "H")] }
    );
    const A = await session();
    const t0 = Date.now();
    const list = ok(await A.call("browser_tabs", { action: "list" }), "list");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < FANOUT_TIMEOUT_MS + 500, `list took ${elapsed} ms`);
    assert.deepEqual(
      list.tabs.map((t) => t.id),
      [221]
    );
    assert.equal(list.browsers["chrome-1"].ok, true);
    assert.equal(list.browsers["chrome-2"].ok, false);
    assert.match(list.browsers["chrome-2"].error, /timed out/);
  },

  async "uc-legacy-plus-new"() {
    const [legacy, edge] = await browsers(
      { legacy: true, tabs: [tab(231, "https://old/", "Old")] },
      { type: "edge", tabs: [tab(232, "https://e/", "E")] }
    );
    assert.equal(legacy.alias, "legacy-1");
    const A = await session();
    const list = ok(await A.call("browser_tabs", { action: "list" }), "list");
    assert.deepEqual(
      list.tabs.filter((t) => t.id === 231).map((t) => t.browser),
      ["legacy-1"]
    );
    ok(await A.call("browser_tabs", { action: "select", tabId: 231 }), "select");
    ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.deepEqual(
      legacy.served("snapshot").map((c) => c.params.tabId),
      [231]
    );
    assert.deepEqual(edge.served("snapshot"), []);
  },

  async "uc-group-tab-by-id"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(241, "https://c/", "C")] },
      {
        type: "edge",
        tabs: [tab(242, "https://p/", "p", { active: true }), tab(243, "https://q/", "q")],
      }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 242 }), "select");
    const grouped = ok(
      await A.call("browser_action", { action: "group_tab", params: { id: 243 } }),
      "group_tab"
    );
    assert.equal(grouped.tabId, 243);
    assert.deepEqual(
      edge.served("group_tab").map((c) => c.params.id),
      [243]
    );
    assert.deepEqual(chrome.served("group_tab"), []);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 243 });
    ok(await A.call("browser_snapshot", {}), "snapshot");
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [243]
    );
    assert.deepEqual(chrome.served("snapshot"), []);
  },

  async "uc-group-tab-default"() {
    const [edge] = await browsers({
      type: "edge",
      tabs: [tab(251, "https://t1/", "t1", { active: true }), tab(252, "https://t2/", "t2")],
    });
    const [A, B, C] = await Promise.all([session(), session(), session()]);
    ok(await A.call("browser_tabs", { action: "select", tabId: 251 }), "A select");
    ok(await B.call("browser_tabs", { action: "select", tabId: 252 }), "B select");
    // The extension pin is now t2 (B's); A's group and ungroup must still act on A's t1
    ok(await A.call("browser_action", { action: "group_tab", params: {} }), "A group");
    ok(await A.call("browser_action", { action: "ungroup_tab", params: {} }), "A ungroup");
    assert.deepEqual(
      edge.served("group_tab").map((c) => c.params.id),
      [251]
    );
    assert.deepEqual(
      edge.served("ungroup_tab").map((c) => c.params.id),
      [251]
    );
    ok(await A.call("browser_snapshot", {}), "A snapshot");
    ok(await B.call("browser_snapshot", {}), "B snapshot");
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [251, 252]
    );
    // A session with no target resolves its default first, then groups that tab by id
    const before = edge.received.length;
    ok(await C.call("browser_action", { action: "group_tab", params: {} }), "C group");
    assert.deepEqual(
      edge.received.slice(before).map((c) => [c.action, c.params.id ?? c.params.tabId ?? null]),
      [
        ["list_tabs", null],
        ["group_tab", 251],
      ]
    );
    assert.deepEqual(await targetOf(C), { browser: "edge-1", tabId: 251 });
  },

  async "uc-raw-tab-actions"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(261, "https://c/", "C")] },
      { type: "edge", tabs: [tab(262, "https://e/", "E")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    const created = ok(
      await A.call("browser_action", { action: "new_tab", params: { url: "https://n/" } }),
      "new_tab"
    );
    assert.equal(created.target.browser, "edge-1");
    assert.equal(edge.served("new_tab").length, 1);
    assert.deepEqual(chrome.served("new_tab"), []);
    ok(await A.call("browser_snapshot", {}), "snapshot new");
    ok(await A.call("browser_action", { action: "switch_tab", params: { id: 262 } }), "switch");
    assert.notEqual(edge.served("switch_tab").at(-1).params.activate, true);
    ok(await A.call("browser_snapshot", {}), "snapshot back");
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [created.id, 262]
    );
    assert.deepEqual(chrome.served("snapshot"), []);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 262 });
  },

  async "uc-select-during-resolution"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", focused: true, tabs: [tab(271, "https://c/", "C")] },
      { type: "edge", tabs: [tab(272, "https://e/", "E")] }
    );
    chrome.holdList = true;
    const A = await session();
    const firstCall = A.call("browser_snapshot", {});
    await waitFor(async () => chrome.served("list_tabs").length === 1, "list_tabs in flight");
    ok(await A.call("browser_tabs", { action: "select", browser: "edge" }), "select");
    chrome.release();
    const first = ok(await firstCall, "first snapshot");
    assert.deepEqual(first.target, {
      browser: "edge-1",
      tabId: 272,
      url: "https://e/",
      title: "E",
    });
    ok(await A.call("browser_snapshot", {}), "second snapshot");
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 272 });
    assert.deepEqual(
      edge.served("snapshot").map((c) => c.params.tabId),
      [272, 272]
    );
    assert.deepEqual(actionsOf(chrome), ["list_tabs"]);
  },

  async "uc-per-call-ambiguous"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(7, "https://c/", "C")] },
      { type: "edge", tabs: [tab(7, "https://e/", "E"), tab(8, "https://e8/", "E8")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 8 }), "select");
    const text = failed(
      await A.call("browser_snapshot", { tabId: 7 }),
      "AMBIGUOUS_TAB",
      "snapshot"
    );
    assert.match(text, /chrome-1/);
    assert.match(text, /edge-1/);
    assert.match(text, /moves your session target/);
    assert.match(text, /subagent/);
    assert.deepEqual(chrome.served("snapshot"), []);
    assert.deepEqual(edge.served("snapshot"), []);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 8 });
  },

  async "uc-per-call-not-found"() {
    const [chrome, edge] = await browsers(
      { type: "chrome", tabs: [tab(281, "https://c/", "C")] },
      { type: "edge", tabs: [tab(282, "https://e/", "E")] }
    );
    const A = await session();
    ok(await A.call("browser_tabs", { action: "select", tabId: 282 }), "select");
    const text = failed(await A.call("browser_snapshot", { tabId: 999 }), null, "snapshot");
    assert.match(text, /tab 999 not found in any connected browser/);
    assert.deepEqual(chrome.served("snapshot"), []);
    assert.deepEqual(edge.served("snapshot"), []);
    assert.deepEqual(await targetOf(A), { browser: "edge-1", tabId: 282 });
  },
};

// ---------------------------------------------------------------- run

if (!CASES[CASE]) {
  console.error(`unknown case ${CASE}; known: ${Object.keys(CASES).join(", ")}`);
  process.exit(2);
}
let code = 0;
try {
  await CASES[CASE]();
  process.stdout.write(`OK ${CASE}\n`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await Promise.all(sessions.map((c) => c.close().catch(() => {})));
}
process.exit(code);
