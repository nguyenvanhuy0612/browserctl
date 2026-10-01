import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { execa } from "execa";
import { WebSocketServer } from "ws";
import { markDaemonRunning, getStateDir } from "./state.js";
import { createRegistry } from "./registry.js";
import { createLeases } from "./leases.js";
import { createOwners } from "./owners.js";
import { TABLESS_ACTIONS, ID_ACTIONS, isRead, tabOf, tabChoices } from "./routing.js";

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

// Which session holds which tab as its target (see leases.js)
const leases = createLeases({
  ttlMs: envNum("LEASE_TTL_MS", 15_000),
  busyMs: envNum("LEASE_BUSY_MS", 30_000),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  },
});
// Which browser has which tab id, learned from every tab listing (see owners.js)
const owners = createOwners();
// The target of each sticky session (the CLI): session -> {browser, tabId}. A CLI process runs
// one command, so the bridge keeps the tab its next command goes to.
const stickyTargets = new Map();

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

  // A session's heartbeat renews its lease; a release gives its tab up at once
  if (req.method === "POST" && (req.url === "/heartbeat" || req.url === "/release")) {
    return readBody(req)
      .then((body) => {
        const { session } = clientTag(body?.client);
        if (session && req.url === "/heartbeat") leases.touch(session);
        if (session && req.url === "/release") {
          leases.release(session);
          stickyTargets.delete(session);
        }
        sendJson(res, 200, { ok: true });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: String(err.message || err) }));
  }

  if (req.method === "POST" && req.url === "/command") {
    return readBody(req)
      .then((body) => handleCommand(body, res, isLoopback(req)))
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

  // The tabs the browser has open now: a hold or CLI target on any other tab of it is stale (the
  // browser restarted and its tab ids are gone), while a service-worker restart keeps them all
  if (Array.isArray(msg.tabs)) {
    const open = new Set(msg.tabs.filter(Number.isInteger).slice(0, 10_000));
    owners.noteListing(entry.alias, [...open]);
    leases.retainIn(entry.alias, open);
    for (const [session, t] of stickyTargets) {
      if (t.browser === entry.alias && !open.has(t.tabId)) stickyTargets.delete(session);
    }
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

    // A tab closed in the browser, by anyone, is no one's target any more
    if (msg.type === "tab_closed" && Number.isInteger(msg.tabId)) {
      const entry = registry.byConn(ws.connId);
      if (entry) forgetTab(entry.alias, msg.tabId);
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
    // Holds and CLI targets in this browser stay: the tabs it reports when it reconnects decide
    // which of them still exist
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

// On unless BROWSERCTL_CALL_LOG is 0 or false: it is the only record of which session sent a
// command, and several agents share one bridge.
const CALL_LOG_ENV = process.env.BROWSERCTL_CALL_LOG || "";
const CALL_LOG_PATH =
  CALL_LOG_ENV === "0" || CALL_LOG_ENV === "false"
    ? null
    : !CALL_LOG_ENV || CALL_LOG_ENV === "1" || CALL_LOG_ENV === "true"
      ? join(getStateDir(), "calls.jsonl")
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

// The name a lease holder is reported under: its surface and session, e.g. "mcp:1a2b3c4d".
function holderName(holder) {
  return `${holder.source || "unknown"}:${holder.session}`;
}

// Adds `browser` to every tab of a list_tabs reply, and `heldBy` to each tab another live
// session (not `session`) holds, leaving every other field untouched. The listing is also what
// the bridge knows about which tab ids that browser has.
function tagTabs(reply, alias, session) {
  if (!reply.ok || !reply.result || !Array.isArray(reply.result.tabs)) return reply;
  owners.noteListing(
    alias,
    reply.result.tabs.map((t) => t.id)
  );
  const tag = (t) => {
    const holder = leases.holderOf(alias, t.id);
    return {
      ...t,
      browser: alias,
      ...(holder && holder.session !== session ? { heldBy: holderName(holder) } : {}),
    };
  };
  return { ...reply, result: { ...reply.result, tabs: reply.result.tabs.map(tag) } };
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
      const tagged = tagTabs(reply, entry.alias, logCtx.who.session);
      const entryTabs = tagged.ok && Array.isArray(tagged.result?.tabs) ? tagged.result.tabs : [];
      tabs.push(...entryTabs);
      browsers[entry.alias] = {
        type: entry.browserType,
        label: entry.label,
        ok: !!reply.ok,
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
function clientTag(client, local = false) {
  const pick = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
  return {
    // The caller's process, when it runs on this machine: its lease ends when that process does
    pid: local && Number.isInteger(client?.pid) && client.pid > 0 ? client.pid : null,
    session: pick(client && client.session, 32),
    source: pick(client && client.source, 16),
    internal: client?.internal === true,
    // The call acts on the tab it names as its session's target, and takes that tab's lease
    lease: client?.lease === true,
    // The bridge keeps this session's target (the CLI): a call naming no tab goes to it
    sticky: client?.sticky === true,
  };
}

// Every connected browser's tabs, tagged, from a fresh listing of each
async function listEverywhere(session) {
  const replies = await Promise.all(
    registry
      .list()
      .map((e) =>
        sendToEntry(e, "list_tabs", {}, FANOUT_TIMEOUT_MS).then((r) => tagTabs(r, e.alias, session))
      )
  );
  return replies.flatMap((r) => (r.ok && Array.isArray(r.result?.tabs) ? r.result.tabs : []));
}

// The connected browsers that have this tab id: from what the bridge knows, and when that is not
// exactly one, from a fresh listing of every browser.
async function ownersOfTab(tabId, session) {
  const connected = () => {
    const aliases = new Set(registry.list().map((e) => e.alias));
    return owners.ownersOf(tabId).filter((a) => aliases.has(a));
  };
  let found = connected();
  if (found.length !== 1) {
    await listEverywhere(session);
    found = connected();
  }
  return found;
}

// The tab the user sees in one browser: the active tab of its focused window, else its first
// active tab.
async function visibleTab(entry) {
  const reply = await sendToEntry(entry, "list_tabs", {}, computeTimeoutMs("list_tabs", {}));
  if (!reply.ok) return { error: { status: 502, code: reply.code || null, message: reply.error } };
  const tabs = Array.isArray(reply.result?.tabs) ? reply.result.tabs : [];
  owners.noteListing(
    entry.alias,
    tabs.map((t) => t.id)
  );
  const tab = tabs.find((t) => t.focusedWindow) || tabs.find((t) => t.active);
  if (!tab || !Number.isInteger(tab.id)) {
    return {
      error: { status: 409, code: "NEEDS_TAB", message: `${entry.alias} has no open tab` },
    };
  }
  return { tabId: tab.id };
}

function isLoopback(req) {
  const a = req.socket?.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

async function handleCommand(body, res, local = false) {
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
  const who = clientTag(client, local);

  // A session gives its tab up (release), or lets any session take it without asking (yield)
  if (action === "release_tab" || action === "yield_tab") {
    if (!who.session) {
      return sendJson(res, 400, { ok: false, error: `'${action}' needs a session` });
    }
    const had = leases.leaseOf(who.session);
    let result;
    if (action === "release_tab") {
      leases.release(who.session);
      stickyTargets.delete(who.session);
      result = { released: had ? { browser: had.browser, tabId: had.tabId } : null };
    } else {
      result = { yielding: leases.yieldTab(who.session) };
    }
    recordCall({ who, seq, startedAt, action, params, ok: true });
    return sendJson(res, 200, { ok: true, result });
  }

  // list_tabs naming no browser fans out when several are connected, unless the caller asks
  // with fanOut: false for one browser only (the sole connected one; several is NEEDS_BROWSER)
  const fanOutList =
    action === "list_tabs" &&
    (browser === "*" || (!browser && fanOut !== false && registry.list().length > 1));
  if (fanOutList && registry.list().length) {
    return respondFanOutListTabs(params, res, { who, seq, startedAt });
  }

  if (who.session) leases.touch(who.session);
  // A sticky session naming no browser stays in the browser its target is in
  const sticky = who.sticky && who.session ? stickyTargets.get(who.session) || null : null;
  // A tab named by id goes to the browser that has it; one named by nothing goes to the sticky
  // session's target browser
  const namedTab = TABLESS_ACTIONS.has(action) ? null : tabOf(action, params);
  let selector = browser || (namedTab == null ? sticky?.browser : undefined);
  if (!selector && namedTab != null && registry.list().length > 1) {
    const found = await ownersOfTab(namedTab, who.session);
    if (found.length !== 1) {
      const code = found.length ? "AMBIGUOUS_TAB" : "TAB_NOT_FOUND";
      recordCall({ who, seq, startedAt, action, params, ok: false, extra: { code } });
      return sendJson(res, 409, {
        ok: false,
        code,
        error: found.length
          ? `tab id ${namedTab} is open in ${found.join(" and ")}; tab ids repeat across browsers, so name the browser. '${action}' was not sent`
          : `tab ${namedTab} not found in any connected browser; '${action}' was not sent`,
        ...(found.length
          ? {
              recoveryHint: `Name the browser: browser_tabs({action: "select", tabId: ${namedTab}, browser: "${found[0]}"}) (CLI: -b ${found[0]}).`,
            }
          : {}),
        diagnostics: { tabId: namedTab, browsers: found },
      });
    }
    selector = found[0];
  }

  // A CLI command naming no tab and no browser, with no target yet and several browsers
  // connected: nothing is guessed. It is NEEDS_TARGET, listing every tab to choose from.
  if (
    who.sticky &&
    !selector &&
    !TABLESS_ACTIONS.has(action) &&
    namedTab == null &&
    registry.list().length > 1
  ) {
    const tabs = await listEverywhere(who.session);
    recordCall({ who, seq, startedAt, action, params, ok: false, extra: { code: "NEEDS_TARGET" } });
    return sendJson(res, 409, {
      ok: false,
      code: "NEEDS_TARGET",
      error:
        `several browsers are connected and this session has no tab yet; '${action}' was not sent. ` +
        `Choose one with 'tab switch <id>' (or -b <browser>). Open tabs:\n${tabChoices(tabs)}`,
    });
  }

  // An entry whose socket is gone is treated as disconnected: it leaves the registry and the
  // selector is resolved again, exactly as if that browser had never been there
  let route = registry.resolve(fanOutList ? null : selector);
  while (route.entry && sockets.get(route.entry.connId)?.readyState !== 1) {
    registry.remove(route.entry.connId);
    route = registry.resolve(selector);
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
  // The params as sent, once the bridge has filled in the tab, so the log names the real tab
  let loggedParams = params;
  const record = (ok, extra) =>
    recordCall({
      who,
      seq,
      startedAt,
      action,
      params: loggedParams,
      instanceId: entry.instanceId,
      browser: entry.alias,
      ok,
      extra,
    });

  // Reloading the extension drops every session's debugger, capture and recording in that
  // browser, so it waits while another session is acting there
  if (action === "reload_extension") {
    const busy = leases.busyIn(entry.alias, who.session);
    if (busy) {
      record(false, { code: "BROWSER_BUSY", holder: holderName(busy.holder) });
      return sendJson(res, 409, {
        ok: false,
        code: "BROWSER_BUSY",
        error: `${holderName(busy.holder)} is acting in ${entry.alias}; reloading the extension now would break its work. '${action}' was not sent`,
        recoveryHint: `Try again in ${Math.ceil(busy.retryInMs / 1000)}s.`,
        browser: entry.alias,
      });
    }
  }

  // Every tab command leaves the bridge naming its tab, and never lands in a tab another
  // session holds unless it only reads it.
  let sendParams = params || {};
  let claimed = null;
  let took = null;
  let tracking = false;
  const done = () => {
    if (tracking) leases.end(who.session);
  };
  // What the session held, and the tab's previous holder when this call takes it, taken just
  // before the claim so a failed send can put both back
  let previous = null;
  let tookFrom = null;
  if (!TABLESS_ACTIONS.has(action)) {
    let tabId = tabOf(action, sendParams);
    if (tabId != null && ID_ACTIONS.has(action) && sendParams.id == null) {
      sendParams = { ...sendParams, id: tabId };
    }
    let claiming = who.lease;
    if (tabId == null) {
      if (!who.sticky) {
        record(false, { code: "NEEDS_TAB" });
        return sendJson(res, 400, {
          ok: false,
          code: "NEEDS_TAB",
          error: `'${action}' names no tab: send the tab id it acts on`,
          browser: entry.alias,
        });
      }
      if (sticky && sticky.browser === entry.alias) {
        tabId = sticky.tabId;
      } else {
        const picked = await visibleTab(entry);
        if (picked.error) {
          record(false, { code: picked.error.code });
          return sendJson(res, picked.error.status, {
            ok: false,
            code: picked.error.code,
            error: picked.error.message,
            browser: entry.alias,
          });
        }
        tabId = picked.tabId;
      }
      sendParams = ID_ACTIONS.has(action) ? { ...sendParams, id: tabId } : { ...sendParams, tabId };
      loggedParams = sendParams;
      claiming = true;
    } else if (who.sticky && action === "switch_tab") {
      claiming = true;
    }
    // Selecting a tab is how a session asks to take one another session holds; `force` confirms
    const taking = claiming && action === "switch_tab";
    const force = sendParams.force === true;
    if ("force" in sendParams) {
      const { force: _force, ...rest } = sendParams;
      sendParams = rest;
    }
    if (claiming && who.session) {
      // This session's own tab was taken from it: it is told once, and nothing is sent
      const notice = leases.takeNotice(who.session, entry.alias, tabId);
      if (notice) {
        if (who.sticky) stickyTargets.delete(who.session);
        return refuseTaken(res, record, { action, alias: entry.alias, tabId, notice });
      }
      previous = {
        lease: leases.leaseOf(who.session),
        sticky: stickyTargets.get(who.session) || null,
      };
      const heldBy = leases.holderOf(entry.alias, tabId);
      const heldLease =
        heldBy && heldBy.session !== who.session ? leases.leaseOf(heldBy.session) : null;
      const got = leases.claim(who.session, who.source, entry.alias, tabId, {
        keep: who.sticky,
        pid: who.pid,
        take: taking,
        force,
      });
      if (!got.ok) {
        const refusal = { action, alias: entry.alias, tabId, holder: got.holder };
        if (got.reason === "busy") return refuseBusy(res, record, { ...refusal, got });
        if (got.reason === "confirm") return refuseConfirm(res, record, { ...refusal, got });
        return refuseOwned(res, record, refusal);
      }
      if (got.took) {
        took = { from: holderName(got.took), forced: got.forced };
        tookFrom = { session: got.took.session, lease: heldLease };
      }
      if (who.sticky) stickyTargets.set(who.session, { browser: entry.alias, tabId });
      claimed = tabId;
    } else {
      const holder = leases.holderOf(entry.alias, tabId);
      if (holder && holder.session !== who.session && !isRead(action, sendParams)) {
        return refuseOwned(res, record, { action, alias: entry.alias, tabId, holder });
      }
    }
    // A command on the session's own tab keeps it busy, so no one takes it mid-action
    const own = who.session ? leases.holderOf(entry.alias, tabId) : null;
    if (own && own.session === who.session) {
      leases.begin(who.session);
      tracking = true;
    }
  }

  // Puts back what this call's claim changed: the session's own lease and target, and the lease
  // of the session it took the tab from, whose notice is withdrawn.
  const restorePrevious = () => {
    leases.restore(who.session, previous.lease);
    if (previous.sticky) stickyTargets.set(who.session, previous.sticky);
    else stickyTargets.delete(who.session);
    if (tookFrom) {
      leases.restore(tookFrom.session, tookFrom.lease);
      leases.takeNotice(tookFrom.session, entry.alias, claimed);
    }
  };
  // A claim whose tab turned out not to exist is taken back: a session whose own target died
  // is left with none, and one that tried to move to a missing tab keeps the target it had.
  const undoClaim = () => {
    if (claimed == null) return;
    const hadIt =
      previous.lease && previous.lease.browser === entry.alias && previous.lease.tabId === claimed;
    if (hadIt) {
      leases.release(who.session);
      stickyTargets.delete(who.session);
      return;
    }
    restorePrevious();
  };

  loggedParams = sendParams;
  const ws = sockets.get(entry.connId);
  const id = randomUUID();
  const message = { id, action, params: sendParams };
  const leaseLog = took
    ? { lease: took.forced ? "forced" : "taken", from: took.from }
    : claimed != null
      ? { lease: "claimed" }
      : {};

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
    done();
    if (claimed != null) restorePrevious();
    record(false, { failure: "send" });
    return sendJson(res, 502, {
      ok: false,
      error: "failed to reach extension: " + err.message,
      browser: entry.alias,
    });
  }

  wait
    .then((reply) => {
      done();
      let outgoing = action === "list_tabs" ? tagTabs(reply, entry.alias, who.session) : reply;
      if (outgoing.ok && took) {
        outgoing = {
          ...outgoing,
          result: {
            ...outgoing.result,
            took,
            warning:
              `took tab ${claimed} from ${took.from}` +
              (took.forced ? " by force" : ", which had yielded it") +
              "; that session is told on its next command",
          },
        };
      }
      if (outgoing.ok) afterReply(action, sendParams, outgoing.result, entry.alias, who);
      else if (TAB_GONE.test(outgoing.error || "")) undoClaim();
      const bytes = (() => {
        try {
          return JSON.stringify(outgoing.result ?? outgoing).length;
        } catch {
          return null;
        }
      })();
      record(!!outgoing.ok, {
        bytes,
        ...leaseLog,
        // A new tab's id exists only in the reply; the log names it like any other tab
        ...(action === "new_tab" && Number.isInteger(outgoing.result?.id)
          ? { tabId: outgoing.result.id }
          : {}),
        ...(outgoing.ok ? null : { code: outgoing.code || null }),
      });
      return sendJson(res, outgoing.ok ? 200 : 400, { ...outgoing, browser: entry.alias });
    })
    .catch((err) => {
      done();
      record(false, { failure: "timeout" });
      return sendJson(res, 504, {
        ok: false,
        error: String(err.message || err),
        browser: entry.alias,
      });
    });
}

// The extension's and Chrome's ways of saying a tab id names no open tab
const TAB_GONE = /^(tab \d+ not found|No tab with id)/;

// TAB_OWNED: the command would act on, or take, a tab another live session holds. Nothing is sent.
function refuseOwned(res, record, { action, alias, tabId, holder }) {
  const seenS = Math.round((Date.now() - holder.lastSeen) / 1000);
  record(false, { code: "TAB_OWNED", lease: "refused", holder: holderName(holder) });
  return sendJson(res, 409, {
    ok: false,
    code: "TAB_OWNED",
    error:
      `tab ${tabId} in ${alias} is the target of another session ` +
      `(${holderName(holder)}, active ${seenS}s ago); '${action}' was not sent`,
    recoveryHint:
      'Work in a tab of your own: browser_tabs({action: "new", url}) (CLI: browserctl tab new <url>). ' +
      'If the user wants this tab, browser_tabs({action: "select", tabId}) asks to take it. ' +
      "Reading it by its tab id is allowed. Do not work around this.",
    diagnostics: { tabId, heldBy: holderName(holder) },
    browser: alias,
  });
}

// TAB_BUSY: the holder is mid-action, or finished one moments ago. Not even force takes it.
function refuseBusy(res, record, { action, alias, tabId, holder, got }) {
  const waitS = Math.ceil(got.retryInMs / 1000);
  record(false, { code: "TAB_BUSY", lease: "refused", holder: holderName(holder) });
  return sendJson(res, 409, {
    ok: false,
    code: "TAB_BUSY",
    error:
      `tab ${tabId} in ${alias} is in use by ${holderName(holder)}: it is acting there now or ` +
      `did moments ago; '${action}' was not sent`,
    recoveryHint: `Try again in ${waitS}s. A tab is never taken mid-action, with or without force.`,
    diagnostics: { tabId, heldBy: holderName(holder), retryInMs: got.retryInMs },
    browser: alias,
  });
}

// TAKE_CONFIRM: the holder is idle, so the tab can be taken, but only when asked again with force.
function refuseConfirm(res, record, { alias, tabId, holder, got }) {
  const idleS = Math.round(got.idleMs / 1000);
  record(false, { code: "TAKE_CONFIRM", lease: "refused", holder: holderName(holder) });
  return sendJson(res, 409, {
    ok: false,
    code: "TAKE_CONFIRM",
    error:
      `tab ${tabId} in ${alias} is held by ${holderName(holder)}, idle for ${idleS}s; ` +
      `taking it ends that session's hold`,
    recoveryHint:
      "Take it only if the user asked for this tab: send the same select again with force: true " +
      "(CLI: --force). Otherwise open a tab of your own.",
    diagnostics: { tabId, heldBy: holderName(holder), idleMs: got.idleMs },
    browser: alias,
  });
}

// TARGET_TAKEN: another session took this session's tab. Told once; nothing is sent.
function refuseTaken(res, record, { action, alias, tabId, notice }) {
  const by = `${notice.bySource || "unknown"}:${notice.by}`;
  record(false, { code: "TARGET_TAKEN", lease: "taken", holder: by });
  return sendJson(res, 409, {
    ok: false,
    code: "TARGET_TAKEN",
    error:
      `your target tab ${tabId} in ${alias} was taken by ${by}` +
      (notice.forced ? " by force" : " after you yielded it") +
      `; '${action}' was not sent, and you have no target`,
    recoveryHint:
      'browser_tabs({action: "new", url}) or select another tab. Tell the user the tab was taken.',
    diagnostics: { tabId, takenBy: by, forced: notice.forced },
    browser: alias,
  });
}

function forgetTab(alias, tabId) {
  owners.remove(alias, tabId);
  leases.releaseTab(alias, tabId);
  for (const [session, t] of stickyTargets) {
    if (t.browser === alias && t.tabId === tabId) stickyTargets.delete(session);
  }
}

// A new tab becomes the target of the session that opened it; a closed tab is held by no one.
function afterReply(action, params, result, alias, who) {
  if (action === "new_tab" && Number.isInteger(result?.id)) owners.add(alias, result.id);
  if (action === "new_tab" && (who.lease || who.sticky) && who.session) {
    if (Number.isInteger(result?.id)) {
      leases.claim(who.session, who.source, alias, result.id, { keep: who.sticky, pid: who.pid });
      if (who.sticky) stickyTargets.set(who.session, { browser: alias, tabId: result.id });
    }
  }
  if (action === "close_tab" && Number.isInteger(params.id)) forgetTab(alias, params.id);
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
        `keeps one .1 file; parameter values are never written). Set BROWSERCTL_CALL_LOG=0 to stop.`
    );
  }
  if (PORT !== 0) {
    try {
      markDaemonRunning({ pid: process.pid, port: PORT, url: `http://${HOST}:${PORT}` });
    } catch {}
  }
});

export { computeTimeoutMs, server, wss };
