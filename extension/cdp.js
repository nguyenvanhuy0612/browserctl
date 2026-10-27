import { truncate } from "./util.js";
import {
  sendCdpCommand,
  dispatchMouseEvent,
  dispatchMouseWheel,
  coordinate_drag,
  dispatchKeyEvent,
  DEVICE_PRESETS,
  setDeviceMetrics,
  setUserAgent,
  setEmulatedMedia,
  setGeolocationOverride,
  setNetworkConditions,
  clearEmulation,
  emulate,
  createNetworkRule,
  networkReplay,
  makeRequest,
  generateCurlCommand,
  getFrameTree,
  flattenFrameTree,
  findFrame,
  mapFrameToContext,
} from "./driver/index.js";
import { resolveJsonPointer as _resolveJsonPointer } from "./driver/network.js";

export {
  sendCdpCommand,
  dispatchMouseEvent,
  dispatchMouseWheel,
  coordinate_drag,
  dispatchKeyEvent,
  DEVICE_PRESETS,
  setDeviceMetrics,
  setUserAgent,
  setEmulatedMedia,
  setGeolocationOverride,
  setNetworkConditions,
  clearEmulation,
  emulate,
  createNetworkRule,
  networkReplay,
  makeRequest,
  generateCurlCommand,
  getFrameTree,
  flattenFrameTree,
  findFrame,
  mapFrameToContext,
};

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 2000;

const sessions = new Map();

export function resolveJsonPointer(obj, pointer) {
  return _resolveJsonPointer(obj, pointer);
}

let ruleCounter = 0;
function urlMatchesPattern(url, pattern) {
  if (!pattern || pattern === "*") return true;
  if (!pattern.includes("*")) return url.includes(pattern);
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$"
  );
  return regex.test(url);
}

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
      await attachShared(tabId);
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
// Concurrent callers share one attach per tab: a second chrome.debugger.attach to a tab this
// extension is still attaching fails exactly as if another tool held the tab. Every attach in this
// file goes through attachShared.
const attaching = new Map();
const opening = new Map();

function attachShared(tabId) {
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

// A session is recorded only once Page.enable has run, so a caller that finds it can rely on Page
// events. A detach during the attach leaves no session, and the callers get a clear error.
export async function ensureAttached(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  let pending = opening.get(tabId);
  if (!pending) {
    pending = (async () => {
      await attachShared(tabId);
      try {
        await sendRaw(tabId, "Page.enable");
      } catch (err) {
        if (/not attached/i.test(err.message || "")) {
          throw new Error(`the debugger detached from tab ${tabId} while attaching; try again`);
        }
      }
      sessions.set(tabId, {
        console: [],
        network: new Map(),
        domainsEnabled: false,
        fetchRules: [],
      });
      persistAttached();
    })().finally(() => opening.delete(tabId));
    opening.set(tabId, pending);
  }
  await pending;
  const s = sessions.get(tabId);
  if (!s) throw new Error(`the debugger detached from tab ${tabId} while attaching; try again`);
  return s;
}

// Wakes a tab the browser froze in the background, through the page lifecycle. When no session
// held the tab, the debugger is detached again afterwards, so the "being debugged" bar only
// flashes.
export async function wakeFrozenTab(tabId) {
  if (opening.has(tabId)) await opening.get(tabId).catch(() => {});
  const held = sessions.has(tabId);
  if (!held) await attachShared(tabId);
  try {
    await sendRaw(tabId, "Page.setWebLifecycleState", { state: "active" });
  } finally {
    if (!held && !sessions.has(tabId) && !opening.has(tabId)) {
      try {
        await detach(tabId);
      } catch {}
    }
  }
}

// A background capture on a browser that paints no frame for it would never answer; the capture
// step alone is bounded (not the attach before it), so the caller gets a hint instead of a hang.
const BACKGROUND_SHOT_MS = 5000;

function boundBackgroundShot(tabId, capture) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `tab ${tabId} is in the background and its capture did not answer within 5 s. ` +
              `Bring it to the front with browser_tabs({action: "select", tabId: ${tabId}, activate: true}), ` +
              `then take the screenshot again.`
          )
        ),
      BACKGROUND_SHOT_MS
    );
  });
  return Promise.race([capture(), bound]).finally(() => clearTimeout(timer));
}

// Focus emulation makes a background tab's page report itself visible and focused, and a
// browser that paints no frame for a hidden tab (Edge) then paints one, so Page.captureScreenshot
// answers. A capture holds it on only for its own duration; concurrent captures of one tab share
// one on/off pair. On a tab where a caller turned it on (cdp_send, spoof_visibility) a capture
// neither sends it nor turns it off. Per tab: { caller, captures }.
const focusEmulation = new Map();

async function withFocusEmulation(tabId, fn) {
  let st = focusEmulation.get(tabId);
  if (!st) {
    st = { caller: false, captures: 0 };
    focusEmulation.set(tabId, st);
  }
  if (st.caller) return await fn();
  st.captures++;
  try {
    if (st.captures === 1) {
      try {
        await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch {}
    }
    return await fn();
  } finally {
    st.captures--;
    if (st.captures === 0 && !st.caller) {
      // Only this capture's own record: a detach and re-attach may have started a newer one
      if (focusEmulation.get(tabId) === st) focusEmulation.delete(tabId);
      try {
        await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
      } catch {}
    }
  }
}

// Records focus emulation that a caller set on a tab itself, so that captures leave it alone.
function noteCallerFocusEmulation(tabId, method, params) {
  if (method !== "Emulation.setFocusEmulationEnabled") return;
  const st = focusEmulation.get(tabId) || { caller: false, captures: 0 };
  st.caller = !!(params && params.enabled);
  if (st.caller || st.captures > 0) focusEmulation.set(tabId, st);
  else focusEmulation.delete(tabId);
}

// emulateFocus: the tab is not the active tab of a focused window. deadline: a promise that
// rejects when the caller stops waiting; focus emulation is turned off then too.
export async function captureViewport(
  tabId,
  { format = "jpeg", quality = 55, emulateFocus = false, deadline } = {}
) {
  const bounded = (p) => (deadline ? Promise.race([p, deadline]) : p);
  await bounded(ensureAttached(tabId));
  const fmt = format === "png" ? "png" : "jpeg";
  const capture = async () => {
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
  };
  return emulateFocus
    ? await withFocusEmulation(tabId, () => bounded(capture()))
    : await bounded(capture());
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

const fileChooserWaiters = new Map();
export function onFileChooserOpened(tabId, fn) {
  const list = fileChooserWaiters.get(tabId) || [];
  list.push(fn);
  fileChooserWaiters.set(tabId, list);
  return () => {
    const cur = fileChooserWaiters.get(tabId) || [];
    fileChooserWaiters.set(
      tabId,
      cur.filter((w) => w !== fn)
    );
  };
}

export async function interceptFileChooser(tabId, enabled = true) {
  await ensureAttached(tabId);
  return await send(tabId, "Page.setInterceptFileChooserDialog", { enabled });
}

export async function setFilesOnBackendNode(tabId, backendNodeId, files) {
  await ensureAttached(tabId);
  return await send(tabId, "DOM.setFileInputFiles", { backendNodeId, files });
}

export async function clickWithUserGesture(tabId, expression) {
  await ensureAttached(tabId);
  return await send(tabId, "Runtime.evaluate", {
    expression,
    userGesture: true,
    awaitPromise: true,
  });
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
    case "Page.fileChooserOpened": {
      const list = fileChooserWaiters.get(source.tabId);
      if (list && list.length) {
        const waiter = list.shift();
        waiter(params);
      }
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
    case "Fetch.requestPaused": {
      const req = params.request;
      const requestId = params.requestId;
      const rules = s.fetchRules || [];
      const matched = rules.find((r) => {
        if (r.match?.method && r.match.method.toUpperCase() !== req.method.toUpperCase())
          return false;
        return urlMatchesPattern(req.url, r.match?.url);
      });
      if (!matched) {
        sendRaw(source.tabId, "Fetch.continueRequest", { requestId }).catch(() => {});
        break;
      }
      const eff = matched.effect || {};
      if (eff.type === "block") {
        sendRaw(source.tabId, "Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        }).catch(() => {});
        break;
      }
      if (eff.type === "mock") {
        const responseCode = eff.status || 200;
        const responseHeaders = [];
        if (eff.headers) {
          for (const [k, v] of Object.entries(eff.headers)) {
            responseHeaders.push({ name: k, value: String(v) });
          }
        }
        if (!responseHeaders.some((h) => h.name.toLowerCase() === "content-type")) {
          responseHeaders.push({ name: "content-type", value: "application/json; charset=utf-8" });
        }
        const bodyStr =
          eff.body != null
            ? typeof eff.body === "string"
              ? eff.body
              : JSON.stringify(eff.body)
            : "";
        const bodyBase64 = btoa(unescape(encodeURIComponent(bodyStr)));
        sendRaw(source.tabId, "Fetch.fulfillRequest", {
          requestId,
          responseCode,
          responseHeaders,
          body: bodyBase64,
        }).catch(() => {});
        break;
      }
      sendRaw(source.tabId, "Fetch.continueRequest", { requestId }).catch(() => {});
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    sessions.delete(source.tabId);
    delete lastCapture[source.tabId];
    focusEmulation.delete(source.tabId);
    persistAttached();
  }
});

export function dropTab(tabId) {
  sessions.delete(tabId);
  delete lastCapture[tabId];
  focusEmulation.delete(tabId);
  dialogs.delete(tabId);
  dialogWaiters.delete(tabId);
  fileChooserWaiters.delete(tabId);
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

async function handleMonitorRequests(tabId, params = {}) {
  const s = await requireDomains(tabId);
  const action = params.action || "list";

  if (action === "clear") {
    s.network.clear();
    return { ok: true, result: { cleared: true, tabId } };
  }

  if (action === "get") {
    if (!params.requestId) {
      throw new Error("monitor_requests get requires 'requestId'");
    }
    const req = s.network.get(params.requestId);
    if (!req) {
      throw new Error(`network request ${params.requestId} not found (evicted or never captured)`);
    }

    let bodyText = undefined;
    let base64Encoded = false;
    try {
      const res = await send(tabId, "Network.getResponseBody", { requestId: params.requestId });
      bodyText = res.body;
      base64Encoded = res.base64Encoded;
    } catch {}

    let parsedJson = null;
    let pointerValue = undefined;
    if (bodyText && !base64Encoded) {
      try {
        parsedJson = JSON.parse(bodyText);
        if (params.pointer && parsedJson) {
          pointerValue = resolveJsonPointer(parsedJson, params.pointer);
        }
      } catch {}
    }

    const curl = generateCurlCommand({
      url: req.request?.url,
      method: req.request?.method,
      headers: req.request?.headers,
      body: req.request?.postData,
    });

    const isTruncated = bodyText && bodyText.length > 50000;
    const safeBody = isTruncated ? truncate(bodyText, 50000) : bodyText;

    return {
      ok: true,
      result: {
        requestId: params.requestId,
        url: req.request?.url,
        method: req.request?.method,
        resourceType: req.resourceType,
        status: req.response?.status,
        statusText: req.response?.statusText,
        requestHeaders: req.request?.headers,
        postData: req.request?.postData,
        responseHeaders: req.response?.headers,
        timing: req.response?.timing,
        body: safeBody,
        json: parsedJson,
        base64Encoded,
        pointer: params.pointer,
        pointerValue,
        curl,
      },
    };
  }

  if (action === "wait") {
    const pattern = params.url_pattern || params.pattern || params.urlContains;
    const targetMethod = params.method ? params.method.toUpperCase() : null;
    const timeoutMs = Number(params.timeout_ms || params.timeoutMs) || 10000;
    const startTime = Date.now();

    const matches = (e) => {
      if (!e || !e.request) return false;
      if (targetMethod && e.request.method.toUpperCase() !== targetMethod) return false;
      if (pattern && !urlMatchesPattern(e.request.url, pattern)) return false;
      return true;
    };

    while (Date.now() - startTime < timeoutMs) {
      const entries = [...s.network.values()].reverse();
      const found = entries.find((e) => matches(e) && (e.response || e.failed));
      if (found) {
        return await handleMonitorRequests(tabId, { action: "get", requestId: found.requestId });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for request matching '${pattern}'`);
  }

  // action === "list" (default)
  const all = [...s.network.values()];
  const pattern = params.url_pattern || params.pattern || params.urlContains;
  const targetMethod = params.method ? params.method.toUpperCase() : null;
  const targetType = params.resource_type || params.type;
  const targetStatus = params.status;

  let filtered = all.filter((e) => {
    if (!e || !e.request) return false;
    if (pattern && !urlMatchesPattern(e.request.url, pattern)) return false;
    if (targetMethod && e.request.method.toUpperCase() !== targetMethod) return false;
    if (
      targetType &&
      (!e.resourceType || !e.resourceType.toLowerCase().includes(targetType.toLowerCase()))
    )
      return false;
    if (targetStatus !== undefined) {
      const st = e.response?.status;
      if (typeof targetStatus === "string" && targetStatus.endsWith("xx")) {
        const prefix = Number(targetStatus[0]);
        if (!st || Math.floor(st / 100) !== prefix) return false;
      } else if (st !== Number(targetStatus)) {
        return false;
      }
    }
    return true;
  });

  if (params.since_id) {
    const idx = filtered.findIndex((e) => e.requestId === params.since_id);
    if (idx !== -1) {
      filtered = filtered.slice(idx + 1);
    }
  }

  const limit = Number(params.limit) || 50;
  if (filtered.length > limit) {
    filtered = filtered.slice(-limit);
  }

  const briefList = filtered.map(briefRequest);

  if (params.include_body) {
    await Promise.all(
      briefList.map(async (item) => {
        try {
          const res = await send(tabId, "Network.getResponseBody", { requestId: item.requestId });
          item.body = res.base64Encoded ? res.body : truncate(res.body, 10000);
          item.base64Encoded = res.base64Encoded;
          try {
            item.json = JSON.parse(res.body);
          } catch {}
        } catch {}
      })
    );
  }

  return {
    ok: true,
    result: {
      count: briefList.length,
      total_captured: s.network.size,
      requests: briefList,
    },
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
        focusEmulation.delete(tabId);
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
      return await handleMonitorRequests(tabId, { ...params, action: "list" });
    }

    case "monitor_requests": {
      return await handleMonitorRequests(tabId, params);
    }

    case "wait_for_request": {
      return await handleMonitorRequests(tabId, { ...params, action: "wait" });
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
      if (params.pointer) {
        if (res.base64Encoded) {
          throw new Error("cannot query JSON pointer on base64-encoded response");
        }
        let parsed;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          throw new Error("response body is not valid JSON; cannot query pointer");
        }
        const val = resolveJsonPointer(parsed, params.pointer);
        return {
          ok: true,
          result: {
            requestId: params.requestId,
            pointer: params.pointer,
            value: val,
            found: val !== undefined,
          },
        };
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

    case "get_network_request": {
      const s = requireSession(tabId);
      if (!params.requestId) throw new Error("get_network_request requires 'requestId'");
      const req = s.network.get(params.requestId);
      if (!req) {
        throw new Error(
          `network request ${params.requestId} not found (evicted or never captured)`
        );
      }
      const part = params.part || "all";
      let bodyText = undefined;
      if (part === "response" || part === "all") {
        try {
          const res = await send(tabId, "Network.getResponseBody", {
            requestId: params.requestId,
          });
          bodyText = res.body;
          if (params.pointer && bodyText) {
            const parsed = JSON.parse(bodyText);
            return {
              ok: true,
              result: {
                requestId: params.requestId,
                part,
                pointer: params.pointer,
                value: resolveJsonPointer(parsed, params.pointer),
              },
            };
          }
        } catch {}
      }
      if (part === "headers") {
        return {
          ok: true,
          result: {
            requestId: params.requestId,
            requestHeaders: req.request?.headers,
            responseHeaders: req.response?.headers,
          },
        };
      }
      if (part === "timing") {
        return {
          ok: true,
          result: {
            requestId: params.requestId,
            timing: req.response?.timing,
            wallTime: req.wallTime,
            startTs: req.startTs,
          },
        };
      }
      if (part === "request") {
        return {
          ok: true,
          result: {
            requestId: params.requestId,
            url: req.request?.url,
            method: req.request?.method,
            headers: req.request?.headers,
            postData: req.request?.postData,
          },
        };
      }
      return {
        ok: true,
        result: {
          requestId: params.requestId,
          url: req.request?.url,
          method: req.request?.method,
          resourceType: req.resourceType,
          status: req.response?.status,
          statusText: req.response?.statusText,
          requestHeaders: req.request?.headers,
          responseHeaders: req.response?.headers,
          timing: req.response?.timing,
          responseBody: bodyText ? truncate(bodyText, 50000) : undefined,
        },
      };
    }

    case "make_request": {
      requireSession(tabId);
      return {
        ok: true,
        result: await makeRequest(tabId, params),
      };
    }

    case "network_replay": {
      const s = requireSession(tabId);
      let recorded = undefined;
      if (params.requestId) {
        recorded = s.network.get(params.requestId);
        if (!recorded && !params.url) {
          throw new Error(`network request ${params.requestId} not found to replay`);
        }
      }
      return {
        ok: true,
        result: await makeRequest(tabId, recorded || params, params),
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
      const capture = async () => {
        let res = await shoot(quality);
        if (format === "jpeg" && res.data.length > 500000) res = await shoot(30);
        return res;
      };
      const res = params.emulateFocus
        ? await withFocusEmulation(tabId, () => boundBackgroundShot(tabId, capture))
        : await capture();
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
        noteCallerFocusEmulation(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
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
      noteCallerFocusEmulation(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
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
      noteCallerFocusEmulation(tabId, method, params.params);
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
      const capture = () =>
        send(tabId, "Page.captureScreenshot", {
          format,
          clip: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 },
          fromSurface: true,
          captureBeyondViewport: true,
        });
      const res = params.emulateFocus
        ? await withFocusEmulation(tabId, () => boundBackgroundShot(tabId, capture))
        : await capture();
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    case "print_pdf": {
      // Attaches for the print only when no session holds the tab, and detaches afterwards only
      // if no session was opened on it meanwhile (another command may have started using it).
      const needAttach = !sessions.has(tabId);
      if (needAttach) {
        try {
          await attachShared(tabId);
        } catch (err) {
          if (!err.message.includes("already attached")) throw err;
        }
      }
      try {
        const res = await send(tabId, "Page.printToPDF", { printBackground: true });
        return { ok: true, result: { base64: res.data } };
      } finally {
        if (needAttach && !sessions.has(tabId) && !opening.has(tabId)) {
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

    case "wheel": {
      requireSession(tabId);
      await requireForegroundForInput(tabId, "wheel");
      const s = captureScale(tabId);
      const x = (params.x ?? 0) / s;
      const y = (params.y ?? 0) / s;
      const deltaX = params.deltaX || 0;
      const deltaY = params.deltaY || 0;
      const modifiers = modMask(params.modifiers);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers,
      });
      return { ok: true, result: { scrolled: { x, y, deltaX, deltaY } } };
    }

    case "emulate": {
      requireSession(tabId);
      if (params.clear || params.off) {
        await send(tabId, "Emulation.clearDeviceMetricsOverride");
        await send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
        await send(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
        await send(tabId, "Emulation.setEmulatedMedia", { media: "" });
        try {
          await send(tabId, "Emulation.clearGeolocationOverride");
        } catch {}
        await send(tabId, "Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        return { ok: true, result: { cleared: true } };
      }

      let preset = null;
      if (params.device && DEVICE_PRESETS[params.device.toLowerCase()]) {
        preset = DEVICE_PRESETS[params.device.toLowerCase()];
      }

      const width = params.viewport?.width ?? preset?.width;
      const height = params.viewport?.height ?? preset?.height;
      const deviceScaleFactor =
        params.viewport?.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1;
      const mobile = params.viewport?.mobile ?? preset?.mobile ?? false;
      const hasTouch = params.viewport?.hasTouch ?? preset?.hasTouch ?? false;
      const userAgent = params.userAgent ?? preset?.userAgent;

      if (width && height) {
        await send(tabId, "Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor,
          mobile,
        });
      }
      if (hasTouch !== undefined) {
        await send(tabId, "Emulation.setTouchEmulationEnabled", { enabled: Boolean(hasTouch) });
      }
      if (userAgent) {
        await send(tabId, "Emulation.setUserAgentOverride", { userAgent });
      }
      if (params.colorScheme || params.color_scheme) {
        const cs = params.colorScheme || params.color_scheme;
        await send(tabId, "Emulation.setEmulatedMedia", {
          media: "page",
          features: [{ name: "prefers-color-scheme", value: cs }],
        });
      }
      if (params.geolocation) {
        await send(tabId, "Emulation.setGeolocationOverride", {
          latitude: params.geolocation.latitude,
          longitude: params.geolocation.longitude,
          accuracy: params.geolocation.accuracy ?? 1,
        });
      }
      if (params.offline !== undefined) {
        await send(tabId, "Network.emulateNetworkConditions", {
          offline: Boolean(params.offline),
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      }

      return {
        ok: true,
        result: {
          emulating: {
            device: params.device || null,
            viewport: width && height ? { width, height, deviceScaleFactor, mobile } : null,
            touch: hasTouch,
            colorScheme: params.colorScheme || params.color_scheme || null,
            geolocation: Boolean(params.geolocation),
            offline: params.offline ?? false,
          },
        },
      };
    }

    case "network_rule_add": {
      const s = requireSession(tabId);
      if (!params.match || !params.effect) {
        throw new Error(
          "network_rule_add requires 'match' ({ url, method? }) and 'effect' ({ type: 'mock'|'block', ... })"
        );
      }
      const rule = {
        id: "rule_" + ++ruleCounter,
        match: params.match,
        effect: params.effect,
      };
      if (!s.fetchRules || s.fetchRules.length === 0) {
        await send(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        s.fetchRules = [];
      }
      s.fetchRules.push(rule);
      return { ok: true, result: { ruleId: rule.id, rulesCount: s.fetchRules.length } };
    }

    case "network_rule_remove": {
      const s = requireSession(tabId);
      if (!params.ruleId) throw new Error("network_rule_remove requires 'ruleId'");
      s.fetchRules = (s.fetchRules || []).filter((r) => r.id !== params.ruleId);
      if (s.fetchRules.length === 0) {
        try {
          await send(tabId, "Fetch.disable");
        } catch {}
      }
      return { ok: true, result: { removed: params.ruleId, remaining: s.fetchRules.length } };
    }

    case "network_rule_list": {
      const s = requireSession(tabId);
      return { ok: true, result: { rules: s.fetchRules || [] } };
    }

    case "network_rule_clear": {
      const s = requireSession(tabId);
      s.fetchRules = [];
      try {
        await send(tabId, "Fetch.disable");
      } catch {}
      return { ok: true, result: { cleared: true } };
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
  "get_network_request",
  "network_replay",
  "monitor_requests",
  "wait_for_request",
  "network_rule_add",
  "network_rule_remove",
  "network_rule_list",
  "network_rule_clear",
  "export_har",
  "capture_screenshot",
  "eval_js",
  "spoof_visibility",
  "cdp_send",
  "coordinate_click",
  "coordinate_drag",
  "wheel",
  "emulate",
  "insert_text",
  "a11y_snapshot",
  "element_screenshot",
  "print_pdf",
  "audit",
  "get_cookies",
  "set_cookie",
  "delete_cookies",
];
