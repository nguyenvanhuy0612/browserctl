// @ts-check
// The extension's link to the daemon. The daemon is probed with a caught fetch before the
// WebSocket is opened, so a stopped daemon never leaves an entry on the Errors page
// (specs/interface.md, specs/architecture.md).
import { guarded, note } from "./diag.js";
import { PROTOCOL } from "./protocol.js";

const DEFAULT_PORT = 8765;
const RETRY_MS = 2000;
const QUEUE_LIMIT = 500;
const QUEUE_KEY = "bctl.eventQueue";

/** @typedef {(params: any) => Promise<unknown>} Handler */

/** @type {WebSocket | null} */
let socket = null;
let connecting = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;
/** @type {string[]} */
let queue = [];
let queueLoaded = false;
/** @type {Record<string, Handler>} */
let handlers = {};
/** @type {() => Promise<object>} */
let helloFactory = async () => ({});
/** Handlers of the daemon's one-way events other than `welcome`. @type {Record<string, (data: any) => void>} */
const daemonEvents = {};

/** @param {string} event @param {(data: any) => void} handler */
export function onDaemonEvent(event, handler) {
  daemonEvents[event] = guarded(`daemon.${event}`, handler);
}
/** @type {{phase: "connecting" | "connected" | "down", port: number, alias: string | null, daemonVersion: string | null, since: number}} */
const state = { phase: "connecting", port: DEFAULT_PORT, alias: null, daemonVersion: null, since: Date.now() };

/** @param {"connecting" | "connected" | "down"} phase */
function setPhase(phase) {
  if (state.phase !== phase) state.since = Date.now();
  state.phase = phase;
  if (phase !== "connected") state.alias = null;
  const title =
    phase === "connected" ? `browserctl: connected as ${state.alias ?? "…"}` : phase === "down" ? `browserctl: daemon not running on 127.0.0.1:${state.port}` : "browserctl: connecting…";
  chrome.action.setTitle({ title }).catch(() => {});
}

/** For the popup (specs/extension-ui.md). */
export function connectionState() {
  return { ...state };
}

/** Closes the socket and connects again (popup Reconnect, port change). */
export function reconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const old = socket;
  socket = null;
  if (old) {
    old.onclose = null;
    try {
      old.close();
    } catch {
      // already closed
    }
  }
  setPhase("connecting");
  return connect();
}

/** @param {Record<string, Handler>} table @param {() => Promise<object>} hello */
export function configure(table, hello) {
  handlers = table;
  helloFactory = hello;
}

async function daemonPort() {
  try {
    const { daemonPort: port } = await chrome.storage.local.get("daemonPort");
    return typeof port === "number" ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

async function loadQueue() {
  if (queueLoaded) return;
  queueLoaded = true;
  try {
    const stored = (await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY];
    if (Array.isArray(stored)) queue = [...stored, ...queue].slice(-QUEUE_LIMIT);
  } catch (error) {
    note("connection.loadQueue", error);
  }
}

let persistPending = false;
function persistQueue() {
  if (persistPending) return;
  persistPending = true;
  setTimeout(() => {
    persistPending = false;
    chrome.storage.session.set({ [QUEUE_KEY]: queue }).catch((error) => note("connection.persistQueue", error));
  }, 200);
}

/** @param {string} event @param {unknown} data */
export function emit(event, data) {
  const message = JSON.stringify({ event, data });
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(message);
    return;
  }
  queue.push(message);
  if (queue.length > QUEUE_LIMIT) queue.shift();
  persistQueue();
}

export function isConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RETRY_MS);
}

/** @param {any} message */
async function onRequest(message) {
  const { id, method, params } = message;
  const handler = handlers[method];
  let reply;
  try {
    if (!handler) throw Object.assign(new Error(`unknown method ${method}`), { code: "UNKNOWN_METHOD" });
    reply = { id, result: (await handler(params ?? {})) ?? {} };
  } catch (error) {
    const err = /** @type {any} */ (error);
    reply = { id, error: { code: err?.code ?? "EXTENSION_ERROR", message: String(err?.message ?? err) } };
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
}

export async function connect() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    await loadQueue();
    const port = await daemonPort();
    state.port = port;
    let healthy = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    if (!healthy) {
      setPhase("down");
      scheduleRetry();
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    socket = ws;
    ws.onerror = () => {};
    ws.onopen = () => {
      helloFactory()
        .then((hello) => {
          ws.send(JSON.stringify({ event: "hello", data: { protocol: PROTOCOL, ...hello } }));
          const pending = queue;
          queue = [];
          persistQueue();
          for (const message of pending) ws.send(message);
        })
        .catch((error) => note("connection.hello", error));
    };
    ws.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(String(message.data));
      } catch (error) {
        note("connection.parse", error);
        return;
      }
      if (data && data.id !== undefined) onRequest(data).catch((error) => note("connection.request", error));
      else if (data?.event === "welcome") {
        state.alias = data.data?.alias ?? null;
        state.daemonVersion = data.data?.version ?? null;
        setPhase("connected");
      } else if (typeof data?.event === "string") daemonEvents[data.event]?.(data.data);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      setPhase("connecting");
      scheduleRetry();
    };
  } catch (error) {
    note("connection.connect", error);
    scheduleRetry();
  } finally {
    connecting = false;
  }
}
