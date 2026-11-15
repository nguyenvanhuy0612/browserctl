// @ts-check
// Tab primitives. New tabs never take focus: they open inactive in the last focused normal window
// (specs/sessions.md).

/** @param {chrome.tabs.Tab} tab @param {Map<number, chrome.windows.Window>} windows */
function describe(tab, windows) {
  const window = windows.get(tab.windowId);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    openerTabId: tab.openerTabId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    status: tab.status,
    windowFocused: window?.focused ?? false,
    windowState: window?.state ?? "normal",
  };
}

async function windowMap() {
  const windows = await chrome.windows.getAll();
  return new Map(windows.map((w) => [/** @type {number} */ (w.id), w]));
}

/** @param {unknown} error */
function tabError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  return Object.assign(new Error(message), { code: /no tab with/i.test(message) ? "TAB_CLOSED" : "TABS_ERROR" });
}

export async function list() {
  const [tabs, windows] = await Promise.all([chrome.tabs.query({}), windowMap()]);
  return { tabs: tabs.map((t) => describe(t, windows)) };
}

/** @param {{tabId: number}} params */
export async function get({ tabId }) {
  try {
    return describe(await chrome.tabs.get(tabId), await windowMap());
  } catch (error) {
    throw tabError(error);
  }
}

/** @param {{url?: string, windowId?: number}} params */
export async function create({ url, windowId }) {
  let target = windowId;
  if (target === undefined) {
    try {
      target = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    } catch {
      target = undefined;
    }
  }
  let tab;
  if (target === undefined) {
    const window = await chrome.windows.create({ url: url ?? "about:blank", focused: false, state: "minimized" });
    tab = /** @type {chrome.tabs.Tab} */ (window?.tabs?.[0]);
  } else {
    tab = await chrome.tabs.create({ url: url ?? "about:blank", active: false, windowId: target });
  }
  return describe(tab, await windowMap());
}

/** @param {{tabId: number, url: string}} params */
export async function navigate({ tabId, url }) {
  try {
    await chrome.tabs.update(tabId, { url });
    return {};
  } catch (error) {
    throw tabError(error);
  }
}

/** @param {{tabId: number, action: "back" | "forward" | "reload"}} params */
export async function history({ tabId, action }) {
  try {
    if (action === "back") await chrome.tabs.goBack(tabId);
    else if (action === "forward") await chrome.tabs.goForward(tabId);
    else await chrome.tabs.reload(tabId);
    return { moved: true };
  } catch (error) {
    const message = String(/** @type {any} */ (error)?.message ?? error);
    // goBack / goForward with no entry: not an error for navigate (specs/tools/navigate.md).
    if (/cannot find a next page in history|no.*(previous|next).*history/i.test(message)) return { moved: false };
    throw tabError(error);
  }
}

/** @param {{tabId: number}} params */
export async function close({ tabId }) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    if (!/no tab with/i.test(String(/** @type {any} */ (error)?.message))) throw tabError(error);
  }
  return {};
}

/** @param {{tabId: number, focusWindow?: boolean}} params */
export async function activate({ tabId, focusWindow }) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (focusWindow && tab) await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  } catch (error) {
    throw tabError(error);
  }
}

