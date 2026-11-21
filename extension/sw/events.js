// @ts-check
// Browser events forwarded to the daemon. Tab and navigation events cover every tab (a tab the
// daemon does not own yet can join a session); network events only the tabs the daemon watches,
// every tab until it first says which (specs/interface.md).
import { emit, onDaemonEvent } from "./connection.js";
import { guarded } from "./diag.js";

/** @type {Set<number> | null} */
let watched = null;
onDaemonEvent("watch", (/** @type {{tabIds: number[]}} */ data) => {
  watched = new Set(data.tabIds);
});

/** @param {number} tabId */
const isWatched = (tabId) => tabId >= 0 && (!watched || watched.has(tabId));

/** @param {{tabId: number, frameId: number, url: string, timeStamp: number}} d */
const nav = (d) => ({ tabId: d.tabId, frameId: d.frameId, url: d.url, at: d.timeStamp });

/** @param {chrome.webRequest.HttpHeader[] | undefined} headers */
const headerMap = (headers) => Object.fromEntries((headers ?? []).map((h) => [h.name, h.value ?? ""]));

export function listen() {
  chrome.tabs.onCreated.addListener(
    guarded("tabs.onCreated", (tab) =>
      emit("tabs.created", { tabId: tab.id, openerTabId: tab.openerTabId, windowId: tab.windowId, url: tab.pendingUrl ?? tab.url ?? "" }),
    ),
  );
  chrome.tabs.onRemoved.addListener(guarded("tabs.onRemoved", (tabId) => emit("tabs.removed", { tabId })));
  chrome.tabs.onUpdated.addListener(
    guarded("tabs.onUpdated", (tabId, change) => {
      if (change.url !== undefined || change.title !== undefined || change.status !== undefined) {
        emit("tabs.updated", { tabId, url: change.url, title: change.title, status: change.status });
      }
    }),
  );

  const navigation = chrome.webNavigation;
  navigation.onBeforeNavigate.addListener(guarded("nav.before", (d) => emit("nav.beforeNavigate", nav(d))));
  navigation.onCommitted.addListener(guarded("nav.committed", (d) => emit("nav.committed", nav(d))));
  navigation.onDOMContentLoaded.addListener(guarded("nav.dcl", (d) => emit("nav.domContentLoaded", nav(d))));
  navigation.onHistoryStateUpdated.addListener(guarded("nav.history", (d) => emit("nav.historyStateUpdated", nav(d))));
  navigation.onReferenceFragmentUpdated.addListener(guarded("nav.fragment", (d) => emit("nav.historyStateUpdated", nav(d))));
  navigation.onCompleted.addListener(guarded("nav.completed", (d) => emit("nav.completed", nav(d))));
  // Tabs opened by a page (target=_blank, window.open), with their source even under noopener.
  navigation.onCreatedNavigationTarget.addListener(
    guarded("nav.created", (d) => emit("nav.createdTarget", { tabId: d.tabId, sourceTabId: d.sourceTabId, sourceFrameId: d.sourceFrameId, url: d.url })),
  );
  navigation.onErrorOccurred.addListener(guarded("nav.error", (d) => emit("nav.error", { ...nav(d), error: d.error })));

  const filter = { urls: ["<all_urls>"] };
  chrome.webRequest.onSendHeaders.addListener(
    guarded("net.send", (d) => {
      if (!isWatched(d.tabId)) return;
      emit("net.request", {
        phase: "send",
        tabId: d.tabId,
        requestId: d.requestId,
        method: d.method,
        url: d.url,
        type: d.type,
        at: d.timeStamp,
        requestHeaders: headerMap(d.requestHeaders),
      });
    }),
    filter,
    ["requestHeaders", "extraHeaders"],
  );
  chrome.webRequest.onCompleted.addListener(
    guarded("net.done", (d) => {
      if (!isWatched(d.tabId)) return;
      emit("net.request", {
        phase: "done",
        tabId: d.tabId,
        requestId: d.requestId,
        status: d.statusCode,
        at: d.timeStamp,
        fromCache: d.fromCache,
        responseHeaders: headerMap(d.responseHeaders),
      });
    }),
    filter,
    ["responseHeaders", "extraHeaders"],
  );
  chrome.webRequest.onErrorOccurred.addListener(
    guarded("net.error", (d) => {
      if (!isWatched(d.tabId)) return;
      emit("net.request", { phase: "error", tabId: d.tabId, requestId: d.requestId, error: d.error, at: d.timeStamp });
    }),
    filter,
  );
}
