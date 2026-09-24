import {
  handleCdp,
  CDP_ACTIONS,
  captureViewport,
  isAttached,
  setLastCaptureScale,
  dropTab as cdpDropTab,
  ensureAttached,
  armDialog,
  takeDialogRecord,
  pendingDialog,
  handleDialog,
  onDialogOpened,
} from "./cdp.js";
import { handleNet, NET_ACTIONS, dropTab as netDropTab } from "./netlog.js";

const DIALOG_TRIGGERS = new Set([
  "click",
  "click_selector",
  "type",
  "fill",
  "press_key",
  "select_option",
  "fill_form",
  "dblclick",
]);

const CONTENT_ACTIONS = [
  "upload_mark",
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
  "get_property",
  "fill",
  "paste",
  "clear",
  "check",
  "uncheck",
  "dblclick",
  "focus",
  "scrollintoview",
  "dismiss",
  "close_modal",
  "element_rect",
  "extract",
  "fill_form",
];

let recordingSteps = [];
const MAX_RECORD_STEPS = 5000;
let isRecording = false;
const RECORDING_KEY = "bctl_recording";
function persistRecording(on) {
  chrome.storage.session.set({ [RECORDING_KEY]: on }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.__bctl_record_step) {
    if (!isRecording || (_sender.tab && _sender.tab.id !== recordingTabId)) return;
    recordingSteps.push(msg.__bctl_record_step);
    if (recordingSteps.length > MAX_RECORD_STEPS) recordingSteps.shift();
    return;
  }
  if (msg && msg.__bctl_getState) {
    chrome.storage.local.get(["bridgeHost", "bridgePort"]).then((cfg) => {
      sendResponse({
        connState,
        host: cfg.bridgeHost || DEFAULT_HOST,
        port: cfg.bridgePort || DEFAULT_PORT,
      });
    });
    return true;
  }
  if (msg && msg.__bctl_connect) {
    startConnecting();
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.__bctl_disconnect) {
    stopConnecting();
    sendResponse({ ok: true });
    return;
  }
});

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const RECONNECT_MS = 2000;
const MAX_BACKOFF_MS = 30000;
let socket = null;
let attempts = 0;
let reconnectTimer = null;
let connecting = false;

let wantConnect = false;
let connState = "idle";

async function bridgeWsUrl() {
  const { bridgeHost = DEFAULT_HOST, bridgePort = DEFAULT_PORT } = await chrome.storage.local.get([
    "bridgeHost",
    "bridgePort",
  ]);
  return `ws://${bridgeHost}:${bridgePort}/extension`;
}

function startConnecting() {
  wantConnect = true;
  attempts = 0;
  clearTimeout(reconnectTimer);
  connState = "connecting";
  chrome.storage.local.set({ giveUp: false });
  connect();
}

function stopConnecting() {
  wantConnect = false;
  clearTimeout(reconnectTimer);
  if (socket) {
    try {
      socket.close();
    } catch {}
  }
  socket = null;
  connState = "idle";
  chrome.storage.local.set({ giveUp: true });
}

async function connect() {
  if (!wantConnect) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (connecting) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  connState = "connecting";
  let url;
  try {
    url = await bridgeWsUrl();
  } finally {
    connecting = false;
  }
  if (!wantConnect) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener("open", () => {
    if (ws !== socket) return;
    attempts = 0;
    connState = "connected";
    console.log("[browserctl] bridge connected:", url);
    chrome.storage.local.set({ autoConnect: true, giveUp: false });
  });

  ws.addEventListener("message", async (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {}
      return;
    }
    const reply = await dispatch(msg).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }));
    reply.id = msg.id;
    if (ws !== socket) return;
    try {
      ws.send(JSON.stringify(reply));
    } catch {}
  });

  ws.addEventListener("close", () => {
    if (ws !== socket) return;
    const wasConnected = connState === "connected";
    socket = null;
    if (!wantConnect) {
      connState = "idle";
      return;
    }
    if (wasConnected) attempts = 0;
    attempts++;
    connState = "connecting";
    const delay = Math.min(RECONNECT_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(connect, delay);
  });

  ws.addEventListener("error", () => {
    if (ws !== socket) return;
    try {
      ws.close();
    } catch {}
  });
}

async function init() {
  const { autoConnect = true, giveUp = false } = await chrome.storage.local.get([
    "autoConnect",
    "giveUp",
  ]);
  if (autoConnect !== false && !giveUp) {
    startConnecting();
  } else {
    connState = "idle";
  }
}

const ACTION_ALIASES = {
  get_text: { action: "get_property", params: { property: "text" } },
  get_value: { action: "get_property", params: { property: "value" } },
  get_html: { action: "get_property", params: { property: "html" } },
  get_box: { action: "get_property", params: { property: "box" } },
  get_attribute: { action: "get_property", params: { property: "attr" } },
  get_count: { action: "get_property", params: { property: "count" } },
  dismiss_modal: { action: "dismiss", params: {} },
  screenshot_fullpage: { action: "screenshot", params: { fullPage: true } },
  take_screenshot: { action: "screenshot", params: {} },
  file_upload: { action: "upload", params: {} },
  evaluate: { action: "eval_js", params: {} },
  get_content: { action: "get_page_content", params: {} },
};

const NOT_EXTENSION_ACTIONS = {
  start: "the browser_start tool (the daemon is managed outside the extension)",
  stop: "the browser_stop tool",
  load_tools: "the browser_load_tools tool",
  unload_tools: "the browser_unload_tools tool",
  list_available_tools: "the browser_list_available_tools tool",
  action: "browser_action itself — it dispatches other actions and is not one",
};

async function dispatch({ action, params = {} }) {
  const alias = ACTION_ALIASES[action];
  if (alias) {
    action = alias.action;
    params = { ...alias.params, ...params };
  }
  if (NOT_EXTENSION_ACTIONS[action]) {
    return {
      ok: false,
      error: `'${action}' is not a page action — use ${NOT_EXTENSION_ACTIONS[action]}.`,
      code: "NOT_A_PAGE_ACTION",
    };
  }

  const guard = await freshPinGuard(action, params);
  if (guard) return guard;

  if (action === "upload") {
    const tab = await targetTab(params);
    const { frameId, params: p } = frameRoute(params);
    const marked = await toContent(
      "upload_mark",
      {
        target: p.target,
        index: p.index,
        ref: p.ref,
        selector: p.selector,
        text: p.text,
        placeholder: p.placeholder,
        tabId: tab.id,
      },
      frameId
    );
    if (!marked.ok) return marked;
    const files = Array.isArray(params.files) ? params.files : params.file ? [params.file] : [];
    const set = await handleCdp("upload_set", { files }, tab.id);
    if (!set.ok) return set;
    const dropped = files.length - (set.result.count || 0);
    const warning =
      dropped > 0
        ? marked.result.multiple
          ? `${files.length} files given, ${set.result.count} attached \u2014 the page's input took what it wanted and dropped ${dropped}`
          : `this input has no 'multiple' attribute, so it holds ONE file: ${dropped} of the ${files.length} given were dropped and only ${set.result.files?.[0] || set.result.count} is attached`
        : null;
    return {
      ok: true,
      result: {
        ...set.result,
        input: marked.result,
        ...(warning ? { warning } : {}),
        note: "the file is attached to the input and change/input have fired; read the page to confirm the site accepted it",
      },
    };
  }

  if (action === "element_screenshot") {
    const tab = await targetTab(params);
    const { frameId, params: p } = frameRoute(params);
    const rectReply = await toContent(
      "element_rect",
      {
        target: p.target,
        selector: p.selector,
        index: p.index,
        ref: p.ref,
        text: p.text,
        placeholder: p.placeholder,
        tabId: tab.id,
      },
      frameId
    );
    if (!rectReply.ok) return rectReply;
    const rect = rectReply.result;
    // Same routes as a viewport screenshot: a visible tab is captured and cropped without the
    // debugger; an attached tab, a background tab, or an element that does not fit in the
    // viewport goes through CDP, attaching on the way.
    if (!isAttached(tab.id) && tab.active && fitsViewport(rect)) {
      return { ok: true, result: await cropVisibleTab(tab, rect, params.format) };
    }
    await ensureAttached(tab.id);
    return await handleCdp("element_screenshot", { rect, format: params.format }, tab.id);
  }

  if (
    action === "press_key" &&
    Array.isArray(params.modifiers) &&
    params.modifiers.length &&
    !params.allowSynthetic
  ) {
    const tab = await targetTab(params);
    if (isAttached(tab.id)) return await handleCdp("press_key_cdp", params, tab.id);
    return {
      ok: false,
      error:
        "press_key with modifiers needs cdp_attach first (the CDP path delivers a real key " +
        "event, incl. Mac editor commands like Cmd+A, but requires the tab to be in the " +
        "foreground). For a background tab, pass allowSynthetic:true to dispatch a synthetic " +
        "DOM event instead — page shortcut handlers fire, native editing does not.",
    };
  }

  if (CDP_ACTIONS.includes(action)) {
    const tab = await targetTab(params);
    const reply = await handleCdp(action, params, tab.id);
    if (action === "a11y_snapshot" && reply && reply.ok) {
      return { ok: true, result: await enrichAxWithRefs(reply.result, tab.id) };
    }
    return reply;
  }

  if (NET_ACTIONS.includes(action)) {
    const tab = await targetTab(params);
    return await handleNet(action, params, tab.id);
  }

  if (CONTENT_ACTIONS.includes(action)) {
    const tab = await targetTab(params);
    if (looksLikePdf(tab.url)) {
      return {
        ok: false,
        error: `tab is showing a PDF (no readable DOM) — call read_pdf instead of '${action}'`,
      };
    }
    if (params.tabId == null) params = { ...params, tabId: tab.id };
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
    if (DIALOG_TRIGGERS.has(action)) return await withDialogGuard(action, p, frameId, tab.id);
    return await toContent(action, p, frameId);
  }

  switch (action) {
    case "navigate":
      return { ok: true, result: await navigate(params) };
    case "screenshot":
      if (params.fullPage) {
        const tab = await targetTab(params);
        await ensureAttached(tab.id);
        return await handleCdp("capture_screenshot", params, tab.id);
      }
      return { ok: true, result: await screenshot(params) };
    case "list_tabs":
      return { ok: true, result: await listTabs() };
    case "new_tab":
      return { ok: true, result: await newTab(params) };
    case "group_tab":
      return { ok: true, result: await groupTab(params) };
    case "ungroup_tab":
      return { ok: true, result: await ungroupTab(params) };
    case "switch_tab":
      return { ok: true, result: await switchTab(params) };
    case "close_tab":
      return { ok: true, result: await closeTab(params) };
    case "go_back":
      return { ok: true, result: await goBack(params) };
    case "go_forward":
      return { ok: true, result: await goForward(params) };
    case "reload":
      return { ok: true, result: await reload(params) };
    case "list_windows":
      return { ok: true, result: await listWindows() };
    case "focus_window":
      return { ok: true, result: await focusWindow(params) };
    case "current_tab":
      return { ok: true, result: await currentTab(params) };
    case "read_pdf":
      return { ok: true, result: await readPdf(params) };
    case "wait_for":
      return await waitFor(params);

    case "handle_dialog": {
      const tab = await targetTab(params);
      await ensureAttached(tab.id);
      if (!params.action || params.action === "peek") {
        return { ok: true, result: { dialog: pendingDialog(tab.id) } };
      }
      return { ok: true, result: await handleDialog(tab.id, params) };
    }
    case "pending_dialog": {
      const tab = await targetTab(params);
      return { ok: true, result: { dialog: isAttached(tab.id) ? pendingDialog(tab.id) : null } };
    }

    case "reload_extension":
      return { ok: true, result: reloadExtension() };
    case "record_start":
      return await recordStart(params);
    case "record_stop":
      return await recordStop(params);
    case "record_get": {
      if (!isRecording && recordingSteps.length === 0) {
        const { [RECORDING_KEY]: wasRecording } = await chrome.storage.session.get(RECORDING_KEY);
        if (wasRecording) {
          return {
            ok: false,
            error: "capture state was reset by a service-worker restart — call record_start again",
          };
        }
      }
      return { ok: true, result: { count: recordingSteps.length, steps: recordingSteps } };
    }
    case "replay":
      return await replay(params);

    default:
      throw new Error(`unknown action: ${action}`);
  }
}

const AX_CENSUS_LIMIT = 100000;

async function enrichAxWithRefs(axResult, tabId) {
  const nodes = (axResult && axResult.nodes) || [];
  let census = [];
  try {
    // Coverage is measured against every control, so the census is requested unpaged.
    const snap = await toContent(
      "snapshot",
      { scope: "all", compact: false, maxText: 0, limit: AX_CENSUS_LIMIT, tabId },
      0
    );
    census = (snap && snap.ok && snap.result && snap.result.elements) || [];
  } catch {}

  const norm = (t) =>
    String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/g, " ")
      .trim();
  const byName = new Map();
  for (const e of census) {
    const k = norm(e.text);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, e);
  }

  const ACTIONABLE = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "tab",
    "switch",
    "option",
    "slider",
    "searchbox",
    "spinbutton",
    "treeitem",
    "listbox",
  ]);

  let matched = 0;
  let named = 0;
  const censusMissing = [];
  const seenMissing = new Set();
  for (const n of nodes) {
    const k = norm(n.name);
    if (!k) continue;
    const hit = byName.get(k);
    if (hit) {
      n.ref = hit.ref;
      n.tag = hit.tag;
    }
    if (!ACTIONABLE.has(String(n.role).toLowerCase())) continue;
    named++;
    if (hit) matched++;
    else if (!seenMissing.has(k) && censusMissing.length < 12) {
      seenMissing.add(k);
      censusMissing.push({ role: n.role, name: String(n.name).slice(0, 60) });
    }
  }
  return {
    ...axResult,
    matchedToCensus: matched,
    namedActionableNodes: named,
    censusCoverage: named ? Math.round((matched / named) * 100) : 100,
    ...(censusMissing.length ? { notInCensus: censusMissing } : {}),
    note: censusMissing.length
      ? `${matched}/${named} of Chrome's named CONTROLS carry a 'ref' you can act on. 'notInCensus' lists controls Chrome names that browser_snapshot did not — usually screen-reader-only text (display:none skip links, shortcut announcements), occasionally a real census gap worth reporting. Non-control nodes (landmarks, headings, StaticText) are excluded from this count by design.`
      : `${matched}/${named} of Chrome's named controls carry a 'ref' you can act on; the census saw every control Chrome did.`,
  };
}

function reloadExtension() {
  setTimeout(() => chrome.runtime.reload(), 300);
  return { reloading: true };
}

let recordingTabId = null;

async function recordStart(params) {
  const tab = await targetTab(params || {});
  const reply = await toContent("record_start", { tabId: tab.id });
  if (!reply || !reply.ok) return reply || { ok: false, error: "record_start got no reply" };
  recordingSteps = [];
  isRecording = true;
  recordingTabId = tab.id;
  persistRecording(true);
  return { ok: true, result: { recording: true } };
}

async function recordStop(params) {
  isRecording = false;
  persistRecording(false);
  const tabId = recordingTabId ?? (params && params.tabId);
  recordingTabId = null;
  try {
    await toContent("record_stop", { tabId });
  } catch {}
  return { ok: true, result: { recording: false, count: recordingSteps.length } };
}

// A navigation replaces the content script and its listeners, so the recorded tab is re-armed
// each time a new document finishes loading.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!isRecording || tabId !== recordingTabId || info.status !== "complete") return;
  toContent("record_start", { tabId }).catch(() => {});
});

async function replay({ steps, startUrl, tabId } = {}) {
  const plan = steps || recordingSteps;
  if (startUrl) {
    await navigate({ url: startUrl, tabId });
  }
  const done = [];
  for (const [i, step] of plan.entries()) {
    let reply = null;
    if (step.type === "navigate" && step.url) {
      await navigate({ url: step.url, tabId });
    } else if (step.type === "click") {
      reply = await toContent("click_selector", { selector: step.selector, tabId });
    } else if (step.type === "input") {
      reply = await toContent("fill_selector", {
        selector: step.selector,
        value: step.value,
        tabId,
      });
    } else {
      continue;
    }
    // A failed step stops the run: every later step assumes the page it would have left.
    if (reply && !reply.ok) {
      return {
        ok: false,
        error: `replay stopped at step ${i} (${step.type} ${step.selector || ""}): ${reply.error}`,
        code: "REPLAY_STEP_FAILED",
        data: { replayed: done.length, steps: plan.length, failedAt: i, step },
      };
    }
    done.push(step.type);
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: true, result: { replayed: done.length, steps: plan.length } };
}

async function waitFor(params) {
  if (params.selector || params.text) return await toContent("wait_for", params);
  const ms = params.timeoutMs ?? 1000;
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, result: { waitedMs: ms } };
}

let targetTabId = null;

const drivenTabIds = new Set();

let clickCandidates = [];
const RECENT_CLICK_WINDOW_MS = 800;
function pruneClickCandidates() {
  const cutoff = Date.now() - RECENT_CLICK_WINDOW_MS;
  clickCandidates = clickCandidates.filter((c) => c.at > cutoff);
}

const pendingFocusRestores = new Map();

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

function looksLikePdf(url) {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

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

const CONTENT_RETURNING = new Set([
  "snapshot",
  "read_page",
  "find",
  "find_text",
  "get_page_content",
  "describe_element",
  "a11y_snapshot",
  "screenshot",
  "capture_screenshot",
  "element_screenshot",
  "print_pdf",
  "eval_js",
  "read_pdf",
  "get_cookies",
  "storage_get",
  "export_har",
  "get_console_logs",
  "get_network_requests",
  "get_response_body",
  "net_get",
  "audit",
]);

async function freshPinGuard(action, params) {
  if (!CONTENT_RETURNING.has(action)) return null;
  if (params && params.tabId != null) return null;
  if (targetTabId == null) {
    const { targetTabId: saved } = await chrome.storage.session.get("targetTabId");
    if (saved != null) targetTabId = saved;
  }
  if (targetTabId != null) {
    try {
      await chrome.tabs.get(targetTabId);
      return null;
    } catch {
      unpinTarget();
    }
  }
  const tab = await activeTab();
  pinTarget(tab.id);
  return {
    ok: false,
    error:
      `no target tab was pinned, so '${action}' would have read whatever tab is focused ` +
      `right now: ${tab.title || "(untitled)"} — ${tab.url}. That tab is NOW pinned, so ` +
      `re-issue the same command to read it, or retarget first with switch_tab / navigate / ` +
      `new_tab (or pass an explicit tabId). This guard fires only on the first ` +
      `content-returning command after the pin was lost.`,
  };
}

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
      unpinTarget();
    }
  }
  const tab = await activeTab();
  pinTarget(tab.id);
  return tab;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) unpinTarget();
  drivenTabIds.delete(tabId);
  pendingFocusRestores.delete(tabId);
  cdpDropTab(tabId);
  netDropTab(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  pruneClickCandidates();
  if (tab.openerTabId == null || clickCandidates.length === 0) return;
  const candidate = clickCandidates.shift();
  pendingFocusRestores.set(tab.id, candidate.restoreTo);
  chrome.tabs.update(tab.id, { active: false }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const restoreTo = pendingFocusRestores.get(tabId);
  if (restoreTo == null) return;
  pendingFocusRestores.delete(tabId);
  chrome.tabs.update(restoreTo, { active: true }).catch(() => {});
});

async function currentTab(params) {
  const tab = await targetTab(params);
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: targetTabId != null,
  };
}

// How long a navigation may take to commit: long enough for a slow VPN, short enough to answer
// inside the bridge's own command timeout.
const NAV_COMMIT_MS = 20_000;

async function navigate(params = {}) {
  const { url } = params;
  if (!url) throw new Error("navigate requires 'url'");
  const tab = await targetTab(params);
  if (params.tabId == null) pinTarget(tab.id);
  const committed = waitForCommit(tab.id, NAV_COMMIT_MS);
  const done = waitForComplete(tab.id);
  await chrome.tabs.update(tab.id, { url });
  const commit = await committed;
  if (commit.error) throw navigationFailed(url, commit.error);
  if (commit.timedOut) {
    const now = await chrome.tabs.get(tab.id);
    throw new Error(
      `navigation to ${url} had not started loading after ${NAV_COMMIT_MS / 1000} s; the tab is still on ${now.url}. ` +
        `A slow network or VPN can take this long and the tab keeps trying: check browser_tabs({action: "list"}) before navigating again.`
    );
  }
  await done;
  const frame = await chrome.webNavigation
    .getFrame({ tabId: tab.id, frameId: 0 })
    .catch(() => null);
  if (frame && frame.errorOccurred) throw navigationFailed(url);
  try {
    await toContent("wait_settle", { timeoutMs: 600, tabId: tab.id });
  } catch {}
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url };
}

// Chrome reports a failed load either as a network error before the commit or, when its error
// page commits instead, as errorOccurred on the frame afterwards; both read the same.
function navigationFailed(url, netError) {
  return new Error(
    `navigation to ${url} failed${netError ? `: ${netError}` : ""} — the tab shows Chrome's error page`
  );
}

// Resolves when the tab's top frame commits a document (or changes in place, for a fragment or
// history.pushState), reports Chrome's network error if the load fails, and gives up after
// timeoutMs. A navigation that was aborted and replaced by another one is not an error.
function waitForCommit(tabId, timeoutMs) {
  const nav = chrome.webNavigation;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    const onCommit = (d) => {
      if (d.tabId === tabId && d.frameId === 0) finish({ committed: true });
    };
    const onError = (d) => {
      if (d.tabId !== tabId || d.frameId !== 0 || d.error === "net::ERR_ABORTED") return;
      finish({ error: d.error });
    };
    const events = [nav.onCommitted, nav.onReferenceFragmentUpdated, nav.onHistoryStateUpdated];
    function finish(result) {
      clearTimeout(timer);
      for (const e of events) e.removeListener(onCommit);
      nav.onErrorOccurred.removeListener(onError);
      resolve(result);
    }
    for (const e of events) e.addListener(onCommit);
    nav.onErrorOccurred.addListener(onError);
  });
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const hard = setTimeout(finish, 15_000);
    const soft = setTimeout(() => {
      if (!sawLoading) finish();
    }, 1500);
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

function fitsViewport(r) {
  const vp = r && r.viewport;
  if (!vp || !vp.width || !vp.height) return false;
  return r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height;
}

// Captures the visible tab and cuts out the element's box. The capture is in device pixels,
// so the CSS box is scaled by the ratio between the image and the reported viewport.
async function cropVisibleTab(tab, rect, format = "png") {
  const fmt = format === "jpeg" ? "jpeg" : "png";
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = bitmap.width / rect.viewport.width;
  const sx = Math.round(rect.x * scale);
  const sy = Math.round(rect.y * scale);
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scale)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scale)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob(
    fmt === "jpeg" ? { type: "image/jpeg", quality: 0.8 } : { type: "image/png" }
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { dataUrl: `data:image/${fmt};base64,${btoa(bin)}` };
}

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
  if (isAttached(tab.id)) {
    return await captureViewport(tab.id, { format, quality });
  }
  if (tab.active) {
    const opts = format === "png" ? { format: "png" } : { format: "jpeg", quality };
    let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
    if (format !== "png" && dataUrl.length > 500000) {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 30 });
    }
    setLastCaptureScale(tab.id, await getDevicePixelRatio(tab.id));
    return { dataUrl };
  }
  return await captureViewport(tab.id, { format, quality });
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  if (targetTabId == null) {
    const { targetTabId: saved } = await chrome.storage.session.get("targetTabId");
    if (saved != null) targetTabId = saved;
  }
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      ...(t.groupId != null && t.groupId !== -1 ? { groupId: t.groupId } : {}),
      ...(t.id === targetTabId ? { pinned: true } : {}),
    })),
    ...(targetTabId == null ? { pinned: null } : { pinned: targetTabId }),
  };
}

async function newTab({ url, wait = true }) {
  const tab = await chrome.tabs.create({ ...(url ? { url } : {}), active: false });
  pinTarget(tab.id);
  if (!url || wait === false) return { id: tab.id };

  try {
    await waitForComplete(tab.id);
    await toContent("wait_settle", { timeoutMs: 600, tabId: tab.id });
  } catch {}
  let ready = { url, title: "" };
  try {
    const updated = await chrome.tabs.get(tab.id);
    ready = { url: updated.url, title: updated.title || "" };
  } catch {}
  return { id: tab.id, ...ready, ready: true };
}

async function groupTab({ id, title = "bctl", color = "blue" } = {}) {
  const tabId = id != null ? id : (await targetTab()).id;
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  pinTarget(tabId);
  try {
    await chrome.tabGroups.update(groupId, { title, color });
  } catch (e) {
    return {
      groupId,
      tabId,
      titled: false,
      note: `grouped, but could not set title/color: ${e.message}`,
    };
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
  if (focus) await chrome.windows.update(tab.windowId, { focused: true });
  pinTarget(tab.id);
  return { id: tab.id };
}

async function closeTab(params = {}) {
  let id = params.id;
  if (id == null) {
    const tab = await targetTab(params);
    id = tab.id;
  }
  // Closing a tab that is already gone is the state the caller asked for, so it succeeds and
  // says so. A failure with the tab still open is a real failure and throws, leaving the pin
  // alone because the tab it points at is still there.
  let alreadyClosed = false;
  try {
    await chrome.tabs.remove(id);
  } catch (err) {
    const stillOpen = await chrome.tabs
      .get(id)
      .then(() => true)
      .catch(() => false);
    if (stillOpen) throw err;
    alreadyClosed = true;
  }
  if (id === targetTabId) unpinTarget();
  return { id, alreadyClosed };
}

// History is driven through the page's own history object via chrome.scripting, not through
// chrome.tabs.goBack/goForward, which answers "Cannot find a next page in history" on a tab that
// is not active. Background tabs are the state this product exists to drive.
async function historyGo(params, delta) {
  const tab = await targetTab(params);
  const before = tab.url;
  const done = waitForComplete(tab.id);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (d) => {
      // Only a single-entry history is known to have nothing behind it. The Navigation API
      // lists same-origin entries only, so its "no" cannot be trusted across origins; whether
      // the move happened is checked afterwards instead.
      if (d < 0 && history.length <= 1) return { moved: false, length: history.length };
      history.go(d);
      return { moved: true, length: history.length };
    },
    args: [delta],
  });
  if (!res?.result?.moved) {
    throw new Error(
      `no ${delta < 0 ? "previous" : "next"} page in this tab's history (length ${res?.result?.length ?? "?"})`
    );
  }
  await done;
  const after = await chrome.tabs.get(tab.id);
  if (after.url === before) {
    throw new Error(
      `no ${delta < 0 ? "previous" : "next"} page in this tab's history — the tab is still on ${before}`
    );
  }
  return { id: tab.id, from: before, url: after.url };
}

async function goBack(params) {
  return await historyGo(params, -1);
}

async function goForward(params) {
  return await historyGo(params, 1);
}

async function reload(params = {}) {
  const { bypassCache } = params;
  const tab = await targetTab(params);
  const done = waitForComplete(tab.id);
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

async function confirmNothingHappened(reply, tabId, urlBefore) {
  const eff = reply && reply.ok && reply.result && reply.result.effect;
  if (!eff || !eff.measured || eff.domMutated || eff.urlChanged || !urlBefore) return reply;
  const deadline = Date.now() + 800;
  for (;;) {
    let after = null;
    try {
      after = await chrome.tabs.get(tabId);
    } catch {}
    if (after && after.url && after.url !== urlBefore) {
      eff.urlChanged = true;
      eff.navigatedTo = after.url;
      delete reply.result.warning;
      reply.result.note =
        `this action navigated the page (${urlBefore} -> ${after.url}); it answered before the ` +
        `navigation committed, so its mutation count describes the old document. Refs from before ` +
        `it are gone — read the new page.`;
      return reply;
    }
    if (!after || after.status !== "loading" || Date.now() > deadline) return reply;
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function withDialogGuard(action, params, frameId, tabId) {
  const { onDialog, promptText, ...rest } = params;
  if (onDialog) {
    await ensureAttached(tabId);
    armDialog(tabId, { action: onDialog, promptText });
    const res = await toContent(action, rest, frameId);
    const dialog = takeDialogRecord(tabId);
    if (dialog && res && res.ok && res.result) {
      res.result.effect = { ...(res.result.effect || {}), dialog };
    }
    return res;
  }
  if (!isAttached(tabId)) return await toContent(action, rest, frameId);
  const alreadyOpen = pendingDialog(tabId);
  if (alreadyOpen) {
    return {
      ok: false,
      error: `a ${alreadyOpen.type} dialog is already open and the page is suspended until it is answered: "${alreadyOpen.message}". Answer it with handle_dialog, then retry '${action}'.`,
      code: "DIALOG_BLOCKED",
      data: { dialog: alreadyOpen },
    };
  }
  let seen = null;
  const stop = onDialogOpened(tabId, (d) => (seen = d));
  // The action is sent exactly once. The watcher only answers when a dialog opens while the
  // action is still pending; it never ends the race on its own.
  let settled = false;
  const run = toContent(action, rest, frameId).finally(() => (settled = true));
  run.catch(() => {});
  try {
    return await Promise.race([
      run,
      (async () => {
        while (!seen && !settled) await new Promise((r) => setTimeout(r, 50));
        if (!seen) return run;
        return {
          ok: false,
          error: `'${action}' raised a ${seen.type} dialog and the page is suspended until it is answered: "${seen.message}". Retry with onDialog: "accept" or "dismiss" (promptText for a prompt), or answer the open one with handle_dialog.`,
          code: "DIALOG_BLOCKED",
          data: { dialog: seen },
        };
      })(),
    ]);
  } finally {
    stop();
  }
}

async function toContent(action, params, frameId = 0) {
  const tab = await targetTab(params);
  const urlBefore = tab.url;
  const opts = { frameId };
  try {
    return await confirmNothingHappened(
      await chrome.tabs.sendMessage(tab.id, { action, params }, opts),
      tab.id,
      urlBefore
    );
  } catch (_err) {
    let after = null;
    try {
      after = await chrome.tabs.get(tab.id);
    } catch {}
    // A navigation the action started shows as a changed url, a pending url that has not
    // committed yet, or a tab that was loaded and is loading again.
    const pendingBefore = tab.pendingUrl || urlBefore;
    const navigatedTo =
      after &&
      ((after.url && urlBefore && after.url !== urlBefore && after.url) ||
        (after.pendingUrl && after.pendingUrl !== pendingBefore && after.pendingUrl) ||
        (tab.status === "complete" &&
          after.status === "loading" &&
          (after.pendingUrl || after.url)));
    if (navigatedTo) {
      return {
        ok: true,
        result: {
          navigated: true,
          from: urlBefore,
          to: navigatedTo,
          effect: { measured: false, urlChanged: true },
          note:
            `'${action}' navigated the page, so the content script running it was replaced and its ` +
            `own reply was lost. The action DID run — it was deliberately not retried, because a ` +
            `retry could repeat it (e.g. submit twice). Read the new page to see the result; refs ` +
            `from before the navigation are gone.`,
        },
      };
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ["content.js"],
    });
    return await confirmNothingHappened(
      await chrome.tabs.sendMessage(tab.id, { action, params }, opts),
      tab.id,
      urlBefore
    );
  }
}

// Which frame an element came from, as origin and path: an iframe's query string (an ad or
// sign-in widget's runs to kilobytes) repeated on every element it holds adds nothing.
function frameLabel(url) {
  try {
    const u = new URL(url);
    return u.origin === "null" ? url.split(/[?#]/)[0] : u.origin + u.pathname;
  } catch {
    return String(url || "").split(/[?#]/)[0];
  }
}

// A frame-qualified ref ('@f3:ref_5') routes to that frame with the bare ref. On 'target' only a
// ref-shaped inner part counts, so visible text such as 'f2: Settings' stays in the top frame.
function frameRoute(params = {}) {
  for (const key of ["target", "ref", "ref_id"]) {
    const v = params[key];
    const m = typeof v === "string" && v.match(/^@?f(\d+):(.+)$/i);
    if (!m) continue;
    const bare = m[2].startsWith("@") ? m[2].slice(1) : m[2];
    if (key === "target") {
      if (!/^(?:ref_\d+|e\d+)$/.test(bare)) continue;
      return { frameId: Number(m[1]), params: { ...params, target: "@" + bare } };
    }
    return { frameId: Number(m[1]), params: { ...params, [key]: bare } };
  }
  return { frameId: 0, params };
}

async function contentFrames(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  if (!frames) return [{ frameId: 0, url: "" }];
  return frames
    .filter((f) => f.frameId === 0 || (f.url && /^https?:|^file:/.test(f.url)))
    .map((f) => ({ frameId: f.frameId, url: f.url || "" }));
}

async function crossFrame(action, params) {
  const tab = await targetTab(params);
  const frames = await contentFrames(tab.id);
  const errors = [];
  const per = await Promise.all(
    frames.map(async (fr) => {
      try {
        const reply = await toContent(action, params, fr.frameId);
        if (reply && reply.ok) return { fr, result: reply.result };
        if (reply && reply.error) errors.push(`f${fr.frameId}: ${reply.error}`);
        return null;
      } catch (err) {
        errors.push(`f${fr.frameId}: ${err && err.message ? err.message : String(err)}`);
        return null;
      }
    })
  );
  return mergeFrameResults(action, per.filter(Boolean), params, errors);
}

const qualifyRef = (frameId, ref) => (frameId === 0 || !ref ? ref : `f${frameId}:${ref}`);

function mergeFrameResults(action, parts, params = {}, errors = []) {
  if (!parts.length) {
    const detail = errors.length ? ` — ${errors.slice(0, 3).join("; ")}` : "";
    return {
      ok: false,
      error: `no frame could handle '${action}' (page not accessible, or the ref/ref_id was not found in any frame)${detail}`,
      ...(errors.length ? { diagnostics: { frameErrors: errors.slice(0, 5) } } : {}),
    };
  }
  const top = parts.find((p) => p.fr.frameId === 0) || parts[0];
  if (action === "snapshot") {
    const elements = [];
    const folded = [];
    for (const { fr, result } of parts) {
      const frame = fr.frameId === 0 ? null : frameLabel(fr.url);
      const inFrame = (el) => (frame ? { ...el, ref: qualifyRef(fr.frameId, el.ref), frame } : el);
      for (const el of result.elements || []) {
        elements.push(frame ? { ...inFrame(el), index: undefined } : el);
      }
      for (const el of result.folded || []) folded.push(inFrame(el));
    }
    const totalElementsCount = parts.reduce(
      (sum, p) => sum + (p.result.totalElementsCount || p.result.elements?.length || 0),
      0
    );
    const offscreenCount = parts.reduce((sum, p) => sum + (p.result.offscreenCount || 0), 0);

    const res = {
      ...top.result,
      scope: top.result.scope || params.scope || "viewport",
      totalElementsCount,
      offscreenCount,
      foldedCount: top.result.foldedCount || 0,
      elements,
      ...(folded.length ? { folded } : {}),
    };
    const topView = top.result.compactView || top.result.census;
    if (topView) {
      const sections = [topView];
      let extraFrames = 0;
      for (const { fr, result } of parts) {
        const partView = result.compactView || result.census;
        if (fr.frameId === 0 || !partView) continue;
        const body = partView
          .split("\n")
          .filter(
            (l) =>
              !/^\[(Quick Actions|Next):/.test(l) && !/^\[Notice:/.test(l) && l.trim() !== "---"
          )
          .join("\n")
          .trim();
        if (!body) continue;
        const qualified = body.replace(
          /\[@(ref_\d+)\]/g,
          (_m, r) => `[@${qualifyRef(fr.frameId, r)}]`
        );
        const shortUrl = frameLabel(fr.url).slice(0, 90);
        extraFrames++;
        sections.push(
          `\n[iframe f${fr.frameId} ${shortUrl}] — refs below are frame-qualified, pass them back verbatim\n${qualified}`
        );
      }
      if (extraFrames > 0) {
        sections.push(
          `[Notice: ${extraFrames} sub-frame${extraFrames > 1 ? "s" : ""} listed above with frame-qualified refs. Page totals: ${elements.length} elements, ${offscreenCount} offscreen]`
        );
        res.compactView = sections.join("\n");
      }
    } else if (params.compact) {
      res.compactNote =
        "compact view unavailable from the content script; use the structured `elements` array";
    }
    return { ok: true, result: res };
  }
  if (action === "find") {
    const matches = [];
    for (const { fr, result } of parts)
      for (const m of result.matches || [])
        matches.push(
          fr.frameId === 0
            ? m
            : { ...m, ref: qualifyRef(fr.frameId, m.ref), frame: frameLabel(fr.url) }
        );
    if (matches.length > 0)
      return { ok: true, result: { ...(top.result || {}), count: matches.length, matches } };

    const nearest = [];
    let note = "";
    let searchedScope = "";
    for (const { fr, result } of parts) {
      for (const n of result.nearest || []) {
        nearest.push(
          fr.frameId === 0
            ? n
            : { ...n, ref: qualifyRef(fr.frameId, n.ref), frame: frameLabel(fr.url) }
        );
      }
      if (!note && result.note) note = result.note;
      if (!searchedScope && result.searchedScope) searchedScope = result.searchedScope;
    }
    return {
      ok: true,
      result: {
        ...(top.result || {}),
        count: 0,
        matches: [],
        ...(searchedScope ? { searchedScope } : {}),
        ...(nearest.length ? { nearest: nearest.slice(0, 5) } : {}),
        ...(note ? { note } : {}),
      },
    };
  }
  let tree = top.result.tree || "";
  for (const { fr, result } of parts) {
    if (fr.frameId === 0 || !result.tree) continue;
    const qualified = result.tree.replace(
      /\[(ref_\d+)\]/g,
      (_, r) => `[${qualifyRef(fr.frameId, r)}]`
    );
    tree += `\n  iframe [f${fr.frameId}] ${fr.url}\n` + qualified.replace(/^/gm, "  ");
  }
  return {
    ok: true,
    result: {
      url: top.result.url,
      title: top.result.title,
      tree,
      truncated: !!top.result.truncated,
      ...(top.result.depthClipped
        ? { depthClipped: true, deepestReached: top.result.deepestReached }
        : {}),
      ...(top.result.depthUsed ? { depthUsed: top.result.depthUsed } : {}),
      ...(top.result.notices ? { notices: top.result.notices } : {}),
      ...(top.result.note ? { note: top.result.note } : {}),
    },
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeHost || changes.bridgePort)) {
    if (!wantConnect) return;
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
    socket = null;
    attempts = 0;
    connect();
  }
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (wantConnect && connState !== "connected") connect();
});
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

init();
