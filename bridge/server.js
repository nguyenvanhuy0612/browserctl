import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { WebSocketServer } from "ws";
import { markDaemonRunning } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

const PORT = envNum("PORT", 8765);
const HOST = envStr("HOST", "0.0.0.0");
const COMMAND_TIMEOUT_MS = envNum("COMMAND_TIMEOUT_MS", 30_000);
const ACTION_TIMEOUT_MS = { replay: 120_000, export_har: 120_000 };
const WAIT_ACTIONS = new Set(["wait_for", "wait_network_idle"]);
const TIMEOUT_BUFFER_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;
const HEARTBEAT_MS = 20_000;
const MAX_WS_PAYLOAD_BYTES = envNum("MAX_WS_PAYLOAD_BYTES", 100 * 1024 * 1024);

function computeTimeoutMs(action, params) {
  let ms = ACTION_TIMEOUT_MS[action] || COMMAND_TIMEOUT_MS;
  if (WAIT_ACTIONS.has(action)) {
    const requested = Number(params && params.timeoutMs);
    if (Number.isFinite(requested) && requested > 0) ms = requested + TIMEOUT_BUFFER_MS;
  }
  return Math.min(ms, MAX_TIMEOUT_MS);
}

let extensionSocket = null;

const pending = new Map();

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    return sendJson(res, 200, statusPayload());
  }

  if (req.method === "POST" && req.url === "/command") {
    return readBody(req)
      .then((body) => handleCommand(body, res))
      .catch((err) => sendJson(res, 400, { ok: false, error: String(err.message || err) }));
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/extension", maxPayload: MAX_WS_PAYLOAD_BYTES });

function rejectAllPending(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: reason });
  }
  pending.clear();
}

wss.on("connection", (ws) => {
  if (extensionSocket) {
    rejectAllPending("extension disconnected");
    try {
      extensionSocket.close();
    } catch {}
  }
  extensionSocket = ws;
  ws.isAlive = true;
  log("extension connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "pong") {
      ws.isAlive = true;
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  });

  ws.on("close", () => {
    const wasActive = extensionSocket === ws;
    if (wasActive) extensionSocket = null;
    if (wasActive) {
      const reason = ws.bctlOversized ? "payload too large" : "extension disconnected";
      rejectAllPending(reason);
      log(
        ws.bctlOversized ? "extension disconnected (payload too large)" : "extension disconnected"
      );
    } else {
      log("stale extension socket closed");
    }
  });

  ws.on("error", (err) => {
    log("extension socket error:", err.message);
    if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") ws.bctlOversized = true;
  });
});

const heartbeat = setInterval(() => {
  const ws = extensionSocket;
  if (!ws) return;
  if (ws.isAlive === false) {
    log("extension heartbeat timeout; dropping stale socket");
    try {
      ws.terminate();
    } catch {}
    return;
  }
  ws.isAlive = false;
  try {
    ws.send(JSON.stringify({ type: "ping" }));
  } catch {}
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

const CALL_LOG_ENV = process.env.BROWSERCTL_CALL_LOG || "";
const CALL_LOG_PATH =
  !CALL_LOG_ENV || CALL_LOG_ENV === "0" || CALL_LOG_ENV === "false"
    ? null
    : CALL_LOG_ENV === "1" || CALL_LOG_ENV === "true"
      ? join(__dirname, "calls.jsonl")
      : CALL_LOG_ENV;
const RUN_ID = randomUUID().slice(0, 8);
const RUN_STARTED_AT = new Date().toISOString();

const CALL_LOG_MAX_BYTES = (() => {
  const mb = Number(process.env.BROWSERCTL_CALL_LOG_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 8 * 1024 * 1024;
})();
// The size on disk, read fresh. The file is not ours alone: it can be truncated, deleted or
// rotated by anything on the machine, and a counter kept in memory would then be wrong for the
// life of the process — rotating early and overwriting a .1 that still held data.
function callLogSize() {
  if (!CALL_LOG_PATH) return 0;
  try {
    return statSync(CALL_LOG_PATH).size;
  } catch {
    return 0;
  }
}
let callSeq = 0;

function paramShape(params) {
  if (!params || typeof params !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) {
      out[k] = "null";
      continue;
    }
    if (typeof v === "string") out[k] = `str:${v.length}`;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = `array:${v.length}`;
    else out[k] = "object";
  }
  return out;
}

function logCall(entry) {
  if (!CALL_LOG_PATH) return;
  try {
    const line = JSON.stringify(entry) + "\n";
    // The cap only holds if the rename succeeded. Resetting the count on a failed rotation
    // would let the file grow past CALL_LOG_MAX_BYTES with nothing to stop it.
    if (callLogSize() + line.length > CALL_LOG_MAX_BYTES) {
      renameSync(CALL_LOG_PATH, CALL_LOG_PATH + ".1");
    }
    appendFileSync(CALL_LOG_PATH, line);
  } catch (_err) {}
}

function statusPayload() {
  return {
    bridgeUrl: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
    extensionConnected: extensionSocket != null,
    runId: RUN_ID,
    callLog: CALL_LOG_PATH || null,
    callLogBytes: CALL_LOG_PATH ? callLogSize() : null,
    callLogMaxBytes: CALL_LOG_PATH ? CALL_LOG_MAX_BYTES : null,
  };
}

// Who is calling, as declared by the caller: a session id that lasts one client process, and a
// source naming the surface it came through. Both are optional and both are free text, so they
// are clamped and never trusted for anything but reading the log back.
function clientTag(client) {
  const pick = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
  return {
    session: pick(client && client.session, 32),
    source: pick(client && client.source, 16),
  };
}

function handleCommand(body, res) {
  const { action, params, client } = body || {};
  if (!action || typeof action !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing 'action'" });
  }

  if (action === "status") {
    return sendJson(res, 200, { ok: true, result: statusPayload() });
  }

  if (action === "exec_system_cmd") {
    const { command, cwd, env, timeoutMs } = params || {};
    if (!command || typeof command !== "string") {
      return sendJson(res, 400, { ok: false, error: "missing 'command' parameter" });
    }
    const timeout = Math.min(Number(timeoutMs) || 30000, 300000);

    const mergedEnv = env && typeof env === "object" ? { ...process.env, ...env } : process.env;

    execa(command, {
      cwd: cwd || undefined,
      env: mergedEnv,
      timeout,
      reject: false,
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
      all: true,
    })
      .then((result) => {
        return sendJson(res, 200, {
          ok: true,
          result: {
            exitCode: result.exitCode ?? (result.failed ? 1 : 0),
            stdout: result.stdout || "",
            stderr: result.stderr || "",
            all: result.all || "",
            failed: Boolean(result.failed),
            timedOut: Boolean(result.timedOut),
            isCanceled: Boolean(result.isCanceled),
            signal: result.signal || null,
            error: result.failed ? result.shortMessage || result.message || null : null,
          },
        });
      })
      .catch((err) => {
        return sendJson(res, 500, {
          ok: false,
          error: String(err.shortMessage || err.message || err),
        });
      });

    return;
  }

  if (action === "upload" || action === "file_upload") {
    const given = Array.isArray(params?.files) ? params.files : params?.file ? [params.file] : [];
    if (given.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "upload needs 'files' (absolute paths on this machine)",
      });
    }
    const bad = [];
    for (const f of given) {
      if (typeof f !== "string" || !isAbsolute(f)) bad.push(`${f} (not an absolute path)`);
      else if (!existsSync(f)) bad.push(`${f} (no such file)`);
      else if (!statSync(f).isFile()) bad.push(`${f} (not a regular file)`);
    }
    if (bad.length) {
      return sendJson(res, 400, {
        ok: false,
        error: `upload cannot read: ${bad.join(", ")}. Chrome opens these paths itself, on this machine, so they must be absolute and must exist.`,
      });
    }
  }

  if (!extensionSocket) {
    return sendJson(res, 503, { ok: false, error: "extension not connected" });
  }

  const id = randomUUID();
  const message = { id, action, params: params || {} };
  const seq = ++callSeq;
  const startedAt = Date.now();
  const who = clientTag(client);
  const record = (ok, extra) =>
    logCall({
      ts: new Date().toISOString(),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      session: who.session,
      source: who.source,
      seq,
      action,
      tabId: (params && (params.tabId ?? params.tab_id)) ?? null,
      params: paramShape(params),
      ok,
      durationMs: Date.now() - startedAt,
      ...(extra || {}),
    });

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
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    record(false, { failure: "send" });
    return sendJson(res, 502, { ok: false, error: "failed to reach extension: " + err.message });
  }

  wait
    .then((reply) => {
      record(!!reply.ok, reply.ok ? null : { code: reply.code || null });
      return sendJson(res, reply.ok ? 200 : 400, reply);
    })
    .catch((err) => {
      record(false, { failure: "timeout" });
      return sendJson(res, 504, { ok: false, error: String(err.message || err) });
    });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const done = (fn, arg) => {
      if (!settled) {
        settled = true;
        fn(arg);
      }
    };
    req.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (raw.length > 5_000_000) {
        raw = "";
        done(reject, new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return done(resolve, {});
      try {
        const parsed = JSON.parse(raw);
        done(resolve, parsed);
      } catch {
        done(reject, new Error("invalid JSON body"));
      }
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

process.on("uncaughtException", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `bridge: cannot listen on ${HOST}:${PORT} — already in use (another bridge running?). Exiting.`
    );
    process.exit(1);
  }
  console.error("uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err);
});

server.listen(PORT, HOST, () => {
  log(`bridge listening on http://${HOST}:${PORT}`);
  log(`extension should connect to ws://${HOST}:${PORT}/extension`);
  if (CALL_LOG_PATH) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    log(
      `call log ON -> ${CALL_LOG_PATH} (${mb(callLogSize())}MB, rotates at ${mb(CALL_LOG_MAX_BYTES)}MB, ` +
        `keeps one .1 file; parameter values are never written). Unset BROWSERCTL_CALL_LOG to stop.`
    );
  }
  if (PORT !== 0) {
    try {
      markDaemonRunning({ pid: process.pid, port: PORT, url: `http://${HOST}:${PORT}` });
    } catch {}
  }
});

export { computeTimeoutMs, server, wss };
