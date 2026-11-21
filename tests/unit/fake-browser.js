// @ts-check
// A daemon in-process on a free port and fake extensions that speak the wire protocol
// (specs/interface.md) over a real WebSocket, for unit tests that need a browser but not Chrome.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { PROTOCOL } from "../../extension/sw/protocol.js";
import { Daemon } from "../../src/daemon/app.js";
import { startServer } from "../../src/daemon/server.js";
import { tools } from "../../src/daemon/tools/index.js";

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => boolean} condition */
export async function until(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

/**
 * @param {{home?: string, sessionIdleMs?: number, cdp?: (daemon: Daemon) => unknown}} [options]
 */
export async function startDaemon({ home = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-unit-")), sessionIdleMs, cdp } = {}) {
  const daemon = new Daemon({ home, version: "test", tools, sessionIdleMs });
  if (cdp) daemon.cdp = /** @type {any} */ (cdp(daemon));
  const server = await startServer(daemon, { port: 0 });
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    daemon,
    home,
    port,
    /**
     * @param {string} tool @param {object} [params] @param {string} [session]
     * @returns {Promise<any>}
     */
    async call(tool, params = {}, session = "unit") {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tools/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-browserctl-session": session, "x-browserctl-client": "unit" },
        body: JSON.stringify(params),
      });
      return res.json();
    },
    async close() {
      daemon.cdp?.close();
      server.closeAllConnections();
      server.close();
      daemon.close();
    },
  };
}

/**
 * @typedef {{tabId: number, url: string, title: string, active: boolean, openerTabId?: number}} FakeTab
 * @typedef {(params: any, browser: FakeBrowser) => unknown} Handler
 */

/**
 * A fake extension. Tabs live in `tabs`; every request is recorded in `requests` and every event
 * the daemon sends in `events`; `handlers` override or add methods.
 * @param {number} port
 * @param {{instanceId?: string, name?: string, protocol?: number, userScripts?: boolean, handlers?: Record<string, Handler>}} [options]
 */
export async function connectFakeBrowser(port, { instanceId = "fake-1", name = "Chrome", protocol = PROTOCOL, userScripts = true, handlers = {} } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextTab = 100;
  /** @type {FakeBrowser} */
  const browser = {
    socket,
    /** @type {FakeTab[]} */
    tabs: [],
    /** @type {{method: string, params: any}[]} */
    requests: [],
    /** @type {{event: string, data: any}[]} */
    events: [],
    /** @param {Partial<FakeTab>} [tab] */
    addTab(tab = {}) {
      const created = { tabId: nextTab++, url: "about:blank", title: "", active: false, ...tab };
      browser.tabs.push(created);
      return created;
    },
    /** @param {string} event @param {object} data */
    emit(event, data) {
      socket.send(JSON.stringify({ event, data }));
    },
    close() {
      socket.close();
    },
  };
  /** @type {Record<string, Handler>} */
  const table = {
    "tabs.list": () => ({ tabs: browser.tabs }),
    "tabs.get": ({ tabId }) => browser.tabs.find((t) => t.tabId === tabId) ?? Promise.reject(Object.assign(new Error(`No tab with id: ${tabId}`), { code: "TAB_CLOSED" })),
    "tabs.create": ({ url }) => browser.addTab({ url }),
    "tabs.close": ({ tabId }) => {
      browser.tabs = browser.tabs.filter((t) => t.tabId !== tabId);
      return {};
    },
    "ext.info": () => ({ userScripts }),
    "debugger.list": () => ({ tabIds: [] }),
    "debugger.detach": () => ({}),
    "dom.call": ({ tabId, op, allFrames }) => {
      const tab = browser.tabs.find((t) => t.tabId === tabId);
      const result = op === "info" ? { ok: true, url: tab?.url, title: tab?.title, mutations: 0 } : op === "dialogLog" ? { ok: true, dialogs: [] } : { ok: true };
      return allFrames ? { frames: [{ frameId: 0, result }] } : result;
    },
    ...handlers,
  };
  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id === undefined) {
      browser.events.push({ event: message.event, data: message.data });
      return;
    }
    browser.requests.push({ method: message.method, params: message.params });
    const handler = table[message.method];
    try {
      if (!handler) throw Object.assign(new Error(`unknown method ${message.method}`), { code: "UNKNOWN_METHOD" });
      socket.send(JSON.stringify({ id: message.id, result: await handler(message.params, browser) }));
    } catch (error) {
      const e = /** @type {any} */ (error);
      socket.send(JSON.stringify({ id: message.id, error: { code: e.code ?? "INTERNAL_ERROR", message: e.message } }));
    }
  });
  browser.emit("hello", { protocol, instanceId, extensionVersion: "0.0.1", browser: { name, version: "158.0.0.0" }, profileLabel: "", browserStartedAt: 1, userScripts });
  return browser;
}

/**
 * @typedef {{
 *   socket: WebSocket,
 *   tabs: FakeTab[],
 *   requests: {method: string, params: any}[],
 *   events: {event: string, data: any}[],
 *   addTab: (tab?: Partial<FakeTab>) => FakeTab,
 *   emit: (event: string, data: object) => void,
 *   close: () => void,
 * }} FakeBrowser
 */
