import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { WebSocketServer } from "ws";
import { markDaemonRunning, getStateDir } from "./state.js";
import { createRegistry } from "./registry.js";

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
const WAIT_ACTIONS = new Set(["wait_for", "wait_settle", "wait_network_idle"]);
const TIMEOUT_BUFFER_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;
const HEARTBEAT_MS = envNum("HEARTBEAT_MS", 20_000);
const FANOUT_TIMEOUT_MS = envNum("FANOUT_TIMEOUT_MS", 3_000);
const CLONE_PROBE_MS = envNum("CLONE_PROBE_MS", 1_500);
const MAX_WS_PAYLOAD_BYTES = envNum("MAX_WS_PAYLOAD_BYTES", 100 * 1024 * 1024);

function computeTimeoutMs(action, params) {
  let ms = ACTION_TIMEOUT_MS[action] || COMMAND_TIMEOUT_MS;
  if (WAIT_ACTIONS.has(action)) {
    const requested = Number(params && params.timeoutMs);
    if (Number.isFinite(requested) && requested > 0) ms = requested + TIMEOUT_BUFFER_MS;
  }
  return Math.min(ms, MAX_TIMEOUT_MS);
}

const registry = createRegistry({ aliasFile: join(getStateDir(), "browsers.json") });
const sockets = new Map();

const pending = new Map();

// Waiters for a probed connId: connId -> Set<resolve(alive: boolean)>. Several probes can be in
// flight against the same holder at once (two clones racing in); a pong resolves every waiter on
// that connection, and each waiter removes only itself (by its own pong or its own timeout), so
// one probe settling never touches another's entry.
const cloneProbes = new Map();

// Pings a connection and waits up to `ms` for its pong. Resolves `true` when the pong arrives,
// `false` when it does not, the socket is already gone, or sending the ping fails. Never rejects.
function probeAlive(ws, ms) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve(false);
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      const waiters = cloneProbes.get(ws.connId);
      if (waiters) {
        waiters.delete(finish);
        if (waiters.size === 0) cloneProbes.delete(ws.connId);
      }
      resolve(alive);
    };
    if (!cloneProbes.has(ws.connId)) cloneProbes.set(ws.connId, new Set());
    cloneProbes.get(ws.connId).add(finish);
    setTimeout(() => finish(false), ms);
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      finish(false);
    }
  });
}

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

// Rejects every command in flight on one connection, leaving other connections' pending
// commands untouched.
function rejectPendingFor(connId, reason) {
  for (const [id, entry] of pending) {
    if (entry.connId !== connId) continue;
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: reason });
    pending.delete(id);
  }
}

// A hello field is shown in /status and written to the log: keep it a short, single-line string.
function helloField(value, max) {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return clean || null;
}

// A hello whose instanceId is already held by another live connection probes that holder with a
// ping. A holder that answers keeps its identity, and the newcomer is admitted under a new id
// and told so with a `welcome` frame (a copied profile directory). A holder that stays silent is
// treated as stale and replaced.
async function handleHello(ws, msg) {
  // A hello counts only from a socket the bridge holds; a replaced or closed one names no browser
  if (sockets.get(ws.connId) !== ws) return;
  const instanceId = helloField(msg.instanceId, 64);
  const browserType = helloField(msg.browserType, 32) || "unknown";
  const label = helloField(msg.label, 40);
  const focused = msg.focused === true;

  const holder = instanceId ? registry.byInstance(instanceId) : null;
  let admitId = instanceId;
  let cloned = false;
  if (holder && holder.connId !== ws.connId) {
    const holderWs = sockets.get(holder.connId);
    const alive = await probeAlive(holderWs, CLONE_PROBE_MS);
    // The newcomer may have closed while the probe waited; its close already left the registry
    if (ws.readyState !== 1 || sockets.get(ws.connId) !== ws) return;
    if (alive) {
      admitId = `${instanceId}_${randomUUID().replace(/-/g, "").slice(0, 4)}`;
      cloned = true;
    }
  }

  const entry = registry.admit({
    connId: ws.connId,
    instanceId: admitId,
    browserType,
    label,
    focused,
  });

  if (cloned) {
    try {
      ws.send(JSON.stringify({ type: "welcome", instanceId: admitId }));
    } catch {}
  } else if (holder && holder.connId !== ws.connId) {
    const old = sockets.get(holder.connId);
    sockets.delete(holder.connId);
    rejectPendingFor(holder.connId, "extension disconnected");
    try {
      old?.close(1000, "replaced by same instance");
    } catch {}
  }

  log(
    `extension instance '${entry.instanceId}' registered as ${entry.alias} (${entry.browserType})`
  );
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.connId = randomUUID();
  sockets.set(ws.connId, ws);
  registry.admit({ connId: ws.connId, instanceId: null, browserType: null, focused: false });
  log("extension connected");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "hello") {
      handleHello(ws, msg).catch((err) => log("hello handling failed:", err.message));
      return;
    }

    if (msg.type === "focus") {
      registry.touchFocus(ws.connId, msg.focused === true);
      return;
    }

    if (msg.type === "pong") {
      ws.isAlive = true;
      const waiters = cloneProbes.get(ws.connId);
      if (waiters) for (const finish of [...waiters]) finish(true);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry || entry.connId !== ws.connId) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  });

  ws.on("close", () => {
    sockets.delete(ws.connId);
    registry.remove(ws.connId);
    const reason = ws.bctlOversized ? "payload too large" : "extension disconnected";
    rejectPendingFor(ws.connId, reason);
    log(ws.bctlOversized ? "extension disconnected (payload too large)" : "extension disconnected");
  });

  ws.on("error", (err) => {
    log("extension socket error:", err.message);
    if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") ws.bctlOversized = true;
  });
});

const heartbeat = setInterval(() => {
  for (const ws of sockets.values()) {
    if (ws.isAlive === false) {
      log("extension heartbeat timeout; dropping stale socket");
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
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
  const browsers = registry.list();
  return {
    bridgeUrl: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
    extensionConnected: browsers.length > 0,
    browsers: browsers.map((e) => ({
      alias: e.alias,
      browserType: e.browserType,
      label: e.label,
      instanceId: e.instanceId,
      legacy: e.legacy,
      connectedAt: e.connectedAt,
      lastFocusedAt: e.lastFocusedAt,
    })),
    runId: RUN_ID,
    pid: process.pid,
    callLog: CALL_LOG_PATH || null,
    callLogBytes: CALL_LOG_PATH ? callLogSize() : null,
    callLogMaxBytes: CALL_LOG_PATH ? CALL_LOG_MAX_BYTES : null,
  };
}

// The shape a routing error reports each candidate browser in: enough to read and to select by.
function browserSummary(e) {
  return { alias: e.alias, browserType: e.browserType, label: e.label };
}

// Sends one command to one registry entry and resolves with its reply, or a synthetic failure
// reply if the socket is gone, sending fails, or no reply arrives within `timeoutMs`. Used for
// fan-out, where one slow or dead browser must never block the others.
function sendToEntry(entry, action, params, timeoutMs) {
  const ws = sockets.get(entry.connId);
  if (!ws || ws.readyState !== 1) {
    return Promise.resolve({ ok: false, error: "extension disconnected" });
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `command '${action}' timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, {
      connId: entry.connId,
      timer,
      reject: () => {},
      resolve: (reply) => {
        clearTimeout(timer);
        resolve(reply);
      },
    });
    try {
      ws.send(JSON.stringify({ id, action, params: params || {} }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: "failed to reach extension: " + err.message });
    }
  });
}

// Adds `browser` to every tab of a list_tabs reply, leaving every other field (including
// `pinned`) untouched.
function tagTabs(reply, alias) {
  if (!reply.ok || !reply.result || !Array.isArray(reply.result.tabs)) return reply;
  return {
    ...reply,
    result: { ...reply.result, tabs: reply.result.tabs.map((t) => ({ ...t, browser: alias })) },
  };
}

// list_tabs fanned out to every connected browser in parallel: every tab carries the alias that
// served it, and a slow or dead browser is reported per-alias without holding up the rest. Each
// browser's result is call-logged individually, sharing the one HTTP request's `seq`.
function respondFanOutListTabs(params, res, logCtx) {
  const entries = registry.list();
  Promise.all(
    entries.map((entry) =>
      sendToEntry(entry, "list_tabs", params, FANOUT_TIMEOUT_MS).then((reply) => ({ entry, reply }))
    )
  ).then((results) => {
    const tabs = [];
    const browsers = {};
    for (const { entry, reply } of results) {
      const tagged = tagTabs(reply, entry.alias);
      const entryTabs = tagged.ok && Array.isArray(tagged.result?.tabs) ? tagged.result.tabs : [];
      tabs.push(...entryTabs);
      browsers[entry.alias] = {
        type: entry.browserType,
        label: entry.label,
        ok: !!reply.ok,
        pinned: reply.ok && reply.result ? (reply.result.pinned ?? null) : null,
        ...(reply.ok ? null : { error: reply.error || "error" }),
      };
      recordCall({
        ...logCtx,
        action: "list_tabs",
        params,
        instanceId: entry.instanceId,
        browser: entry.alias,
        ok: !!reply.ok,
        extra: { fanout: true, ...(reply.ok ? null : { code: reply.code || null }) },
      });
    }
    sendJson(res, 200, { ok: true, result: { tabs, browsers } });
  });
}

// One call-log line: shared request context (session/source/seq/startedAt) plus which browser
// served it and whether it succeeded.
function recordCall({ who, seq, startedAt, action, params, instanceId, browser, ok, extra }) {
  logCall({
    // A command the caller sent for its own bookkeeping, not one its agent asked for
    ...(who.internal ? { internal: true } : null),
    // The response size is what a page read actually costs an agent, and the only honest way
    // to compare two runs: token totals carry the agent's own reasoning, which varies far more
    // between runs than the payload does.
    ts: new Date().toISOString(),
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    session: who.session,
    source: who.source,
    instanceId,
    browser,
    seq,
    action,
    tabId: (params && (params.tabId ?? params.tab_id)) ?? null,
    params: paramShape(params),
    ok,
    durationMs: Date.now() - startedAt,
    ...(extra || {}),
  });
}

// Who is calling, as declared by the caller: a session id that lasts one client process, and a
// source naming the surface it came through. Both are optional and both are free text, so they
// are clamped and never trusted for anything but reading the log back.
function clientTag(client) {
  const pick = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
  return {
    session: pick(client && client.session, 32),
    source: pick(client && client.source, 16),
    internal: client?.internal === true,
  };
}

function handleCommand(body, res) {
  const { action, params, client, browser, fanOut } = body || {};
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

  const seq = ++callSeq;
  const startedAt = Date.now();
  const who = clientTag(client);

  // list_tabs naming no browser fans out when several are connected, unless the caller asks
  // for the default browser alone with fanOut: false
  const fanOutList =
    action === "list_tabs" &&
    (browser === "*" || (!browser && fanOut !== false && registry.list().length > 1));
  if (fanOutList && registry.list().length) {
    return respondFanOutListTabs(params, res, { who, seq, startedAt });
  }

  // An entry whose socket is gone is treated as disconnected: it leaves the registry and the
  // selector is resolved again, exactly as if that browser had never been there
  let route = registry.resolve(fanOutList ? null : browser);
  while (route.entry && sockets.get(route.entry.connId)?.readyState !== 1) {
    registry.remove(route.entry.connId);
    route = registry.resolve(browser);
  }
  if (route.error) {
    return sendJson(res, 409, {
      ok: false,
      code: route.error.code,
      error: route.error.message,
      data: { browsers: route.error.candidates.map(browserSummary) },
    });
  }
  const entry = route.entry;
  const ws = sockets.get(entry.connId);

  const id = randomUUID();
  const message = { id, action, params: params || {} };
  const record = (ok, extra) =>
    recordCall({
      who,
      seq,
      startedAt,
      action,
      params,
      instanceId: entry.instanceId,
      browser: entry.alias,
      ok,
      extra,
    });

  const timeoutMs = computeTimeoutMs(action, params);
  const wait = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`command '${action}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { connId: entry.connId, resolve, reject, timer });
  });

  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    const pendingEntry = pending.get(id);
    if (pendingEntry) {
      clearTimeout(pendingEntry.timer);
      pending.delete(id);
    }
    record(false, { failure: "send" });
    return sendJson(res, 502, {
      ok: false,
      error: "failed to reach extension: " + err.message,
      browser: entry.alias,
    });
  }

  wait
    .then((reply) => {
      const outgoing = action === "list_tabs" ? tagTabs(reply, entry.alias) : reply;
      const bytes = (() => {
        try {
          return JSON.stringify(outgoing.result ?? outgoing).length;
        } catch {
          return null;
        }
      })();
      record(!!outgoing.ok, { bytes, ...(outgoing.ok ? null : { code: outgoing.code || null }) });
      return sendJson(res, outgoing.ok ? 200 : 400, { ...outgoing, browser: entry.alias });
    })
    .catch((err) => {
      record(false, { failure: "timeout" });
      return sendJson(res, 504, {
        ok: false,
        error: String(err.message || err),
        browser: entry.alias,
      });
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
