const MAX_BUFFER = 2000;

const capturing = new Set();

const buffers = new Map();

const inFlight = new Map();
const STALE_MS = 15000;

function incInFlight(tabId, requestId) {
  let m = inFlight.get(tabId);
  if (!m) {
    m = new Map();
    inFlight.set(tabId, m);
  }
  m.set(requestId, Date.now());
}

function decInFlight(tabId, requestId) {
  const m = inFlight.get(tabId);
  if (m) m.delete(requestId);
}

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

export function dropTab(tabId) {
  capturing.delete(tabId);
  buffers.delete(tabId);
  inFlight.delete(tabId);
  persistCapturing();
}

function clearBuffer(tabId) {
  buffers.set(tabId, { list: [], byId: new Map() });
}

const CAPTURING_KEY = "bctl_net_capturing_tabs";
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

function headersToMap(list) {
  const map = {};
  for (const h of list || []) map[h.name] = h.value;
  return map;
}

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

const FILTER = { urls: ["<all_urls>"] };

if (typeof chrome !== "undefined" && chrome?.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
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

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    decInFlight(details.tabId, details.requestId);
    if (!capturing.has(details.tabId)) return;
    const rec = getRecord(details.tabId, details.requestId);
    rec.error = details.error;
    rec.endTime = details.timeStamp;
    rec.done = true;
  }, FILTER);
}

function requireTabId(tabId) {
  if (tabId == null) throw new Error("this net action requires a tabId");
}

function briefRecord(rec) {
  const timeMs =
    rec.endTime != null && rec.startTime != null ? Math.max(0, rec.endTime - rec.startTime) : null;
  return {
    method: rec.method,
    url: rec.url,
    type: rec.type,
    status: rec.status != null ? rec.status : rec.statusCode != null ? rec.statusCode : null,
    fromCache: rec.fromCache != null ? rec.fromCache : null,
    ip: rec.ip != null ? rec.ip : null,
    error: rec.error != null ? rec.error : null,
    timeMs,
    requestHeaders: rec.requestHeaders || null,
    responseHeaders: rec.responseHeaders || null,
  };
}

export function waitNetworkIdle(tabId, idleMs = 500, timeoutMs = 10000, maxInFlight = 0) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let idleSince = inFlightCount(tabId) <= maxInFlight ? start : null;

    const timer = setInterval(() => {
      const now = Date.now();
      const count = inFlightCount(tabId);

      if (count > maxInFlight) {
        idleSince = null;
      } else if (idleSince === null) {
        idleSince = now;
      }

      if (idleSince !== null && now - idleSince >= idleMs) {
        clearInterval(timer);
        resolve({ idle: true, waitedMs: now - start, inFlight: count });
        return;
      }

      if (now - start >= timeoutMs) {
        clearInterval(timer);
        const err = new Error(
          `wait_network_idle timed out after ${timeoutMs}ms (still ${count} in flight). Tip: SPAs with persistent WebSockets or telemetry never reach 0 in-flight; use 'wait --settle' instead or set maxInFlight: 1.`
        );
        err.code = "NETWORK_IDLE_TIMEOUT";
        err.diagnostics = { timeoutMs, inFlight: count, maxInFlight };
        err.recoveryHint =
          "Modern SPAs often keep persistent WebSockets or telemetry active. Use 'wait --settle' (or browser_wait_for with for:'settle') instead, or pass maxInFlight: 1.";
        reject(err);
      }
    }, 100);
  });
}

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
        throw new Error(
          "capture state was reset by a service-worker restart — call net_start again"
        );
      }
      const b = getBuffer(tabId);
      if (!capturing.has(tabId) && b.list.length === 0) {
        const err = new Error(
          "network capture is not running for this tab, so nothing was recorded — this is NOT the same as the page making no requests"
        );
        err.code = "NET_CAPTURE_NOT_STARTED";
        err.recoveryHint =
          "Call net_start, then reload or navigate the page (capture only records requests made after it starts), then net_get.";
        throw err;
      }
      let records = b.list;
      if (params.urlContains) {
        records = records.filter((r) => (r.url || "").includes(params.urlContains));
      }
      const limit = params.limit ?? 200;
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
      const maxInFlight = params.maxInFlight ?? params.tolerance ?? 0;
      const result = await waitNetworkIdle(tabId, idleMs, timeoutMs, maxInFlight);
      return { ok: true, result };
    }

    default:
      throw new Error(`unknown net action: ${action}`);
  }
}

export const NET_ACTIONS = ["net_start", "net_stop", "net_get", "net_clear", "wait_network_idle"];
