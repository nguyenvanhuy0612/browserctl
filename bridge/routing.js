// How the bridge treats each extension action when routing it to a tab.

// Actions that act on a browser, not on one tab: they are sent without a tab id.
export const TABLESS_ACTIONS = new Set([
  "list_tabs",
  "new_tab",
  "list_windows",
  "focus_window",
  "reload_extension",
]);

// Actions that name their tab in `id` rather than `tabId`.
export const ID_ACTIONS = new Set(["switch_tab", "close_tab", "group_tab", "ungroup_tab"]);

// Actions that only read a tab and leave it as it was. A session may run these on a tab another
// session holds, given its id; every other action, including any not listed here, is refused
// there. Reads that attach the debugger (screenshots, the accessibility tree, PDF, audit) are
// not on the list: the attach outlives the call and changes how the holder's tab behaves.
export const READ_ACTIONS = new Set([
  "snapshot",
  "read_page",
  "find",
  "find_text",
  "get_page_content",
  "get_content",
  "describe_element",
  "get_property",
  "get_text",
  "get_value",
  "get_html",
  "get_box",
  "get_attribute",
  "get_count",
  "extract",
  "element_rect",
  "read_pdf",
  "wait_for",
  "wait_settle",
  "pending_dialog",
  "current_tab",
  "storage_get",
  "net_get",
  "get_console_logs",
  "get_network_requests",
  "get_response_body",
]);

// Whether a command only reads its tab: a listed read, not asked to clear what it read.
export function isRead(action, params) {
  return READ_ACTIONS.has(action) && params?.clear !== true;
}

// The tab a command names, if it names one. The actions that take `id` also accept `tabId`.
export function tabOf(action, params) {
  const v = ID_ACTIONS.has(action) ? (params?.id ?? params?.tabId) : params?.tabId;
  return Number.isInteger(v) ? v : null;
}

// The text of NEEDS_TARGET: every open tab, one per line, marked where another session holds it,
// so the caller can pick one. At most `max` lines.
export function tabChoices(tabs, max = 50) {
  const line = (t) =>
    `${t.browser} tab ${t.id} "${String(t.title || "").slice(0, 50)}" ${String(t.url || "").slice(0, 80)}` +
    (t.heldBy ? ` [held by ${t.heldBy}]` : "");
  const more = tabs.length > max ? `\n(${tabs.length - max} more tabs)` : "";
  return tabs.slice(0, max).map(line).join("\n") + more;
}
