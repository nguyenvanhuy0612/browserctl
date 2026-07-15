// Service worker: keeps a WebSocket open to the bridge and dispatches commands.
//
// Commands that touch the page DOM (snapshot/click/type/scroll) are forwarded to
// the content script. Tab/window-level commands are handled here with chrome.*.
// Console/network/HAR/eval commands are handled by the CDP module (cdp.js).

import { handleCdp, CDP_ACTIONS, captureViewport, isAttached, setLastCaptureScale, dropTab as cdpDropTab } from "./cdp.js";
import { handleNet, NET_ACTIONS, dropTab as netDropTab } from "./netlog.js";

// DOM-level commands that run in the active tab's content script.
const CONTENT_ACTIONS = [
  "snapshot",
  "read_page",
  "find",
  "find_text",
  "click",
  "type",
  "scroll",
  "hover",
  "select_option",
  "press_key",
  "wait_settle",
  "get_page_content",
  "describe_element",
  "click_selector",
  "fill_selector",
  "storage_get",
  "storage_set",
  "storage_remove",
  "storage_clear",
];

// Recorded interaction steps, accumulated from the content recorder (record_start).
let recordingSteps = [];
const MAX_RECORD_STEPS = 5000; // cap so a long/runaway recording can't grow unbounded

// Whether a recording is (believed to be) in progress in THIS service-worker instance.
// Persisted to storage.session so record_get can tell "recycled mid-recording" (recording
// was on, steps are now gone) apart from "never started" — the in-memory steps can't be
// recovered, so the goal is an honest error instead of a silent empty count.
let isRecording = false;
const RECORDING_KEY = "aibc_recording";
function persistRecording(on) {
  chrome.storage.session.set({ [RECORDING_KEY]: on }).catch(() => {});
}

// The content recorder pushes each captured step here via chrome.runtime.sendMessage.
// The popup also talks to the worker here: read connection state, Connect, Disconnect.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.__aibc_record_step) {
    recordingSteps.push(msg.__aibc_record_step);
    if (recordingSteps.length > MAX_RECORD_STEPS) recordingSteps.shift();
    return;
  }
  if (msg && msg.__aibc_getState) {
    chrome.storage.local.get(["bridgeHost", "bridgePort"]).then((cfg) => {
      sendResponse({
        connState,
        host: cfg.bridgeHost || DEFAULT_HOST,
        port: cfg.bridgePort || DEFAULT_PORT,
      });
    });
    return true; // async sendResponse
  }
  if (msg && msg.__aibc_connect) { startConnecting(); sendResponse({ ok: true }); return; }
  if (msg && msg.__aibc_disconnect) { stopConnecting(); sendResponse({ ok: true }); return; }
});

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const RECONNECT_MS = 2000;
const MAX_BACKOFF_MS = 30000; // cap the exponential backoff between reconnect tries

let socket = null;
let attempts = 0;
let reconnectTimer = null;
// Guards the async gap in connect() between the readyState check and the socket being
// created/assigned (awaiting bridgeWsUrl()), so a second connect() call landing in that
// gap (e.g. from the keepalive alarm) is a no-op instead of racing a duplicate socket.
let connecting = false;

// Are we actively trying to be connected? Drives whether close/keepalive retry.
let wantConnect = false;
// "idle" | "connecting" | "connected" — reported to the popup. ("connecting"
// persists across a down bridge: we retry with backoff instead of failing out.)
let connState = "idle";

// Bridge host/port are configurable on the options page (chrome.storage.local).
async function bridgeWsUrl() {
  const { bridgeHost = DEFAULT_HOST, bridgePort = DEFAULT_PORT } =
    await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  return `ws://${bridgeHost}:${bridgePort}/extension`;
}

// Begin (or resume) trying to connect, clearing any prior give-up state.
function startConnecting() {
  wantConnect = true;
  attempts = 0;
  clearTimeout(reconnectTimer);
  connState = "connecting";
  chrome.storage.local.set({ giveUp: false });
  connect();
}

// Stop trying and drop any open socket. Persist giveUp so a recycled service
// worker (or the keepalive alarm) won't silently reconnect on its own.
function stopConnecting() {
  wantConnect = false;
  clearTimeout(reconnectTimer);
  if (socket) { try { socket.close(); } catch {} }
  socket = null;
  connState = "idle";
  chrome.storage.local.set({ giveUp: true });
}

async function connect() {
  if (!wantConnect) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connecting) return; // another connect() is already past this point, awaiting the URL
  connecting = true;
  clearTimeout(reconnectTimer);
  connState = "connecting";
  let url;
  try {
    url = await bridgeWsUrl();
  } finally {
    connecting = false;
  }
  // Re-check after the await: wantConnect may have flipped, or another connect() call
  // (e.g. from a close/error handler firing during the gap) may have already opened a
  // live socket, in which case this call should not create a second one.
  if (!wantConnect) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const ws = new WebSocket(url);
  socket = ws;

  // Every handler below is bound to the local `ws` it was created for and ignores the
  // event if `ws !== socket` — i.e. this socket has since been replaced/closed elsewhere
  // — so a stale socket's late events can't act on (or close) the current live socket.
  ws.addEventListener("open", () => {
    if (ws !== socket) return;
    attempts = 0;
    connState = "connected";
    console.log("[ai-browser] bridge connected:", url);
    // First successful connect: enable bounded auto-retry on future startups.
    chrome.storage.local.set({ autoConnect: true, giveUp: false });
  });

  ws.addEventListener("message", async (event) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    // Heartbeat from the bridge. Receiving this message is itself what resets the
    // MV3 service-worker idle timer; the pong lets the bridge detect a dead link.
    if (msg.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    const reply = await dispatch(msg).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }));
    reply.id = msg.id;
    if (ws !== socket) return; // replaced while dispatch() was in flight
    try { ws.send(JSON.stringify(reply)); } catch {}
  });

  ws.addEventListener("close", () => {
    if (ws !== socket) return; // a stale socket closing; the current socket already replaced it
    const wasConnected = connState === "connected";
    socket = null;
    if (!wantConnect) { connState = "idle"; return; }
    // Never latch a permanent give-up on a transient outage: keep retrying with
    // capped exponential backoff until we reconnect or the user hits Disconnect.
    // A dropped live link restarts the backoff from the bottom. The setTimeout is
    // best-effort (it dies if the service worker is suspended); the chrome.alarms
    // keepalive below is the durable backstop that resumes reconnect after a recycle.
    if (wasConnected) attempts = 0;
    attempts++;
    connState = "connecting";
    const delay = Math.min(RECONNECT_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(connect, delay);
  });

  ws.addEventListener("error", () => {
    if (ws !== socket) return;
    try { ws.close(); } catch {}
  });
}

// On service-worker load/startup, only auto-connect if the user has connected
// before (autoConnect) and hasn't been left in the give-up state. A fresh
// install stays idle and makes NO socket attempt -> no console error.
async function init() {
  const { autoConnect = false, giveUp = false } =
    await chrome.storage.local.get(["autoConnect", "giveUp"]);
  if (autoConnect && !giveUp) startConnecting();
  else connState = "idle";
}

// Route a command to the right handler. Returns { ok, result } or throws.
async function dispatch({ action, params = {} }) {
  // element_screenshot needs a rect the content script resolves (by ref/index, incl.
  // shadow DOM), then CDP clips to it. Resolve the rect first, then hand it to the CDP
  // handler so a read_page/find ref works, not just a snapshot index.
  if (action === "element_screenshot") {
    const tab = await targetTab(params);
    const { frameId, params: p } = frameRoute(params);
    const rectReply = await toContent("element_rect", { index: p.index, ref: p.ref, tabId: params.tabId }, frameId);
    if (!rectReply.ok) return rectReply;
    // NOTE: a sub-frame rect is frame-relative while the CDP clip is page-relative, so
    // element_screenshot of a ref inside an iframe can be offset. Top-frame is exact.
    return await handleCdp("element_screenshot", { rect: rectReply.result, format: params.format }, tab.id);
  }

  // press_key with modifiers (Cmd+A, Cmd+Z, ...) needs CDP so Mac editor commands fire;
  // route there when the debugger is attached. The content-script key dispatch ignores
  // modifiers entirely, so falling through to it would silently drop them and report
  // success — return a clear error instead so the caller knows to cdp_attach first.
  if (action === "press_key" && Array.isArray(params.modifiers) && params.modifiers.length) {
    const tab = await targetTab(params);
    if (isAttached(tab.id)) return await handleCdp("press_key_cdp", params, tab.id);
    return { ok: false, error: "modifiers require cdp_attach" };
  }

  // CDP-backed commands (console/network/HAR/eval) operate on the target tab.
  if (CDP_ACTIONS.includes(action)) {
    const tab = await targetTab(params);
    return await handleCdp(action, params, tab.id);
  }

  // Light network capture (chrome.webRequest, no debugger banner).
  // handleNet already returns { ok, result }, so pass it through (no double-wrap).
  if (NET_ACTIONS.includes(action)) {
    const tab = await targetTab(params);
    return await handleNet(action, params, tab.id);
  }

  // DOM-level commands run in the target tab's content script(s), which already reply
  // in { ok, result|error } shape. Reads (snapshot/read_page/find) aggregate across all
  // frames; ref-addressed actions route to the frame that owns the ref (see frameRoute).
  // read_page with a ref_id is ref-addressed too (the ref lives in exactly one frame) —
  // broadcasting it via crossFrame would fail in every frame and fall back to a fake
  // empty result, so route it directly like the ref-addressed actions below.
  if (CONTENT_ACTIONS.includes(action)) {
    // Fast-fail on a PDF tab: Chrome's built-in PDF viewer isn't a real DOM (no text
    // nodes for get_page_content/find_text to read, no INTERACTIVE_SELECTOR elements
    // for snapshot/find/click), so every content action would otherwise silently return
    // empty/confusing results — an agent burned 50-60+ tool calls discovering that the
    // hard way before this check existed. One cheap URL check here, before crossFrame OR
    // toContent, covers every content action in one place.
    const tab = await targetTab(params);
    if (looksLikePdf(tab.url)) {
      return { ok: false, error: `tab is showing a PDF (no readable DOM) — call read_pdf instead of '${action}'` };
    }
    // Pin the tab resolved above as an explicit tabId for the rest of this dispatch.
    // Without this, when the caller used the global pin (no params.tabId), the SECOND
    // targetTab() resolution below (inside crossFrame/toContent) could land on a
    // different tab if the pinned target closes in the brief window between the two
    // calls — silently re-pinning onto whatever's now active, the exact drift the
    // pinning model exists to prevent. An explicit tabId fails closed ("tab not found")
    // instead.
    if (params.tabId == null) params = { ...params, tabId: tab.id };
    // Mark "a click just happened" for the focus-steal catch below — click and
    // click_selector are the two actions that invoke a real DOM .click(), which can hit a
    // target="_blank" link or an onclick handler's window.open(). Only register a
    // candidate when the CURRENT foreground tab is itself one we're driving — Chrome
    // attributes a spawned tab's opener to the foreground tab regardless of which
    // (possibly background) tab actually fired the click, so gating on drivenTabIds
    // keeps an unrelated tab the user opens by hand in their own foreground tab from
    // being mistaken for our own automation.
    if (action === "click" || action === "click_selector") {
      try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (active && drivenTabIds.has(active.id)) {
          pruneClickCandidates();
          clickCandidates.push({ at: Date.now(), restoreTo: active.id });
        }
      } catch {}
    }
    if (action === "snapshot" || action === "find" || (action === "read_page" && !params.ref_id)) {
      return await crossFrame(action, params);
    }
    const { frameId, params: p } = frameRoute(params);
    return await toContent(action, p, frameId);
  }

  switch (action) {
    case "navigate":     return { ok: true, result: await navigate(params) };
    case "screenshot":   return { ok: true, result: await screenshot(params) };
    case "list_tabs":    return { ok: true, result: await listTabs() };
    case "new_tab":      return { ok: true, result: await newTab(params) };
    case "group_tab":    return { ok: true, result: await groupTab(params) };
    case "ungroup_tab":  return { ok: true, result: await ungroupTab(params) };
    case "switch_tab":   return { ok: true, result: await switchTab(params) };
    case "close_tab":    return { ok: true, result: await closeTab(params) };
    case "go_back":      return { ok: true, result: await goBack(params) };
    case "go_forward":   return { ok: true, result: await goForward(params) };
    case "reload":       return { ok: true, result: await reload(params) };
    case "list_windows": return { ok: true, result: await listWindows() };
    case "focus_window": return { ok: true, result: await focusWindow(params) };
    case "current_tab":  return { ok: true, result: await currentTab(params) };
    case "read_pdf":     return { ok: true, result: await readPdf(params) };
    case "wait_for":     return await waitFor(params);

    case "reload_extension": return { ok: true, result: reloadExtension() };
    case "record_start":     return { ok: true, result: await recordStart(params) };
    case "record_stop":      return { ok: true, result: await recordStop(params) };
    case "record_get": {
      // isRecording resets to false on a fresh service-worker instance regardless of
      // history, so a false here with no steps buffered is ambiguous — check the
      // persisted flag to tell "never started" apart from "recycled mid-recording".
      if (!isRecording && recordingSteps.length === 0) {
        const { [RECORDING_KEY]: wasRecording } = await chrome.storage.session.get(RECORDING_KEY);
        if (wasRecording) {
          return { ok: false, error: "capture state was reset by a service-worker restart — call record_start again" };
        }
      }
      return { ok: true, result: { count: recordingSteps.length, steps: recordingSteps } };
    }
    case "replay":           return { ok: true, result: await replay(params) };

    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// Reload the whole extension from disk (picks up edited files). Reply is sent
// first; the actual reload fires shortly after so this command can return.
function reloadExtension() {
  setTimeout(() => chrome.runtime.reload(), 300);
  return { reloading: true };
}

// NOTE: recordingSteps/isRecording are single, extension-wide state (one recording at a
// time), unlike other actions here. Passing tabId targets the content-script listener at
// the right tab, but two agents cannot record two tabs concurrently — the second
// record_start resets the one shared buffer. Not fixed here; documented as a known limit.
async function recordStart(params) {
  recordingSteps = [];
  isRecording = true;
  persistRecording(true);
  await toContent("record_start", { tabId: params && params.tabId });
  return { recording: true };
}

async function recordStop(params) {
  isRecording = false;
  persistRecording(false);
  await toContent("record_stop", { tabId: params && params.tabId });
  return { recording: false, count: recordingSteps.length };
}

// Replay recorded (or supplied) steps against the target tab (or params.tabId).
async function replay({ steps, startUrl, tabId } = {}) {
  const plan = steps || recordingSteps;
  if (startUrl) { await navigate({ url: startUrl, tabId }); }
  const done = [];
  for (const step of plan) {
    if (step.type === "navigate" && step.url) {
      await navigate({ url: step.url, tabId });
    } else if (step.type === "click") {
      await toContent("click_selector", { selector: step.selector, tabId });
    } else if (step.type === "input") {
      await toContent("fill_selector", { selector: step.selector, value: step.value, tabId });
    } else {
      continue;
    }
    done.push(step.type);
    await new Promise((r) => setTimeout(r, 400)); // let the page settle between steps
  }
  return { replayed: done.length, steps: plan.length };
}

// Time-only waits resolve here; selector/text waits poll in the content script.
async function waitFor(params) {
  if (params.selector || params.text) return await toContent("wait_for", params);
  const ms = params.timeoutMs || 1000;
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, result: { waitedMs: ms } };
}

// The tab the agent is driving. Pinned when the agent explicitly opens, switches
// to, or navigates a tab; cleared when that tab closes. This decouples agent
// commands from whatever the user manually clicks, so a snapshot/read can't
// silently land on a different (possibly sensitive) tab.
let targetTabId = null;

// Every tab we've resolved as a target (pinned or explicit tabId) at least once. Used
// below ONLY to gate the focus-steal correction against a driven tab's foreground
// identity — NOT to match a spawned tab's openerTabId directly (see the long comment
// on the onCreated/onActivated pair for why that doesn't work).
const drivenTabIds = new Set();

// A click on a driven (possibly background) tab can hit a target="_blank" link or
// window.open(), which Chrome opens as a new ACTIVE tab by default — entirely outside
// our own chrome.tabs.create() calls (which already pass active:false), so that fix
// alone doesn't cover it. Tracked as a QUEUE (not a single scalar): with several agents
// each clicking their own driven tab concurrently, or one click spawning two popups, a
// single "last click" variable would let one candidate silently overwrite another's
// tracking. Each entry is {at, restoreTo}; pruned to RECENT_CLICK_WINDOW_MS.
let clickCandidates = [];
const RECENT_CLICK_WINDOW_MS = 800; // observed actual creation latency is ~6ms; this
  // stays generous while narrowing the window an unrelated user action could land in.

function pruneClickCandidates() {
  const cutoff = Date.now() - RECENT_CLICK_WINDOW_MS;
  clickCandidates = clickCandidates.filter((c) => c.at > cutoff);
}

// spawnedTabId -> tabId to restore focus to. A Map (not a single scalar) so onActivated
// only ever acts on the SPECIFIC tab it was told to correct — an unrelated activation
// (user alt-tabs, another agent's tab, a second spawned tab) can't consume or clear a
// pending correction that belongs to a different tab.
const pendingFocusRestores = new Map();

// Persist the pin to chrome.storage.session so it survives a service-worker recycle.
// Without this, an MV3 suspend (~30s idle) drops targetTabId and the next command
// silently re-pins onto whatever tab the user is now viewing — the exact drift the
// pinning model exists to prevent. storage.session is in-memory (cleared on browser
// close), which matches tab-id lifetime.
function pinTarget(id) {
  targetTabId = id;
  chrome.storage.session.set({ targetTabId: id });
}

function unpinTarget() {
  targetTabId = null;
  chrome.storage.session.remove("targetTabId");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

// Cheap, deterministic heuristic: does this URL point at a .pdf file (Chrome renders
// those with its built-in PDF viewer, not a real DOM)? Checks the path only, so a
// query/fragment after ".pdf" doesn't defeat it and an unrelated ".pdf" substring
// elsewhere in the URL doesn't false-positive. Doesn't catch PDFs served without a
// literal .pdf extension — a known, accepted gap (see read_pdf).
function looksLikePdf(url) {
  if (!url) return false;
  try { return /\.pdf$/i.test(new URL(url).pathname); }
  catch { return false; }
}

// Report whether the target tab is showing a PDF and, if so, its URL — this extension
// does not extract PDF text itself (Chrome's built-in viewer isn't a real DOM, and a
// hand-rolled parser silently mis-reads subset/CID-font PDFs, which is worse than
// erroring for numeric data like a rate sheet). The caller is expected to fetch the URL
// and read it with its own PDF-reading capability instead.
async function readPdf(params) {
  const tab = await targetTab(params);
  const isPdf = looksLikePdf(tab.url);
  return {
    url: tab.url,
    isPdf,
    note: isPdf
      ? "This extension does not extract PDF text. Fetch this URL and read it with your own PDF-reading capability."
      : "This tab's URL does not look like a PDF (no .pdf extension found in the path).",
  };
}

// The tab DOM/CDP commands operate on. Pin-on-first-touch: if a target is pinned and
// still exists, use it; otherwise grab the focused active tab AND pin it, so the agent
// locks onto one tab at its first command and never drifts onto a tab the user later
// switches to. switch_tab / navigate / new_tab re-pin explicitly.
//
// Per-command override: any command may carry params.tabId to act on THAT specific tab
// for this one command WITHOUT touching the global pin. This lets several agents drive
// different tabs concurrently (each passes its own tabId) instead of racing on one pin.
async function targetTab(params) {
  if (params && params.tabId != null) {
    const id = Number(params.tabId);
    if (!Number.isInteger(id)) throw new Error(`invalid tabId: ${params.tabId}`);
    try {
      const tab = await chrome.tabs.get(id);
      drivenTabIds.add(tab.id);
      return tab;
    } catch {
      throw new Error(`tab ${id} not found`);
    }
  }
  // Recover the pin from session storage if the worker was recycled since it was set.
  if (targetTabId == null) {
    const { targetTabId: saved } = await chrome.storage.session.get("targetTabId");
    if (saved != null) targetTabId = saved;
  }
  if (targetTabId != null) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      drivenTabIds.add(tab.id);
      return tab;
    } catch {
      unpinTarget(); // target was closed; re-pin below
    }
  }
  const tab = await activeTab();
  pinTarget(tab.id);
  return tab;
}

// If the pinned target tab is closed, unpin so the next command re-pins cleanly, and
// drop any CDP/network/focus-restore state we held for it so nothing leaks per closed tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) unpinTarget();
  drivenTabIds.delete(tabId);
  pendingFocusRestores.delete(tabId);
  cdpDropTab(tabId);
  netDropTab(tabId);
});

// A click we just dispatched can hit a target="_blank" link or a window.open() call,
// which Chrome opens as a new ACTIVE tab by default — outside our own tab-creation calls
// (new_tab already passes active:false), so it needs its own catch here.
//
// A same-tick chrome.tabs.update(newTab, {active:false}) inside onCreated resolves
// without error but does NOT stick — confirmed empirically: Chrome activates the new
// target="_blank" tab in a step that runs AFTER onCreated fires, silently overwriting our
// correction. onActivated is the authoritative "this tab is now shown" event (it fires
// after whatever internal step actually flips activation), so react to THAT instead: claim
// the oldest pending click candidate for the newly created tab in onCreated, then when
// onActivated confirms that SPECIFIC tab actually became active, restore focus to
// whichever tab was in front when that click was dispatched.
chrome.tabs.onCreated.addListener((tab) => {
  pruneClickCandidates();
  if (tab.openerTabId == null || clickCandidates.length === 0) return;
  const candidate = clickCandidates.shift(); // FIFO: oldest pending click claims this tab
  pendingFocusRestores.set(tab.id, candidate.restoreTo);
  chrome.tabs.update(tab.id, { active: false }).catch(() => {}); // best-effort; onActivated below is the real fix
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const restoreTo = pendingFocusRestores.get(tabId);
  if (restoreTo == null) return; // an unrelated activation — never touches other tabs' pending entries
  pendingFocusRestores.delete(tabId);
  chrome.tabs.update(restoreTo, { active: true }).catch(() => {});
});

// Report which tab commands currently act on (for the agent to verify before reading).
// With params.tabId, report that specific tab; `pinned` still reflects the global pin.
async function currentTab(params) {
  const tab = await targetTab(params);
  return { id: tab.id, url: tab.url, title: tab.title, active: tab.active, pinned: targetTabId != null };
}

async function navigate(params = {}) {
  const { url } = params;
  if (!url) throw new Error("navigate requires 'url'");
  const tab = await targetTab(params);
  // Re-pin only when driving the global target; an explicit tabId navigates that tab
  // without hijacking the pin (so concurrent per-tab agents don't clobber each other).
  if (params.tabId == null) pinTarget(tab.id); // pin: subsequent reads stay on the tab we navigated
  const done = waitForComplete(tab.id); // start listening BEFORE the load begins
  await chrome.tabs.update(tab.id, { url });
  await done;
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url };
}

// Resolve once the tab finishes a load STARTED after this call (or after a safety
// timeout). Must be called before the tabs.update/reload that triggers the load so we
// catch the loading->complete transition; resolving on the first "complete" seen would
// otherwise race against the previous page's already-fired "complete". A same-document
// (hash/SPA) navigation emits no load cycle, so if no "loading" is seen shortly we
// resolve anyway rather than block for the full timeout.
function waitForComplete(tabId) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const hard = setTimeout(finish, 15_000);
    const soft = setTimeout(() => { if (!sawLoading) finish(); }, 1500);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    }
    function finish() {
      clearTimeout(hard);
      clearTimeout(soft);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Best-effort devicePixelRatio of a tab, for the captureVisibleTab path below (which
// captures at device pixels, not CSS pixels — unlike the CDP paths, which force
// deviceScaleFactor to 1). Falls back to 1 (no correction) if it can't be read.
async function getDevicePixelRatio(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio || 1,
    });
    return result || 1;
  } catch {
    return 1;
  }
}

async function screenshot(params = {}) {
  const { format = "jpeg", quality = 55 } = params;
  const tab = await targetTab(params);
  // If a debugger session already exists on this tab, capture via CDP so the screenshot
  // is in the same pixel space coordinate_click maps against (avoids a Retina/clip-scale
  // mismatch). Otherwise prefer the no-banner path when the tab is foreground.
  if (isAttached(tab.id)) {
    return await captureViewport(tab.id, { format, quality });
  }
  // If the target is the active tab of its window, capture it directly — no debugger,
  // no banner. captureVisibleTab grabs that window's visible tab regardless of OS focus.
  if (tab.active) {
    const opts = format === "png" ? { format: "png" } : { format: "jpeg", quality };
    let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
    if (format !== "png" && dataUrl.length > 500000) {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 30 });
    }
    // captureVisibleTab returns device pixels (2x on Retina); record that scale so a
    // later coordinate_click (which divides by it) maps back to viewport CSS pixels
    // regardless of which screenshot path ran last.
    setLastCaptureScale(tab.id, await getDevicePixelRatio(tab.id));
    return { dataUrl };
  }
  // Background tab: capture via CDP so we DON'T activate it and steal the user's focus.
  // Attaches the debugger on first use (the "is being debugged" banner appears on this
  // tab only). Restricted pages (chrome://, Web Store) reject the debugger — that error
  // surfaces rather than silently flipping the tab to the foreground.
  return await captureViewport(tab.id, { format, quality });
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  };
}

async function newTab({ url }) {
  // active:false — chrome.tabs.create() defaults to activating (switching the user's
  // view to) the new tab, which is exactly the focus-steal this whole extension is
  // built to avoid. Every other action here is already background-safe; this was the
  // one call site that wasn't.
  const tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: false });
  pinTarget(tab.id); // pin: the agent now drives the tab it just opened
  return { id: tab.id };
}

// Put a tab into a labeled tab group so the user can see which tab the agent drives.
// Defaults to the target tab. Grouping does NOT activate the tab, so this never steals
// the user's focus. Also pins the grouped tab as the target.
async function groupTab({ id, title = "aibc", color = "blue" } = {}) {
  const tabId = id != null ? id : (await targetTab()).id;
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  pinTarget(tabId); // pin (no activation) — before the title step so a titling failure can't skip it
  // Title/color need the "tabGroups" permission; the group still exists without it.
  try {
    await chrome.tabGroups.update(groupId, { title, color });
  } catch (e) {
    return { groupId, tabId, titled: false, note: `grouped, but could not set title/color: ${e.message}` };
  }
  return { groupId, tabId, title, color };
}

async function ungroupTab({ id } = {}) {
  const tabId = id != null ? id : (await targetTab()).id;
  await chrome.tabs.ungroup(tabId);
  return { ungrouped: tabId };
}

async function switchTab({ id, focus = false }) {
  if (id == null) throw new Error("switch_tab requires 'id'");
  const tab = await chrome.tabs.update(id, { active: true });
  // Activating the tab within its window is enough to retarget. Raising the whole
  // window steals OS focus from the user, so only do it when explicitly asked.
  if (focus) await chrome.windows.update(tab.windowId, { focused: true });
  pinTarget(tab.id); // pin to the tab the agent switched to
  return { id: tab.id };
}

async function closeTab({ id }) {
  if (id == null) throw new Error("close_tab requires 'id'");
  await chrome.tabs.remove(id);
  if (id === targetTabId) unpinTarget(); // unpin a closed target
  return { id };
}

async function goBack(params) {
  const tab = await targetTab(params);
  const done = waitForComplete(tab.id); // wait for the history nav to land (same as navigate/reload)
  await chrome.tabs.goBack(tab.id);
  await done;
  return { id: tab.id };
}

async function goForward(params) {
  const tab = await targetTab(params);
  const done = waitForComplete(tab.id);
  await chrome.tabs.goForward(tab.id);
  await done;
  return { id: tab.id };
}

async function reload(params = {}) {
  const { bypassCache } = params;
  const tab = await targetTab(params);
  const done = waitForComplete(tab.id); // listen before triggering the reload
  await chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache });
  await done;
  return { id: tab.id };
}

async function listWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  return {
    windows: windows.map((w) => ({
      id: w.id,
      focused: w.focused,
      state: w.state,
      tabCount: (w.tabs || []).length,
      tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
    })),
  };
}

async function focusWindow({ id }) {
  if (id == null) throw new Error("focus_window requires 'id'");
  await chrome.windows.update(id, { focused: true });
  return { id };
}

// Send a message to a specific frame's content script, injecting it if missing.
// With all_frames injection every frame has a listener, so we ALWAYS target one
// frame (frameId 0 = the top document) — otherwise every frame would reply and race.
async function toContent(action, params, frameId = 0) {
  const tab = await targetTab(params);
  const opts = { frameId };
  try {
    return await chrome.tabs.sendMessage(tab.id, { action, params }, opts);
  } catch (err) {
    // Content script not present (page predates install, or was reloaded): inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, { action, params }, opts);
  }
}

// Cross-frame refs are exposed to the agent as `f<frameId>:ref_N`; the top frame keeps
// bare `ref_N` for compatibility. Split a params object into the owning frameId and the
// params the in-frame content script expects (with the local, unprefixed ref). Checks
// both `ref` (click/type/hover/...) and `ref_id` (read_page) — a frame-qualified ref_id
// must route to (and be stripped for) the owning frame just like ref does, or it fails
// to resolve in every frame and read_page falls back to a fabricated empty result.
function frameRoute(params = {}) {
  for (const key of ["ref", "ref_id"]) {
    const v = params[key];
    const m = typeof v === "string" && v.match(/^f(\d+):(.+)$/);
    if (m) return { frameId: Number(m[1]), params: { ...params, [key]: m[2] } };
  }
  return { frameId: 0, params };
}

// List frames worth querying for DOM reads: the top frame plus child frames that
// actually loaded a document (skip about:blank / errored frames).
async function contentFrames(tabId) {
  let frames;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { frames = null; }
  if (!frames) return [{ frameId: 0, url: "" }];
  return frames
    .filter((f) => f.frameId === 0 || (f.url && /^https?:|^file:/.test(f.url)))
    .map((f) => ({ frameId: f.frameId, url: f.url || "" }));
}

// Run a DOM read (snapshot/read_page/find) across every frame and merge, prefixing
// non-top-frame refs with `f<frameId>:` so a later click routes back to the right frame.
async function crossFrame(action, params) {
  const tab = await targetTab(params);
  const frames = await contentFrames(tab.id);
  const per = await Promise.all(frames.map(async (fr) => {
    try {
      const reply = await toContent(action, params, fr.frameId);
      return reply && reply.ok ? { fr, result: reply.result } : null;
    } catch { return null; }
  }));
  return mergeFrameResults(action, per.filter(Boolean));
}

const qualifyRef = (frameId, ref) => (frameId === 0 || !ref ? ref : `f${frameId}:${ref}`);

function mergeFrameResults(action, parts) {
  // Every frame errored (restricted page, or a ref/ref_id that no frame could resolve) —
  // return an honest error rather than a fabricated empty snapshot-shaped success, which
  // would look to the caller like "the page really is empty".
  if (!parts.length) {
    return { ok: false, error: "no frame could handle this (page not accessible, or the ref/ref_id was not found in any frame)" };
  }
  const top = parts.find((p) => p.fr.frameId === 0) || parts[0];
  if (action === "snapshot") {
    const elements = [];
    for (const { fr, result } of parts) {
      for (const el of result.elements || []) {
        // Only the top frame's indices are addressable by number; sub-frame elements
        // are ref-only (frame-qualified). Tag sub-frame elements with their frame url.
        elements.push(fr.frameId === 0
          ? el
          : { ...el, index: undefined, ref: qualifyRef(fr.frameId, el.ref), frame: fr.url });
      }
    }
    return { ok: true, result: { url: top.result.url, title: top.result.title, elements, text: top.result.text } };
  }
  if (action === "find") {
    const matches = [];
    for (const { fr, result } of parts)
      for (const m of result.matches || [])
        matches.push(fr.frameId === 0 ? m : { ...m, ref: qualifyRef(fr.frameId, m.ref), frame: fr.url });
    return { ok: true, result: { count: matches.length, matches } };
  }
  // read_page: top-frame tree, then each sub-frame tree appended under a frame header,
  // with every ref in that subtree frame-qualified.
  let tree = top.result.tree || "";
  for (const { fr, result } of parts) {
    if (fr.frameId === 0 || !result.tree) continue;
    const qualified = result.tree.replace(/\[(ref_\d+)\]/g, (_, r) => `[${qualifyRef(fr.frameId, r)}]`);
    tree += `\n  iframe [f${fr.frameId}] ${fr.url}\n` + qualified.replace(/^/gm, "  ");
  }
  return { ok: true, result: { url: top.result.url, title: top.result.title, tree, truncated: !!top.result.truncated } };
}

// Reconnect when the bridge host/port changes on the options page — but only if
// we're already meant to be connected. A config edit alone never starts dialing.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeHost || changes.bridgePort)) {
    if (!wantConnect) return;
    if (socket) { try { socket.close(); } catch {} }
    socket = null;
    attempts = 0;
    connect();
  }
});

// Keep the service worker alive / reconnect promptly after it is recycled —
// but only while we want a connection. Once we've given up, the alarm is a
// no-op, so a recycled worker won't re-spam connection attempts.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (wantConnect && connState !== "connected") connect();
});
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

init();
