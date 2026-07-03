// Light network capture using chrome.webRequest only (NO chrome.debugger, so no
// "is being debugged" banner). Trade-off: we get method/url/type/status/headers/
// timing but NOT response bodies — that's expected and acceptable here.
//
// MANIFEST REQUIREMENTS (added by the integrator, not here):
//   - "permissions" must include "webRequest"
//   - "host_permissions" must include "<all_urls>"
// Without these the listeners below silently receive nothing.


const MAX_BUFFER = 2000;

// tabIds currently capturing.
const capturing = new Set();

// tabId -> { list: [record], byId: Map(requestId -> record) }
// `list` keeps insertion order (and is what we cap/shift); `byId` gives O(1) merge.
const buffers = new Map();

// tabId -> number of currently in-flight requests. This is maintained for ALL
// tabs, independent of the `capturing` set, so `wait_network_idle` works even
// when detailed capture was never started. Updated in the webRequest listeners
// below (incremented on start, decremented on completion/error, floored at 0).
// Per-tab in-flight requests, tracked by requestId with a start timestamp so a
// request that never reports completion (long-poll, hung socket, aborted on
// navigation) can be pruned by age instead of leaking and blocking idle forever.
const inFlight = new Map(); // tabId -> Map(requestId -> startMs)
const STALE_MS = 15000;

function incInFlight(tabId, requestId) {
  let m = inFlight.get(tabId);
  if (!m) { m = new Map(); inFlight.set(tabId, m); }
  m.set(requestId, Date.now());
}

function decInFlight(tabId, requestId) {
  const m = inFlight.get(tabId);
  if (m) m.delete(requestId);
}

// Count in-flight requests for a tab, pruning any older than STALE_MS first.
function inFlightCount(tabId) {
  const m = inFlight.get(tabId);
  if (!m) return 0;
  const cutoff = Date.now() - STALE_MS;
  for (const [id, ts] of m) if (ts < cutoff) m.delete(id);
  return m.size;
}

function getBuffer(tabId) {
  let b = buffers.get(tabId);
  if (!b) {
    b = { list: [], byId: new Map() };
    buffers.set(tabId, b);
  }
  return b;
}

// Drop all per-tab state for a closed tab. Called from background.js's
// tabs.onRemoved so buffers/inFlight/capturing don't accumulate one entry per
// tab that ever loaded a URL for the life of the service worker.
export function dropTab(tabId) {
  capturing.delete(tabId);
  buffers.delete(tabId);
  inFlight.delete(tabId);
  persistCapturing();
}

function clearBuffer(tabId) {
  buffers.set(tabId, { list: [], byId: new Map() });
}

// Persist which tabs are being captured, so net_get can tell "never started" apart from
// "was capturing, then the service worker recycled and lost the in-memory buffer" — the
// buffered requests can't be recovered, so the goal is an honest error, not a silent
// empty/zero read.
const CAPTURING_KEY = "aibc_net_capturing_tabs";
function persistCapturing() {
  chrome.storage.session.set({ [CAPTURING_KEY]: [...capturing] }).catch(() => {});
}
async function wasCapturingBeforeRestart(tabId) {
  try {
    const { [CAPTURING_KEY]: ids } = await chrome.storage.session.get(CAPTURING_KEY);
    return Array.isArray(ids) && ids.includes(tabId);
  } catch {
    return false;
  }
}

// Convert a webRequest header array ([{name,value}]) to a map (verbatim, no redaction).
function headersToMap(list) {
  const map = {};
  for (const h of list || []) map[h.name] = h.value;
  return map;
}

// Best-effort byte size of a request body from details.requestBody.
function requestBodySize(requestBody) {
  if (!requestBody) return 0;
  let size = 0;
  if (Array.isArray(requestBody.raw)) {
    for (const part of requestBody.raw) {
      if (part.bytes) size += part.bytes.byteLength || 0;
    }
  }
  if (requestBody.formData) {
    for (const values of Object.values(requestBody.formData)) {
      for (const v of values) size += String(v).length;
    }
  }
  return size;
}

// Get-or-create the record for a requestId within the tab's buffer.
// New records are pushed onto the list (and capped) and indexed by requestId.
function getRecord(tabId, requestId) {
  const b = getBuffer(tabId);
  let rec = b.byId.get(requestId);
  if (!rec) {
    rec = { requestId };
    b.byId.set(requestId, rec);
    b.list.push(rec);
    if (b.list.length > MAX_BUFFER) {
      const dropped = b.list.shift();
      if (dropped) b.byId.delete(dropped.requestId);
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// webRequest listeners — registered ONCE at module load, observational only
// (never blocking). We only record events for tabs in `capturing`.
// ---------------------------------------------------------------------------

const FILTER = { urls: ["<all_urls>"] };

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Always track in-flight requests (independent of `capturing`).
    incInFlight(details.tabId, details.requestId);
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.method = details.method;
    rec.url = details.url;
    rec.type = details.type;
    rec.tabId = details.tabId;
    rec.startTime = details.timeStamp;
    rec.requestBodySize = requestBodySize(details.requestBody);
  },
  FILTER,
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.requestHeaders = headersToMap(details.requestHeaders);
  },
  FILTER,
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.statusCode = details.statusCode;
    rec.statusLine = details.statusLine;
    rec.responseHeaders = headersToMap(details.responseHeaders);
  },
  FILTER,
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Always track in-flight requests (independent of `capturing`).
    decInFlight(details.tabId, details.requestId);
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.status = details.statusCode;
    rec.fromCache = details.fromCache;
    rec.ip = details.ip;
    rec.endTime = details.timeStamp;
    rec.done = true;
  },
  FILTER,
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    // Always track in-flight requests (independent of `capturing`).
    decInFlight(details.tabId, details.requestId);
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.error = details.error;
    rec.endTime = details.timeStamp;
    rec.done = true;
  },
  FILTER
);

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

function requireTabId(tabId) {
  if (tabId == null) throw new Error("this net action requires a tabId");
}

// Map a stored record to the brief shape returned to the agent / LLM.
function briefRecord(rec) {
  const timeMs =
    rec.endTime != null && rec.startTime != null
      ? Math.max(0, rec.endTime - rec.startTime)
      : null;
  return {
    method: rec.method,
    url: rec.url,
    type: rec.type,
    status: rec.status != null ? rec.status : rec.statusCode != null ? rec.statusCode : null,
    fromCache: rec.fromCache != null ? rec.fromCache : null,
    ip: rec.ip != null ? rec.ip : null,
    error: rec.error != null ? rec.error : null,
    timeMs,
    // Verbatim, no redaction — this is a local debug aid (see cross-cutting decision).
    requestHeaders: rec.requestHeaders || null,
    responseHeaders: rec.responseHeaders || null,
  };
}

// Resolve once the tab has had no in-flight requests for `idleMs` continuous
// milliseconds, or reject on timeout. Uses the always-on `inFlight` counter, so
// it works regardless of whether detailed capture (`capturing`) is started.
function waitNetworkIdle(tabId, idleMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    // Timestamp when the tab was last observed fully idle (no in-flight requests).
    // Reset to null whenever we see in-flight requests.
    let idleSince = inFlightCount(tabId) === 0 ? start : null;

    const timer = setInterval(() => {
      const now = Date.now();
      const count = inFlightCount(tabId);

      if (count > 0) {
        idleSince = null;
      } else if (idleSince === null) {
        idleSince = now;
      }

      if (idleSince !== null && now - idleSince >= idleMs) {
        clearInterval(timer);
        resolve({ idle: true, waitedMs: now - start });
        return;
      }

      if (now - start >= timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            "wait_network_idle timed out after " +
              timeoutMs +
              "ms (still " +
              count +
              " in flight)"
          )
        );
      }
    }, 100);
  });
}

// Dispatch a network-related action. `tabId` is the resolved active tab.
export async function handleNet(action, params, tabId) {
  switch (action) {
    case "net_start": {
      requireTabId(tabId);
      capturing.add(tabId);
      clearBuffer(tabId);
      persistCapturing();
      return { ok: true, result: { capturing: true, tabId } };
    }

    case "net_stop": {
      requireTabId(tabId);
      capturing.delete(tabId);
      persistCapturing();
      return { ok: true, result: { capturing: false, tabId } };
    }

    case "net_get": {
      requireTabId(tabId);
      if (!capturing.has(tabId) && (await wasCapturingBeforeRestart(tabId))) {
        throw new Error("capture state was reset by a service-worker restart — call net_start again");
      }
      const b = getBuffer(tabId);
      let records = b.list;
      if (params.urlContains) {
        records = records.filter((r) => (r.url || "").includes(params.urlContains));
      }
      const limit = params.limit || 200;
      const newest = records.slice(-limit);
      return {
        ok: true,
        result: {
          count: newest.length,
          capturing: capturing.has(tabId),
          requests: newest.map(briefRecord),
        },
      };
    }

    case "net_clear": {
      requireTabId(tabId);
      clearBuffer(tabId);
      return { ok: true, result: { cleared: true } };
    }

    case "wait_network_idle": {
      requireTabId(tabId);
      const idleMs = params.idleMs != null ? params.idleMs : 500;
      const timeoutMs = params.timeoutMs != null ? params.timeoutMs : 10000;
      const result = await waitNetworkIdle(tabId, idleMs, timeoutMs);
      return { ok: true, result };
    }

    default:
      throw new Error(`unknown net action: ${action}`);
  }
}

export const NET_ACTIONS = ["net_start", "net_stop", "net_get", "net_clear", "wait_network_idle"];
