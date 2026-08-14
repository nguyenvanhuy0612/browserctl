#!/usr/bin/env node
// MCP server: exposes the browser-control bridge as tools for Claude Code / Desktop.
//
// Each tool is a thin wrapper that POSTs { action, params } to the local bridge
// (default http://127.0.0.1:8765). The bridge relays to the Chrome extension.
//
// Connect from Claude Code:
//   claude mcp add browserctl -- node /abs/path/to/browserctl/mcp/index.js
// or add to .mcp.json (see README).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  getDaemonState,
  markDaemonRunning,
  markDaemonStopped,
  isDaemonExplicitlyStopped,
} from "../bridge/state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

const BRIDGE_URL = envStr("BROWSERCTL_BRIDGE_URL", envStr("BRIDGE_URL", "http://127.0.0.1:8765"));

let isStartingDaemon = null;
let lastSpawnAttempt = 0;
let spawnFailCount = 0;
const SPAWN_COOLDOWN_MS = 5000; // 5s cooldown after repeated failures

async function isBridgeRunning() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(600) });
    if (res.ok) {
      spawnFailCount = 0;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function startBridgeDaemon() {
  if (isStartingDaemon) return isStartingDaemon;

  const now = Date.now();
  if (spawnFailCount >= 3 && now - lastSpawnAttempt < SPAWN_COOLDOWN_MS) {
    return false;
  }

  isStartingDaemon = (async () => {
    lastSpawnAttempt = Date.now();
    const serverPath = join(__dirname, "..", "bridge", "server.js");
    if (!fs.existsSync(serverPath)) {
      spawnFailCount++;
      return false;
    }

    try {
      const child = spawn(process.execPath, [serverPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PORT: "8765" },
      });
      child.unref();

      // Poll up to 2.5s (max 25 iterations of 100ms) with hard bounded loop
      const start = Date.now();
      while (Date.now() - start < 2500) {
        await new Promise((r) => setTimeout(r, 100));
        if (await isBridgeRunning()) {
          spawnFailCount = 0;
          try {
            markDaemonRunning({ pid: child.pid, port: 8765, url: BRIDGE_URL });
          } catch {}
          return true;
        }
      }
      spawnFailCount++;
      return false;
    } catch {
      spawnFailCount++;
      return false;
    } finally {
      isStartingDaemon = null;
    }
  })();

  return isStartingDaemon;
}

async function ensureBridge(forceAuto = false) {
  if (await isBridgeRunning()) return true;

  // If daemon was explicitly stopped and not forced, do NOT auto-start
  if (isDaemonExplicitlyStopped() && !forceAuto) {
    return false;
  }

  const autoStartPolicy = envStr("BROWSERCTL_AUTO_START", "auto");
  if ((autoStartPolicy === "manual" || autoStartPolicy === "false") && !forceAuto) {
    return false;
  }

  return await startBridgeDaemon();
}

// Carries the per-call tabId (if the tool was invoked with one) down to callBridge
// without every build having to thread it through explicitly. AsyncLocalStorage keeps
// this isolated per async call chain, so concurrent tool invocations (e.g. several
// agents each driving a different tab) never see each other's tabId.
const tabStore = new AsyncLocalStorage();

// POST a command to the bridge with strict 1-retry bound and per-request timeout.
async function callBridge(action, params = {}) {
  const tabId = tabStore.getStore();
  if (tabId != null && params.tabId == null) params = { ...params, tabId };

  if (!(await isBridgeRunning()) && isDaemonExplicitlyStopped()) {
    throw new Error(
      `cannot reach bridge at ${BRIDGE_URL}: Bridge daemon is currently stopped (explicitly stopped). ` +
      `Call 'browser_start' tool (or run 'browserctl start' in terminal) to start it.`
    );
  }

  const maxAttempts = 2; // Strict bound: at most 2 attempts (1 initial + 1 auto-restart retry)
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await ensureBridge();
    }
    try {
      const timeoutMs = (params.timeoutMs ? params.timeoutMs + 5000 : 65000);
      const res = await fetch(`${BRIDGE_URL}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || `command '${action}' failed (HTTP ${res.status})`);
      return data.result;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        await ensureBridge();
      }
    }
  }

  throw new Error(`cannot reach bridge at ${BRIDGE_URL}: ${lastErr?.message || "connection failed"}`);
}

function text(obj, format = "smart") {
  if (typeof obj === "string") {
    return { content: [{ type: "text", text: obj }] };
  }
  if (format === "pretty") {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
  }
  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(obj) }] };
  }
  if (format === "raw") {
    if (obj?.value !== undefined) {
      return { content: [{ type: "text", text: typeof obj.value === "object" ? JSON.stringify(obj.value) : String(obj.value) }] };
    }
    if (typeof obj?.text === "string") {
      return { content: [{ type: "text", text: obj.text }] };
    }
    return { content: [{ type: "text", text: typeof obj === "object" ? JSON.stringify(obj) : String(obj) }] };
  }

  // Smart default (Token-Efficient, Zero Info Loss)
  if (obj?.compactView) {
    const header = `Page: ${obj.title || "Untitled"} (${obj.url})\nInteractive elements (${obj.elements?.length || 0}):\n\n`;
    return { content: [{ type: "text", text: header + obj.compactView }] };
  }
  if (obj?.value !== undefined && typeof obj.value !== "object") {
    return { content: [{ type: "text", text: String(obj.value) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function fail(err) {
  return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true };
}

// Wrap a handler so bridge errors become MCP tool errors instead of crashing.
// Run the build inside the tabStore context seeded with args.tabId so any callBridge
// it makes routes to that tab (see tabStore/callBridge above). tabId undefined => no
// override => the bridge uses the pinned target, exactly as before.
function tool(action, build) {
  return async (args = {}) => {
    try {
      return await tabStore.run(args.tabId, () => build(args));
    } catch (err) {
      return fail(err);
    }
  };
}

// Server-level operating policy. MCP clients surface this to the model on
// connect, so it frames every action before any tool description is read. It
// encodes the pinned-target-tab, background-first control model this bridge is
// built around — the single most important thing an agent must get right here.
const INSTRUCTIONS = `This server drives ONE pinned "target" tab in the background. Follow this policy on every task:

- Pinned target: your first command pins the currently focused tab as the target, and it STAYS pinned even after the user switches to other tabs. Every command — DOM (click/type/navigate/read), CDP (debugger/console/network/eval), light network capture, and screenshots — acts on that pinned target, never on whatever tab the user is currently looking at.
- Work in the background. Do NOT switch or foreground a tab in order to act on it: clicks, typing, navigation, reads, and screenshots all work while the target sits in the background. The user must be able to keep working in their own tab (e.g. GitLab) uninterrupted while you work yours (e.g. LinkedIn).
- Call browser_group_tab once near the start so the user can see which tab you drive (a labeled tab group). It does not steal focus.
- To act on a different page, use browser_new_tab or browser_navigate — both re-pin the target. Only use browser_switch_tab / browser_focus_window when the user explicitly asks to bring a tab forward, or when a step genuinely cannot run in the background.
- Screenshots capture the background target without activating it (an "is being debugged" bar may appear on that tab only). Never foreground a tab just to screenshot it.
- Before reading or screenshotting sensitive content, confirm the target with browser_current_tab.
- Driving several tabs at once: every tab-scoped tool accepts an optional tabId (from browser_list_tabs). Pass it to run THAT command against THAT tab without changing the pinned target — so parallel agents can each drive a different tab without racing on the single pin. Omit tabId to use the pinned target.
- Full protocol capability & browser_action tool: In default (core) mode, dedicated tools are registered for primary operations. ALL other protocol capabilities (including cdp_send, cdp_attach, get_console_logs, get_network_requests, export_har, get_cookies, set_cookie, delete_cookies, storage_get, storage_set, read_pdf, record_start, record_stop, replay, describe_element, etc.) are 100% available by calling the 'browser_action' tool with { action: "<action_name>", params: { ... } } or via the host CLI 'browserctl <action>'.`;

const SERVER_VERSION = "0.5.0";

const server = new McpServer(
  { name: "browserctl", version: SERVER_VERSION },
  { instructions: INSTRUCTIONS }
);

// Optional per-command tab override, offered on every tab-scoped tool. Passing it
// routes THIS command to a specific tab without changing the pinned target, so several
// agents can drive different tabs concurrently. See tabStore/callBridge and the
// extension's targetTab(params).
const TAB_ID_FIELD = z
  .number()
  .int()
  .optional()
  .describe(
    "Target a specific tab id (from browser_list_tabs) for THIS command only, without changing the pinned target. Omit to use the pinned target. Lets multiple agents drive different tabs concurrently."
  );

// Tools that manage tabs/windows or the extension itself are NOT tab-scoped: they take
// their own id (or none), so tabId does not apply and must not be injected.
const NO_TAB_TOOLS = new Set([
  "browser_list_tabs", "browser_new_tab", "browser_group_tab", "browser_ungroup_tab",
  "browser_switch_tab", "browser_close_tab", "browser_list_windows", "browser_focus_window",
  "browser_reload_extension", "browser_record_get",
  // Reports bridge/extension health and daemon control; deliberately never touches a tab
  "browser_status",
  "browser_start",
  "browser_stop",
  // Runs system shell command on bridge host; doesn't touch browser tabs.
  "browser_exec_system_cmd",
  // Manages its own tab identity (open-or-reuse, like browser_new_tab) — declares its
  // own tabId field below with composite-specific semantics instead of the generic
  // per-command-override one.
  "browser_open_and_read",
]);

// Auto-add tabId to every tab-scoped tool's inputSchema in one place, instead of
// duplicating the field across ~45 tool definitions. Handles the two schema shapes used
// below: a raw shape (plain object of zod fields) and a zod object (incl. one wrapped by
// .refine()). Builds don't change — tool()/callBridge pick tabId up from the context.
function withTabId(schema) {
  // zod object (incl. one carrying a .refine() check, e.g. browser_click): .extend
  // adds the field and preserves the refinement (verified on zod 4).
  if (schema instanceof z.ZodObject) return schema.extend({ tabId: TAB_ID_FIELD });
  if (schema instanceof z.ZodType) return schema; // some other zod shape — leave it
  return { ...schema, tabId: TAB_ID_FIELD }; // raw shape (plain object of fields), incl. {}
}

// Tool Profiles: 'core' (default, ~20 essential tools + browser_action) or 'all' (all 68 tools).
// Core mode saves ~10k tokens in system prompts while still allowing any action via browser_action.
const MCP_PROFILE = envStr("BROWSERCTL_MCP_PROFILE", "core").toLowerCase();
const CORE_TOOLS = new Set([
  "browser_status",
  "browser_start",
  "browser_stop",
  "browser_exec_system_cmd",
  "browser_snapshot",
  "browser_read_page",
  "browser_find",
  "browser_find_text",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_paste",
  "browser_scroll",
  "browser_hover",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_wait_settle",
  "browser_get_page_content",
  "browser_screenshot",
  "browser_screenshot_fullpage",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_eval_js",
  "browser_action",
]);

const _registerTool = server.registerTool.bind(server);
server.registerTool = (name, config, handler) => {
  if (MCP_PROFILE !== "all" && MCP_PROFILE !== "full" && !CORE_TOOLS.has(name)) {
    return;
  }
  if (!NO_TAB_TOOLS.has(name) && config && "inputSchema" in config) {
    config = { ...config, inputSchema: withTabId(config.inputSchema) };
  }
  return _registerTool(name, config, handler);
};

server.registerTool(
  "browser_action",
  {
    title: "Universal Browser Action Dispatcher",
    description:
      "Execute any browserctl protocol action directly by name (e.g. 'click', 'type', 'navigate', 'cdp_send', 'snapshot', 'storage_get', 'export_har', 'record_start', etc.) with custom parameters. Use this to execute specialized actions without needing individual MCP tool schemas.",
    inputSchema: {
      action: z.string().describe("The action name (e.g. 'click', 'type', 'navigate', 'cdp_send', 'snapshot', 'storage_get', etc.)"),
      params: z.record(z.string(), z.any()).optional().describe("Parameters for the action as a key-value object"),
    },
  },
  tool("action", async ({ action, params = {} }) => text(await callBridge(action, params)))
);

server.registerTool(
  "browser_cdp_send",
  {
    title: "Send a raw CDP command",
    description:
      "POWER TOOL. Send any Chrome DevTools Protocol method to the target tab and get its result verbatim. Requires browser_cdp_attach first. Use it for capabilities that have no dedicated tool yet — Fetch.* (request interception / mocking / HTTP auth), DOM.setFileInputFiles (file upload), Page.handleJavaScriptDialog (alert/confirm), Emulation.* (device metrics, throttling, timezone, locale, geolocation, prefers-color-scheme), Storage.*, Tracing.*. Only domains in Chrome's chrome.debugger allowlist work; notably DOMStorage and IndexedDB are NOT available. Two footguns: enabling an interception domain without handling its events (e.g. Fetch.enable) pauses page traffic until you disable it, and Emulation.setDeviceMetricsOverride changes the screenshot scale that browser_coordinate_click depends on.",
    inputSchema: {
      method: z.string().describe("CDP method, e.g. 'Page.getLayoutMetrics' or 'Emulation.setCPUThrottlingRate'"),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe("Method parameters as an object, e.g. { rate: 4 }. Omit for methods that take none."),
    },
  },
  tool("cdp_send", async ({ method, params }) => text(await callBridge("cdp_send", { method, params })))
);

server.registerTool(
  "browser_status",
  {
    title: "Bridge/extension status",
    description:
      "Report whether the bridge is reachable, current daemon state (running/stopped), and whether the Chrome extension is connected to it. Call this first if a command failed, or to check readiness after starting/stopping the bridge.",
    inputSchema: {
      format: z.enum(["smart", "json", "pretty"]).optional().describe("Output format"),
    },
  },
  async ({ format } = {}) => {
    const state = getDaemonState();
    try {
      const res = await fetch(`${BRIDGE_URL}/status`, { method: "GET", signal: AbortSignal.timeout(600) });
      const data = await res.json().catch(() => ({}));
      return text({
        bridgeUrl: BRIDGE_URL,
        bridgeReachable: true,
        daemonState: "running",
        extensionConnected: data.extensionConnected === true,
        mcpServerVersion: SERVER_VERSION,
        ready: data.extensionConnected === true,
        hint:
          data.extensionConnected === true
            ? "ready"
            : "bridge is up but no extension is connected — open the extension popup and press Connect",
      }, format);
    } catch (err) {
      return text({
        bridgeUrl: BRIDGE_URL,
        bridgeReachable: false,
        daemonState: state.state || "stopped",
        extensionConnected: false,
        mcpServerVersion: SERVER_VERSION,
        ready: false,
        hint: `cannot reach the bridge (${err.message}) — start it with 'browser_start' tool or 'browserctl start'`,
      }, format);
    }
  }
);

server.registerTool(
  "browser_exec_system_cmd",
  {
    title: "Execute System Command",
    description:
      "Execute a shell/system command on the host running the bridge server. Returns exitCode, stdout, stderr, all (combined output), failed, timedOut, and signal.",
    inputSchema: {
      command: z.string().describe("Shell command line to execute on the bridge host"),
      cwd: z.string().optional().describe("Working directory for command execution"),
      env: z.record(z.string(), z.string()).optional().describe("Custom environment variables object"),
      timeoutMs: z.number().int().optional().describe("Timeout in milliseconds (default: 30000, max: 300000)"),
    },
  },
  tool("exec_system_cmd", async ({ command, cwd, env, timeoutMs }) =>
    text(await callBridge("exec_system_cmd", { command, cwd, env, timeoutMs }))
  )
);

server.registerTool(
  "browser_snapshot",
  {
    title: "Snapshot page",
    description:
      "Return the TARGET tab's interactive elements (each with an 'index' and a stable 'ref'), the page URL/title, and visible text. On your first command the focused tab is pinned as the target and stays pinned even if the user switches tabs (use browser_switch_tab to retarget). Check the returned url/title (or call browser_current_tab) before reading sensitive pages. Call this first, then act by ref/index. Re-call after any action that changes the page. Covers elements inside iframes (including cross-origin): a sub-frame element carries a 'frame' url and a frame-qualified ref like 'f3:ref_5' — pass that ref back verbatim to click/type it (index is top-frame only).",
    inputSchema: {
      compact: z.boolean().optional().describe("Return a compact token-efficient representation (saves ~75% tokens, default true)"),
      format: z.enum(["smart", "compact", "json", "pretty", "raw"]).optional().describe("Output formatting: 'smart' (default, compact tree), 'json', 'pretty', or 'raw'"),
      maxText: z.number().int().optional().describe("Max characters of page body text to include (default 4000)"),
    },
  },
  tool("snapshot", async ({ compact, format, maxText }) => {
    const isCompact = (format === "compact" || format === "smart" || format === undefined) ? (compact !== false) : compact;
    const res = await callBridge("snapshot", { compact: isCompact, maxText });
    return text(res, format);
  })
);

server.registerTool(
  "browser_read_page",
  {
    title: "Read page (accessibility tree)",
    description:
      "Return the TARGET tab's accessibility tree as compact indented text — roles, accessible names, and a stable 'ref' on each interactive element (e.g. textbox \"Email\" [ref_5]). Cheaper than a screenshot and usable for reasoning about structured pages. Act on results with browser_click/browser_type using the ref. mode='interactive' (default) lists actionable elements; mode='all' includes everything. Pass ref_id to focus a subtree, depth to limit nesting. iframe contents are appended under an 'iframe [f<id>] <url>' header with frame-qualified refs (e.g. f3:ref_5).",
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
      "Find interactive elements whose accessible name / text / placeholder / aria-label contains the query. Returns up to 'max' matches, each with a stable 'ref' to act on. Searches inside iframes too; matches from a sub-frame carry a frame-qualified ref (e.g. f3:ref_5) — pass it back verbatim. Use when you know the label of a control but not its index.",
    inputSchema: {
      query: z.string().describe("Text to match (case-insensitive substring)"),
      max: z.number().int().optional().describe("Max matches (default 20)"),
    },
  },
  tool("find", async ({ query, max }) => text(await callBridge("find", { query, max })))
);

server.registerTool(
  "browser_find_text",
  {
    title: "Find text on the page",
    description:
      "Search the FULL page text (not just interactive elements) for a query and return matching snippets with surrounding context, each flagged 'visible' (false for screen-reader-only/off-screen text) and paired with the nearest clickable/typeable ancestor if one exists ('nearestInteractive': {ref, tag, text}), so a hit can be turned into an action in one follow-up call. A match may span an inline element boundary (e.g. a name in its own link followed by plain text) — when it touches 2+ distinct interactive ancestors, an additional 'spanInteractives' array lists all of them (nearestInteractive stays the first/start one). Use this to answer 'does this page contain X, and where' — e.g. a rating, a price, a status string sitting in plain text that browser_find/browser_snapshot can't see (they only index interactive elements by design). For 'what can I click', use browser_find instead. Top frame only (like browser_get_page_content) — does not search iframes.",
    inputSchema: {
      query: z.string().describe("Text to match (case-insensitive substring by default)"),
      regex: z.boolean().optional().describe("Treat query as a JS regex pattern instead of a literal substring. Default false."),
      max: z.number().int().optional().describe("Max matches (default 20)"),
      contextChars: z.number().int().optional().describe("Characters of context to include before/after each match (default 80)"),
    },
  },
  tool("find_text", async ({ query, regex, max, contextChars }) =>
    text(await callBridge("find_text", { query, regex, max, contextChars }))
  )
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
    description: "Click an element identified by 'ref' (e.g. '@e1', 'ref_5'), 'index', CSS 'selector', or visible 'text'. Automatically waits for DOM mutations to settle.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector (e.g. '#submit-btn')"),
      text: z.string().optional().describe("Match interactive element by visible text (e.g. 'Sign In')"),
      waitFor: z.string().optional().describe("CSS selector to wait for after click (e.g. modal or textarea to appear)"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle after click (default true)"),
      settleMs: z.number().int().optional().describe("Settle timeout in ms (default 150)"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined || v.selector !== undefined || v.text !== undefined, {
      message: "Provide at least one of 'ref', 'index', 'selector', or 'text'.",
    }),
  },
  tool("click", async ({ index, ref, selector, text: t, waitFor, autoSettle, settleMs }) =>
    text(await callBridge("click", { index, ref, selector, text: t, waitFor, autoSettle, settleMs }))
  )
);

server.registerTool(
  "browser_type",
  {
    title: "Type / Fill text into element",
    description:
      "Instantly focus an element (by 'ref', 'index', 'selector', or 'placeholder') and set its text via native prototype setters (compatible with React/Vue v-model and rich-text contenteditable editors like ProseMirror/Tiptap), NOT slow keystroke simulation. Set submit=true to press Enter afterward.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector (e.g. 'input.username')"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
      text: z.string().describe("Text to enter"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      waitFor: z.string().optional().describe("CSS selector to wait for after typing"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle after typing (default true)"),
      settleMs: z.number().int().optional().describe("Settle timeout in ms (default 100)"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined || v.selector !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'ref', 'index', 'selector', or 'placeholder'.",
    }),
  },
  tool("type", async ({ index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }) =>
    text(await callBridge("type", { index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }))
  )
);

server.registerTool(
  "browser_fill",
  {
    title: "Fill text into input or rich-text editor",
    description:
      "High-level fill primitive: clears existing value and sets text instantly via native prototype setters and bubbling events. Fully compatible with Vue/React v-model and rich-text ProseMirror/Tiptap contenteditable editors.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector (e.g. 'textarea.comment-box')"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
      text: z.string().describe("Text to enter"),
      submit: z.boolean().optional().describe("Press Enter after filling"),
      waitFor: z.string().optional().describe("CSS selector to wait for after filling"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle (default true)"),
      settleMs: z.number().int().optional().describe("Settle timeout in ms (default 100)"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined || v.selector !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'ref', 'index', 'selector', or 'placeholder'.",
    }),
  },
  tool("fill", async ({ index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }) =>
    text(await callBridge("fill", { index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }))
  )
);

server.registerTool(
  "browser_paste",
  {
    title: "Paste text / Markdown into element",
    description:
      "Paste text or multi-line Markdown into a target element or rich-text editor (Tiptap/ProseMirror/Quill) by simulating native Clipboard events. Ideal for inserting large payloads without keystroke lag or breaking editor AST.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
      text: z.string().describe("Text or Markdown content to paste"),
      submit: z.boolean().optional().describe("Press Enter after pasting"),
      waitFor: z.string().optional().describe("CSS selector to wait for after pasting"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle (default true)"),
      settleMs: z.number().int().optional().describe("Settle timeout in ms (default 150)"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined || v.selector !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'ref', 'index', 'selector', or 'placeholder'.",
    }),
  },
  tool("paste", async ({ index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }) =>
    text(await callBridge("paste", { index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }))
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
    if (!m) throw new Error(`screenshot returned an unrecognized data URL (expected data:image/png|jpeg;base64,...)`);
    return { content: [{ type: "image", data: m[2], mimeType: `image/${m[1]}` }] };
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
  "browser_open_and_read",
  {
    title: "Open (or reuse) a tab and read it in one call",
    description:
      "Composite convenience: open a URL in a new tab (or navigate/reuse an existing one via tabId), wait for it to load, then read its content — replacing the browser_new_tab + browser_wait_network_idle/browser_wait_settle + browser_get_page_content/browser_snapshot sequence with a single call. On a wait timeout this does NOT error: it returns whatever content exists with waited.settled=false, since the page is usually still readable. Always returns the tabId so you can keep driving that tab (e.g. with further tabId-scoped calls) for background/concurrent multi-tab work.",
    inputSchema: {
      url: z.string().optional().describe("URL to open. Omit to just wait+read an existing tab (requires tabId)."),
      tabId: z.number().int().optional().describe("Reuse this specific tab (from browser_list_tabs) instead of opening a new one. If url is also given, navigates this tab to url first."),
      wait: z.enum(["network-idle", "settle", "none"]).optional().describe("Default 'network-idle'."),
      timeoutMs: z.number().int().optional().describe("Wait timeout in ms, default 15000."),
      read: z.enum(["text", "snapshot", "both"]).optional().describe("Default 'text' (browser_get_page_content). 'snapshot' returns interactive elements instead. 'both' returns both."),
      maxChars: z.number().int().optional().describe("Max chars for text content, default 8000; also caps snapshot's page-text field."),
    },
  },
  tool("open_and_read", async ({ url, tabId, wait = "network-idle", timeoutMs = 15000, read = "text", maxChars = 8000 }) => {
    if (!url && tabId == null) throw new Error("open_and_read requires 'url' and/or 'tabId'");

    let targetTabId = tabId;
    if (targetTabId == null) {
      const opened = await callBridge("new_tab", { url });
      targetTabId = opened.id;
    } else if (url) {
      await callBridge("navigate", { url, tabId: targetTabId });
    }

    const waitStart = Date.now();
    let settled = true;
    if (wait === "network-idle") {
      try { await callBridge("wait_network_idle", { tabId: targetTabId, timeoutMs }); }
      catch { settled = false; }
    } else if (wait === "settle") {
      try { await callBridge("wait_settle", { tabId: targetTabId, timeoutMs }); }
      catch { settled = false; }
    }
    const elapsedMs = Date.now() - waitStart;

    const out = { tabId: targetTabId, waited: { settled, elapsedMs } };

    // Check for a PDF BEFORE attempting a DOM-dependent read: get_page_content/snapshot
    // both fast-fail on a PDF tab (Chrome's built-in viewer isn't a real DOM), which
    // would otherwise throw here and discard the tabId this call just opened — losing
    // exactly the info (confirmed PDF + its URL) the caller needs to recover. PDFs are a
    // real, confirmed case (bank rate sheets), not a hypothetical.
    const pdfCheck = await callBridge("read_pdf", { tabId: targetTabId });
    if (pdfCheck.isPdf) {
      out.isPdf = true;
      out.url = pdfCheck.url;
      out.note = pdfCheck.note;
      return text(out);
    }

    if (read === "text" || read === "both") {
      const content = await callBridge("get_page_content", { tabId: targetTabId, maxChars });
      out.title = content.title;
      out.url = content.url;
      out.text = content.text;
    }
    if (read === "snapshot" || read === "both") {
      const snap = await callBridge("snapshot", { tabId: targetTabId, maxText: maxChars });
      out.snapshot = snap;
      if (out.title == null) { out.title = snap.title; out.url = snap.url; }
    }
    return text(out);
  })
);

server.registerTool(
  "browser_group_tab",
  {
    title: "Group a tab (visual marker)",
    description:
      "Put a tab into a labeled, colored tab group so you (and the user) can see which tab the agent drives. Defaults to the target tab; pass id to group a specific tab. Does NOT activate the tab (no focus steal) and pins the grouped tab as the target.",
    inputSchema: {
      id: z.number().int().optional().describe("Tab id to group (default: target tab)"),
      title: z.string().optional().describe("Group label, default 'bctl'"),
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
    description: "Make the tab with the given id active and the target for subsequent commands. Activates the tab within its window but does NOT raise the window (no focus steal) unless focus=true. Prefer browser_navigate/browser_new_tab to work a new page; use this (especially focus=true) only when the user asks to bring a tab forward.",
    inputSchema: {
      id: z.number().int().describe("Tab id from browser_list_tabs"),
      focus: z.boolean().optional().describe("Also raise the window to the foreground (steals the user's focus). Default false."),
    },
  },
  tool("switch_tab", async ({ id, focus }) => text(await callBridge("switch_tab", { id, focus })))
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
      "Attach the debugger to the target tab to start capturing console logs and network traffic. Shows an 'is being debugged' bar in the browser. Call this before get_console_logs / get_network_requests / export_har.",
    inputSchema: {},
  },
  tool("cdp_attach", async () => text(await callBridge("cdp_attach")))
);

server.registerTool(
  "browser_cdp_detach",
  {
    title: "Detach debugger",
    description: "Detach the debugger from the target tab and stop capturing. Removes the debugging bar.",
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
      "Export captured network traffic as a HAR 1.2 object (headers, status, timing). Headers are included verbatim (local tool, no redaction). Set bodies=true to also include response bodies (best-effort, slower). Requires browser_cdp_attach.",
    inputSchema: { bodies: z.boolean().optional().describe("Include response bodies") },
  },
  tool("export_har", async ({ bodies }) => text(await callBridge("export_har", { bodies })))
);

server.registerTool(
  "browser_eval_js",
  {
    title: "Evaluate JavaScript",
    description:
      "Run a JavaScript expression in the target page and return its value. The value must be JSON-serializable (functions/DOM nodes are dropped, via JSON round-trip). If the debugger is attached it runs via Runtime.evaluate (bypasses page CSP); otherwise in the page MAIN world.",
    inputSchema: {
      expression: z.string().describe("JavaScript expression to evaluate"),
      format: z.enum(["smart", "json", "pretty", "raw"]).optional().describe("Output formatting: 'smart' (default), 'json', 'pretty', or 'raw'"),
    },
  },
  tool("eval_js", async ({ expression, format }) => text(await callBridge("eval_js", { expression }), format))
);

server.registerTool(
  "browser_spoof_visibility",
  {
    title: "Spoof page visibility (unblock background lazy-load)",
    description:
      "Make the target tab's page JS believe it's visible/focused (document.hidden=false, document.visibilityState='visible', fires a visibilitychange event), WITHOUT actually foregrounding the tab or stealing the user's focus. Use this when scrolling a backgrounded tab isn't loading new content — many sites (e.g. infinite-scroll feeds) deliberately pause lazy-loading via the Page Visibility API while a tab is hidden, as a resource-saving pattern. This is explicit and opt-in on purpose: call it once before scrolling a background tab that needs to lazy-load, not automatically on every scroll — visibility state is also used for other things a site might not want spoofed unconditionally (video autoplay, polling/websocket resume, analytics time-on-page). Attaches the CDP debugger if not already attached (shows the 'is being debugged' bar). KNOWN LIMITATION: this patches JS-visible state only — it does not lift Chrome's renderer-level throttling of a backgrounded tab (requestAnimationFrame doesn't fire, IntersectionObserver rides the same throttled pipeline). If a site's lazy-load is driven by rAF/IO rather than a visibilitychange or scroll listener, this may not help; there is no further automatic fallback (foregrounding the tab, even briefly, is a deliberate manual decision this tool will never make for you).",
    inputSchema: {},
  },
  tool("spoof_visibility", async () => text(await callBridge("spoof_visibility")))
);

// --- More DOM interaction (content script) ---

server.registerTool(
  "browser_hover",
  {
    title: "Hover element",
    description: "Hover the pointer over an element identified by 'ref' (from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5')"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined, {
      message: "Provide at least one of 'ref' or 'index'.",
    }),
  },
  tool("hover", async ({ index, ref }) => text(await callBridge("hover", { index, ref })))
);

server.registerTool(
  "browser_select_option",
  {
    title: "Select dropdown option",
    description: "Select an option in a <select> element (identified by 'ref' or 'index') by value or by visible label.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Index of the <select> element from browser_snapshot"),
      ref: z.string().optional().describe("Stable ref of the <select> element (e.g. 'ref_5')"),
      value: z.string().optional().describe("Option value to select"),
      label: z.string().optional().describe("Visible option text to select"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined, {
      message: "Provide at least one of 'ref' or 'index'.",
    }),
  },
  tool("select_option", async ({ index, ref, value, label }) =>
    text(await callBridge("select_option", { index, ref, value, label }))
  )
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press a key",
    description:
      "Dispatch a keyboard key (e.g. Enter, Escape, ArrowDown) to an element or the focused element. Note: 'Enter' on a form field can submit the form. WITHOUT modifiers this is a synthetic DOM event and works on a background tab. WITH modifiers (e.g. ['Meta','Shift'] for Cmd+A / Cmd+Z) it runs via CDP, which needs browser_cdp_attach first AND the tab in the foreground — Chrome silently drops CDP key input for background tabs, so this errors instead of pretending to succeed. On Mac the CDP path drives real editor commands (Cmd+A/Z/C/V/X). Pass allowSynthetic:true to use the DOM path for a modified key on a background tab: the page's own shortcut handler fires, but native editing does not. The result reports via:'cdp' or via:'dom' so you always know which semantics you got.",
    inputSchema: {
      key: z.string().describe("Key name, e.g. 'Enter', 'Escape', 'ArrowDown', or a letter for shortcuts"),
      index: z.number().int().optional().describe("Target element index from browser_snapshot; defaults to the focused element"),
      ref: z.string().optional().describe("Stable ref of the target element (e.g. 'ref_5'); defaults to the focused element"),
      modifiers: z.array(z.enum(["Meta", "Control", "Alt", "Shift"])).optional().describe("Modifier keys held during the press (Meta = Cmd on Mac)"),
      allowSynthetic: z
        .boolean()
        .optional()
        .describe(
          "With modifiers on a BACKGROUND tab, dispatch a synthetic DOM event instead of erroring. Page shortcut handlers fire; native editing (real Cmd+A selection) does not. Default false."
        ),
    },
  },
  tool("press_key", async ({ key, index, ref, modifiers, allowSynthetic }) =>
    text(await callBridge("press_key", { key, index, ref, modifiers, allowSynthetic }))
  )
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

server.registerTool(
  "browser_read_pdf",
  {
    title: "Read a PDF tab",
    description:
      "Call this when the target tab is showing a PDF (browser_get_page_content/browser_find_text/browser_snapshot/browser_click all fail on a PDF tab with 'no readable DOM' — Chrome's built-in PDF viewer isn't a real DOM, so those tools cannot see its text). Returns the tab's URL and an isPdf verdict; this extension does NOT extract PDF text itself (a hand-rolled parser silently mis-reads subset/CID-font PDFs — dangerous for numeric data like a rate sheet). Fetch the returned URL yourself and read it with your own PDF-reading capability instead of retrying the DOM-based tools.",
    inputSchema: {},
  },
  tool("read_pdf", async () => text(await callBridge("read_pdf")))
);

// --- Navigation history & windows ---

server.registerTool(
  "browser_go_back",
  { title: "Go back", description: "Navigate back in the target tab's history.", inputSchema: {} },
  tool("go_back", async () => text(await callBridge("go_back")))
);

server.registerTool(
  "browser_go_forward",
  { title: "Go forward", description: "Navigate forward in the target tab's history.", inputSchema: {} },
  tool("go_forward", async () => text(await callBridge("go_forward")))
);

server.registerTool(
  "browser_reload",
  {
    title: "Reload",
    description: "Reload the target tab. Set bypassCache=true for a hard reload.",
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
    description: "Bring the window with the given id to the foreground. Steals the user's OS focus — use only when the user explicitly asks to surface a window, not as part of background work.",
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
      "Start capturing network requests for the target tab via webRequest. No debugger banner, but no response bodies. Clears the previous buffer.",
    inputSchema: {},
  },
  tool("net_start", async () => text(await callBridge("net_start")))
);

server.registerTool(
  "browser_net_stop",
  { title: "Stop network capture (light)", description: "Stop the webRequest capture for the target tab.", inputSchema: {} },
  tool("net_stop", async () => text(await callBridge("net_stop")))
);

server.registerTool(
  "browser_net_get",
  {
    title: "Get captured network (light)",
    description:
      "Return network requests captured by the light webRequest capture (method, url, type, status, timing). Headers are included verbatim (local tool, no redaction).",
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
  { title: "Clear network capture (light)", description: "Clear the light network capture buffer for the target tab.", inputSchema: {} },
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
      "Capture the entire page (beyond the viewport) as an image. JPEG by default (quality 55, smaller); pass format='png' for a lossless image (e.g. pixel-diff QA). Requires browser_cdp_attach (uses the debugger).",
    inputSchema: {
      format: z.enum(["png", "jpeg"]).optional().describe("Image format, default jpeg"),
      quality: z.number().int().optional().describe("JPEG quality 1-100, default 55 (jpeg only)"),
    },
  },
  tool("capture_screenshot", async ({ format, quality }) => {
    const { dataUrl } = await callBridge("capture_screenshot", { fullPage: true, format, quality });
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    if (!m) throw new Error(`capture_screenshot returned an unrecognized data URL (expected data:image/png|jpeg;base64,...)`);
    return { content: [{ type: "image", data: m[2], mimeType: `image/${m[1]}` }] };
  })
);

// --- Coordinate input, accessibility, capture, audit (CDP; require attach) ---

server.registerTool(
  "browser_coordinate_click",
  {
    title: "Click at coordinates",
    description: "Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click / browser_click_selector (ref or selector) instead.",
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
    description: "Press at (fromX,fromY), move to (toX,toY), release. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click / browser_click_selector (ref or selector) instead.",
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
    description: "Capture just one element as an image, identified by 'ref' (from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref. Requires browser_cdp_attach.",
    inputSchema: {
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5')"),
      format: z.enum(["png", "jpeg"]).optional(),
    },
  },
  tool("element_screenshot", async ({ index, ref, format }) => {
    const { dataUrl } = await callBridge("element_screenshot", { index, ref, format });
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    if (!m) throw new Error(`element_screenshot returned an unrecognized data URL (expected data:image/png|jpeg;base64,...)`);
    return { content: [{ type: "image", data: m[2], mimeType: `image/${m[1]}` }] };
  })
);

server.registerTool(
  "browser_describe_element",
  {
    title: "Describe one element",
    description:
      "Given a ref (from browser_snapshot/browser_read_page/browser_find/browser_find_text) or an index (from the latest browser_snapshot), return everything useful for debugging it: tag, full attribute dump, bounding rect, a visibility verdict WITH the specific reason it failed if not visible ('zero-size rect' | 'visibility:hidden' | 'display:none' | 'opacity:0' | 'disabled' | 'visible'), and whether it matches the interactive-element selector browser_find/browser_snapshot use. Use this to understand why a click/type failed, why an element didn't show up in browser_snapshot, or to inspect an element browser_find_text pointed at via nearestInteractive. Does not return full computed style (hundreds of mostly-noise properties) — just the fields that explain real failures.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5')"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined, {
      message: "Provide at least one of 'ref' or 'index'.",
    }),
  },
  tool("describe_element", async ({ index, ref }) => text(await callBridge("describe_element", { index, ref })))
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
    description: "Return browser cookies, optionally filtered to cookies whose domain contains this substring. Requires browser_cdp_attach.",
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
    description: "Start recording user interactions (clicks, field changes) in the target tab. Replay later with browser_replay.",
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
    description: "Replay recorded steps (or supplied steps) against the target tab. Optionally navigate to startUrl first.",
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
    description: "Wait until the target tab has had no in-flight requests for idleMs (default 500), up to timeoutMs (default 10000). Reduces flaky waits.",
    inputSchema: { idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional() },
  },
  tool("wait_network_idle", async ({ idleMs, timeoutMs }) =>
    text(await callBridge("wait_network_idle", { idleMs, timeoutMs }))
  )
);

server.registerTool(
  "browser_start",
  {
    title: "Start bridge daemon",
    description: "Start the local browserctl bridge server daemon in the background if stopped.",
    inputSchema: {},
  },
  async () => {
    const running = await isBridgeRunning();
    if (running) return text({ ok: true, message: "Bridge is already running", url: BRIDGE_URL });
    const started = await startBridgeDaemon();
    return text({ ok: started, message: started ? "Bridge started" : "Failed to start bridge daemon", url: BRIDGE_URL });
  }
);

server.registerTool(
  "browser_stop",
  {
    title: "Stop bridge daemon",
    description: "Stop the local browserctl bridge server daemon (records explicit stopped state).",
    inputSchema: {},
  },
  async () => {
    markDaemonStopped({ stoppedBy: "mcp_stop" });
    return text({ ok: true, message: "Bridge daemon stopped" });
  }
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
ensureBridge().catch(() => {});
console.error(`browserctl MCP server running (bridge: ${BRIDGE_URL})`);
