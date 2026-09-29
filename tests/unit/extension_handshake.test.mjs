// The extension side of the bridge handshake, run on the shipped source of
// extension/background.js in a node:vm context: the hello it sends, the identity it keeps, and
// how it reacts to each close code the bridge uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractFunction } from "./source-slice.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
const FUNCS = [
  "bridgeWsUrl",
  "getInstanceId",
  "detectBrowserType",
  "helloExtras",
  "reportFocus",
  "registerFocusListener",
  "connect",
]
  .map((n) => extractFunction(SRC, n))
  .join("\n");

function load({
  stored = {},
  userAgent = "Mozilla/5.0 Chrome/140.0",
  brave = false,
  lastFocused = { focused: false },
  lastFocusedRejects = false,
} = {}) {
  const storage = { ...stored };
  const sockets = [];
  const timers = [];
  const focusListeners = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
    async fire(type, event = {}) {
      if (type === "open") this.readyState = 1;
      if (type === "close") this.readyState = 3;
      for (const fn of this.listeners[type] || []) await fn(event);
    }
  }

  const ctx = vm.createContext({
    console: { log() {}, warn() {} },
    WebSocket: FakeWebSocket,
    navigator: { userAgent, ...(brave ? { brave: {} } : {}) },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of [].concat(keys)) if (k in storage) out[k] = storage[k];
            return out;
          },
          async set(obj) {
            Object.assign(storage, obj);
          },
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        async getLastFocused() {
          if (lastFocusedRejects) throw new Error("getLastFocused failed");
          return lastFocused;
        },
        onFocusChanged: {
          addListener: (fn) => focusListeners.push(fn),
        },
      },
    },
    dispatch: async () => ({ ok: true }),
  });
  vm.runInContext(
    `const DEFAULT_HOST = "127.0.0.1";
     const DEFAULT_PORT = 8765;
     const RECONNECT_MS = 2000;
     const MAX_BACKOFF_MS = 30000;
     let socket = null, attempts = 0, reconnectTimer = null, connecting = false;
     let wantConnect = true, connState = "idle";
     ${FUNCS}
     registerFocusListener();
     globalThis.api = {
       connect, detectBrowserType, getInstanceId,
       get connState() { return connState; },
       get wantConnect() { return wantConnect; },
     };`,
    ctx
  );
  return { api: ctx.api, storage, sockets, timers, focusListeners };
}

async function openSocket(env) {
  await env.api.connect();
  const ws = env.sockets.at(-1);
  await ws.fire("open");
  return ws;
}

test("on open the extension says hello with a persisted instanceId and its browser type", async () => {
  const env = load();
  const ws = await openSocket(env);
  assert.equal(ws.url, "ws://127.0.0.1:8765/extension");
  assert.equal(ws.sent.length, 1);
  const hello = ws.sent[0];
  assert.equal(hello.type, "hello");
  assert.match(hello.instanceId, /^inst_[a-z0-9]+$/);
  assert.equal(hello.browserType, "chrome");
  assert.equal(env.storage.instanceId, hello.instanceId, "the id is stored for the next connect");
});

test("the instanceId is stable across reconnects and reuses a stored one", async () => {
  const env = load({ stored: { instanceId: "inst_mine" } });
  const first = await openSocket(env);
  await first.fire("close", { code: 1006 });
  env.timers.at(-1).fn();
  await new Promise((r) => setImmediate(r));
  const second = env.sockets.at(-1);
  assert.notEqual(second, first);
  await second.fire("open");
  assert.equal(first.sent[0].instanceId, "inst_mine");
  assert.equal(second.sent[0].instanceId, "inst_mine");
});

test("the configured port is where it connects", async () => {
  const env = load({ stored: { bridgePort: 8766 } });
  const ws = await openSocket(env);
  assert.equal(ws.url, "ws://127.0.0.1:8766/extension");
});

test("every close code, including 4009, schedules a reconnect with backoff", async () => {
  for (const code of [4008, 4009, 1000, 1005, 1006]) {
    const env = load();
    const ws = await openSocket(env);
    await ws.fire("close", { code });
    assert.equal(env.api.connState, "connecting", `code ${code}`);
    assert.equal(env.api.wantConnect, true, `code ${code}`);
    const t = env.timers.at(-1);
    assert.ok(t && t.ms >= 2000 && t.ms <= 30000, `code ${code} scheduled ${t && t.ms}`);
  }
});

test("browser type detection: Edge, Opera, Brave and Chrome are told apart", () => {
  const cases = [
    [{ userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0" }, "edge"],
    [{ userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 OPR/120.0" }, "opera"],
    [{ userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36", brave: true }, "brave"],
    [{ userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36" }, "chrome"],
    [{ userAgent: "Mozilla/5.0 Firefox/130.0" }, "firefox"],
    [{ userAgent: "" }, "chromium"],
  ];
  for (const [opts, want] of cases) {
    assert.equal(load(opts).api.detectBrowserType(), want, JSON.stringify(opts));
  }
});

test("a welcome frame stores the reassigned instanceId and the next hello uses it", async () => {
  const env = load({ stored: { instanceId: "i1" } });
  const first = await openSocket(env);
  assert.equal(first.sent[0].instanceId, "i1");
  await first.fire("message", { data: JSON.stringify({ type: "welcome", instanceId: "i1_ab12" }) });
  assert.equal(env.storage.instanceId, "i1_ab12");
  await first.fire("close", { code: 1006 });
  env.timers.at(-1).fn();
  await new Promise((r) => setImmediate(r));
  const second = env.sockets.at(-1);
  await second.fire("open");
  assert.equal(second.sent[0].instanceId, "i1_ab12");
});

test("an instanceId the bridge would reject is never generated", async () => {
  // The bridge keeps at most 64 printable characters; a generated id must pass unchanged
  for (let i = 0; i < 50; i++) {
    const id = await load().api.getInstanceId();
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(id.length > "inst_".length, `id too short to be unique: ${id}`);
  }
});

test("hello carries label and focus", async () => {
  const env = load({ stored: { label: "Test profile" }, lastFocused: { focused: true } });
  const ws = await openSocket(env);
  const hello = ws.sent[0];
  assert.equal(hello.label, "Test profile");
  assert.equal(hello.focused, true);
});

test("hello omits label when none is stored, and reports focus false", async () => {
  const env = load({ lastFocused: { focused: false } });
  const ws = await openSocket(env);
  const hello = ws.sent[0];
  assert.ok(!("label" in hello), "no label was stored, so hello must not carry one");
  assert.equal(hello.focused, false);
});

test("a getLastFocused rejection degrades to focused:false, and the hello is still sent", async () => {
  const env = load({ stored: { label: "Test profile" }, lastFocusedRejects: true });
  const ws = await openSocket(env);
  assert.equal(ws.sent.length, 1, "the hello must still be sent");
  const hello = ws.sent[0];
  assert.equal(hello.type, "hello");
  assert.match(hello.instanceId, /^inst_[a-z0-9]+$/);
  assert.equal(hello.browserType, "chrome");
  assert.equal(hello.label, "Test profile", "label is still sent when it can be read");
  assert.equal(hello.focused, false, "an unreadable focus state degrades to false, not a throw");
});

test("focus changes are reported", async () => {
  const env = load();
  const ws = await openSocket(env);
  const listener = env.focusListeners.at(-1);
  await listener(5);
  await listener(-1);
  const frames = ws.sent.slice(1);
  assert.deepEqual(
    frames.map((f) => ({ type: f.type, focused: f.focused })),
    [
      { type: "focus", focused: true },
      { type: "focus", focused: false },
    ]
  );
});

function loadListTabs({
  tabs,
  lastFocused = { id: 1 },
  targetTabId = null,
  lastFocusedRejects = false,
} = {}) {
  const ctx = vm.createContext({
    chrome: {
      tabs: {
        async query() {
          return tabs;
        },
      },
      storage: {
        session: {
          async get() {
            return { targetTabId };
          },
        },
      },
      windows: {
        async getLastFocused() {
          if (lastFocusedRejects) throw new Error("getLastFocused failed");
          return lastFocused;
        },
      },
    },
  });
  vm.runInContext(
    `let targetTabId = ${targetTabId === null ? "null" : targetTabId};
     ${extractFunction(SRC, "listTabs")}
     globalThis.listTabs = listTabs;`,
    ctx
  );
  return ctx.listTabs;
}

test("listTabs marks the focused window's active tab", async () => {
  const tabs = [
    { id: 1, url: "https://a.test", title: "A", active: true, windowId: 10 },
    { id: 2, url: "https://b.test", title: "B", active: true, windowId: 20 },
    { id: 3, url: "https://c.test", title: "C", active: false, windowId: 10 },
  ];
  const listTabs = loadListTabs({ tabs, lastFocused: { id: 10 } });
  const { tabs: out } = await listTabs();
  const byId = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.equal(byId[1].focusedWindow, true, "active tab in the last-focused window");
  assert.equal(byId[2].focusedWindow, false, "active tab, but not in the last-focused window");
  assert.equal(byId[3].focusedWindow, false, "in the last-focused window, but not active");
  assert.equal(byId[1].windowId, 10);
});

test("listTabs reports incognito only when true", async () => {
  const tabs = [
    { id: 1, url: "https://a.test", title: "A", active: true, windowId: 10, incognito: true },
    { id: 2, url: "https://b.test", title: "B", active: false, windowId: 10, incognito: false },
  ];
  const listTabs = loadListTabs({ tabs, lastFocused: { id: 10 } });
  const { tabs: out } = await listTabs();
  const byId = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.equal(byId[1].incognito, true);
  assert.ok(!("incognito" in byId[2]), "a non-incognito tab carries no incognito field");
});

test("a getLastFocused rejection degrades to focusedWindow:false, and every tab is still listed", async () => {
  const tabs = [
    { id: 1, url: "https://a.test", title: "A", active: true, windowId: 10 },
    { id: 2, url: "https://b.test", title: "B", active: false, windowId: 10 },
  ];
  const listTabs = loadListTabs({ tabs, lastFocusedRejects: true });
  const { tabs: out } = await listTabs();
  assert.equal(out.length, 2, "every tab is still listed");
  assert.ok(
    out.every((t) => t.focusedWindow === false),
    "no tab can be claimed as the focused window's active tab when it could not be read"
  );
});
