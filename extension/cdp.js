import { truncate } from "./util.js";

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 2000;

const sessions = new Map();

const lastCapture = {};
export function isAttached(tabId) {
  return sessions.has(tabId);
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const IS_MAC = /Mac/i.test((globalThis.navigator && navigator.userAgent) || "");
const MOD_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const NAMED_VK = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  " ": 32,
};
function modMask(mods) {
  let m = 0;
  for (const x of mods || []) m |= MOD_BITS[String(x).toLowerCase()] || 0;
  return m;
}
function vkOf(key) {
  if (!key) return 0;
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : NAMED_VK[key] || 0;
}
const NAMED_CODE = {
  " ": "Space",
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
};
function codeOf(key) {
  if (!key) return undefined;
  if (NAMED_CODE[key]) return NAMED_CODE[key];
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return "Key" + key.toUpperCase();
    if (/[0-9]/.test(key)) return "Digit" + key;
  }
  return undefined;
}
function macCommands(key, mods) {
  if (!IS_MAC) return [];
  const set = new Set((mods || []).map((x) => String(x).toLowerCase()));
  if (!(set.has("meta") || set.has("command") || set.has("cmd"))) return [];
  const k = (key || "").toLowerCase();
  const shift = set.has("shift");
  if (k === "a") return ["selectAll"];
  if (k === "z") return shift ? ["redo"] : ["undo"];
  if (k === "c") return ["copy"];
  if (k === "v") return ["paste"];
  if (k === "x") return ["cut"];
  return [];
}
const captureScale = (tabId) => (lastCapture[tabId] && lastCapture[tabId].scale) || 1;

export function setLastCaptureScale(tabId, scale) {
  lastCapture[tabId] = { scale };
}

async function requireForegroundForInput(tabId, what) {
  let tab, win;
  try {
    tab = await chrome.tabs.get(tabId);
    win = await chrome.windows.get(tab.windowId);
  } catch {
    return;
  }
  if (tab.active && win.focused) return;
  const why = !tab.active
    ? "the tab is not the active tab in its window"
    : "its window is not focused";
  throw new Error(
    `${what} needs the target tab in the foreground (${why}). Chrome silently drops CDP ` +
      `synthetic input for background tabs. Either foreground it first ` +
      `(switch_tab {id, focus:true} — this steals focus), or use a DOM-level equivalent that ` +
      `works in the background: click / click_selector / type / fill_selector / hover / ` +
      `select_option by ref or selector, insert_text for text entry, or press_key with ` +
      `allowSynthetic:true for a synthetic key event.`
  );
}

function attachOnce(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve();
    });
  });
}

async function attach(tabId) {
  try {
    await attachOnce(tabId);
  } catch (err) {
    if (!/another debugger is already attached/i.test(err.message || "")) throw err;
    try {
      await detach(tabId);
    } catch {}
    try {
      await attachOnce(tabId);
    } catch {
      throw new Error(
        "another debugger is already attached to this tab \u2014 Chrome allows only one. " +
          "Close DevTools on that tab (or stop the other automation tool holding it), or drive a different tab."
      );
    }
  }
  try {
    await sendRaw(tabId, "Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch {}
}

function detach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve();
    });
  });
}

function sendRaw(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(res);
    });
  });
}

async function enableDomains(tabId) {
  await sendRaw(tabId, "Network.enable");
  await sendRaw(tabId, "Runtime.enable");
  await sendRaw(tabId, "Log.enable");
  await sendRaw(tabId, "Page.enable");
}

async function send(tabId, method, params = {}) {
  try {
    return await sendRaw(tabId, method, params);
  } catch (e) {
    if (/debugger is not attached/i.test(e.message || "")) {
      await attach(tabId);
      const s = sessions.get(tabId);
      try {
        if (s && s.domainsEnabled) await enableDomains(tabId);
        else await sendRaw(tabId, "Page.enable");
      } catch {}
      return await sendRaw(tabId, method, params);
    }
    throw e;
  }
}

const ATTACHED_KEY = "bctl_cdp_attached_tabs";
function persistAttached() {
  chrome.storage.session.set({ [ATTACHED_KEY]: [...sessions.keys()] }).catch(() => {});
}

// Page events are on for every session, however it was attached: a JavaScript dialog is only
// reported (Page.javascriptDialogOpening) once Page.enable has run.
export async function ensureAttached(tabId) {
  if (!sessions.has(tabId)) {
    await attach(tabId);
    sessions.set(tabId, { console: [], network: new Map(), domainsEnabled: false });
    persistAttached();
    try {
      await sendRaw(tabId, "Page.enable");
    } catch {}
  }
  return sessions.get(tabId);
}

export async function captureViewport(tabId, { format = "jpeg", quality = 55 } = {}) {
  await ensureAttached(tabId);
  const fmt = format === "png" ? "png" : "jpeg";
  let clip;
  let dpr = 1;
  try {
    const m = await send(tabId, "Page.getLayoutMetrics");
    const vp = m.cssVisualViewport || m.cssLayoutViewport || m.visualViewport || {};
    const w = Math.round(vp.clientWidth || 0);
    const h = Math.round(vp.clientHeight || 0);
    const devVp = m.visualViewport || {};
    if (w && devVp.clientWidth) dpr = Math.max(1, devVp.clientWidth / w);
    if (w && h) {
      const MAX_SIDE = 1568;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const x = Math.round(vp.pageX || 0);
      const y = Math.round(vp.pageY || 0);
      clip = { x, y, width: w, height: h, scale };
    }
  } catch {}
  lastCapture[tabId] = { scale: (clip ? clip.scale : 1) * dpr };
  const shoot = (q) =>
    send(tabId, "Page.captureScreenshot", {
      format: fmt,
      ...(fmt === "jpeg" ? { quality: q } : {}),
      ...(clip ? { clip } : {}),
      captureBeyondViewport: false,
      fromSurface: true,
    });
  let res = await shoot(quality);
  if (fmt === "jpeg" && res.data.length > 500000) res = await shoot(30);
  return { dataUrl: `data:image/${fmt};base64,${res.data}` };
}

function requireSession(tabId) {
  const s = sessions.get(tabId);
  if (!s) throw new Error("not attached: call cdp_attach first");
  return s;
}

async function requireSessionOrExplainReset(tabId) {
  const s = sessions.get(tabId);
  if (s) return s;
  try {
    const { [ATTACHED_KEY]: ids } = await chrome.storage.session.get(ATTACHED_KEY);
    if (Array.isArray(ids) && ids.includes(tabId)) {
      throw new Error(
        "capture state was reset by a service-worker restart — call cdp_attach again"
      );
    }
  } catch (e) {
    if (/service-worker restart/.test(e.message || "")) throw e;
  }
  throw new Error("not attached: call cdp_attach first");
}

async function requireDomains(tabId) {
  const s = await requireSessionOrExplainReset(tabId);
  if (!s.domainsEnabled) {
    await enableDomains(tabId);
    s.domainsEnabled = true;
  }
  return s;
}

function remoteToString(o) {
  if (!o) return "";
  if (o.value !== undefined)
    return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.description) return o.description;
  return o.type || "";
}

const dialogs = new Map();

export function armDialog(tabId, { action = "dismiss", promptText } = {}) {
  dialogs.set(tabId, {
    armed: { accept: action === "accept", promptText },
    answered: null,
    open: null,
  });
}

export function takeDialogRecord(tabId) {
  const d = dialogs.get(tabId);
  if (!d) return null;
  dialogs.delete(tabId);
  return d.answered || (d.open ? { ...d.open, answered: null } : null);
}

export function pendingDialog(tabId) {
  const d = dialogs.get(tabId);
  return d && d.open ? d.open : null;
}

export async function handleDialog(tabId, { action = "dismiss", promptText } = {}) {
  const open = pendingDialog(tabId);
  if (!open) {
    const err = new Error("no JavaScript dialog is open on this tab");
    err.code = "NO_DIALOG";
    throw err;
  }
  await sendRaw(tabId, "Page.handleJavaScriptDialog", {
    accept: action === "accept",
    ...(promptText !== undefined ? { promptText } : {}),
  });
  const d = dialogs.get(tabId);
  d.answered = { ...open, answered: action, promptText: promptText ?? null };
  d.open = null;
  return d.answered;
}

// Each pending action on a tab has its own waiter; removing one leaves the others in place.
const dialogWaiters = new Map();
export function onDialogOpened(tabId, fn) {
  if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
  const set = dialogWaiters.get(tabId);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && dialogWaiters.get(tabId) === set) dialogWaiters.delete(tabId);
  };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;

  switch (method) {
    case "Page.javascriptDialogOpening": {
      const open = {
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt ?? null,
        url: params.url,
      };
      const d = dialogs.get(source.tabId) || { armed: null, answered: null, open: null };
      d.open = open;
      dialogs.set(source.tabId, d);
      if (d.armed) {
        const { accept, promptText } = d.armed;
        d.armed = null;
        sendRaw(source.tabId, "Page.handleJavaScriptDialog", {
          accept,
          ...(promptText !== undefined ? { promptText } : {}),
        })
          .then(() => {
            d.answered = {
              ...open,
              answered: accept ? "accept" : "dismiss",
              promptText: promptText ?? null,
            };
            d.open = null;
          })
          .catch(() => {});
      } else {
        for (const waiter of dialogWaiters.get(source.tabId) || []) waiter(open);
      }
      break;
    }
    case "Page.javascriptDialogClosed": {
      const d = dialogs.get(source.tabId);
      if (d) d.open = null;
      break;
    }
    case "Runtime.consoleAPICalled":
      pushConsole(s, {
        type: params.type,
        text: (params.args || []).map(remoteToString).join(" "),
        ts: params.timestamp,
      });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      pushConsole(s, {
        type: "error",
        text: d.exception ? d.exception.description || d.text : d.text,
        ts: params.timestamp,
      });
      break;
    }
    case "Log.entryAdded":
      pushConsole(s, {
        type: params.entry.level,
        text: params.entry.text,
        source: params.entry.source,
        url: params.entry.url,
        ts: params.entry.timestamp,
      });
      break;

    case "Network.requestWillBeSent":
      // Newest requests win: once full, the oldest entry (first in insertion order) goes.
      if (!s.network.has(params.requestId) && s.network.size >= MAX_NETWORK) {
        s.network.delete(s.network.keys().next().value);
      }
      s.network.set(params.requestId, {
        requestId: params.requestId,
        request: params.request,
        resourceType: params.type,
        wallTime: params.wallTime,
        startTs: params.timestamp,
      });
      break;
    case "Network.responseReceived": {
      const e = s.network.get(params.requestId);
      if (e) {
        e.response = params.response;
        e.resourceType = params.type;
      }
      break;
    }
    case "Network.loadingFinished": {
      const e = s.network.get(params.requestId);
      if (e) {
        e.endTs = params.timestamp;
        e.encodedDataLength = params.encodedDataLength;
      }
      break;
    }
    case "Network.loadingFailed": {
      const e = s.network.get(params.requestId);
      if (e) {
        e.failed = params.errorText;
        e.endTs = params.timestamp;
      }
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    sessions.delete(source.tabId);
    delete lastCapture[source.tabId];
    persistAttached();
  }
});

export function dropTab(tabId) {
  sessions.delete(tabId);
  delete lastCapture[tabId];
  dialogs.delete(tabId);
  dialogWaiters.delete(tabId);
  persistAttached();
}

function pushConsole(s, entry) {
  s.console.push(entry);
  if (s.console.length > MAX_CONSOLE) s.console.shift();
}

async function runtimeEval(tabId, expression) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: false,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "eval error");
  const r = res.result || {};
  if (!r.objectId) {
    if (r.type === "undefined") return { value: null, type: "undefined" };
    return { value: r.value !== undefined ? r.value : (r.description ?? null), type: r.type };
  }
  try {
    const ser = await send(tabId, "Runtime.callFunctionOn", {
      objectId: r.objectId,
      functionDeclaration:
        "function(){ try { return { ok: true, v: JSON.parse(JSON.stringify(this)) } } catch (e) { return { ok: false, why: String(e) } } }",
      returnByValue: true,
    });
    const out = (ser.result && ser.result.value) || { ok: false, why: "no result" };
    const kind = r.className || r.subtype || r.type;
    if (!out.ok)
      return {
        value: null,
        type: kind,
        note: `${kind} could not be serialised (${out.why}) \u2014 return its fields instead`,
      };
    const empty =
      out.v &&
      typeof out.v === "object" &&
      !Array.isArray(out.v) &&
      Object.keys(out.v).length === 0;
    if (empty && kind && kind !== "Object") {
      return {
        value: out.v,
        type: kind,
        note: `${kind} has no JSON form, so this is {} rather than nothing \u2014 return its fields instead (.textContent, [...set], Object.fromEntries(map))`,
      };
    }
    return { value: out.v, type: kind };
  } finally {
    try {
      await send(tabId, "Runtime.releaseObject", { objectId: r.objectId });
    } catch {}
  }
}

function toHeaders(h) {
  return Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function buildHar(entries, bodies) {
  const harEntries = entries
    .filter((e) => e.request)
    .map((e) => {
      const time = e.endTs && e.startTs ? Math.max(0, (e.endTs - e.startTs) * 1000) : 0;
      const resp = e.response || {};
      const content = { size: e.encodedDataLength || 0, mimeType: resp.mimeType || "" };
      const body = bodies && bodies.get(e.requestId);
      if (body) {
        content.text = body.text;
        if (body.base64Encoded) content.encoding = "base64";
      }
      return {
        startedDateTime: new Date((e.wallTime || 0) * 1000).toISOString(),
        time,
        request: {
          method: e.request.method,
          url: e.request.url,
          httpVersion: resp.protocol || "HTTP/1.1",
          headers: toHeaders(e.request.headers),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.request.postData ? e.request.postData.length : 0,
        },
        response: {
          status: resp.status || (e.failed ? 0 : 0),
          statusText: resp.statusText || e.failed || "",
          httpVersion: resp.protocol || "HTTP/1.1",
          headers: toHeaders(resp.headers),
          cookies: [],
          content,
          redirectURL: "",
          headersSize: -1,
          bodySize: e.encodedDataLength || 0,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        _resourceType: e.resourceType,
        _error: e.failed,
      };
    });
  return {
    log: {
      version: "1.2",
      creator: { name: "browserctl", version: "0.5.1" },
      entries: harEntries,
    },
  };
}

const AX_STATE_PROPS = new Set([
  "checked",
  "selected",
  "expanded",
  "pressed",
  "disabled",
  "required",
  "invalid",
  "level",
]);

function collectAxNodes(axNodes, max) {
  const skip = new Set(["none", "GenericContainer", "InlineTextBox", "ignored"]);
  const out = [];
  for (const node of axNodes || []) {
    const role = node.role && node.role.value;
    if (!role || skip.has(role)) continue;
    const name = (node.name && node.name.value) || "";
    const value = node.value && node.value.value;
    if (!name && (value === undefined || value === "")) continue;
    const entry = { role, name };
    if (value !== undefined && value !== "") entry.value = value;
    for (const p of node.properties || []) {
      if (!AX_STATE_PROPS.has(p.name)) continue;
      const v = p.value && p.value.value;
      if (v === undefined || v === false || v === "false") continue;
      (entry.state || (entry.state = {}))[p.name] = v;
    }
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

function briefRequest(e) {
  return {
    requestId: e.requestId,
    method: e.request.method,
    url: e.request.url,
    resourceType: e.resourceType,
    status: e.response ? e.response.status : null,
    mimeType: e.response ? e.response.mimeType : null,
    size: e.encodedDataLength || null,
    failed: e.failed || null,
    requestHeaders: e.request.headers || null,
    responseHeaders: e.response ? e.response.headers || null : null,
  };
}

export async function handleCdp(action, params, tabId) {
  switch (action) {
    case "cdp_attach": {
      const s = await ensureAttached(tabId);
      await enableDomains(tabId);
      s.domainsEnabled = true;
      return { ok: true, result: { attached: true, tabId } };
    }

    case "cdp_detach": {
      if (sessions.has(tabId)) {
        try {
          await detach(tabId);
        } catch {}
        sessions.delete(tabId);
        persistAttached();
      }
      return { ok: true, result: { attached: false, tabId } };
    }

    case "get_console_logs": {
      const s = await requireDomains(tabId);
      const limit = params.limit ?? 200;
      const logs = s.console.slice(-limit);
      if (params.clear) s.console.length = 0;
      return { ok: true, result: { count: logs.length, logs } };
    }

    case "get_network_requests": {
      const s = await requireDomains(tabId);
      const all = [...s.network.values()];
      const filtered = params.urlContains
        ? all.filter((e) => e.request.url.includes(params.urlContains))
        : all;
      return {
        ok: true,
        result: { count: filtered.length, requests: filtered.map(briefRequest) },
      };
    }

    case "export_har": {
      const s = requireSession(tabId);
      const entries = [...s.network.values()];
      if (!params.bodies) {
        return { ok: true, result: buildHar(entries) };
      }
      const bodies = new Map();
      await Promise.all(
        entries
          .filter((e) => e.response && e.requestId)
          .map(async (e) => {
            try {
              const res = await send(tabId, "Network.getResponseBody", { requestId: e.requestId });
              bodies.set(e.requestId, { text: res.body, base64Encoded: res.base64Encoded });
            } catch {}
          })
      );
      return { ok: true, result: buildHar(entries, bodies) };
    }

    case "get_response_body": {
      requireSession(tabId);
      if (!params.requestId) throw new Error("get_response_body requires 'requestId'");
      let res;
      try {
        res = await send(tabId, "Network.getResponseBody", { requestId: params.requestId });
      } catch {
        throw new Error(
          "response body unavailable for " +
            params.requestId +
            " (it may have been evicted; capture is best-effort)"
        );
      }
      return {
        ok: true,
        result: {
          requestId: params.requestId,
          base64Encoded: res.base64Encoded,
          body: res.base64Encoded ? res.body : truncate(res.body, 50000),
        },
      };
    }

    case "capture_screenshot": {
      requireSession(tabId);
      const format = params.format === "png" ? "png" : "jpeg";
      const quality = params.quality ?? 55;
      let dpr = 1;
      try {
        const m = await send(tabId, "Page.getLayoutMetrics");
        const vp = m.cssVisualViewport || m.cssLayoutViewport || {};
        const devVp = m.visualViewport || {};
        const w = Math.round(vp.clientWidth || 0);
        if (w && devVp.clientWidth) dpr = Math.max(1, devVp.clientWidth / w);
      } catch {}
      lastCapture[tabId] = { scale: dpr };
      const shoot = (q) =>
        send(tabId, "Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: q } : {}),
          captureBeyondViewport: params.fullPage !== false,
          fromSurface: true,
        });
      let res = await shoot(quality);
      if (format === "jpeg" && res.data.length > 500000) res = await shoot(30);
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    // The patch keeps the page's own descriptors on window.__bctlVisibility so that restore can
    // put them back. It lives in the document, so a navigation or reload ends it as well.
    case "spoof_visibility": {
      await ensureAttached(tabId);
      if (params.restore) {
        try {
          await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
        } catch {}
        const undo = `(() => {
          const saved = window.__bctlVisibility;
          if (!saved) return false;
          for (const [k, d] of Object.entries(saved)) {
            try {
              Object.defineProperty(Document.prototype, k, d);
            } catch (e) {}
          }
          delete window.__bctlVisibility;
          document.dispatchEvent(new Event("visibilitychange"));
          return true;
        })()`;
        const { value } = await runtimeEval(tabId, undo);
        return { ok: true, result: { restored: value === true, tabId } };
      }
      try {
        await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch {}
      const patch = `(() => {
        const patched = { visibilityState: false, hidden: false };
        if (!window.__bctlVisibility) {
          const saved = {};
          for (const k of ["hidden", "visibilityState"]) {
            const d = Object.getOwnPropertyDescriptor(Document.prototype, k);
            if (d) saved[k] = d;
          }
          window.__bctlVisibility = saved;
        }
        try {
          Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
          patched.hidden = true;
        } catch (e) {}
        try {
          Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });
          patched.visibilityState = true;
        } catch (e) {}
        document.dispatchEvent(new Event("visibilitychange"));
        return patched;
      })()`;
      const { value } = await runtimeEval(tabId, patch);
      return {
        ok: true,
        result: { spoofed: value, tabId, until: "the page navigates or reloads" },
      };
    }

    case "eval_js": {
      if (!params.expression) throw new Error("eval_js requires 'expression'");
      if (sessions.has(tabId)) {
        return { ok: true, result: await runtimeEval(tabId, params.expression) };
      }
      try {
        const [out] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: async (expr) => {
            try {
              const raw = eval(expr);
              const v = raw && typeof raw.then === "function" ? await raw : raw;
              if (v === undefined) return { ok: true, value: null, type: "undefined" };
              if (typeof v === "function") return { ok: true, value: String(v), type: "function" };
              const kind =
                v === null
                  ? "null"
                  : typeof v === "object"
                    ? (v.constructor && v.constructor.name) || "Object"
                    : typeof v;
              let json;
              try {
                json = JSON.parse(JSON.stringify(v));
              } catch (err) {
                return {
                  ok: true,
                  value: null,
                  type: kind,
                  note: `${kind} could not be serialised (${String(err)}) — return its fields instead`,
                };
              }
              if (
                v &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                json &&
                Object.keys(json).length === 0 &&
                kind !== "Object"
              ) {
                return {
                  ok: true,
                  value: json,
                  type: kind,
                  note: `${kind} has no JSON form, so this is {} rather than nothing — return its fields instead (.textContent, [...set], Object.fromEntries(map))`,
                };
              }
              return { ok: true, value: json, type: kind };
            } catch (err) {
              return { ok: false, error: String(err) };
            }
          },
          args: [params.expression],
        });
        if (out?.result?.ok) {
          const { value, type, note } = out.result;
          return {
            ok: true,
            result: { value, ...(type ? { type } : {}), ...(note ? { note } : {}) },
          };
        }

        const errStr = out?.result?.error || "";
        const isCspOrTrustedTypes =
          /trusted type|content security policy|csp|eval.*disabled|violates.*directive/i.test(
            errStr
          );
        if (!isCspOrTrustedTypes) {
          throw new Error(errStr + " (tip: cdp_attach first to bypass page CSP)");
        }
      } catch (scriptErr) {
        if (
          !/trusted type|content security policy|csp|eval.*disabled|violates.*directive/i.test(
            scriptErr?.message || ""
          )
        ) {
          throw scriptErr;
        }
      }

      await ensureAttached(tabId);
      const evalRes = await runtimeEval(tabId, params.expression);
      return { ok: true, result: evalRes };
    }

    case "coordinate_click": {
      requireSession(tabId);
      await requireForegroundForInput(tabId, "coordinate_click");
      const s = captureScale(tabId);
      const x = params.x / s,
        y = params.y / s;
      const button = params.button || "left";
      const clickCount = params.clickCount || 1;
      const buttons = BUTTON_MASK[button] || 1;
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await pause(40);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons,
        clickCount,
      });
      await pause(12);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount,
      });
      return { ok: true, result: { clicked: { x, y } } };
    }

    case "coordinate_drag": {
      requireSession(tabId);
      await requireForegroundForInput(tabId, "coordinate_drag");
      const s = captureScale(tabId);
      const fromX = params.fromX / s,
        fromY = params.fromY / s;
      const toX = params.toX / s,
        toY = params.toY / s;
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: fromX,
        y: fromY,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await pause(12);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: (fromX + toX) / 2,
        y: (fromY + toY) / 2,
        button: "left",
        buttons: 1,
      });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: toX,
        y: toY,
        button: "left",
        buttons: 1,
      });
      await pause(12);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: toX,
        y: toY,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      return { ok: true, result: { dragged: true } };
    }

    case "press_key_cdp": {
      requireSession(tabId);
      const key = params.key;
      if (!key) throw new Error("press_key requires 'key'");
      await requireForegroundForInput(tabId, "press_key with modifiers");
      const modifiers = modMask(params.modifiers);
      const commands = macCommands(key, params.modifiers);
      const evt = {
        key,
        code: codeOf(key),
        windowsVirtualKeyCode: vkOf(key),
        nativeVirtualKeyCode: vkOf(key),
        modifiers,
        ...(commands.length ? { commands } : {}),
      };
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...evt });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...evt });
      return {
        ok: true,
        result: { pressed: key, modifiers: params.modifiers || [], commands, via: "cdp" },
      };
    }

    case "cdp_send": {
      requireSession(tabId);
      const method = params.method;
      if (!method || typeof method !== "string") {
        throw new Error("cdp_send requires 'method' (e.g. 'Page.getLayoutMetrics')");
      }
      if (!method.includes(".")) {
        throw new Error(`'${method}' is not a CDP method name — expected Domain.method`);
      }
      const result = await send(tabId, method, params.params || {});
      return { ok: true, result: { method, result: result === undefined ? null : result } };
    }

    case "insert_text": {
      requireSession(tabId);
      if (params.text === undefined) throw new Error("insert_text requires 'text'");
      await send(tabId, "Input.insertText", { text: String(params.text) });
      return { ok: true, result: { inserted: String(params.text).length } };
    }

    case "a11y_snapshot": {
      await ensureAttached(tabId);
      const max = params.max ?? 200;
      try {
        await send(tabId, "Accessibility.enable");
      } catch {}
      const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
      const nodes = collectAxNodes(axNodes, max);
      return { ok: true, result: { count: nodes.length, nodes } };
    }

    case "upload_set": {
      await ensureAttached(tabId);
      const files = params.files || [];
      const found = await send(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const seen = new Set();
          const walk = (root) => {
            const hit = root.querySelector && root.querySelector('[data-bctl-upload]');
            if (hit) return hit;
            const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
            for (const el of all) {
              if (el.shadowRoot && !seen.has(el.shadowRoot)) {
                seen.add(el.shadowRoot);
                const inner = walk(el.shadowRoot);
                if (inner) return inner;
              }
            }
            return null;
          };
          return walk(document);
        })()`,
      });
      const objectId = found.result && found.result.objectId;
      if (!objectId)
        throw new Error(
          "the marked file input was gone by the time CDP looked for it (did the page re-render?)"
        );
      try {
        try {
          await send(tabId, "DOM.enable");
        } catch {}
        await send(tabId, "DOM.setFileInputFiles", { objectId, files });
        const readBack = await send(tabId, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration:
            "function(){return {count:this.files.length,names:[...this.files].map(f=>f.name),bytes:[...this.files].reduce((n,f)=>n+f.size,0)}}",
          returnByValue: true,
        });
        const attached = (readBack.result && readBack.result.value) || { count: 0, names: [] };
        return {
          ok: true,
          result: { files: attached.names, count: attached.count, bytes: attached.bytes },
        };
      } finally {
        try {
          await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function(){this.removeAttribute('data-bctl-upload')}",
          });
        } catch {}
        try {
          await send(tabId, "Runtime.releaseObject", { objectId });
        } catch {}
      }
    }

    case "element_screenshot": {
      requireSession(tabId);
      const format = params.format || "png";
      const r = params.rect;
      if (!r) throw new Error("element_screenshot needs the element's rect from element_rect");
      let scrollX = 0,
        scrollY = 0;
      try {
        const m = await send(tabId, "Page.getLayoutMetrics");
        const lvp = m.cssLayoutViewport || m.layoutViewport || {};
        scrollX = lvp.pageX || 0;
        scrollY = lvp.pageY || 0;
      } catch {}
      const res = await send(tabId, "Page.captureScreenshot", {
        format,
        clip: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 },
        fromSurface: true,
        captureBeyondViewport: true,
      });
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    case "print_pdf": {
      const needAttach = !sessions.has(tabId);
      if (needAttach) {
        try {
          await attach(tabId);
        } catch (err) {
          if (!err.message.includes("already attached")) throw err;
        }
      }
      try {
        const res = await send(tabId, "Page.printToPDF", { printBackground: true });
        return { ok: true, result: { base64: res.data } };
      } finally {
        if (needAttach) {
          try {
            await detach(tabId);
          } catch {}
        }
      }
    }

    case "audit": {
      requireSession(tabId);
      try {
        await send(tabId, "Performance.enable");
      } catch {}
      const { metrics } = await send(tabId, "Performance.getMetrics");
      const metricMap = {};
      for (const m of metrics || []) metricMap[m.name] = m.value;
      const wanted = [
        "Documents",
        "Nodes",
        "JSHeapUsedSize",
        "LayoutCount",
        "RecalcStyleCount",
        "ScriptDuration",
        "TaskDuration",
      ];
      const performance = {};
      for (const name of wanted) {
        if (metricMap[name] !== undefined) performance[name] = metricMap[name];
      }

      let interactiveMissingName = 0;
      let totalAxNodes = 0;
      try {
        try {
          await send(tabId, "Accessibility.enable");
        } catch {}
        const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
        const interactiveRoles = new Set([
          "button",
          "link",
          "textbox",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "menuitem",
          "switch",
          "slider",
          "tab",
        ]);
        for (const node of axNodes || []) {
          const role = node.role && node.role.value;
          if (!role) continue;
          totalAxNodes++;
          const name = (node.name && node.name.value) || "";
          if (interactiveRoles.has(role) && !name) interactiveMissingName++;
        }
      } catch {}

      return {
        ok: true,
        result: {
          performance,
          accessibility: { interactiveMissingName, totalAxNodes },
        },
      };
    }

    case "get_cookies": {
      requireSession(tabId);
      try {
        await send(tabId, "Network.enable");
      } catch {}
      let raw;
      let scope;
      if (params.allDomains) {
        ({ cookies: raw } = await send(tabId, "Network.getAllCookies"));
        scope = "all domains in this browser profile";
      } else {
        let url = params.url;
        if (!url) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          url = tab && tab.url;
        }
        if (!url || /^(chrome|about|edge|devtools):/i.test(url)) {
          const err = new Error(
            `cannot determine a page URL to scope cookies to (tab url: ${url || "unknown"})`
          );
          err.code = "INVALID_ARGUMENT";
          err.recoveryHint =
            "Pass url:'https://example.com', or allDomains:true to read the entire cookie jar.";
          throw err;
        }
        ({ cookies: raw } = await send(tabId, "Network.getCookies", { urls: [url] }));
        scope = url;
      }
      const filtered = params.urlContains
        ? (raw || []).filter((c) => String(c.domain || "").includes(params.urlContains))
        : raw || [];
      const MAX = params.limit ?? 200;
      const page = filtered.slice(0, MAX);
      const cookies = page.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        value: c.value,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires,
      }));
      const result = { count: cookies.length, scope, cookies };
      if (filtered.length > cookies.length) {
        result.totalMatched = filtered.length;
        result.truncated = true;
        result.note = `showing ${cookies.length} of ${filtered.length}; narrow with urlContains or raise limit`;
      }
      return { ok: true, result };
    }

    case "set_cookie": {
      requireSession(tabId);
      try {
        await send(tabId, "Network.enable");
      } catch {}
      if (!params.url && !params.domain) {
        throw new Error("set_cookie requires 'url' or 'domain'");
      }
      const cookie = { name: params.name, value: params.value };
      if (params.url) cookie.url = params.url;
      if (params.domain) cookie.domain = params.domain;
      if (params.path) cookie.path = params.path;
      if (params.secure !== undefined) cookie.secure = params.secure;
      if (params.httpOnly !== undefined) cookie.httpOnly = params.httpOnly;
      if (params.expires !== undefined) cookie.expires = params.expires;
      await send(tabId, "Network.setCookie", cookie);
      return { ok: true, result: { set: params.name } };
    }

    case "delete_cookies": {
      requireSession(tabId);
      try {
        await send(tabId, "Network.enable");
      } catch {}
      await send(tabId, "Network.deleteCookies", { name: params.name, url: params.url });
      return { ok: true, result: { deleted: params.name } };
    }

    default:
      throw new Error(`unknown cdp action: ${action}`);
  }
}

export const CDP_ACTIONS = [
  "upload_set",
  "cdp_attach",
  "cdp_detach",
  "get_console_logs",
  "get_network_requests",
  "get_response_body",
  "export_har",
  "capture_screenshot",
  "eval_js",
  "spoof_visibility",
  "cdp_send",
  "coordinate_click",
  "coordinate_drag",
  "insert_text",
  "a11y_snapshot",
  "element_screenshot",
  "print_pdf",
  "audit",
  "get_cookies",
  "set_cookie",
  "delete_cookies",
];
