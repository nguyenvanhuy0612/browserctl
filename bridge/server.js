// Bridge server: relays AI-agent commands to the Chrome extension.
//
//   Agent  --HTTP-->  this server  --WebSocket-->  extension
//
// Endpoints:
//   POST /command         { action, params? }  -> runs a command, returns its result
//   GET  /status                               -> { extensionConnected }
//   WS   /extension                            -> the extension connects here
//
// No auth, localhost only. See README "Security".

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8765;
const HOST = "127.0.0.1";
// Overridable via env so tests can exercise real timeout firing without a 30s wait;
// unset in normal operation, so production behavior is unchanged.
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS) || 30_000;
// A few actions legitimately run longer than the default (multi-step replay chains,
// each with its own navigation wait; export_har{bodies:true} can be slow to collect).
// Give them a larger ceiling so the bridge doesn't 504 while the extension is still
// legitimately working.
const ACTION_TIMEOUT_MS = { replay: 120_000, export_har: 120_000 };
// wait_for / wait_network_idle accept a caller-supplied timeoutMs that can legitimately
// exceed the default command timeout (or be shorter). Honor it end-to-end by using
// timeoutMs + a buffer (time for the extension to notice its own wait expired and
// reply) as this request's bridge-side timeout, instead of the fixed default.
const WAIT_ACTIONS = new Set(["wait_for", "wait_network_idle"]);
const TIMEOUT_BUFFER_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000; // hard ceiling regardless of what a caller requests
// App-level heartbeat. The inbound ping resets the extension's MV3 service-worker
// idle timer (~30s), keeping the socket genuinely open instead of churning; the
// pong lets us detect and drop a dead extension. Must be an application message,
// not a protocol ws.ping() frame — the browser answers those itself without ever
// waking the service worker's message handler.
const HEARTBEAT_MS = 20_000;
// Explicit inbound WS payload cap (matches ws's own default, named here so it's
// visible/tunable and paired with a friendly error instead of a bare 1009 close).
// Overridable via env for tests.
const MAX_WS_PAYLOAD_BYTES = Number(process.env.MAX_WS_PAYLOAD_BYTES) || 100 * 1024 * 1024;

// Per-command timeout, aware of the action being run. See WAIT_ACTIONS/ACTION_TIMEOUT_MS above.
function computeTimeoutMs(action, params) {
  let ms = ACTION_TIMEOUT_MS[action] || COMMAND_TIMEOUT_MS;
  if (WAIT_ACTIONS.has(action)) {
    const requested = Number(params && params.timeoutMs);
    if (Number.isFinite(requested) && requested > 0) ms = requested + TIMEOUT_BUFFER_MS;
  }
  return Math.min(ms, MAX_TIMEOUT_MS);
}

// The single connected extension socket (we support one browser for now).
let extensionSocket = null;

// id -> { resolve, reject, timer } for in-flight commands awaiting a reply.
const pending = new Map();

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    return sendJson(res, 200, { extensionConnected: extensionSocket != null });
  }

  if (req.method === "POST" && req.url === "/command") {
    return readBody(req)
      .then((body) => handleCommand(body, res))
      .catch((err) => sendJson(res, 400, { ok: false, error: String(err.message || err) }));
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

// WebSocket endpoint for the extension.
const wss = new WebSocketServer({ server, path: "/extension", maxPayload: MAX_WS_PAYLOAD_BYTES });

// Fail every in-flight command instead of letting its HTTP caller hang until its
// own timeout: called on socket replacement and on close/error of the live socket.
function rejectAllPending(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: reason });
  }
  pending.clear();
}

wss.on("connection", (ws) => {
  if (extensionSocket) {
    // A new connection replaces the old one; anything still waiting on the old
    // socket will never get a reply, so fail it now rather than at its own timeout.
    rejectAllPending("extension disconnected");
    try { extensionSocket.close(); } catch {}
  }
  extensionSocket = ws;
  ws.isAlive = true;
  log("extension connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (msg.type === "pong") { ws.isAlive = true; return; } // heartbeat reply
    const entry = pending.get(msg.id);
    if (!entry) return; // unknown / already-timed-out id
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  });

  ws.on("close", () => {
    const wasActive = extensionSocket === ws;
    if (wasActive) extensionSocket = null;
    // Only a genuine disconnect of the currently-active socket should fail pending
    // commands here — replacement already rejected (and cleared) pending at connect
    // time, so a stale socket's belated close must not clobber requests already
    // in flight against the new one.
    if (wasActive) {
      const reason = ws.aibcOversized ? "payload too large" : "extension disconnected";
      rejectAllPending(reason);
      log(ws.aibcOversized ? "extension disconnected (payload too large)" : "extension disconnected");
    } else {
      log("stale extension socket closed");
    }
  });

  ws.on("error", (err) => {
    log("extension socket error:", err.message);
    // ws aborts the connection on an oversized inbound frame; remember why so the
    // close handler above can reject pending callers with a friendlier reason than
    // a bare disconnect.
    if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") ws.aibcOversized = true;
  });
});

// Heartbeat: ping the extension every HEARTBEAT_MS. If the previous ping went
// unanswered by the next tick, the socket is dead (SW gone, machine slept) —
// terminate it so /status flips to disconnected and the extension re-links.
const heartbeat = setInterval(() => {
  const ws = extensionSocket;
  if (!ws) return;
  if (ws.isAlive === false) {
    log("extension heartbeat timeout; dropping stale socket");
    try { ws.terminate(); } catch {}
    return;
  }
  ws.isAlive = false;
  try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

function handleCommand(body, res) {
  const { action, params } = body || {};
  if (!action || typeof action !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing 'action'" });
  }
  if (!extensionSocket) {
    return sendJson(res, 503, { ok: false, error: "extension not connected" });
  }

  const id = randomUUID();
  const message = { id, action, params: params || {} };

  const timeoutMs = computeTimeoutMs(action, params);
  const wait = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`command '${action}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });

  try {
    extensionSocket.send(JSON.stringify(message));
  } catch (err) {
    const entry = pending.get(id);
    if (entry) { clearTimeout(entry.timer); pending.delete(id); }
    return sendJson(res, 502, { ok: false, error: "failed to reach extension: " + err.message });
  }

  wait
    .then((reply) => sendJson(res, reply.ok ? 200 : 500, reply))
    .catch((err) => sendJson(res, 504, { ok: false, error: String(err.message || err) }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    req.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (raw.length > 5_000_000) {
        // Reject now, but keep letting the stream drain to 'end' (the `settled`
        // guard above stops us from buffering more into `raw`). Neither destroying
        // nor pausing the request is safe here: destroying tears down the shared
        // socket and kills the 400 response we're about to send; pausing leaves the
        // rest of this oversized body unread on the socket, which then corrupts the
        // next request if the connection is reused (keep-alive).
        raw = "";
        done(reject, new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return done(resolve, {});
      try { const parsed = JSON.parse(raw); done(resolve, parsed); }
      catch { done(reject, new Error("invalid JSON body")); }
    });
    req.on("error", (err) => done(reject, err));
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${PORT} in use — another bridge running?`);
    process.exit(1);
  }
  console.error("bridge server error:", err);
});

// Last-resort safety nets: log to stderr and keep running instead of dying silently
// (or crashing the whole process) on a stray/unawaited rejection or thrown error.
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err);
});

server.listen(PORT, HOST, () => {
  log(`bridge listening on http://${HOST}:${PORT}`);
  log(`extension should connect to ws://${HOST}:${PORT}/extension`);
});

export { computeTimeoutMs, server, wss };
