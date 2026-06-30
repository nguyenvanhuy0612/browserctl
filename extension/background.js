// Service worker: keeps a WebSocket open to the bridge and dispatches commands.
//
// Commands that touch the page DOM (snapshot/click/type/scroll) are forwarded to
// the content script. Tab/window-level commands are handled here with chrome.*.
// Console/network/HAR/eval commands are handled by the CDP module (cdp.js).

import { handleCdp, CDP_ACTIONS } from "./cdp.js";
import { handleNet, NET_ACTIONS } from "./netlog.js";

// DOM-level commands that run in the active tab's content script.
const CONTENT_ACTIONS = [
  "snapshot",
  "click",
  "type",
  "scroll",
  "hover",
  "select_option",
  "press_key",
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

// The content recorder pushes each captured step here via chrome.runtime.sendMessage.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.__aibc_record_step) recordingSteps.push(msg.__aibc_record_step);
});

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const RECONNECT_MS = 2000;

let socket = null;

// Bridge host/port are configurable on the options page (chrome.storage.local).
async function bridgeWsUrl() {
  const { bridgeHost = DEFAULT_HOST, bridgePort = DEFAULT_PORT } =
    await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  return `ws://${bridgeHost}:${bridgePort}/extension`;
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = await bridgeWsUrl();
  socket = new WebSocket(url);

  socket.addEventListener("open", () => console.log("[ai-browser] bridge connected:", url));

  socket.addEventListener("message", async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const reply = await dispatch(msg).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }));
    reply.id = msg.id;
    try { socket.send(JSON.stringify(reply)); } catch {}
  });

  socket.addEventListener("close", () => {
    console.log("[ai-browser] bridge disconnected, retrying");
    setTimeout(connect, RECONNECT_MS);
  });

  socket.addEventListener("error", () => {
    try { socket.close(); } catch {}
  });
}

// Route a command to the right handler. Returns { ok, result } or throws.
async function dispatch({ action, params = {} }) {
  // CDP-backed commands (console/network/HAR/eval) operate on the active tab.
  if (CDP_ACTIONS.includes(action)) {
    const tab = await activeTab();
    return await handleCdp(action, params, tab.id);
  }

  // Light network capture (chrome.webRequest, no debugger banner).
  // handleNet already returns { ok, result }, so pass it through (no double-wrap).
  if (NET_ACTIONS.includes(action)) {
    const tab = await activeTab();
    return await handleNet(action, params, tab.id);
  }

  // DOM-level commands run in the active tab's content script, which already
  // replies in { ok, result|error } shape, so pass it through.
  if (CONTENT_ACTIONS.includes(action)) {
    return await toContent(action, params);
  }

  switch (action) {
    case "navigate":     return { ok: true, result: await navigate(params) };
    case "screenshot":   return { ok: true, result: await screenshot(params) };
    case "list_tabs":    return { ok: true, result: await listTabs() };
    case "new_tab":      return { ok: true, result: await newTab(params) };
    case "switch_tab":   return { ok: true, result: await switchTab(params) };
    case "close_tab":    return { ok: true, result: await closeTab(params) };
    case "go_back":      return { ok: true, result: await goBack() };
    case "go_forward":   return { ok: true, result: await goForward() };
    case "reload":       return { ok: true, result: await reload(params) };
    case "list_windows": return { ok: true, result: await listWindows() };
    case "focus_window": return { ok: true, result: await focusWindow(params) };
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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

async function navigate({ url }) {
  if (!url) throw new Error("navigate requires 'url'");
  const tab = await activeTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForComplete(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url };
}

// Resolve once the tab finishes loading (or after a safety timeout).
function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, 15_000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    function finish() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function screenshot({ format = "png" } = {}) {
  const tab = await activeTab();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
  return { dataUrl };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  };
}

async function newTab({ url }) {
  const tab = await chrome.tabs.create(url ? { url } : {});
  return { id: tab.id };
}

async function switchTab({ id }) {
  if (id == null) throw new Error("switch_tab requires 'id'");
  const tab = await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { id: tab.id };
}

async function closeTab({ id }) {
  if (id == null) throw new Error("close_tab requires 'id'");
  await chrome.tabs.remove(id);
  return { id };
}

async function goBack() {
  const tab = await activeTab();
  await chrome.tabs.goBack(tab.id);
  return { id: tab.id };
}

async function goForward() {
  const tab = await activeTab();
  await chrome.tabs.goForward(tab.id);
  return { id: tab.id };
}

async function reload({ bypassCache } = {}) {
  const tab = await activeTab();
  await chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache });
  await waitForComplete(tab.id);
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

// Send a message to the active tab's content script, injecting it if missing.
async function toContent(action, params) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { action, params });
  } catch (err) {
    // Content script not present (page predates install, or was reloaded): inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, { action, params });
  }
}

// Reconnect immediately when the bridge host/port is changed on the options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeHost || changes.bridgePort)) {
    if (socket) { try { socket.close(); } catch {} }
    socket = null;
    connect();
  }
});

// Keep the service worker alive / reconnect promptly after it is recycled.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
