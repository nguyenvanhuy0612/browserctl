#!/usr/bin/env node
// MCP server: exposes the browser-control bridge as tools for Claude Code / Desktop.
//
// Each tool is a thin wrapper that POSTs { action, params } to the local bridge
// (default http://127.0.0.1:8765). The bridge relays to the Chrome extension.
//
// Connect from Claude Code:
//   claude mcp add browser -- node /abs/path/to/ai-browser-control/mcp/index.js
// or add to .mcp.json (see README).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:8765";

// POST a command to the bridge and return its result, throwing on failure.
async function callBridge(action, params = {}) {
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
  } catch (err) {
    throw new Error(
      `cannot reach bridge at ${BRIDGE_URL} (is 'npm start' running in bridge/?): ${err.message}`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || `command '${action}' failed (HTTP ${res.status})`);
  return data.result;
}

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function fail(err) {
  return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true };
}

// Wrap a handler so bridge errors become MCP tool errors instead of crashing.
function tool(action, build) {
  return async (args = {}) => {
    try {
      return await build(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const server = new McpServer({ name: "ai-browser-control", version: "0.1.0" });

server.registerTool(
  "browser_snapshot",
  {
    title: "Snapshot page",
    description:
      "Return the TARGET tab's interactive elements (each with an 'index' and a stable 'ref'), the page URL/title, and visible text. On your first command the focused tab is pinned as the target and stays pinned even if the user switches tabs (use browser_switch_tab to retarget). Check the returned url/title (or call browser_current_tab) before reading sensitive pages. Call this first, then act by ref/index. Re-call after any action that changes the page.",
    inputSchema: {},
  },
  tool("snapshot", async () => text(await callBridge("snapshot")))
);

server.registerTool(
  "browser_read_page",
  {
    title: "Read page (accessibility tree)",
    description:
      "Return the TARGET tab's accessibility tree as compact indented text — roles, accessible names, and a stable 'ref' on each interactive element (e.g. textbox \"Email\" [ref_5]). Cheaper than a screenshot and usable for reasoning about structured pages. Act on results with browser_click/browser_type using the ref. mode='interactive' (default) lists actionable elements; mode='all' includes everything. Pass ref_id to focus a subtree, depth to limit nesting.",
    inputSchema: {
      mode: z.enum(["interactive", "all"]).optional().describe("Default 'interactive'"),
      depth: z.number().int().optional().describe("Max nesting depth (default 15)"),
      ref_id: z.string().optional().describe("Focus the subtree under this ref"),
      maxChars: z.number().int().optional().describe("Output cap (default 50000)"),
    },
  },
  tool("read_page", async ({ mode, depth, ref_id, maxChars }) =>
    text(await callBridge("read_page", { mode, depth, ref_id, maxChars }))
  )
);

server.registerTool(
  "browser_find",
  {
    title: "Find elements by text",
    description:
      "Find interactive elements whose accessible name / text / placeholder / aria-label contains the query. Returns up to 'max' matches, each with a stable 'ref' to act on. Use when you know the label of a control but not its index.",
    inputSchema: {
      query: z.string().describe("Text to match (case-insensitive substring)"),
      max: z.number().int().optional().describe("Max matches (default 20)"),
    },
  },
  tool("find", async ({ query, max }) => text(await callBridge("find", { query, max })))
);

server.registerTool(
  "browser_navigate",
  {
    title: "Navigate",
    description: "Load a URL in the target tab (pins it as the target for later commands). Returns the final URL once loaded.",
    inputSchema: { url: z.string().describe("Absolute URL to load") },
  },
  tool("navigate", async ({ url }) => text(await callBridge("navigate", { url })))
);

server.registerTool(
  "browser_click",
  {
    title: "Click element",
    description: "Click an element identified by 'ref' (stable, from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref.",
    inputSchema: {
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5')"),
    },
  },
  tool("click", async ({ index, ref }) => text(await callBridge("click", { index, ref })))
);

server.registerTool(
  "browser_type",
  {
    title: "Type into element",
    description:
      "Focus an element (by 'ref' or 'index') and set its text. Set submit=true to press Enter afterward.",
    inputSchema: {
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5')"),
      text: z.string().describe("Text to enter"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
    },
  },
  tool("type", async ({ index, ref, text: t, submit }) =>
    text(await callBridge("type", { index, ref, text: t, submit }))
  )
);

server.registerTool(
  "browser_scroll",
  {
    title: "Scroll page",
    description: "Scroll the page up or down by a number of pixels (default 600).",
    inputSchema: {
      direction: z.enum(["up", "down"]).optional().describe("Default 'down'"),
      amount: z.number().optional().describe("Pixels to scroll, default 600"),
    },
  },
  tool("scroll", async ({ direction, amount }) =>
    text(await callBridge("scroll", { direction, amount }))
  )
);

server.registerTool(
  "browser_screenshot",
  {
    title: "Screenshot",
    description:
      "Capture the visible viewport of the TARGET tab. Works on a background tab without activating it (so the user can keep using other tabs); attaching the debugger for that shows the 'is being debugged' bar on the target tab. JPEG by default (smaller); pass format='png' for a lossless image (e.g. pixel-diff QA).",
    inputSchema: {
      format: z.enum(["png", "jpeg"]).optional().describe("Image format, default jpeg"),
      quality: z.number().int().optional().describe("JPEG quality 1-100, default 55"),
    },
  },
  tool("screenshot", async ({ format, quality }) => {
    const { dataUrl } = await callBridge("screenshot", { format, quality });
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    return { content: [{ type: "image", data: m ? m[2] : dataUrl, mimeType: `image/${m ? m[1] : "jpeg"}` }] };
  })
);

server.registerTool(
  "browser_list_tabs",
  {
    title: "List tabs",
    description: "List all open tabs with their id, url, title, and whether active.",
    inputSchema: {},
  },
  tool("list_tabs", async () => text(await callBridge("list_tabs")))
);

server.registerTool(
  "browser_new_tab",
  {
    title: "New tab",
    description: "Open a new tab, optionally at a URL, and make it the target tab for subsequent commands. Returns the new tab id.",
    inputSchema: { url: z.string().optional().describe("Optional URL to open") },
  },
  tool("new_tab", async ({ url }) => text(await callBridge("new_tab", { url })))
);

server.registerTool(
  "browser_group_tab",
  {
    title: "Group a tab (visual marker)",
    description:
      "Put a tab into a labeled, colored tab group so you (and the user) can see which tab the agent drives. Defaults to the target tab; pass id to group a specific tab. Does NOT activate the tab (no focus steal) and pins the grouped tab as the target.",
    inputSchema: {
      id: z.number().int().optional().describe("Tab id to group (default: target tab)"),
      title: z.string().optional().describe("Group label, default 'aibc'"),
      color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional().describe("Group color, default 'blue'"),
    },
  },
  tool("group_tab", async ({ id, title, color }) => text(await callBridge("group_tab", { id, title, color })))
);

server.registerTool(
  "browser_ungroup_tab",
  {
    title: "Ungroup a tab",
    description: "Remove a tab from its tab group. Defaults to the target tab.",
    inputSchema: { id: z.number().int().optional().describe("Tab id to ungroup (default: target tab)") },
  },
  tool("ungroup_tab", async ({ id }) => text(await callBridge("ungroup_tab", { id })))
);

server.registerTool(
  "browser_switch_tab",
  {
    title: "Switch tab",
    description: "Make the tab with the given id active and the target for subsequent commands.",
    inputSchema: { id: z.number().int().describe("Tab id from browser_list_tabs") },
  },
  tool("switch_tab", async ({ id }) => text(await callBridge("switch_tab", { id })))
);

server.registerTool(
  "browser_current_tab",
  {
    title: "Current target tab",
    description:
      "Report which tab commands currently act on (id, url, title, and whether a target is pinned). The target is pinned on your first command and held across user tab switches. Call this to confirm you're on the right page before snapshotting or reading sensitive content.",
    inputSchema: {},
  },
  tool("current_tab", async () => text(await callBridge("current_tab")))
);

server.registerTool(
  "browser_close_tab",
  {
    title: "Close tab",
    description: "Close the tab with the given id.",
    inputSchema: { id: z.number().int().describe("Tab id from browser_list_tabs") },
  },
  tool("close_tab", async ({ id }) => text(await callBridge("close_tab", { id })))
);

// --- CDP-backed tools (console / network / HAR / eval). Require browser_cdp_attach. ---

server.registerTool(
  "browser_cdp_attach",
  {
    title: "Attach debugger",
    description:
      "Attach the debugger to the active tab to start capturing console logs and network traffic. Shows an 'is being debugged' bar in the browser. Call this before get_console_logs / get_network_requests / export_har.",
    inputSchema: {},
  },
  tool("cdp_attach", async () => text(await callBridge("cdp_attach")))
);

server.registerTool(
  "browser_cdp_detach",
  {
    title: "Detach debugger",
    description: "Detach the debugger from the active tab and stop capturing. Removes the debugging bar.",
    inputSchema: {},
  },
  tool("cdp_detach", async () => text(await callBridge("cdp_detach")))
);

server.registerTool(
  "browser_get_console_logs",
  {
    title: "Get console logs",
    description:
      "Return buffered console messages (log/warn/error/exceptions) captured since attach. Requires browser_cdp_attach.",
    inputSchema: {
      limit: z.number().int().optional().describe("Max messages to return (default 200, newest)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
    },
  },
  tool("get_console_logs", async ({ limit, clear }) =>
    text(await callBridge("get_console_logs", { limit, clear }))
  )
);

server.registerTool(
  "browser_get_network_requests",
  {
    title: "Get network requests",
    description:
      "Return network requests captured since attach (method, url, status, type, size). Requires browser_cdp_attach.",
    inputSchema: {
      urlContains: z.string().optional().describe("Only return requests whose URL contains this substring"),
    },
  },
  tool("get_network_requests", async ({ urlContains }) =>
    text(await callBridge("get_network_requests", { urlContains }))
  )
);

server.registerTool(
  "browser_export_har",
  {
    title: "Export HAR",
    description:
      "Export captured network traffic as a HAR 1.2 object (headers, status, timing). Sensitive headers (cookies, auth) are redacted. Set bodies=true to also include response bodies (best-effort, slower). Requires browser_cdp_attach.",
    inputSchema: { bodies: z.boolean().optional().describe("Include response bodies") },
  },
  tool("export_har", async ({ bodies }) => text(await callBridge("export_har", { bodies })))
);

server.registerTool(
  "browser_eval_js",
  {
    title: "Evaluate JavaScript",
    description:
      "Run a JavaScript expression in the active page and return its (JSON-serializable) value. If the debugger is attached it runs via Runtime.evaluate (bypasses page CSP); otherwise in the page MAIN world.",
    inputSchema: { expression: z.string().describe("JavaScript expression to evaluate") },
  },
  tool("eval_js", async ({ expression }) => text(await callBridge("eval_js", { expression })))
);

// --- More DOM interaction (content script) ---

server.registerTool(
  "browser_hover",
  {
    title: "Hover element",
    description: "Hover the pointer over the element with the given snapshot index.",
    inputSchema: { index: z.number().int().describe("Element index from browser_snapshot") },
  },
  tool("hover", async ({ index }) => text(await callBridge("hover", { index })))
);

server.registerTool(
  "browser_select_option",
  {
    title: "Select dropdown option",
    description: "Select an option in a <select> element by value or by visible label.",
    inputSchema: {
      index: z.number().int().describe("Index of the <select> element"),
      value: z.string().optional().describe("Option value to select"),
      label: z.string().optional().describe("Visible option text to select"),
    },
  },
  tool("select_option", async ({ index, value, label }) =>
    text(await callBridge("select_option", { index, value, label }))
  )
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press a key",
    description: "Dispatch a keyboard key (e.g. Enter, Escape, ArrowDown) to an element or the focused element.",
    inputSchema: {
      key: z.string().describe("Key name, e.g. 'Enter', 'Escape', 'ArrowDown'"),
      index: z.number().int().optional().describe("Target element index; defaults to the focused element"),
    },
  },
  tool("press_key", async ({ key, index }) => text(await callBridge("press_key", { key, index })))
);

server.registerTool(
  "browser_wait_for",
  {
    title: "Wait for condition",
    description:
      "Wait until a CSS selector or page text appears (or disappears with gone=true). With neither, waits a fixed time. Use after actions that trigger async page changes.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector to wait for"),
      text: z.string().optional().describe("Page text to wait for"),
      gone: z.boolean().optional().describe("Wait for the selector/text to disappear instead"),
      timeoutMs: z.number().int().optional().describe("Timeout in ms (default 8000; fixed wait default 1000)"),
    },
  },
  tool("wait_for", async ({ selector, text: t, gone, timeoutMs }) =>
    text(await callBridge("wait_for", { selector, text: t, gone, timeoutMs }))
  )
);

server.registerTool(
  "browser_wait_settle",
  {
    title: "Wait for page to settle",
    description:
      "Wait until the page is fully loaded AND no CSS/JS animations are running (document.readyState complete + getAnimations() empty). Catches transitions that wait_for/network-idle miss. Use before a screenshot or read after navigation.",
    inputSchema: { timeoutMs: z.number().int().optional().describe("Timeout in ms (default 10000)") },
  },
  tool("wait_settle", async ({ timeoutMs }) => text(await callBridge("wait_settle", { timeoutMs })))
);

server.registerTool(
  "browser_get_page_content",
  {
    title: "Get readable page content",
    description: "Extract the main readable text of the page (title, url, cleaned text). Good for reading articles.",
    inputSchema: { maxChars: z.number().int().optional().describe("Max characters of text (default 8000)") },
  },
  tool("get_page_content", async ({ maxChars }) =>
    text(await callBridge("get_page_content", { maxChars }))
  )
);

// --- Navigation history & windows ---

server.registerTool(
  "browser_go_back",
  { title: "Go back", description: "Navigate back in the active tab's history.", inputSchema: {} },
  tool("go_back", async () => text(await callBridge("go_back")))
);

server.registerTool(
  "browser_go_forward",
  { title: "Go forward", description: "Navigate forward in the active tab's history.", inputSchema: {} },
  tool("go_forward", async () => text(await callBridge("go_forward")))
);

server.registerTool(
  "browser_reload",
  {
    title: "Reload",
    description: "Reload the active tab. Set bypassCache=true for a hard reload.",
    inputSchema: { bypassCache: z.boolean().optional().describe("Hard reload, bypassing cache") },
  },
  tool("reload", async ({ bypassCache }) => text(await callBridge("reload", { bypassCache })))
);

server.registerTool(
  "browser_list_windows",
  {
    title: "List windows",
    description: "List all browser windows with their tabs.",
    inputSchema: {},
  },
  tool("list_windows", async () => text(await callBridge("list_windows")))
);

server.registerTool(
  "browser_focus_window",
  {
    title: "Focus window",
    description: "Bring the window with the given id to the foreground.",
    inputSchema: { id: z.number().int().describe("Window id from browser_list_windows") },
  },
  tool("focus_window", async ({ id }) => text(await callBridge("focus_window", { id })))
);

// --- Light network capture (chrome.webRequest, NO debugger banner) ---

server.registerTool(
  "browser_net_start",
  {
    title: "Start network capture (light)",
    description:
      "Start capturing network requests for the active tab via webRequest. No debugger banner, but no response bodies. Clears the previous buffer.",
    inputSchema: {},
  },
  tool("net_start", async () => text(await callBridge("net_start")))
);

server.registerTool(
  "browser_net_stop",
  { title: "Stop network capture (light)", description: "Stop the webRequest capture for the active tab.", inputSchema: {} },
  tool("net_stop", async () => text(await callBridge("net_stop")))
);

server.registerTool(
  "browser_net_get",
  {
    title: "Get captured network (light)",
    description:
      "Return network requests captured by the light webRequest capture (method, url, type, status, timing). Sensitive headers are stripped.",
    inputSchema: {
      urlContains: z.string().optional().describe("Filter by URL substring"),
      limit: z.number().int().optional().describe("Max requests (default 200, newest)"),
    },
  },
  tool("net_get", async ({ urlContains, limit }) =>
    text(await callBridge("net_get", { urlContains, limit }))
  )
);

server.registerTool(
  "browser_net_clear",
  { title: "Clear network capture (light)", description: "Clear the light network capture buffer for the active tab.", inputSchema: {} },
  tool("net_clear", async () => text(await callBridge("net_clear")))
);

// --- CDP extras ---

server.registerTool(
  "browser_get_response_body",
  {
    title: "Get response body",
    description:
      "Fetch the response body of a captured request by its requestId (from get_network_requests). Best-effort; bodies may be evicted. Requires browser_cdp_attach.",
    inputSchema: { requestId: z.string().describe("requestId from the CDP network capture") },
  },
  tool("get_response_body", async ({ requestId }) =>
    text(await callBridge("get_response_body", { requestId }))
  )
);

server.registerTool(
  "browser_screenshot_fullpage",
  {
    title: "Full-page screenshot",
    description:
      "Capture the entire page (beyond the viewport) as an image. Requires browser_cdp_attach (uses the debugger).",
    inputSchema: { format: z.enum(["png", "jpeg"]).optional().describe("Image format, default png") },
  },
  tool("capture_screenshot", async ({ format }) => {
    const { dataUrl } = await callBridge("capture_screenshot", { fullPage: true, format });
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    return { content: [{ type: "image", data: m ? m[2] : dataUrl, mimeType: `image/${m ? m[1] : "png"}` }] };
  })
);

// --- Coordinate input, accessibility, capture, audit (CDP; require attach) ---

server.registerTool(
  "browser_coordinate_click",
  {
    title: "Click at coordinates",
    description: "Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp_attach.",
    inputSchema: {
      x: z.number().describe("X in screenshot pixels"),
      y: z.number().describe("Y in screenshot pixels"),
      button: z.enum(["left", "right", "middle"]).optional(),
      clickCount: z.number().int().optional().describe("e.g. 2 for double-click"),
    },
  },
  tool("coordinate_click", async ({ x, y, button, clickCount }) => text(await callBridge("coordinate_click", { x, y, button, clickCount })))
);

server.registerTool(
  "browser_insert_text",
  {
    title: "Insert text (CDP)",
    description: "Type text into the focused element via CDP Input.insertText — robust for emoji/IME/multibyte that key-by-key typing can't represent. Click/focus the field first. Requires browser_cdp_attach.",
    inputSchema: { text: z.string().describe("Text to insert at the focus") },
  },
  tool("insert_text", async ({ text: t }) => text(await callBridge("insert_text", { text: t })))
);

server.registerTool(
  "browser_coordinate_drag",
  {
    title: "Drag between coordinates",
    description: "Press at (fromX,fromY), move to (toX,toY), release. Requires browser_cdp_attach.",
    inputSchema: {
      fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(),
    },
  },
  tool("coordinate_drag", async (a) => text(await callBridge("coordinate_drag", a)))
);

server.registerTool(
  "browser_a11y_snapshot",
  {
    title: "Accessibility snapshot",
    description: "Return the page's accessibility tree (role/name/value) — a semantic view of the page. Requires browser_cdp_attach.",
    inputSchema: { max: z.number().int().optional().describe("Max nodes (default 200)") },
  },
  tool("a11y_snapshot", async ({ max }) => text(await callBridge("a11y_snapshot", { max })))
);

server.registerTool(
  "browser_element_screenshot",
  {
    title: "Screenshot one element",
    description: "Capture just the element at the given snapshot index as an image. Requires browser_cdp_attach.",
    inputSchema: { index: z.number().int(), format: z.enum(["png", "jpeg"]).optional() },
  },
  tool("element_screenshot", async ({ index, format }) => {
    const { dataUrl } = await callBridge("element_screenshot", { index, format });
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    return { content: [{ type: "image", data: m ? m[2] : dataUrl, mimeType: `image/${m ? m[1] : "png"}` }] };
  })
);

server.registerTool(
  "browser_print_pdf",
  {
    title: "Print page to PDF",
    description: "Render the page to a PDF; returns base64 (save it to a .pdf file). Requires browser_cdp_attach.",
    inputSchema: {},
  },
  tool("print_pdf", async () => text(await callBridge("print_pdf")))
);

server.registerTool(
  "browser_audit",
  {
    title: "Audit page",
    description: "Lightweight audit: performance metrics (DOM nodes, JS heap, layout/script timing) plus an accessibility count of interactive elements missing a name. Requires browser_cdp_attach.",
    inputSchema: {},
  },
  tool("audit", async () => text(await callBridge("audit")))
);

server.registerTool(
  "browser_get_cookies",
  {
    title: "Get cookies",
    description: "Return browser cookies, optionally filtered by domain/url substring. Requires browser_cdp_attach.",
    inputSchema: { urlContains: z.string().optional() },
  },
  tool("get_cookies", async ({ urlContains }) => text(await callBridge("get_cookies", { urlContains })))
);

server.registerTool(
  "browser_set_cookie",
  {
    title: "Set cookie",
    description: "Set a cookie (provide url or domain). Useful for test setup. Requires browser_cdp_attach.",
    inputSchema: {
      name: z.string(), value: z.string(),
      url: z.string().optional(), domain: z.string().optional(), path: z.string().optional(),
      secure: z.boolean().optional(), httpOnly: z.boolean().optional(), expires: z.number().optional(),
    },
  },
  tool("set_cookie", async (a) => text(await callBridge("set_cookie", a)))
);

server.registerTool(
  "browser_delete_cookies",
  {
    title: "Delete cookies",
    description: "Delete cookies by name (optionally scoped to a url). Requires browser_cdp_attach.",
    inputSchema: { name: z.string(), url: z.string().optional() },
  },
  tool("delete_cookies", async (a) => text(await callBridge("delete_cookies", a)))
);

// --- Selector-based interaction & storage (content script) ---

server.registerTool(
  "browser_click_selector",
  {
    title: "Click by CSS selector",
    description: "Click the first element matching a CSS selector (no snapshot needed).",
    inputSchema: { selector: z.string() },
  },
  tool("click_selector", async ({ selector }) => text(await callBridge("click_selector", { selector })))
);

server.registerTool(
  "browser_fill_selector",
  {
    title: "Fill by CSS selector",
    description: "Set the value of the element matching a CSS selector and fire input/change.",
    inputSchema: { selector: z.string(), value: z.string() },
  },
  tool("fill_selector", async ({ selector, value }) => text(await callBridge("fill_selector", { selector, value })))
);

server.registerTool(
  "browser_storage_get",
  {
    title: "Read web storage",
    description: "Read localStorage or sessionStorage. With a key returns its value; without, returns all items.",
    inputSchema: { area: z.enum(["local", "session"]).optional(), key: z.string().optional() },
  },
  tool("storage_get", async ({ area, key }) => text(await callBridge("storage_get", { area, key })))
);

server.registerTool(
  "browser_storage_set",
  {
    title: "Write web storage",
    description: "Set a key in localStorage or sessionStorage (test fixtures, feature flags).",
    inputSchema: { area: z.enum(["local", "session"]).optional(), key: z.string(), value: z.string() },
  },
  tool("storage_set", async (a) => text(await callBridge("storage_set", a)))
);

server.registerTool(
  "browser_storage_remove",
  {
    title: "Remove web storage key",
    description: "Remove a key from localStorage or sessionStorage.",
    inputSchema: { area: z.enum(["local", "session"]).optional(), key: z.string() },
  },
  tool("storage_remove", async (a) => text(await callBridge("storage_remove", a)))
);

server.registerTool(
  "browser_storage_clear",
  {
    title: "Clear web storage",
    description: "Clear all of localStorage or sessionStorage.",
    inputSchema: { area: z.enum(["local", "session"]).optional() },
  },
  tool("storage_clear", async ({ area }) => text(await callBridge("storage_clear", { area })))
);

// --- Record & replay, network-idle, extension reload ---

server.registerTool(
  "browser_record_start",
  {
    title: "Start recording",
    description: "Start recording user interactions (clicks, field changes) in the active tab. Replay later with browser_replay.",
    inputSchema: {},
  },
  tool("record_start", async () => text(await callBridge("record_start")))
);

server.registerTool(
  "browser_record_stop",
  { title: "Stop recording", description: "Stop recording interactions.", inputSchema: {} },
  tool("record_stop", async () => text(await callBridge("record_stop")))
);

server.registerTool(
  "browser_record_get",
  { title: "Get recorded steps", description: "Return the recorded interaction steps.", inputSchema: {} },
  tool("record_get", async () => text(await callBridge("record_get")))
);

server.registerTool(
  "browser_replay",
  {
    title: "Replay steps",
    description: "Replay recorded steps (or supplied steps) against the active tab. Optionally navigate to startUrl first.",
    inputSchema: {
      startUrl: z.string().optional(),
      steps: z.array(z.object({
        type: z.string(), selector: z.string().optional(), value: z.string().optional(), url: z.string().optional(),
      })).optional(),
    },
  },
  tool("replay", async ({ startUrl, steps }) => text(await callBridge("replay", { startUrl, steps })))
);

server.registerTool(
  "browser_wait_network_idle",
  {
    title: "Wait for network idle",
    description: "Wait until the active tab has had no in-flight requests for idleMs (default 500), up to timeoutMs (default 10000). Reduces flaky waits.",
    inputSchema: { idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional() },
  },
  tool("wait_network_idle", async ({ idleMs, timeoutMs }) =>
    text(await callBridge("wait_network_idle", { idleMs, timeoutMs }))
  )
);

server.registerTool(
  "browser_reload_extension",
  {
    title: "Reload the extension",
    description: "Reload the browser extension itself from disk (dev convenience; picks up edited extension code). The connection drops briefly and reconnects.",
    inputSchema: {},
  },
  tool("reload_extension", async () => text(await callBridge("reload_extension")))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ai-browser-control MCP server running (bridge: ${BRIDGE_URL})`);
