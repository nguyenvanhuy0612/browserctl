// CDP module: console logs, network capture, HAR export, JS eval.
//
// These require attaching chrome.debugger to a tab (which shows the "is being
// debugged" infobar). Opt in with cdp_attach, then read with get_console_logs /
// get_network_requests / export_har. eval_js works with or without attach
// (attach bypasses page CSP via Runtime.evaluate).

import { truncate } from "./util.js";

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 2000;

// tabId -> { console: [], network: Map(requestId -> entry) }
const sessions = new Map();

// Per-tab metadata about the most recent CDP screenshot, so coordinate_click/drag can
// map model coordinates (screenshot-pixel space) back to viewport CSS pixels. With
// deviceScaleFactor forced to 1, the only scaling is captureViewport's clip.scale.
const lastCapture = {}; // tabId -> { scale }

export function isAttached(tabId) {
  return sessions.has(tabId);
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Key dispatch helpers (used by the CDP press_key path for modifier shortcuts).
const IS_MAC = /Mac/i.test((globalThis.navigator && navigator.userAgent) || "");
const MOD_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const NAMED_VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, " ": 32,
};
function modMask(mods) { let m = 0; for (const x of mods || []) m |= MOD_BITS[String(x).toLowerCase()] || 0; return m; }
function vkOf(key) { if (!key) return 0; return key.length === 1 ? key.toUpperCase().charCodeAt(0) : (NAMED_VK[key] || 0); }
// DOM physical-key name ("KeyA", "Digit1", "Enter"). Chromium's key handling is more
// faithful when `code` is present alongside the virtual key code.
const NAMED_CODE = { " ": "Space", Escape: "Escape", Enter: "Enter", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End" };
function codeOf(key) {
  if (!key) return undefined;
  if (NAMED_CODE[key]) return NAMED_CODE[key];
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return "Key" + key.toUpperCase();
    if (/[0-9]/.test(key)) return "Digit" + key;
  }
  return undefined;
}
// Mac NSResponder editor commands so Cmd+A / Cmd+Z etc. actually perform the edit — a bare
// synthetic key event does not trigger native editing. No-op off Mac (there the modifier +
// virtual-key code alone drives the native shortcut, e.g. Ctrl+A). Matches the official
// extension's dispatchKeyEvent handling (see docs/prior-art.md #5).
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
// Scale of the most recent CDP screenshot for a tab (1 if none). coordinate_* divide the
// model's screenshot-pixel coords by this to get viewport CSS pixels.
const captureScale = (tabId) => (lastCapture[tabId] && lastCapture[tabId].scale) || 1;

// Record the effective screenshot->CSS-pixel scale for a tab. Exported so
// background.js's non-CDP screenshot paths (chrome.tabs.captureVisibleTab) can
// register their scale too — coordinate_click must remap correctly regardless
// of which screenshot path ran last.
export function setLastCaptureScale(tabId, scale) {
  lastCapture[tabId] = { scale };
}

// Chrome delivers CDP *synthetic input* only to the foreground tab: on a background tab
// (or any tab whose window isn't OS-focused) Input.dispatchMouseEvent and
// Input.dispatchKeyEvent are accepted and return success while doing NOTHING. Verified
// 2026-08-04 on Chrome/macOS: background -> zero keydown reaches the page and a
// coordinate_click never fires the handler; foreground -> both work, including the Mac
// editor commands. Input.insertText is NOT affected (it targets the focused editable
// directly) and neither is Page.captureScreenshot, which is why screenshots of a
// background tab do work.
//
// Returning success for a no-op is the worst outcome for an agent — it reasons on as if
// the click landed. Fail loudly instead, and name both remedies.
async function requireForegroundForInput(tabId, what) {
  let tab, win;
  try {
    tab = await chrome.tabs.get(tabId);
    win = await chrome.windows.get(tab.windowId);
  } catch {
    return; // can't determine state — don't block the command on a lookup failure
  }
  if (tab.active && win.focused) return;
  const why = !tab.active ? "the tab is not the active tab in its window" : "its window is not focused";
  throw new Error(
    `${what} needs the target tab in the foreground (${why}). Chrome silently drops CDP ` +
    `synthetic input for background tabs. Either foreground it first ` +
    `(switch_tab {id, focus:true} — this steals focus), or use a DOM-level equivalent that ` +
    `works in the background: click / click_selector / type / fill_selector / hover / ` +
    `select_option by ref or selector, insert_text for text entry, or press_key with ` +
    `allowSynthetic:true for a synthetic key event.`
  );
}

async function attach(tabId) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
  // Force deviceScaleFactor to 1 so CDP screenshots are captured in CSS-pixel space,
  // matching the coordinates coordinate_click / coordinate_drag dispatch. Without this,
  // HiDPI/Retina displays (e.g. Apple Silicon) produce 2x screenshots, so every pixel
  // coordinate the agent reads off them is off by the device pixel ratio. width/height
  // stay at 0 (= "don't override this dimension"), so only the scale factor changes and
  // the page does not reflow. Best-effort: a failure here must not fail the attach.
  // Use sendRaw (not send) so a transient error here can't recurse into reattach.
  try {
    await sendRaw(tabId, "Emulation.setDeviceMetricsOverride", {
      width: 0, height: 0, deviceScaleFactor: 1, mobile: false,
    });
  } catch {}
}

function detach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

function sendRaw(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res);
    });
  });
}

// Enable the event domains. Uses sendRaw (not send) so it can be called from the
// reattach path without recursing. Idempotent — safe to call more than once.
async function enableDomains(tabId) {
  await sendRaw(tabId, "Network.enable");
  await sendRaw(tabId, "Runtime.enable");
  await sendRaw(tabId, "Log.enable");
  await sendRaw(tabId, "Page.enable");
}

// send with one-shot auto-reattach: a dropped debugger (tab reload, service-worker
// recycle) surfaces as "debugger is not attached"; re-attach once and retry so a single
// action doesn't fail spuriously. If the session had domains enabled, re-enable them
// after reattach — a bare re-attach loses Network/Runtime/Log/Page, so buffered
// console/network events would otherwise silently stop arriving.
async function send(tabId, method, params = {}) {
  try {
    return await sendRaw(tabId, method, params);
  } catch (e) {
    if (/debugger is not attached/i.test(e.message || "")) {
      await attach(tabId);
      const s = sessions.get(tabId);
      if (s && s.domainsEnabled) { try { await enableDomains(tabId); } catch {} }
      return await sendRaw(tabId, method, params);
    }
    throw e;
  }
}

// Key for persisting which tabs have an active CDP session, so a later read (after a
// service-worker recycle wiped the in-memory `sessions` Map) can tell "capture was
// running and got reset" apart from "never attached at all".
const ATTACHED_KEY = "bctl_cdp_attached_tabs";
function persistAttached() {
  chrome.storage.session.set({ [ATTACHED_KEY]: [...sessions.keys()] }).catch(() => {});
}

// Ensure the debugger is attached to a tab and a session record exists, WITHOUT enabling
// the event domains (console/network). Used by the lazy screenshot path so a background
// capture works without a prior cdp_attach. cdp_attach later enables domains on demand.
export async function ensureAttached(tabId) {
  if (!sessions.has(tabId)) {
    await attach(tabId);
    sessions.set(tabId, { console: [], network: new Map(), domainsEnabled: false });
    persistAttached();
  }
  return sessions.get(tabId);
}

// Capture the visible viewport of a tab via CDP. Works on a BACKGROUND tab (the renderer
// stays alive) so we never have to activate it and steal the user's focus. Sizes the
// image down to the vision-token budget via clip.scale (resize happens inside CDP).
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
    // Derive the device-pixel ratio actually in force from the device-vs-CSS viewport
    // ratio. We force deviceScaleFactor=1 on attach so this is normally ~1, but if that
    // override failed the captured image is dpr× larger than CSS pixels. Folding dpr into
    // the recorded scale self-corrects coordinate_click/drag mapping either way.
    const devVp = m.visualViewport || {};
    if (w && devVp.clientWidth) dpr = Math.max(1, devVp.clientWidth / w);
    if (w && h) {
      const MAX_SIDE = 1568; // Anthropic vision tiling: longest side cap
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      clip = { x: 0, y: 0, width: w, height: h, scale };
    }
  } catch {}
  // Record the effective screenshot->CSS-pixel scale so coordinate_click/drag can map
  // model coordinates (read off the returned image) back to viewport CSS pixels.
  lastCapture[tabId] = { scale: (clip ? clip.scale : 1) * dpr };
  const shoot = (q) => send(tabId, "Page.captureScreenshot", {
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

// Like requireSession, but distinguishes "never attached" from "was attached, but the
// service worker recycled and lost the in-memory session" (the live CDP buffers can't be
// restored, so this surfaces an honest error instead of a later silent empty read).
async function requireSessionOrExplainReset(tabId) {
  const s = sessions.get(tabId);
  if (s) return s;
  try {
    const { [ATTACHED_KEY]: ids } = await chrome.storage.session.get(ATTACHED_KEY);
    if (Array.isArray(ids) && ids.includes(tabId)) {
      throw new Error("capture state was reset by a service-worker restart — call cdp_attach again");
    }
  } catch (e) {
    if (/service-worker restart/.test(e.message || "")) throw e;
  }
  throw new Error("not attached: call cdp_attach first");
}

// Require an attached session with the event domains enabled, auto-enabling them if the
// session was only lazily attached (e.g. by a background screenshot) without a prior
// cdp_attach. Used by the log/network read paths so they don't silently return count:0.
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
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.description) return o.description;
  return o.type || "";
}

// Buffer CDP events per attached tab.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;

  switch (method) {
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
      if (s.network.size < MAX_NETWORK) {
        s.network.set(params.requestId, {
          requestId: params.requestId,
          request: params.request,
          resourceType: params.type,
          wallTime: params.wallTime,
          startTs: params.timestamp,
        });
      }
      break;
    case "Network.responseReceived": {
      const e = s.network.get(params.requestId);
      if (e) { e.response = params.response; e.resourceType = params.type; }
      break;
    }
    case "Network.loadingFinished": {
      const e = s.network.get(params.requestId);
      if (e) { e.endTs = params.timestamp; e.encodedDataLength = params.encodedDataLength; }
      break;
    }
    case "Network.loadingFailed": {
      const e = s.network.get(params.requestId);
      if (e) { e.failed = params.errorText; e.endTs = params.timestamp; }
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

// Drop all per-tab CDP state for a closed tab. Called from background.js's
// tabs.onRemoved. The debugger auto-detaches when the tab closes, so we only
// clear our own bookkeeping (sessions is also cleared by onDetach, but that can
// race with removal; lastCapture is otherwise never pruned).
export function dropTab(tabId) {
  sessions.delete(tabId);
  delete lastCapture[tabId];
  persistAttached();
}

function pushConsole(s, entry) {
  s.console.push(entry);
  if (s.console.length > MAX_CONSOLE) s.console.shift();
}

async function runtimeEval(tabId, expression) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "eval error");
  return { value: res.result.value, type: res.result.type };
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
          statusText: resp.statusText || (e.failed || ""),
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
      creator: { name: "browserctl", version: "0.5.0" },
      entries: harEntries,
    },
  };
}

// Build a compact list of meaningful accessibility nodes from a full AX tree.
function collectAxNodes(axNodes, max) {
  const skip = new Set(["none", "GenericContainer", "InlineTextBox", "ignored"]);
  const out = [];
  for (const node of axNodes || []) {
    const role = node.role && node.role.value;
    if (!role || skip.has(role)) continue;
    const name = (node.name && node.name.value) || "";
    const value = node.value && node.value.value;
    if (!name && (value === undefined || value === "")) continue;
    out.push({ role, name, value });
    if (out.length >= max) break;
  }
  return out;
}

function briefRequest(e) {
  return {
    requestId: e.requestId, // needed to fetch the body via get_response_body
    method: e.request.method,
    url: e.request.url,
    resourceType: e.resourceType,
    status: e.response ? e.response.status : null,
    mimeType: e.response ? e.response.mimeType : null,
    size: e.encodedDataLength || null,
    failed: e.failed || null,
    // Verbatim, no redaction — this is a local debug aid (see cross-cutting decision).
    requestHeaders: e.request.headers || null,
    responseHeaders: e.response ? e.response.headers || null : null,
  };
}

// Dispatch a CDP-related action. `tabId` is the resolved active tab.
export async function handleCdp(action, params, tabId) {
  switch (action) {
    case "cdp_attach": {
      // The session may already exist (a lazy screenshot attached without enabling the
      // event domains); enable them here if not already done.
      const s = await ensureAttached(tabId);
      // Re-enable unconditionally (idempotent): a same-tab navigation resets all
      // enabled domains WITHOUT firing onDetach, so gating on domainsEnabled would
      // leave post-navigation capture silently dead. Re-calling enable is cheap.
      await enableDomains(tabId);
      s.domainsEnabled = true;
      return { ok: true, result: { attached: true, tabId } };
    }

    case "cdp_detach": {
      if (sessions.has(tabId)) {
        try { await detach(tabId); } catch {}
        sessions.delete(tabId);
        persistAttached();
      }
      return { ok: true, result: { attached: false, tabId } };
    }

    case "get_console_logs": {
      const s = await requireDomains(tabId);
      const limit = params.limit ?? 200;  // ?? so limit:0 returns none rather than 200
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
      // Best-effort: gather response bodies before building the HAR. One failed
      // body (e.g. evicted) must not abort the export, so each is try/caught.
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
          "response body unavailable for " + params.requestId +
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
      // Full-page screenshot via CDP (captures beyond the viewport). Requires attach.
      // JPEG by default to keep the base64 payload (and the agent's token cost) small;
      // pass format:"png" for a lossless image (e.g. pixel-diff QA). `quality` (jpeg only,
      // default 55) is degraded once to 30 if the capture is still large.
      requireSession(tabId);
      const format = params.format === "png" ? "png" : "jpeg";
      const quality = params.quality ?? 55;
      // Record the screenshot->CSS-pixel scale for coordinate_click/drag, same dpr
      // correction as captureViewport (this path has no clip.scale — only the dpr
      // correction matters, since deviceScaleFactor is normally forced to 1 on attach).
      let dpr = 1;
      try {
        const m = await send(tabId, "Page.getLayoutMetrics");
        const vp = m.cssVisualViewport || m.cssLayoutViewport || {};
        const devVp = m.visualViewport || {};
        const w = Math.round(vp.clientWidth || 0);
        if (w && devVp.clientWidth) dpr = Math.max(1, devVp.clientWidth / w);
      } catch {}
      lastCapture[tabId] = { scale: dpr };
      const shoot = (q) => send(tabId, "Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: q } : {}),
        captureBeyondViewport: params.fullPage !== false,
        fromSurface: true,
      });
      let res = await shoot(quality);
      if (format === "jpeg" && res.data.length > 500000) res = await shoot(30);
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    // Make a backgrounded tab's page JS believe it's visible/focused, so lazy-load /
    // infinite-scroll code gated on document.visibilityState (a common, deliberate
    // resource-saving pattern) fires while the tab never actually becomes the foreground
    // one — the human keeps their own tab. Explicit, opt-in action (not automatic on
    // every scroll/read): visibility state is also used for OTHER things a site may not
    // want spoofed unconditionally (video autoplay, polling/websocket resume, analytics
    // time-on-page), so the caller must ask for this deliberately, once, when it knows
    // the target relies on lazy-loading.
    //
    // KNOWN LIMITATION (confirmed, not just theoretical): this patches JS-visible state
    // only. It does NOT lift Chrome's renderer-level throttling of a backgrounded tab —
    // requestAnimationFrame doesn't fire, IntersectionObserver callbacks ride the (also
    // throttled) rendering pipeline. If a site's loader is driven by rAF/IO rather than a
    // visibilitychange/scroll listener, this may not help; there is no further fallback
    // built here (see PROTOCOL.md for the documented alternative: briefly foreground the
    // tab, restore after).
    case "spoof_visibility": {
      await ensureAttached(tabId);
      try { await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }); }
      catch {} // best-effort; experimental CDP method, absence shouldn't fail the whole action
      const patch = `(() => {
        const patched = { visibilityState: false, hidden: false };
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
      return { ok: true, result: { spoofed: value, tabId } };
    }

    case "eval_js": {
      if (!params.expression) throw new Error("eval_js requires 'expression'");
      if (sessions.has(tabId)) {
        return { ok: true, result: await runtimeEval(tabId, params.expression) };
      }
      // Fallback without attach: run in the page's MAIN world (subject to page CSP).
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (expr) => {
          try {
            const v = eval(expr);
            // JSON.stringify(undefined) returns undefined (not "undefined"), and
            // JSON.parse(undefined) throws — surfacing a misleading error for a
            // successful eval that simply returns nothing (assignments, void, DOM calls).
            if (v === undefined) return { ok: true, value: null };
            return { ok: true, value: JSON.parse(JSON.stringify(v)) };
          }
          catch (err) { return { ok: false, error: String(err) }; }
        },
        args: [params.expression],
      });
      if (!out.result.ok) {
        throw new Error(out.result.error + " (tip: cdp_attach first to bypass page CSP)");
      }
      return { ok: true, result: { value: out.result.value } };
    }

    case "coordinate_click": {
      requireSession(tabId);
      await requireForegroundForInput(tabId, "coordinate_click");
      const s = captureScale(tabId);
      const x = params.x / s, y = params.y / s;
      const button = params.button || "left";
      const clickCount = params.clickCount || 1;
      const buttons = BUTTON_MASK[button] || 1;
      // Real click sequence: move, settle, press, brief hold, release — so sites that
      // gate on hover/mousedown timing behave as with a human click.
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await pause(40);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount });
      await pause(12);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
      return { ok: true, result: { clicked: { x, y } } };
    }

    case "coordinate_drag": {
      requireSession(tabId);
      await requireForegroundForInput(tabId, "coordinate_drag");
      const s = captureScale(tabId);
      const fromX = params.fromX / s, fromY = params.fromY / s;
      const toX = params.toX / s, toY = params.toY / s;
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
      await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1 });
      await pause(12);
      // A couple of intermediate moves so drag-tracking handlers fire.
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: (fromX + toX) / 2, y: (fromY + toY) / 2, button: "left", buttons: 1 });
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: toX, y: toY, button: "left", buttons: 1 });
      await pause(12);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1 });
      return { ok: true, result: { dragged: true } };
    }

    case "press_key_cdp": {
      // Key press via CDP with modifier support + Mac editor commands. Acts on the page's
      // currently focused element (click/type/focus the field first). Routed here by
      // background.js only when modifiers are present and the debugger is attached.
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
      // via:"cdp" = a real OS-level key event (native editor commands apply). The DOM
      // fallback in content.js reports via:"dom" instead, so a caller can always tell
      // which semantics it got.
      return { ok: true, result: { pressed: key, modifiers: params.modifiers || [], commands, via: "cdp" } };
    }

    case "cdp_send": {
      // Raw CDP escape hatch: send ANY method in the chrome.debugger domain allowlist to
      // the target tab and return its result verbatim. This exists so a capability that
      // has no first-class tool yet (Fetch request interception, DOM.setFileInputFiles,
      // Page.handleJavaScriptDialog, Emulation.*, Storage.*, Tracing.*) can be used or
      // prototyped without shipping a tool per method — and so debugging a CDP question
      // does not require editing this file and reloading the extension.
      //
      // Deliberately unguarded beyond requiring an attach: it is a power tool on a
      // single-user, trusted-machine bridge (see README "Security"). It can wedge a tab
      // (e.g. Fetch.enable with no handler pauses every request until you disable it) and
      // it can undo this module's own invariants (Emulation.setDeviceMetricsOverride
      // changes the screenshot scale that coordinate_click relies on).
      requireSession(tabId);
      const method = params.method;
      if (!method || typeof method !== "string") {
        throw new Error("cdp_send requires 'method' (e.g. 'Page.getLayoutMetrics')");
      }
      if (!method.includes(".")) {
        throw new Error(`'${method}' is not a CDP method name — expected Domain.method`);
      }
      const result = await send(tabId, method, params.params || {});
      // CDP methods that return nothing resolve to undefined; report null so the caller
      // can tell "succeeded with no payload" from a transport failure.
      return { ok: true, result: { method, result: result === undefined ? null : result } };
    }

    case "insert_text": {
      // Type into the focused element via CDP, robust for emoji/IME/multibyte that
      // char-by-char keycodes can't represent.
      requireSession(tabId);
      if (params.text === undefined) throw new Error("insert_text requires 'text'");
      await send(tabId, "Input.insertText", { text: String(params.text) });
      return { ok: true, result: { inserted: String(params.text).length } };
    }

    case "a11y_snapshot": {
      requireSession(tabId);
      const max = params.max ?? 200;  // ?? so max:0 is honoured
      try { await send(tabId, "Accessibility.enable"); } catch {}
      const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
      const nodes = collectAxNodes(axNodes, max);
      return { ok: true, result: { count: nodes.length, nodes } };
    }

    case "element_screenshot": {
      requireSession(tabId);
      const format = params.format || "png";
      // Prefer a rect resolved by the content script (which owns ref/index resolution,
      // including shadow-DOM elements). Fall back to the data-bctl-ref index stamp for
      // callers that still pass a raw index without a resolved rect.
      let r = params.rect;
      if (!r) {
        const index = params.index;
        const rect = await send(tabId, "Runtime.evaluate", {
          expression: `(()=>{const e=document.querySelector('[data-bctl-ref="${index}"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
          returnByValue: true,
        });
        r = rect.result && rect.result.value;
      }
      if (!r) throw new Error(`element not found (snapshot first, or pass a valid ref/index)`);
      // r is viewport-relative (getBoundingClientRect), but Page.captureScreenshot's
      // clip is page-absolute when captureBeyondViewport is true — add the page scroll
      // offset so a scrolled page clips the right region (Puppeteer does the same via
      // layoutViewport.pageX/pageY).
      let scrollX = 0, scrollY = 0;
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
      // printToPDF is normally headless-only, but Edge/Chrome support it via CDP
      // for the active page. Auto-attach if not already attached.
      const needAttach = !sessions.has(tabId);
      if (needAttach) {
        try { await attach(tabId); } catch (err) {
          // If debugger is already attached externally, proceed with send
          if (!err.message.includes("already attached")) throw err;
        }
      }
      try {
        const res = await send(tabId, "Page.printToPDF", { printBackground: true });
        return { ok: true, result: { base64: res.data } };
      } finally {
        if (needAttach) {
          try { await detach(tabId); } catch {}
        }
      }
    }

    case "audit": {
      requireSession(tabId);
      try { await send(tabId, "Performance.enable"); } catch {}
      const { metrics } = await send(tabId, "Performance.getMetrics");
      const metricMap = {};
      for (const m of metrics || []) metricMap[m.name] = m.value;
      const wanted = [
        "Documents", "Nodes", "JSHeapUsedSize", "LayoutCount",
        "RecalcStyleCount", "ScriptDuration", "TaskDuration",
      ];
      const performance = {};
      for (const name of wanted) {
        if (metricMap[name] !== undefined) performance[name] = metricMap[name];
      }

      // Best-effort accessibility audit: count interactive nodes missing a name.
      let interactiveMissingName = 0;
      let totalAxNodes = 0;
      try {
        try { await send(tabId, "Accessibility.enable"); } catch {}
        const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
        const interactiveRoles = new Set([
          "button", "link", "textbox", "checkbox", "radio", "combobox",
          "listbox", "menuitem", "switch", "slider", "tab",
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
      try { await send(tabId, "Network.enable"); } catch {}
      const { cookies: all } = await send(tabId, "Network.getAllCookies");
      const filtered = params.urlContains
        ? (all || []).filter((c) => String(c.domain || "").includes(params.urlContains))
        : (all || []);
      const cookies = filtered.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        value: c.value,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires,
      }));
      return { ok: true, result: { count: cookies.length, cookies } };
    }

    case "set_cookie": {
      requireSession(tabId);
      try { await send(tabId, "Network.enable"); } catch {}
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
      try { await send(tabId, "Network.enable"); } catch {}
      await send(tabId, "Network.deleteCookies", { name: params.name, url: params.url });
      return { ok: true, result: { deleted: params.name } };
    }

    default:
      throw new Error(`unknown cdp action: ${action}`);
  }
}

export const CDP_ACTIONS = [
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
