// Fixture for tests/unit/multi_browser_live_script.test.mjs: a real bridge (bridge/server.js
// on an ephemeral port), fake extensions that answer from an in-memory tab table, and the real
// tests/e2e/multi_browser_live.mjs script spawned as a child process pointed at that bridge
// through BROWSERCTL_BRIDGE_URL. Usage: node multi-browser-live.mjs <case>. Prints OK <case> on
// success; a failed assertion exits non-zero. HOME/USERPROFILE must already point at a temp
// directory (the parent test sets them).
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { execFile } from "node:child_process";
import util from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = util.promisify(execFile);
const CASE = process.argv[2];
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "..", "..", "e2e", "multi_browser_live.mjs");

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.FANOUT_TIMEOUT_MS = "500";
process.env.COMMAND_TIMEOUT_MS = "5000";
const CALL_LOG = join(mkdtempSync(join(tmpdir(), "browserctl-live-script-")), "calls.jsonl");
process.env.BROWSERCTL_CALL_LOG = CALL_LOG;

const { server: bridge } = await import("../../../bridge/server.js");
if (!bridge.listening) await new Promise((r) => bridge.once("listening", r));
const BASE = `http://127.0.0.1:${bridge.address().port}`;
const WS_URL = `ws://127.0.0.1:${bridge.address().port}/extension`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const tabRec = (id, url, title, extra = {}) => ({ id, url, title, active: false, ...extra });

// A stand-in extension: its tab table is the truth it answers list_tabs/current_tab/switch_tab
// /new_tab/close_tab from; every other action answers generically with the tab the params or
// the pin resolve to, which is all browser_snapshot and browser_click need from a fake.
function fake({ type = "chrome", label, focused = false, tabs = [], failCloseTab = false }) {
  const f = {
    instanceId: `inst-${++nextInstance}`,
    type,
    tabs: new Map(),
    pin: null,
    received: [],
    ws: null,
    failCloseTab,
  };
  for (const t of tabs) f.tabs.set(t.id, { ...t });
  if (![...f.tabs.values()].some((t) => t.active) && f.tabs.size) {
    [...f.tabs.values()][0].active = true;
  }
  const view = (t) => ({ id: t.id, url: t.url, title: t.title, active: t.active });
  const resolveTab = (params) => {
    if (params.tabId != null) {
      const t = f.tabs.get(params.tabId);
      if (!t) throw new Error(`tab ${params.tabId} not found`);
      return t;
    }
    if (f.pin != null && f.tabs.has(f.pin)) return f.tabs.get(f.pin);
    const active = [...f.tabs.values()].find((t) => t.active);
    if (!active) throw new Error("no tab");
    f.pin = active.id;
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
        const t = resolveTab(params);
        return { ...view(t), pinned: true };
      }
      case "new_tab": {
        const t = tabRec(++nextTabId, params.url || "about:blank", "");
        f.tabs.set(t.id, t);
        if (params.activate) {
          for (const o of f.tabs.values()) o.active = false;
          t.active = true;
        }
        f.pin = t.id;
        return { id: t.id, url: t.url, title: "", ready: true };
      }
      case "switch_tab": {
        const t = f.tabs.get(params.id);
        if (!t) throw new Error(`No tab with id: ${params.id}.`);
        if (params.activate) {
          for (const o of f.tabs.values()) o.active = false;
          t.active = true;
        }
        f.pin = t.id;
        return { id: t.id, url: t.url, title: t.title };
      }
      case "close_tab":
        if (f.failCloseTab) throw new Error(`close_tab failed (simulated) for tab ${params.id}`);
        f.tabs.delete(params.id);
        if (f.pin === params.id) f.pin = null;
        return { id: params.id, alreadyClosed: false };
      default: {
        const t = resolveTab(params);
        return { by: f.alias, action, tabId: t.id };
      }
    }
  };
  f.connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      f.ws = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
        if (msg.type === "welcome") return;
        if (!msg.id) return;
        f.received.push({ action: msg.action, params: msg.params || {} });
        let reply;
        try {
          reply = { id: msg.id, ok: true, result: answer(msg.action, msg.params || {}) };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message };
        }
        ws.send(JSON.stringify(reply));
      });
      ws.once("open", () => {
        const hello = { type: "hello", instanceId: f.instanceId, browserType: type, focused };
        if (label) hello.label = label;
        ws.send(JSON.stringify(hello));
        resolve();
      });
      ws.once("error", reject);
    });
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
    const entry = s.browsers.find((b) => b.instanceId === f.instanceId);
    f.alias = entry.alias;
    out.push(f);
  }
  return out;
}

async function runScript(extraArgs = []) {
  const env = { ...process.env };
  for (const k of [
    "PORT",
    "HOST",
    "FANOUT_TIMEOUT_MS",
    "COMMAND_TIMEOUT_MS",
    "BROWSERCTL_CALL_LOG",
    "BROWSERCTL_FB_QUERY",
    "BROWSERCTL_EDGE_QUERY",
    "BROWSERCTL_E2E_BROWSER",
    "BRIDGE_URL",
  ]) {
    delete env[k];
  }
  env.BROWSERCTL_BRIDGE_URL = BASE;
  try {
    const { stdout } = await run(process.execPath, [SCRIPT_PATH, ...extraArgs], { env });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: (err.stdout || "") + (err.stderr || "") };
  }
}

// ---------------------------------------------------------------- the cases

const CASES = {
  // Every non-interactive check has what it needs: two Chrome profiles (one with the only
  // facebook.com tab), one Edge profile with the only example.com tab (the script's defaults).
  async "case-pass"() {
    await browsers(
      { type: "chrome", tabs: [tabRec(11, "https://mail.google.com/", "Gmail")] },
      { type: "chrome", tabs: [tabRec(31, "https://www.facebook.com/", "Facebook")] },
      { type: "edge", tabs: [tabRec(41, "https://example.com/", "Example Domain")] }
    );
    const { code, stdout } = await runScript();
    assert.equal(code, 0, stdout);
    assert.match(stdout, /\[PASS\] 1\.1 /);
    assert.match(stdout, /\[PASS\] 1\.2 /);
    assert.match(stdout, /\[PASS\] 1\.3 /);
    assert.match(stdout, /\[SKIP\] 1\.4 /);
    assert.match(stdout, /\[SKIP\] 1\.5 /);
    assert.match(stdout, /\[PASS\] 1\.6 /);
    assert.match(stdout, /RESULT: 4\/6 checks passed, 2 skipped, 0 failed/);
  },

  // The facebook query matches two Chrome profiles: 1.2 must FAIL and the script must exit
  // non-zero, even though every other non-interactive check still has what it needs.
  async "case-fail-fb-two-profiles"() {
    await browsers(
      { type: "chrome", tabs: [tabRec(51, "https://www.facebook.com/", "Facebook")] },
      { type: "chrome", tabs: [tabRec(52, "https://www.facebook.com/groups", "Facebook Groups")] },
      { type: "edge", tabs: [tabRec(61, "https://example.com/", "Example Domain")] }
    );
    const { code, stdout } = await runScript();
    assert.notEqual(code, 0, stdout);
    assert.match(stdout, /\[FAIL\] 1\.2 /);
  },

  // Edge has only one tab, so check 1.6 opens a scratch tab; closing it back fails. The check's
  // own PASS still prints, every remaining check still runs, and the close failure is reported
  // as its own FAIL naming the tab id rather than aborting the script with an uncaught error.
  async "case-close-tab-fails"() {
    await browsers(
      { type: "chrome", tabs: [tabRec(81, "https://mail.google.com/", "Gmail")] },
      { type: "chrome", tabs: [tabRec(82, "https://www.facebook.com/", "Facebook")] },
      {
        type: "edge",
        failCloseTab: true,
        tabs: [tabRec(83, "https://example.com/", "Example Domain")],
      }
    );
    const { code, stdout } = await runScript();
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\[PASS\] 1\.6 /);
    assert.match(
      stdout,
      /\[FAIL\] 1\.6 .*could not close the scratch tab.*tabId \d+.*close it by hand/
    );
    assert.match(stdout, /RESULT: \d+\/7 checks passed, 2 skipped, 1 failed/);
  },

  // Only one browser connected: the whole script reports the top-level skip and exits clean,
  // running no individual checks at all.
  async "case-one-browser-skips"() {
    await browsers({ type: "chrome", tabs: [tabRec(71, "https://a.example/", "A")] });
    const { code, stdout } = await runScript();
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^SKIPPED \(one browser\)/m);
    assert.doesNotMatch(stdout, /RESULT:/);
  },
};

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
}
process.exit(code);
