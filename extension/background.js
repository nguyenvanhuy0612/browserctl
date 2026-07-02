// Service worker: keeps a WebSocket open to the bridge and dispatches commands.
//
// Commands that touch the page DOM (snapshot/click/type/scroll) are forwarded to
// the content script. Tab/window-level commands are handled here with chrome.*.
// Console/network/HAR/eval commands are handled by the CDP module (cdp.js).

import { handleCdp, CDP_ACTIONS, captureViewport, isAttached, dropTab as cdpDropTab } from "./cdp.js";
import { handleNet, NET_ACTIONS, dropTab as netDropTab } from "./netlog.js";

// DOM-level commands that run in the active tab's content script.
const CONTENT_ACTIONS = [
  "snapshot",
  "read_page",
  "find",
  "click",
  "type",
  "scroll",
  "hover",
  "select_option",
  "press_key",
  "wait_settle",
  "get_page_content",
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
  clearTimeout(reconnectTimer);
  connState = "connecting";
  const url = await bridgeWsUrl();
  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    attempts = 0;
    connState = "connected";
    console.log("[ai-browser] bridge connected:", url);
    // First successful connect: enable bounded auto-retry on future startups.
    chrome.storage.local.set({ autoConnect: true, giveUp: false });
  });

  socket.addEventListener("message", async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    // Heartbeat from the bridge. Receiving this message is itself what resets the
    // MV3 service-worker idle timer; the pong lets the bridge detect a dead link.
    if (msg.type === "ping") { try { socket.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    const reply = await dispatch(msg).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }));
    reply.id = msg.id;
    try { socket.send(JSON.stringify(reply)); } catch {}
  });

  socket.addEventListener("close", () => {
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

  socket.addEventListener("error", () => {
    try { socket.close(); } catch {}
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
    const tab = await targetTab();
    const { frameId, params: p } = frameRoute(params);
    const rectReply = await toContent("element_rect", { index: p.index, ref: p.ref }, frameId);
    if (!rectReply.ok) return rectReply;
    // NOTE: a sub-frame rect is frame-relative while the CDP clip is page-relative, so
    // element_screenshot of a ref inside an iframe can be offset. Top-frame is exact.
    return await handleCdp("element_screenshot", { rect: rectReply.result, format: params.format }, tab.id);
  }

  // press_key with modifiers (Cmd+A, Cmd+Z, ...) needs CDP so Mac editor commands fire;
  // route there when the debugger is attached, else fall back to the DOM key dispatch.
  if (action === "press_key" && Array.isArray(params.modifiers) && params.modifiers.length) {
    const tab = await targetTab();
    if (isAttached(tab.id)) return await handleCdp("press_key_cdp", params, tab.id);
  }

  // CDP-backed commands (console/network/HAR/eval) operate on the target tab.
  if (CDP_ACTIONS.includes(action)) {
    const tab = await targetTab();
    return await handleCdp(action, params, tab.id);
  }

  // Light network capture (chrome.webRequest, no debugger banner).
  // handleNet already returns { ok, result }, so pass it through (no double-wrap).
  if (NET_ACTIONS.includes(action)) {
    const tab = await targetTab();
    return await handleNet(action, params, tab.id);
  }

  // DOM-level commands run in the target tab's content script(s), which already reply
  // in { ok, result|error } shape. Reads (snapshot/read_page/find) aggregate across all
  // frames; ref-addressed actions route to the frame that owns the ref (see frameRoute).
  if (CONTENT_ACTIONS.includes(action)) {
    if (action === "snapshot" || action === "read_page" || action === "find") {
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
    case "go_back":      return { ok: true, result: await goBack() };
    case "go_forward":   return { ok: true, result: await goForward() };
    case "reload":       return { ok: true, result: await reload(params) };
    case "list_windows": return { ok: true, result: await listWindows() };
    case "focus_window": return { ok: true, result: await focusWindow(params) };
    case "current_tab":  return { ok: true, result: await currentTab() };
    case "wait_for":     return await waitFor(params);

    case "reload_extension": return { ok: true, result: reloadExtension() };
    case "record_start":     return { ok: true, result: await recordStart() };
    case "record_stop":      return { ok: true, result: await recordStop() };
    case "record_get":       return { ok: true, result: { count: recordingSteps.length, steps: recordingSteps } };
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

async function recordStart() {
  recordingSteps = [];
  await toContent("record_start", {});
  return { recording: true };
}

async function recordStop() {
  await toContent("record_stop", {});
  return { recording: false, count: recordingSteps.length };
}

// Replay recorded (or supplied) steps against the active tab.
async function replay({ steps, startUrl } = {}) {
  const plan = steps || recordingSteps;
  if (startUrl) { await navigate({ url: startUrl }); }
  const done = [];
  for (const step of plan) {
    if (step.type === "navigate" && step.url) {
      await navigate({ url: step.url });
    } else if (step.type === "click") {
      await toContent("click_selector", { selector: step.selector });
    } else if (step.type === "input") {
      await toContent("fill_selector", { selector: step.selector, value: step.value });
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

// The tab DOM/CDP commands operate on. Pin-on-first-touch: if a target is pinned and
// still exists, use it; otherwise grab the focused active tab AND pin it, so the agent
// locks onto one tab at its first command and never drifts onto a tab the user later
// switches to. switch_tab / navigate / new_tab re-pin explicitly.
async function targetTab() {
  // Recover the pin from session storage if the worker was recycled since it was set.
  if (targetTabId == null) {
    const { targetTabId: saved } = await chrome.storage.session.get("targetTabId");
    if (saved != null) targetTabId = saved;
  }
  if (targetTabId != null) {
    try {
      return await chrome.tabs.get(targetTabId);
    } catch {
      unpinTarget(); // target was closed; re-pin below
    }
  }
  const tab = await activeTab();
  pinTarget(tab.id);
  return tab;
}

// If the pinned target tab is closed, unpin so the next command re-pins cleanly, and
// drop any CDP/network state we held for it so those maps don't leak per closed tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) unpinTarget();
  cdpDropTab(tabId);
  netDropTab(tabId);
});

// Report which tab commands currently act on (for the agent to verify before reading).
async function currentTab() {
  const tab = await targetTab();
  return { id: tab.id, url: tab.url, title: tab.title, active: tab.active, pinned: targetTabId != null };
}

async function navigate({ url }) {
  if (!url) throw new Error("navigate requires 'url'");
  const tab = await targetTab();
  pinTarget(tab.id); // pin: subsequent reads stay on the tab we navigated
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

async function screenshot({ format = "jpeg", quality = 55 } = {}) {
  const tab = await targetTab();
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
  const tab = await chrome.tabs.create(url ? { url } : {});
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

async function goBack() {
  const tab = await targetTab();
  const done = waitForComplete(tab.id); // wait for the history nav to land (same as navigate/reload)
  await chrome.tabs.goBack(tab.id);
  await done;
  return { id: tab.id };
}

async function goForward() {
  const tab = await targetTab();
  const done = waitForComplete(tab.id);
  await chrome.tabs.goForward(tab.id);
  await done;
  return { id: tab.id };
}

async function reload({ bypassCache } = {}) {
  const tab = await targetTab();
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
  const tab = await targetTab();
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
// params the in-frame content script expects (with the local, unprefixed ref).
function frameRoute(params = {}) {
  const m = typeof params.ref === "string" && params.ref.match(/^f(\d+):(.+)$/);
  if (m) return { frameId: Number(m[1]), params: { ...params, ref: m[2] } };
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
  const tab = await targetTab();
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
  if (!parts.length) return { ok: true, result: { url: "", title: "", elements: [], text: "" } };
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
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (wantConnect && connState !== "connected") connect();
});
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

init();
