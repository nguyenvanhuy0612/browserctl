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
const COMMAND_TIMEOUT_MS = 30_000;
// A few actions legitimately run longer than the default (multi-step replay chains,
// each with its own navigation wait). Give them a larger ceiling so the bridge doesn't
// 504 while the extension is still legitimately working.
const ACTION_TIMEOUT_MS = { replay: 120_000 };
// App-level heartbeat. The inbound ping resets the extension's MV3 service-worker
// idle timer (~30s), keeping the socket genuinely open instead of churning; the
// pong lets us detect and drop a dead extension. Must be an application message,
// not a protocol ws.ping() frame — the browser answers those itself without ever
// waking the service worker's message handler.
const HEARTBEAT_MS = 20_000;

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
const wss = new WebSocketServer({ server, path: "/extension" });

wss.on("connection", (ws) => {
  if (extensionSocket) {
    // Replace any stale connection with the newest one.
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
    if (extensionSocket === ws) extensionSocket = null;
    log("extension disconnected");
  });

  ws.on("error", (err) => log("extension socket error:", err.message));
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

  const timeoutMs = ACTION_TIMEOUT_MS[action] || COMMAND_TIMEOUT_MS;
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
        req.destroy(); // stop the client from streaming more once we've bailed
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

server.listen(PORT, HOST, () => {
  log(`bridge listening on http://${HOST}:${PORT}`);
  log(`extension should connect to ws://${HOST}:${PORT}/extension`);
});
