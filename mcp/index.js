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
      if (!data.ok) {
        const err = new Error(data.error || `command '${action}' failed (HTTP ${res.status})`);
        if (data.code) err.code = data.code;
        if (data.diagnostics) err.diagnostics = data.diagnostics;
        if (data.recoveryHint) err.recoveryHint = data.recoveryHint;
        // The bridge answered; the command itself failed. Retrying would dispatch the
        // action a second time (a click that errors after firing would fire twice), and
        // falling through to the transport error below would relabel a page-level
        // problem as a connectivity problem and discard code/diagnostics/recoveryHint —
        // which is every structured error the extension produces.
        err.isApplicationError = true;
        throw err;
      }
      return data.result;
    } catch (err) {
      if (err?.isApplicationError) throw err;
      lastErr = err;
      if (attempt === 1) {
        await ensureBridge();
      }
    }
  }

  throw new Error(`cannot reach bridge at ${BRIDGE_URL}: ${lastErr?.message || "connection failed"}`);
}

// The extension writes its inline hints in CLI syntax — `get text @ref_4`,
// `snapshot --all`, `find "label"`. The CLI can run those verbatim; an MCP client cannot:
// it has `browser_get_property`, `browser_snapshot({scope:"all"})`, `browser_find`. The
// mapping does exist in this server's INSTRUCTIONS, but an agent reads that once at
// session start and reads the hint inline forty messages later, and the inline one wins.
//
// Measured: a Gmail session drove 28 of its 44 calls through eval_js, hand-rolling reads
// that `browser_get_text` answers exactly (`el.innerText`), with zero calls to get_text,
// get_page_content or find_text and six snapshots that never widened past the viewport.
// The comment above the hint footer in content.js predicted this failure precisely — the
// footer was added to prevent it, and then written in the syntax the reader cannot call.
// That is invariant I3: guidance that reaches one surface but not its twin.
//
// Rewriting here rather than in content.js keeps ONE emitter: the bridge does not know
// whether its caller is the CLI or MCP, but this server does.
const CLI_TO_MCP = [
  // Longest / most specific first: `find text "x"` must not be eaten by `find "x"`.
  [/\bfind text "([^"]*)"/g, 'browser_find({query:"$1",in:"text"})'],
  // `@ref` with no number is the footer's placeholder, not a real ref; keep it a placeholder.
  // The dialog notices told an MCP client to "use 'dismiss'" — a CLI verb, and since the
  // dismiss_modal tool was removed there is no browser_dismiss to guess at either. Name
  // the call that exists.
  [/\b(?:use|with) 'dismiss'/g, 'browser_action({action:"dismiss"})'],
  [/\bget text @ref\b(?!_)/g, 'browser_get_property({ref:"<ref>"})'],
  [/\bget attr @ref\b(?!_) (\S+)/g, 'browser_get_property({ref:"<ref>",property:"attr",attr:"$1"})'],
  [/\bget text @(\w+)/g, 'browser_get_property({ref:"$1"})'],
  [/\bget attr @(\w+) (\S+)/g, 'browser_get_property({ref:"$1",property:"attr",attr:"$2"})'],
  [/\bget count <css>/g, "browser_get_property({selector:\"<css>\",property:\"count\"})"],
  [/\bget count (\S+)/g, 'browser_get_property({selector:"$1",property:"count"})'],
  [/\bfind "([^"]*)"/g, 'browser_find({query:"$1"})'],
  [/'find <text>'/g, "browser_find({query:\"<text>\"})"],
  [/'?\bsnapshot --all'?/g, 'browser_snapshot({scope:"all"})'],
  [/\bscroll down\b/g, 'browser_scroll({direction:"down"})'],
  [/\bclick\/type @ref\b/g, "browser_click / browser_fill by ref"],
];

// Bounded to bracketed hint spans. Page text also flows through here — an element label
// or an email body could contain "snapshot --all" — and rewriting a page's own words
// would be reporting something the page did not say.
function mcpifyHints(s) {
  if (typeof s !== "string" || s.indexOf("[") === -1) return s;
  return s.replace(/\[[^\]]*\]/g, (span) => {
    let out = span;
    for (const [re, to] of CLI_TO_MCP) out = out.replace(re, to);
    return out;
  });
}

function withMcpHints(res) {
  for (const part of res.content || []) {
    if (part.type === "text") part.text = mcpifyHints(part.text);
  }
  return res;
}

function text(obj, format = "smart") {
  // `fullTextVia` is a hint carried as a plain field, so it never reaches the bracketed
  // rewrite below. It is the one an agent follows to read a truncated body.
  if (obj && typeof obj === "object" && typeof obj.fullTextVia === "string") {
    obj = { ...obj, fullTextVia: mcpifyHints("[" + obj.fullTextVia + "]").slice(1, -1) };
  }
  return withMcpHints(textRaw(obj, format));
}

function textRaw(obj, format = "smart") {
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
    const vh = obj.viewport?.height || 0;
    const sy = obj.viewport?.scrollY || 0;
    const sh = obj.viewport?.scrollHeight || vh;
    const total = obj.totalElementsCount ?? obj.elements?.length ?? 0;
    // How many are IN SCOPE, not how many this page of the census happened to list. Once
    // the census became paged these two diverged, and the header went on reporting the
    // page size as the viewport count — three numbers in one response (45 listed, 102 in
    // viewport, 119 on the page) with the wrong one in the most prominent line.
    const visible = obj.window?.inScope ?? (obj.elements?.length || 0);
    const folded = obj.foldedCount ? `, ${obj.foldedCount} folded` : "";

    let header = `Page: ${obj.title || "Untitled"} (${obj.url})\n`;
    if (obj.viewport) {
      header += `Viewport: Y: ${sy}px-${sy + vh}px of ${sh}px total height (${obj.viewport.width}x${vh}, scroll: ${obj.viewport.scrollPercent}%, scope: ${obj.scope || "viewport"})\n`;
    }
    if (obj.pageState?.hasActiveModal) {
      header += `[Active Modal: <${obj.pageState.activeModalTag || "dialog"}>]\n`;
    }
    if (obj.scope === "viewport" && obj.offscreenCount > 0) {
      header += `Elements: ${visible} visible in viewport (${total} total on page${folded})\n`;
      // The compact view already carries a notice that names what is offscreen; a second
      // count-only line above it is duplicated tokens and a second number to reconcile.
      header += "\n";
    } else {
      header += `Interactive elements (${visible}${folded}):\n\n`;
    }
    const hint = inactiveCapabilityHint();
    return { content: [{ type: "text", text: header + obj.compactView + (hint ? "\n" + hint : "") }] };
  }
  // get_property results: keep the terse "just the value" output, but never drop the
  // qualifiers that say how much to trust it — whether an attribute was actually present
  // (an absent one used to render as no output at all), and whether the selector matched
  // more elements than the one answered for.
  if (obj?.property !== undefined && (obj.value !== undefined || obj.present !== undefined)) {
    const lines = [];
    if (obj.property === "attr" && obj.present === false) {
      lines.push(`${obj.name}: (attribute not present)`);
    } else if (obj.property === "attr" && obj.resolved) {
      // Show both: the raw attribute is what the page says, the resolved URL is what it
      // means. Printing only the raw value sent an agent to eval_js to check whether a
      // bare "front" was the whole answer.
      lines.push(`${obj.value}   (resolves to ${obj.resolved})`);
    } else if (obj.value === null) {
      lines.push("(null)");
    } else if (typeof obj.value !== "object") {
      lines.push(String(obj.value));
    } else {
      lines.push(JSON.stringify(obj.value));
    }
    if (obj.note) lines.push(`Note: ${obj.note}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
  if (obj?.value !== undefined && typeof obj.value !== "object") {
    return { content: [{ type: "text", text: String(obj.value) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// One line, only when something is actually unloaded. A small model will not go looking
// for capabilities it cannot see: given no prompt at all it concluded that network
// capture, cookies, HAR, recording and profiling were impossible, while given one
// sentence it found them immediately. The sentence belongs here, not in the user's task.
function inactiveCapabilityHint() {
  const all = Object.values(server._registeredTools || {});
  const inactive = all.filter((t) => t.enabled === false).length;
  if (inactive === 0) return "";
  const profiles = Object.entries(TOOL_CATEGORIES)
    .filter(([name]) => name !== "core")
    .filter(([, list]) => list.some((n) => server._registeredTools?.[n]?.enabled === false))
    .map(([name]) => name);
  if (profiles.length === 0) return "";
  return `[${inactive} more capabilities not loaded — ${profiles.join(", ")}. Load with browser_load_tools before assuming something is impossible.]`;
}

function fail(err) {
  if (err && err.code) {
    const lines = [
      `Error [${err.code}]: ${err.message || err}`,
      err.diagnostics ? `Diagnostics: ${JSON.stringify(err.diagnostics)}` : null,
      err.recoveryHint ? `Suggested Remedy: ${err.recoveryHint}` : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true };
}

// Wrap a handler so bridge errors become MCP tool errors instead of crashing.
// Run the build inside the tabStore context seeded with args.tabId so any callBridge
// it makes routes to that tab (see tabStore/callBridge above). tabId undefined => no
// override => the bridge uses the pinned target, exactly as before.
// Every protocol action reachable through a registered tool. browser_action can dispatch
// any of them by name, but until now it shipped with no way to find out what they are —
// so the escape hatch existed and no agent ever used it.
const KNOWN_ACTIONS = new Set();

function tool(action, build) {
  KNOWN_ACTIONS.add(action);
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

WHAT YOU WANT -> WHAT TO CALL. There is a tool for each of these; reaching for browser_eval_js
instead costs far more tokens and gives you no diagnostics when it goes wrong.
- Open a URL (here, or in a new tab) ................. browser_open_url  (target: current|new|<tabId>, read: text|snapshot)
- See what is on the page, or what I can click ....... browser_snapshot   (TEXT, not an image)
- See the rest of a long census ..................... browser_snapshot({cursor: <next>})  <- it is paged, not cut
- Find a control when I know its label ............... browser_find
- Get a ref for an element I have a CSS selector for . browser_find({selector})  <- one call, no page re-read
- Find a value/price/status sitting in plain text .... browser_find({query, in: "text"})
- Read the page's prose (article, posting, docs) ..... browser_get_page_content
- Read one element's text, value, HTML or box ........ browser_get_property
- Read the SAME field across every match ............. browser_get_property({selector, all: true})
- Read a LIST of rows with several fields each ....... browser_get_property({selector: "<row>", all: true, fields: {...}})
- Read one attribute (href, src, aria-*) ............. browser_get_property({property: "attr", attr: "href"})
- Count matching elements ............................ browser_get_property({property: "count"})
- See the nesting/structure of a form or region ...... browser_read_page  (structure, NOT prose)
- Click something ................................... browser_click
- Put text anywhere, or choose a dropdown option ..... browser_fill  (method: set|type|paste, or option: "...")
- Close a dialog / cookie banner .................... browser_click on its close control, or browser_action({action:"dismiss"})
- Reach more of a long page or list .................. browser_scroll, or browser_snapshot with scope='all'
- Wait for the page to be ready ...................... browser_wait_for({for: "settle"})  (navigation already waits)
- Take a picture (only when the answer is visual) .... browser_screenshot  (fullPage: true for the whole page)
- Send a key or a chord ............................. browser_press_key
- See / switch / close tabs ......................... browser_list_tabs, browser_switch_tab, browser_close_tab
- Reload the page ................................... browser_reload
- Network requests, cookies, storage, console, CDP ... browser_load_tools, then the tool it unlocks
- Anything at all, without loading its tool .......... browser_action({action, params}); call it bare for the catalogue

Every read tool tells you what it did NOT return. If a response mentions offscreen elements, an open
dialog, folded rows or "possible hidden content", your answer is probably incomplete — follow it up
before reporting. Never conclude a capability is missing without checking browser_action's catalogue.

Parameter names are checked, not guessed at: an unknown one is refused with the legal set and a
did-you-mean, so a call that returns a result used the parameters you meant. If you have a CSS
selector and no ref, browser_find({selector}) is the call that turns one into the other — that is
cheaper than a snapshot and far cheaper than writing the read in JavaScript.


- Pinned target: your first command pins the currently focused tab as the target, and it STAYS pinned even after the user switches to other tabs. Every command — DOM (click/type/navigate/read), CDP (debugger/console/network/eval), light network capture, and screenshots — acts on that pinned target, never on whatever tab the user is currently looking at.
- Work in the background. Do NOT switch or foreground a tab in order to act on it: clicks, typing, navigation, reads, and screenshots all work while the target sits in the background. The user must be able to keep working in their own tab (e.g. GitLab) uninterrupted while you work yours (e.g. LinkedIn).
- Call browser_group_tab once near the start so the user can see which tab you drive (a labeled tab group). It does not steal focus.
- To act on a different page, use browser_open_url (target: "new" for a fresh tab) — it re-pins the target. Only use browser_switch_tab / browser_focus_window when the user explicitly asks to bring a tab forward, or when a step genuinely cannot run in the background.
- Screenshots capture the background target without activating it (an "is being debugged" bar may appear on that tab only). Never foreground a tab just to screenshot it.
- Before reading or screenshotting sensitive content, confirm the target with browser_current_tab.
- Driving several tabs at once: every tab-scoped tool accepts an optional tabId (from browser_list_tabs). Pass it to run THAT command against THAT tab without changing the pinned target — so parallel agents can each drive a different tab without racing on the single pin. Omit tabId to use the pinned target.
- Daemon & Zero-Terminal Execution: The local bridge server daemon is automatically started and maintained in the background by this MCP server. You DO NOT need to run a background terminal command, dev server, or long-running process to start or keep the bridge running. If the daemon is ever reported stopped, simply invoke the 'browser_start' tool.
- Full protocol capability & browser_action tool: In default (core) mode, dedicated tools are registered for primary operations. ALL other protocol capabilities (including cdp_send, cdp_attach, get_console_logs, get_network_requests, export_har, get_cookies, set_cookie, delete_cookies, storage_get, storage_set, read_pdf, record_start, record_stop, replay, describe_element, etc.) are 100% available by calling the 'browser_action' tool with { action: "<action_name>", params: { ... } } or via the host CLI 'browserctl <action>'.`;

// Read from package.json rather than restated here: the two drifted the moment 0.6.4 was
// cut, and browser_status then reported a version that had not been running for hours.
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(join(__dirname, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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

// `tab_id` was accepted by exactly three tools (navigate, switch_tab, close_tab) and by
// nothing else, so the surface taught snake_case on four tools and dropped it silently on
// the other 76. Measured cost: an Antigravity session sent `read_page {tab_id}`, the key
// was stripped, the fresh-pin guard fired on a call that had named its tab explicitly, and
// the session fell through to eval_js for the rest of the task. Declared everywhere now,
// and normalised to `tabId` before any handler sees it.
const TAB_ID_ALIAS = z
  .number()
  .int()
  .optional()
  .describe("Alias for tabId (snake_case). Prefer tabId.");

// Tools that manage tabs/windows or the extension itself are NOT tab-scoped: they take
// their own id (or none), so tabId does not apply and must not be injected.
const NO_TAB_TOOLS = new Set([
  "browser_list_tabs", "browser_group_tab", "browser_ungroup_tab",
  "browser_switch_tab", "browser_close_tab", "browser_list_windows", "browser_focus_window",
  "browser_reload_extension", "browser_record_get",
  // Reports bridge/extension health and daemon control; deliberately never touches a tab
  "browser_status",
  "browser_start",
  "browser_stop",
  // Runs system shell command on bridge host; doesn't touch browser tabs.
  "browser_exec_system_cmd",
  // Manages its own tab identity through 'target' (current | new | <tab id>). Injecting
  // the generic per-command tabId here would give one tool two parameters meaning "which
  // tab", which is the ambiguity this surface spent three releases removing.
  "browser_open_url",
]);

// Auto-add tabId to every tab-scoped tool's inputSchema in one place, instead of
// duplicating the field across ~45 tool definitions. Handles the two schema shapes used
// below: a raw shape (plain object of zod fields) and a zod object (incl. one wrapped by
// .refine()). Builds don't change — tool()/callBridge pick tabId up from the context.
function withTabId(schema) {
  // zod object (incl. one carrying a .refine() check, e.g. browser_click): .extend
  // adds the field and preserves the refinement (verified on zod 4).
  if (schema instanceof z.ZodObject) return schema.extend({ tabId: TAB_ID_FIELD, tab_id: TAB_ID_ALIAS });
  if (schema instanceof z.ZodType) return schema; // some other zod shape — leave it
  return { ...schema, tabId: TAB_ID_FIELD, tab_id: TAB_ID_ALIAS }; // raw shape, incl. {}
}

// Tool Profiles & Categories for Dynamic Loading/Unloading
const MCP_PROFILE = envStr("BROWSERCTL_MCP_PROFILE", "core").toLowerCase();

const TOOL_CATEGORIES = {
  core: [
    "browser_status",
    "browser_start",
    "browser_stop",
    "browser_snapshot",
    "browser_read_page",
    "browser_find",
    "browser_click",
    "browser_fill",
    "browser_scroll",
    "browser_press_key",
    "browser_wait_for",
    "browser_get_page_content",
    "browser_get_property",
    "browser_screenshot",
    "browser_list_tabs",
    "browser_open_url",
    "browser_switch_tab",
    "browser_close_tab",
    "browser_reload",
    "browser_eval_js",
    "browser_action",
    "browser_load_tools",
    "browser_list_available_tools",
  ],
  // Runs a shell command on the bridge host. Not a browser verb, never used by an agent in
  // the measured window, and the one tool in the old core with real blast radius — so it is
  // now something you have to ask for by name.
  system: ["browser_exec_system_cmd"],
  network: [
    "browser_get_network_requests",
    "browser_get_response_body",
    "browser_export_har",
    "browser_net_start",
    "browser_net_stop",
    "browser_net_get",
    "browser_net_clear",
    "browser_wait_network_idle",
  ],
  cdp: [
    "browser_cdp_attach",
    "browser_cdp_detach",
    "browser_cdp_send",
    "browser_coordinate_click",
    "browser_coordinate_drag",
    "browser_insert_text",
    "browser_audit",
  ],
  cookies: [
    "browser_get_cookies",
    "browser_set_cookie",
    "browser_delete_cookies",
  ],
  storage: [
    "browser_storage_get",
    "browser_storage_set",
    "browser_storage_remove",
    "browser_storage_clear",
  ],
  console: [
    "browser_get_console_logs",
  ],
  record: [
    "browser_record_start",
    "browser_record_stop",
    "browser_record_get",
    "browser_replay",
  ],
  tabs: [
    "browser_list_windows",
    "browser_focus_window",
    "browser_group_tab",
    "browser_ungroup_tab",
    "browser_spoof_visibility",
    "browser_current_tab",
  ],
  advanced: [
    // Demoted from core in 0.6.4: measured zero calls across 43 agent sessions, and each
    // has a cheaper neighbour that agents do reach for (hover -> click, unload -> just
    // leave the profile loaded). Still one browser_load_tools call away.
    "browser_hover",
    "browser_unload_tools",
    "browser_describe_element",
    "browser_a11y_snapshot",
    "browser_read_pdf",
    "browser_element_screenshot",
    "browser_print_pdf",
    "browser_go_back",
    "browser_go_forward",
    "browser_reload_extension",
  ],
};

const CORE_TOOLS = new Set(TOOL_CATEGORIES.core);

// A flat list of 35 tools gives a model no way to ask "which of these reads a page?" —
// it has to infer the grouping from 35 prose blocks every turn. Three consecutive probe
// runs picked `read_page` over `snapshot` despite `snapshot` being registered first and
// described as the primary reader, because nothing said the two are alternatives in one
// group, and "snapshot" reads as "screenshot" to anything trained on browser tooling.
//
// Each description is prefixed with its group and, where a group has a default, which
// member to reach for first. This is the cheapest possible disambiguation: no new tools,
// no renames, one line the model sees before the prose.
const TOOL_GROUPS = {
  READ: [
    "browser_snapshot", "browser_read_page", "browser_find",
    "browser_get_property", "browser_get_page_content", "browser_screenshot",
  ],
  ACT: ["browser_click", "browser_fill", "browser_hover", "browser_press_key", "browser_scroll"],
  NAVIGATE: ["browser_open_url", "browser_reload", "browser_switch_tab", "browser_close_tab", "browser_list_tabs"],
  WAIT: ["browser_wait_for"],
  CAPABILITY: ["browser_load_tools", "browser_unload_tools", "browser_list_available_tools", "browser_action"],
  SESSION: ["browser_status", "browser_start", "browser_stop", "browser_exec_system_cmd"],
};
const GROUP_OF = new Map();
for (const [g, names] of Object.entries(TOOL_GROUPS)) for (const n of names) GROUP_OF.set(n, g);

// Said once per group, on every member, so the choice never depends on having read the
// sibling's description.
const GROUP_NOTE = {
  READ: "READ group (snapshot, read_page, find, find_text, get_text, screenshot). DEFAULT: browser_snapshot — it is a text census of the page's controls, not an image, and it is the only reader that reports open dialogs, what it left out, and content that loads on demand.",
  ACT: "ACT group. Every action returns an 'effect' block (DOM mutations, url change) — check it rather than assuming the page reacted.",
  NAVIGATE: "NAVIGATE group. These pin the target tab; they wait for the page to be usable before returning.",
  WAIT: "WAIT group. Prefer a READ tool where you can: snapshot/find report what is actually on the page instead of asking you to guess a string.",
  CAPABILITY: "CAPABILITY group. 45 further capabilities (network, cookies, storage, console, CDP, HAR) are one browser_load_tools call away.",
  SESSION: "SESSION group. The bridge daemon starts and maintains itself — you should almost never call these. Do NOT call browser_stop to 'clean up' at the end of a task: the daemon is shared with the user and with other agents, and stopping it interrupts their work.",
};

// Parameter names an agent invents, and what they meant. Measured, not guessed: every
// failure observed in the 2026-09-07..09 window was parameter-level, and two of the four
// were swallowed in silence — `read_page {format:"markdown"}` returned an accessibility
// tree and reported success, so the agent concluded the reader was broken and hand-rolled
// the read in eval_js. Unknown keys are now refused with the legal set and a redirect.
const PARAM_ALIASES = {
  browser_read_page: { ref: "ref_id", refId: "ref_id" },
  browser_find: { text: "query" },
};

// Wrong-tool tells: a parameter that is legal somewhere else and names the tool that has it.
const PARAM_REDIRECTS = {
  browser_read_page: {
    format:
      "browser_read_page always returns the accessibility tree (structure). For the page's readable prose call browser_get_page_content; for one region's text call browser_get_property.",
  },
  browser_get_page_content: {
    format: "browser_get_page_content returns cleaned prose text; there is no format to choose. Use maxChars to cap it.",
  },
  browser_snapshot: {
    mode: "browser_snapshot has no 'mode'. Use scope='viewport'|'all' for how much of the page, compact for how terse.",
  },
  browser_open_url: {
    tabId: "browser_open_url names the tab with 'target': target=<tab id> navigates that tab, target='new' opens one, target='current' (default) uses the pinned tab and opens a new one if nothing is pinned.",
    tab_id: "browser_open_url names the tab with 'target': target=<tab id> navigates that tab, target='new' opens one, target='current' (default) uses the pinned tab and opens a new one if nothing is pinned.",
  },
};

function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function nearestParam(key, declared) {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  let best = null, bestD = Infinity;
  for (const d of declared) {
    const dd = editDistance(k, d.toLowerCase().replace(/[_-]/g, ""));
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return bestD <= Math.max(2, Math.floor(k.length / 3)) ? best : null;
}

// Declared parameter names per tool, filled in as each tool registers.
const DECLARED_PARAMS = new Map();

function declaredKeysOf(schema) {
  if (!schema) return null;
  if (schema instanceof z.ZodObject) return new Set(Object.keys(schema.shape || {}));
  if (schema instanceof z.ZodType) return null; // shape not introspectable — skip the check
  return new Set(Object.keys(schema));
}

// zod strips unknown keys by default, which is exactly the silent failure above. Loose
// objects let them through to the wrapper, which refuses them with a message that names
// the legal set. Refinements survive .loose() (verified on zod 4.4).
function looseSchema(schema) {
  if (schema instanceof z.ZodObject) return schema.loose();
  if (schema instanceof z.ZodType) return schema;
  return z.object(schema).loose();
}

function normalizeParams(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const declared = DECLARED_PARAMS.get(name);
  if (!declared) return args;
  const aliases = PARAM_ALIASES[name] || {};
  const out = {};
  // Declared names first, so an explicit `tabId` always beats an aliased `tab_id`.
  for (const [k, v] of Object.entries(args)) if (declared.has(k)) out[k] = v;
  const unknown = [];
  for (const [k, v] of Object.entries(args)) {
    if (declared.has(k)) continue;
    const target = aliases[k];
    if (target && declared.has(target)) {
      if (out[target] === undefined) out[target] = v;
      continue;
    }
    unknown.push(k);
  }
  if (out.tab_id !== undefined) {
    if (out.tabId === undefined) out.tabId = out.tab_id;
    delete out.tab_id;
  }
  if (unknown.length) {
    const lines = unknown.map((k) => {
      const redirect = PARAM_REDIRECTS[name]?.[k];
      if (redirect) return `unknown param '${k}' on ${name} — ${redirect}`;
      const near = nearestParam(k, declared);
      return `unknown param '${k}' on ${name}${near ? ` — did you mean '${near}'?` : ""}`;
    });
    lines.push(`valid params: ${[...declared].filter((k) => k !== "tab_id").sort().join(", ") || "(none)"}`);
    throw new Error(lines.join("\n"));
  }
  return out;
}

const _registerTool = server.registerTool.bind(server);
server.registerTool = (name, config, handler) => {
  if (!NO_TAB_TOOLS.has(name) && config && "inputSchema" in config) {
    config = { ...config, inputSchema: withTabId(config.inputSchema) };
  }
  const group = GROUP_OF.get(name);
  if (group && config && config.description) {
    config = { ...config, description: `[${group}] ${GROUP_NOTE[group]}\n\n${config.description}` };
  }
  if (config && "inputSchema" in config) {
    const declared = declaredKeysOf(config.inputSchema);
    if (declared) DECLARED_PARAMS.set(name, declared);
    config = { ...config, inputSchema: looseSchema(config.inputSchema) };
    const inner = handler;
    handler = async (args, extra) => {
      let normalized;
      try {
        normalized = normalizeParams(name, args);
      } catch (err) {
        return fail(err);
      }
      return inner(normalized, extra);
    };
  }
  const reg = _registerTool(name, config, handler);
  // If running in core profile and this is not a core tool, disable initially
  if (MCP_PROFILE !== "all" && MCP_PROFILE !== "full" && !CORE_TOOLS.has(name)) {
    if (server._registeredTools?.[name]) {
      server._registeredTools[name].enabled = false;
    }
  }
  return reg;
};

server.registerTool(
  "browser_load_tools",
  {
    title: "Dynamically load tools into session",
    description:
      "Unlock capabilities that are NOT currently loaded. The tools you can see are a subset; these profiles exist and are one call away:\n" +
      "  network  — capture every request the page makes, read response bodies, export a HAR, wait for network idle\n" +
      "  cookies  — read, set and delete cookies\n" +
      "  storage  — read and write localStorage / sessionStorage\n" +
      "  console  — read the page's console messages and errors\n" +
      "  cdp      — Chrome DevTools Protocol: raw CDP commands, coordinate clicks/drags, IME-safe text insert, Lighthouse audit\n" +
      "  record   — record an interaction sequence and replay it\n" +
      "  tabs     — window management, tab groups, visibility spoofing\n" +
      "  advanced — accessibility-tree snapshot, PDF read/print, back/forward/reload, element screenshots, hover\n" +
      "  system   — run a shell command on the machine hosting the bridge (not the page)\n" +
      "  all      — everything at once\n" +
      "If a task seems to need something you have no tool for (network traffic, cookies, storage, console output, raw CDP), load the profile instead of falling back to eval_js.",
    inputSchema: {
      profile: z
        .enum(["network", "cdp", "cookies", "storage", "console", "record", "tabs", "advanced", "system", "all"])
        .optional()
        .describe("Category of tools to load"),
      tools: z
        .array(z.string())
        .optional()
        .describe("Specific tool names to load (e.g. ['browser_export_har', 'browser_get_cookies'])"),
    },
  },
  async ({ profile, tools } = {}) => {
    const toEnable = new Set();
    if (profile === "all") {
      for (const list of Object.values(TOOL_CATEGORIES)) {
        for (const t of list) toEnable.add(t);
      }
      for (const t of Object.keys(server._registeredTools || {})) {
        toEnable.add(t);
      }
    } else if (profile && TOOL_CATEGORIES[profile]) {
      for (const t of TOOL_CATEGORIES[profile]) toEnable.add(t);
    }
    if (Array.isArray(tools)) {
      for (const t of tools) toEnable.add(t);
    }

    const enabledList = [];
    for (const name of toEnable) {
      const entry = server._registeredTools?.[name];
      if (entry) {
        entry.enabled = true;
        enabledList.push(name);
      }
    }

    try {
      await server.sendToolListChanged();
    } catch {}

    const totalActive = Object.values(server._registeredTools || {}).filter((t) => t.enabled !== false).length;
    return text({
      ok: true,
      message: `Loaded ${enabledList.length} tools into active session.`,
      loadedProfile: profile || null,
      loadedTools: enabledList,
      totalActiveTools: totalActive,
    });
  }
);

server.registerTool(
  "browser_unload_tools",
  {
    title: "Dynamically unload tools from session",
    description:
      "Unload specific tool categories or reset active tools back to the lightweight 'core' profile. Frees system prompt tokens when specialized tools are no longer needed.",
    inputSchema: {
      profile: z
        .enum(["network", "cdp", "cookies", "storage", "console", "record", "tabs", "advanced", "system", "all"])
        .optional()
        .describe("Category of tools to unload. If omitted or 'all', resets back to the base 'core' profile."),
      tools: z
        .array(z.string())
        .optional()
        .describe("Specific tool names to unload"),
    },
  },
  async ({ profile, tools } = {}) => {
    const toDisable = new Set();
    if (!profile && !tools) {
      // Reset to core profile: disable everything not in CORE_TOOLS
      for (const [name, entry] of Object.entries(server._registeredTools || {})) {
        if (!CORE_TOOLS.has(name)) {
          toDisable.add(name);
        }
      }
    } else if (profile === "all") {
      for (const [name, entry] of Object.entries(server._registeredTools || {})) {
        if (!CORE_TOOLS.has(name)) {
          toDisable.add(name);
        }
      }
    } else if (profile && TOOL_CATEGORIES[profile]) {
      for (const t of TOOL_CATEGORIES[profile]) {
        if (!CORE_TOOLS.has(t)) toDisable.add(t);
      }
    }
    if (Array.isArray(tools)) {
      for (const t of tools) {
        if (!CORE_TOOLS.has(t)) toDisable.add(t);
      }
    }

    const disabledList = [];
    for (const name of toDisable) {
      const entry = server._registeredTools?.[name];
      if (entry) {
        entry.enabled = false;
        disabledList.push(name);
      }
    }

    try {
      await server.sendToolListChanged();
    } catch {}

    const totalActive = Object.values(server._registeredTools || {}).filter((t) => t.enabled !== false).length;
    return text({
      ok: true,
      message: `Unloaded ${disabledList.length} tools.`,
      unloadedProfile: profile || (tools ? null : "reset_to_core"),
      unloadedTools: disabledList,
      totalActiveTools: totalActive,
    });
  }
);

server.registerTool(
  "browser_list_available_tools",
  {
    title: "List available tool profiles & catalog",
    description:
      "List all tool categories (profiles) and check which tools are currently active (loaded in prompt) vs inactive (available for dynamic loading).",
    inputSchema: {
      format: z.enum(["smart", "json", "pretty"]).optional().describe("Output format"),
    },
  },
  async ({ format } = {}) => {
    const registered = server._registeredTools || {};
    const categories = {};
    for (const [cat, tools] of Object.entries(TOOL_CATEGORIES)) {
      categories[cat] = tools.map((name) => ({
        tool: name,
        active: registered[name] ? registered[name].enabled !== false : false,
      }));
    }
    const totalRegistered = Object.keys(registered).length;
    const totalActive = Object.values(registered).filter((t) => t.enabled !== false).length;

    const summary = {
      activeProfile: totalActive === totalRegistered ? "all" : "core (or customized)",
      totalActiveTools: totalActive,
      totalRegisteredTools: totalRegistered,
      categories,
    };
    return text(summary, format);
  }
);

// The MCP tool surface and the protocol action surface are not the same list, and an
// agent only ever sees the first one. `browser_get_property` is the tool; `get_text` is NOT a
// protocol action — it is `get_property` with `{property: "text"}`. So an agent that
// discovered browser_action (the documented escape hatch for capabilities with no loaded
// tool) and reached for the read it had just seen got a bare "unknown action: get_text",
// and did what agents do at a dead end: fell back to eval_js and hand-rolled the read.
// Measured on a live audit, six of the most common reads failed this way.
//
// Every tool name now dispatches, whatever layer it belongs to.
const ACTION_ALIASES = {
  get_text: { action: "get_property", params: { property: "text" } },
  get_value: { action: "get_property", params: { property: "value" } },
  get_html: { action: "get_property", params: { property: "html" } },
  get_box: { action: "get_property", params: { property: "box" } },
  get_attribute: { action: "get_property", params: { property: "attr" } },
  get_count: { action: "get_property", params: { property: "count" } },
  screenshot_fullpage: { action: "screenshot", params: { fullPage: true } },
  dismiss_modal: { action: "dismiss", params: {} },
};

// Handled by the MCP server itself, never sent to the bridge. Routing one through
// browser_action used to return "unknown action", which reads like the capability is
// missing rather than like it is simply reachable another way.
const MCP_ONLY_TOOLS = new Set([
  "status", "start", "stop", "load_tools", "unload_tools", "list_available_tools", "action",
]);

server.registerTool(
  "browser_action",
  {
    title: "Universal Browser Action Dispatcher",
    description:
      "Execute any browserctl protocol action by name, with no need to load that action's own MCP tool. Call it with NO arguments to get the catalogue of every available action name. Parameters are the same as the matching browser_<action> tool takes.\n" +
      "This also reaches a few actions that have no dedicated tool at all: 'dismiss' (close the active modal), 'close_modal', 'element_rect', and get_property variants such as {action:'get_property', params:{property:'html', ref:'@ref_1'}}.",
    inputSchema: {
      action: z
        .string()
        .optional()
        .describe("Action name, e.g. 'click', 'navigate', 'export_har', 'get_cookies'. Omit to list every available action."),
      params: z.record(z.string(), z.any()).optional().describe("Parameters for the action as a key-value object"),
    },
  },
  tool("action", async ({ action, params = {} }) => {
    if (!action) {
      // Protocol actions with no MCP tool of their own. KNOWN_ACTIONS is built from tool()
      // registrations, so every tool deleted in 0.7.0 (and the two duplicates dropped in
      // 0.6.4) would otherwise vanish from the catalogue while the bridge still runs them —
      // this list is the only thing that keeps the catalogue honest about what dispatches.
      const extra = [
        "dismiss", "close_modal", "element_rect",
        "clear", "check", "uncheck",
        "type", "paste", "select_option", "wait_settle", "capture_screenshot",
        "click_selector", "fill_selector", "navigate", "new_tab", "find_text", "dismiss_modal",
      ];
      const actions = [...new Set([...KNOWN_ACTIONS, ...extra, ...Object.keys(ACTION_ALIASES)])]
        .filter((a) => a !== "action").sort();
      return text({
        note:
          "Dispatch any of these with browser_action({action, params}). Every name here matches the " +
          "browser_<name> tool and takes the same parameters, so you can go straight from a tool name " +
          "you saw to a call. A few names are conveniences that map onto get_property: " +
          "get_text / get_value / get_html / get_box / get_attribute / get_count.",
        count: actions.length,
        actions,
      });
    }
    const mapped = ACTION_ALIASES[action];
    if (mapped) return text(await callBridge(mapped.action, { ...mapped.params, ...params }));
    if (MCP_ONLY_TOOLS.has(action)) {
      const err = new Error(
        `'${action}' is handled by the MCP server itself, not by the browser — call the tool browser_${action} directly rather than routing it through browser_action.`
      );
      err.code = "MCP_ONLY_TOOL";
      err.recoveryHint = `Call browser_${action}.`;
      throw err;
    }
    return text(await callBridge(action, params));
  })
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
      "NOT an image — despite the name, this returns TEXT. It is the primary tool to inspect ANY page state, UI controls, navigation headers, notifications, badges, form fields, and interactive layout (includes aria-labels, buttons, links, inputs). Returns the TARGET tab's interactive elements (each with an 'index' and a stable 'ref'), the page URL/title, visible text, viewport state, and every open dialog. Elements are listed in reading order. Call this first, then act by ref/index, and re-call after any action that changes the page.\n" +
      "SCOPE: 'viewport' (default) lists only what is on screen; 'all' lists everything currently in the DOM. On a dense SPA the two differ by roughly 10-35% of the census, so 'all' is cheap — prefer it whenever a COUNT or a COMPLETE list is the answer ('how many X', 'list all Y'), because a viewport census can silently omit rows of exactly the kind you were asked for. The response names what it withheld.\n" +
      "'all' means every element IN THE DOM — not everything the page can show. Feeds, notification panels, infinite lists and virtualised tables keep most rows out of the DOM until something is clicked, so no scope setting reveals them; when such content is likely the response carries a 'Possible hidden content' line naming the control to click.\n" +
      "In compact mode key inputs and search boxes are preserved at the top, and dense repetitive runs are folded (their refs still listed) to protect the token budget. Also reported: open dialogs whether or not they block the page, truncated labels with the ref that returns the rest, and suppressed duplicate links.\n" +
      "PAGED, NOT TRUNCATED: a dense page lists 'limit' elements (default 200) and returns 'next' — call snapshot again with cursor: <next> for the rest. Indices and refs stay valid across pages. The cursor is an offset into that call's ordering, so start over rather than continuing if the page has changed since.",
    inputSchema: {
      scope: z.enum(["viewport", "all"]).optional().describe("'viewport' (default) = on-screen elements only. 'all' = every element currently in the DOM (NOT every row the page could load). Use 'all' for counts and complete lists; it typically costs only 3-35% more than viewport."),
      compact: z.boolean().optional().describe("Compact indented view (default true). Passing false returns the same elements as structured JSON — it is not a larger census."),
      format: z.enum(["smart", "compact", "json", "pretty", "raw"]).optional().describe("Output formatting: 'smart' (default, compact tree), 'json', 'pretty', or 'raw'"),
      maxText: z.number().int().optional().describe("Max characters of page body text to include (default 4000)"),
      limit: z.number().int().optional().describe("Max elements to LIST (default 200). The census is paged, not silently cut."),
      cursor: z.number().int().optional().describe("Continue a paged census: pass the 'next' value the previous response returned."),
    },
  },
  tool("snapshot", async ({ scope, compact, format, maxText, limit, cursor }) => {
    const isCompact = (format === "compact" || format === "smart" || format === undefined) ? (compact !== false) : compact;
    const res = await callBridge("snapshot", { scope: scope || "viewport", compact: isCompact, maxText, limit, cursor });
    return text(res, format);
  })
);

server.registerTool(
  "browser_read_page",
  {
    title: "Read page (accessibility tree)",
    description:
      "SPECIALISED reader — reach for browser_snapshot first unless you specifically need NESTING (which control sits inside which group, form or region). Returns the accessibility tree as indented text — roles, accessible names, ARIA state, and a stable 'ref' on each interactive element (e.g. textbox \"Email\" [ref_5]). Unlike snapshot it has a depth limit, and it does NOT report open dialogs, what it left out, or content that loads on demand — so it cannot tell you when your answer is incomplete.\n" +
      "Called bare on a large app it returns the whole page at default depth, which is rarely what you want. Narrow it: pass 'ref_id' to read one subtree (a thread, a panel, a form) and mode='all' to include non-interactive nodes. If what you actually want is that region's TEXT rather than its structure, browser_get_property on the same ref is the shorter answer.\n" +
      "mode='interactive' (default) lists actionable elements and headings; mode='all' includes every element except script/style. Pass ref_id to focus a subtree. 'depth' defaults to 60: a React/Comet SPA nests content 25-45 levels deep, and a walk that stops short returns an almost empty tree — the response now says 'depthClipped' and reports 'deepestReached' when that happens, so an empty result is never mistaken for an empty page.\n" +
      "iframe contents are appended under an 'iframe [f<id>] <url>' header with frame-qualified refs (e.g. f3:ref_5).",
    inputSchema: {
      mode: z.enum(["interactive", "all"]).optional().describe("Default 'interactive'"),
      depth: z.number().int().optional().describe("Max nesting depth (default 60). Deep SPAs need this; raise it further if the response reports depthClipped."),
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
      "Find things on the page. in='controls' (default) searches interactive elements by accessible name / text / placeholder / aria-label / title, e.g. query='Notifications', and each match carries a stable 'ref' to act on. in='text' searches the page's whole TEXT instead — a price, rating or status string sitting in plain prose that the control index cannot see, e.g. query='Total: $50'; those matches carry 'visible' and 'nearestInteractive' ({ref, tag, text}), so a text hit becomes an action in one follow-up call.\n" +
      "in='text' also takes 'regex' (treat the query as a JS regular expression) and 'contextChars' (how much surrounding prose to return, default 80).\n" +
      "Takes a CSS 'selector' instead of 'query' when that is what you have — e.g. selector='div[role=\"textbox\"][contenteditable]' — and returns the same refs. This is the cheap way to get a ref for an element that just appeared (a composer, a dialog field) without re-reading the whole page: pass the ref straight to browser_click or browser_fill.\n" +
      "Each match carries a stable 'ref' to act on, plus 'matchedBy' saying which rung found it — 'interactive' (native control), 'aria' (role/tabindex widget), 'custom-element' (Web Component), or 'text-container' (the text exists but nothing listens for a click on it, so 'clickable' is false and browser_click will refuse the ref). browser_click resolves text through this same ladder, so anything listed here as clickable can be clicked.\n" +
      "SCOPE (in='text'): searches the top frame including open Shadow DOM, but NOT iframes. The response states what was searched in 'searchedScope', so an empty result tells you whether the text is absent or merely out of scope. Each match carries 'visible' (false for screen-reader-only or off-screen text) and 'nearestInteractive' ({ref, tag, text}) — the closest clickable/typeable ancestor. A match spanning 2+ interactive ancestors also carries 'spanInteractives'.\n" +
      "SCOPE (in='controls'): searches the WHOLE PAGE — top frame, open Shadow DOM and iframes — regardless of what is on screen. This differs from browser_snapshot, which defaults to the viewport, so the two can disagree about how many matches exist; find sees more. A sub-frame match carries a frame-qualified ref such as 'f3:ref_5', which must be passed back verbatim.\n" +
      "On zero matches the response carries 'nearest': labels that differ only by diacritics or case, with their refs — so a one-character transcription error costs one call, not four. Long labels are cut at 200 chars and carry 'truncatedBy' plus the get-text call that returns the rest.",
    inputSchema: z.object({
      query: z.string().optional().describe("Text to match, e.g. 'Notifications', 'Search' (case-insensitive substring). Give this OR selector."),
      selector: z.string().optional().describe("CSS selector to match instead of text, e.g. 'div[role=\"textbox\"][contenteditable]'. Pierces open Shadow DOM. Give this OR query. Controls only."),
      in: z
        .enum(["controls", "text"])
        .optional()
        .describe("What to search. 'controls' (default) = interactive elements, returns refs. 'text' = the page's prose, returns snippets with the nearest actionable ancestor."),
      regex: z.boolean().optional().describe("With in='text': treat query as a JS regex pattern instead of a literal substring."),
      contextChars: z.number().int().optional().describe("With in='text': how many characters of surrounding prose to return with each match (default 80). Raise it when the match alone does not say what the value belongs to."),
      max: z.number().int().optional().describe("Max matches (default 20)"),
    }).refine((v) => v.query !== undefined || v.selector !== undefined, {
      message: "find requires 'query' (text/label) or 'selector' (CSS)",
    }).refine((v) => v.in !== "text" || v.query !== undefined, {
      message: "in='text' searches prose, so it needs 'query' — a CSS selector cannot match text.",
    }),
  },
  // find and find_text were the same question ("where is X on this page") answered over two
  // different indexes, and the split cost a call every time an agent guessed the wrong one:
  // find on a price returns nothing, and the response could only say "no control has that
  // label". One tool, one parameter, and a miss on one index can name the other.
  tool("find", async ({ query, selector, in: where, regex, contextChars, max }) =>
    where === "text"
      ? text(await callBridge("find_text", { query, regex, contextChars, max }))
      : text(await callBridge("find", { query, selector, max }))
  )
);



server.registerTool(
  "browser_click",
  {
    title: "Click element",
    description:
      "Click an element identified by 'ref' (e.g. '@ref_5', 'ref_5', '@e1'), 'index', CSS 'selector', or visible 'text'. Resolves across standard buttons/links, ARIA controls (menuitem, option, tab, treeitem, switch), and custom Web Components (tags containing '-'). Automatically waits for DOM mutations to settle.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector (e.g. '#submit-btn')"),
      text: z.string().optional().describe("Match interactive element by visible text (e.g. 'Sign In')"),
      waitFor: z.string().optional().describe("CSS selector to wait for after click (e.g. modal or textarea to appear)"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle after the click, so the 'effect' block can report what changed (default true). Set false only for a click you know is inert; without it there is nothing to distinguish a real action from a no-op."),
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
  "browser_fill",
  {
    title: "Fill text into input or rich-text editor",
    description:
      "The one text-entry verb: put text into ANY editable target — <input>, <textarea>, contenteditable, and rich-text editors (ProseMirror/Tiptap/Quill) — or pick an option in a <select>. Clears the existing value and sets the new one via native prototype setters and bubbling events, so Vue/React v-model see it. If an uneditable element is targeted by mistake, returns candidate editable input refs in the viewport.\n" +
      "method='set' (default) writes the value in one shot. method='type' focuses the field and enters the text keystroke-style. method='paste' simulates native Clipboard events — use it for large or multi-line payloads, and for editors that rebuild their AST on paste.\n" +
      "For a <select>, pass 'option' instead of 'text': it matches an option by value first, then by visible label.\n" +
      "Getting a ref for something that just appeared (a composer, a dialog field) costs one browser_find({selector}) call — you do not need a full page read for it.",
    inputSchema: z.object({
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@e1')"),
      selector: z.string().optional().describe("CSS selector (e.g. 'textarea.comment-box')"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
      text: z.string().optional().describe("Text to enter. Required unless 'option' is given."),
      option: z.string().optional().describe("For a <select>: the option to choose, matched by value then by visible label."),
      method: z
        .enum(["set", "type", "paste"])
        .optional()
        .describe("How to enter the text. Default 'set'. 'paste' for large/multi-line payloads and AST-based editors."),
      submit: z.boolean().optional().describe("Press Enter after filling"),
      waitFor: z.string().optional().describe("CSS selector to wait for after filling"),
      autoSettle: z.boolean().optional().describe("Wait for DOM mutations to settle afterwards, so the 'effect' block can report what changed (default true)."),
      settleMs: z.number().int().optional().describe("Settle timeout in ms (default 100)"),
    }).refine((v) => v.index !== undefined || v.ref !== undefined || v.selector !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'ref', 'index', 'selector', or 'placeholder'.",
    }).refine((v) => v.text !== undefined || v.option !== undefined, {
      message: "Provide 'text' (any editable target) or 'option' (a <select>).",
    }),
  },
  // fill/type/paste/select_option were four tools for one intent, and the measured cost of
  // that split was not confusion between them — it was that agents used none of them: fill
  // ran in 3 of 43 sessions against click's 27. One verb, one 'method'.
  tool("fill", async ({ index, ref, selector, placeholder, text: t, option, method, submit, waitFor, autoSettle, settleMs }) => {
    if (option !== undefined) {
      return text(await callBridge("select_option", { index, ref, selector, option }));
    }
    const action = method === "type" ? "type" : method === "paste" ? "paste" : "fill";
    return text(await callBridge(action, { index, ref, selector, placeholder, text: t, submit, waitFor, autoSettle, settleMs }));
  })
);


server.registerTool(
  "browser_scroll",
  {
    title: "Scroll page or container",
    description:
      "Scroll the page or a specific container (e.g. div with overflow:auto, iframe, table, drawer) up or down. Automatically detects nested scrollable containers if the root window is locked.",
    inputSchema: {
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("Default 'down'"),
      amount: z.number().optional().describe("Pixels to scroll, default 600"),
      ref: z.string().optional().describe("Target scrollable element ref (e.g. '@ref_1', '@f898:ref_54')"),
      selector: z.string().optional().describe("Target scrollable CSS selector"),
      index: z.number().int().optional().describe("Element index from snapshot"),
    },
  },
  tool("scroll", async ({ direction, amount, ref, selector, index }) =>
    text(await callBridge("scroll", { direction, amount, ref, selector, index }))
  )
);


server.registerTool(
  "browser_screenshot",
  {
    title: "Screenshot",
    description:
      "Capture the TARGET tab as an image. Works on a background tab without activating it (so the user can keep using other tabs); attaching the debugger for that shows the 'is being debugged' bar on the target tab. JPEG by default (smaller); pass format='png' for a lossless image (e.g. pixel-diff QA).\n" +
      "Defaults to the visible viewport. Pass fullPage=true for the whole page beyond the viewport (that route goes through the debugger, so it needs browser_cdp_attach).",
    inputSchema: {
      fullPage: z.boolean().optional().describe("Capture the entire page instead of the viewport. Requires browser_cdp_attach."),
      format: z.enum(["png", "jpeg"]).optional().describe("Image format, default jpeg"),
      quality: z.number().int().optional().describe("JPEG quality 1-100, default 55"),
    },
  },
  tool("screenshot", async ({ fullPage, format, quality }) => {
    // Two different capture paths: the extension's captureVisibleTab for the viewport,
    // CDP's Page.captureScreenshot for the whole page. One tool, because "screenshot" is
    // the name an agent reaches for and it should not have to know which engine runs.
    // The full-page path runs through CDP, which needs an explicit attach. As a separate
    // tool that requirement lived in the tool's own description; as a parameter it does
    // not, and a live probe hit a bare "not attached: call cdp_attach first" with nothing
    // saying which tool that is or that the debugger profile has to be loaded first.
    let dataUrl;
    if (fullPage) {
      try {
        ({ dataUrl } = await callBridge("capture_screenshot", { fullPage: true, format, quality }));
      } catch (err) {
        if (/not attached/i.test(err.message || "")) {
          const hinted = new Error(
            `${err.message} — fullPage capture goes through the debugger. Call ` +
            `browser_action({action: "cdp_attach"}) first (or browser_load_tools({profile: "cdp"}) ` +
            `for the tool), then retry. For the viewport alone, drop fullPage: no attach needed.`
          );
          hinted.code = err.code;
          throw hinted;
        }
        throw err;
      }
    } else {
      ({ dataUrl } = await callBridge("screenshot", { format, quality }));
    }
    const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
    if (!m) throw new Error(`screenshot returned an unrecognized data URL (expected data:image/png|jpeg;base64,...)`);
    return { content: [{ type: "image", data: m[2], mimeType: `image/${m[1]}` }] };
  })
);

server.registerTool(
  "browser_open_url",
  {
    title: "Open a URL — here, in a new tab, or in a named tab",
    description:
      "Put a URL somewhere and wait for it to be usable. Returns the tabId it drove, so you can keep driving that tab with tabId-scoped calls.\n" +
      "target='current' (default) navigates the pinned target tab — and if NOTHING is pinned yet it opens a new tab instead of hijacking whatever the user happens to be looking at; the response says which happened. target='new' always opens a new tab. target=<tab id from browser_list_tabs> navigates that specific tab.\n" +
      "read='text' also returns the page's readable prose in the same call, read='snapshot' its interactive elements, read='both' both — replacing the open + wait + read sequence with one round trip. A wait timeout does NOT error: you get whatever content exists with waited.settled=false, because the page is usually still readable.\n" +
      "If the URL turns out to be a PDF this returns isPdf and the URL instead of failing on a DOM read Chrome's PDF viewer cannot serve.",
    inputSchema: {
      url: z.string().describe("URL to open"),
      target: z
        .union([z.enum(["current", "new"]), z.number().int()])
        .optional()
        .describe("'current' (default, opens a new tab if none is pinned), 'new', or a tab id to navigate"),
      wait: z.enum(["network-idle", "settle", "none"]).optional().describe("Default 'network-idle'."),
      timeoutMs: z.number().int().optional().describe("Wait timeout in ms, default 15000."),
      read: z
        .enum(["none", "text", "snapshot", "both"])
        .optional()
        .describe("Read the page in the same call. Default 'none'."),
      maxChars: z.number().int().optional().describe("Max chars for the read, default 8000."),
    },
  },
  // browser_navigate and browser_new_tab were one intent — "put this URL somewhere" — split
  // by destination, and browser_open_and_read was the same intent again with a read bolted
  // on (0 calls in 43 sessions, because nobody finds a third name for a thing they already
  // have two names for). The destination is a parameter now.
  //
  // The default deliberately does NOT navigate whatever tab the user is looking at: with no
  // pinned target, 'current' opens a new tab. Hijacking the focused tab is the one mistake
  // in this tool that the user, not the agent, pays for.
  tool("open_url", async ({ url, target = "current", wait = "network-idle", timeoutMs = 15000, read = "none", maxChars = 8000 }) => {
    let targetTabId = null;
    let opened = null;

    if (typeof target === "number") {
      await callBridge("navigate", { url, tabId: target });
      targetTabId = target;
      opened = "tab " + target;
    } else if (target === "new") {
      targetTabId = (await callBridge("new_tab", { url })).id;
      opened = "new tab";
    } else {
      // list_tabs, not current_tab: current_tab resolves through targetTab(), which PINS
      // the active tab when nothing is pinned — asking the question would answer it, and
      // the answer would be "navigate whatever the user is looking at".
      const tabs = await callBridge("list_tabs", {}).catch(() => null);
      const pinnedId = tabs && tabs.pinned != null ? tabs.pinned : null;
      if (pinnedId != null) {
        await callBridge("navigate", { url, tabId: pinnedId });
        targetTabId = pinnedId;
        opened = "pinned tab";
      } else {
        targetTabId = (await callBridge("new_tab", { url })).id;
        opened = "new tab (nothing was pinned)";
      }
    }

    const waitStart = Date.now();
    let settled = true;
    if (wait === "network-idle") {
      try { await callBridge("wait_network_idle", { tabId: targetTabId, timeoutMs }); } catch { settled = false; }
    } else if (wait === "settle") {
      try { await callBridge("wait_settle", { tabId: targetTabId, timeoutMs }); } catch { settled = false; }
    }
    const out = { tabId: targetTabId, opened, waited: { settled, elapsedMs: Date.now() - waitStart } };

    if (read === "none") return text(out);

    // Probe for a PDF BEFORE any DOM-dependent read: get_page_content/snapshot both
    // fast-fail on a PDF tab, and throwing here would discard the tabId this call just
    // opened — losing exactly what the caller needs to recover.
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
  "browser_list_tabs",
  {
    title: "List tabs",
    description: "List all open tabs with their id, url, title, whether active, and which one is the pinned target ('pinned'). Reads the pin WITHOUT setting it — this is the safe way to ask what you are driving.",
    inputSchema: {},
  },
  tool("list_tabs", async () => text(await callBridge("list_tabs")))
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
    description: "Make the tab with the given id active and the target for subsequent commands. Activates the tab within its window but does NOT raise the window (no focus steal) unless focus=true. Prefer browser_open_url to work a new page; use this (especially focus=true) only when the user asks to bring a tab forward.",
    inputSchema: {
      id: z.number().int().optional().describe("Tab id from browser_list_tabs"),
      tabId: z.number().int().optional().describe("Alias for id"),
      tab_id: z.number().int().optional().describe("Alias for id"),
      focus: z.boolean().optional().describe("Also raise the window to the foreground (steals the user's focus). Default false."),
    },
  },
  tool("switch_tab", async ({ id, tabId, tab_id, focus }) => text(await callBridge("switch_tab", { id: id ?? tabId ?? tab_id, focus })))
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
    inputSchema: {
      id: z.number().int().optional().describe("Tab id from browser_list_tabs"),
      tabId: z.number().int().optional().describe("Alias for id"),
      tab_id: z.number().int().optional().describe("Alias for id"),
    },
  },
  tool("close_tab", async ({ id, tabId, tab_id }) => text(await callBridge("close_tab", { id: id ?? tabId ?? tab_id })))
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
      "Run a JavaScript expression in the target page and return its value. The value must be JSON-serializable. Automatically falls back to CDP Runtime.evaluate if page Content Security Policy (CSP) or Trusted Types block standard script execution. For reading text or attributes without writing JS, prefer 'browser_get_property' — it reads text, value, html, box, attributes and counts, one match or every match.",
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
      "Wait until a CSS selector or page text appears (or disappears with gone=true). With neither, waits a fixed time. Use after actions that trigger async page changes.\n" +
      "Pass for='settle' to wait until the page itself stops moving instead: document.readyState complete AND no running CSS/JS animation. That is the one to use on an SPA (YouTube, Algolia, Azure Portal, GitHub) whose background sockets never let network-idle reach zero, and before a screenshot or snapshot after navigation or submit.",
    inputSchema: {
      for: z
        .enum(["settle", "selector", "text"])
        .optional()
        .describe("What to wait for. 'settle' = page finished loading and animating (no selector/text needed). Default: inferred from selector/text."),
      selector: z.string().optional().describe("CSS selector to wait for"),
      text: z.string().optional().describe("Page text to wait for"),
      gone: z.boolean().optional().describe("Wait for the selector/text to disappear instead"),
      timeoutMs: z.number().int().optional().describe("Timeout in ms (default 8000; fixed wait default 1000)"),
    },
  },
  tool("wait_for", async ({ for: waitFor, selector, text: t, gone, timeoutMs }) =>
    waitFor === "settle"
      ? text(await callBridge("wait_settle", { timeoutMs }))
      : text(await callBridge("wait_for", { selector, text: t, gone, timeoutMs }))
  )
);


server.registerTool(
  "browser_get_property",
  {
    title: "Read an element — text, value, HTML, box, attribute, or how many match",
    description:
      "THE element read. One element, a whole region, or every match — identified by CSS 'selector' (e.g. '.price', '#status', 'h1'), 'ref' (e.g. '@ref_1'), 'index' or 'placeholder'. Pierces open Shadow DOM and works on custom Web Components. Prefer this over eval_js for every one of them.\n" +
      "property: 'text' (default, visible innerText) | 'value' (current form-field value, including what a page set itself) | 'html' (outerHTML markup) | 'box' (position and size) | 'attr' (needs attr='href' etc; a URL also comes back resolved to an absolute URL) | 'count' (how many elements the selector matches — a question about the SET, not about one element, and 0 is an answer, not a failure).\n" +
      "ALSO READS A WHOLE REGION, not just one field: point it at a container and you get that container's entire visible text. This is the read for a long article, an email thread, a chat log, a comment list, or any body that browser_snapshot truncated with '[+N chars: ...]' — browser_get_property({selector: 'div[role=\"main\"]'}) returns exactly what element.innerText would, without writing any JS.\n" +
      "READS EVERY MATCH with all=true: browser_get_property({selector: 'a', property: 'attr', attr: 'href', all: true}) returns one row per match, each with its own ref.\n" +
      "SEVERAL FIELDS PER ROW, one call: browser_get_property({selector: 'li.result', all: true, fields: {title: 'h3', url: {selector: 'a', attr: 'href'}, price: '.price'}}) returns a row per match with those three values named. This is the read that otherwise gets written as Array.from(document.querySelectorAll(...)).map(...) in eval_js. Field selectors resolve INSIDE each row — a value sitting in a SIBLING of the row is a separate call, and the response says which fields matched nothing.\n" +
      "Without all=true it returns the FIRST match and says so in 'matchCount' — pass a ref to pick a specific one.",
    inputSchema: z.object({
      selector: z.string().optional().describe("CSS selector (e.g. 'ytd-active-account-header-renderer', '.header-title', 'a')"),
      ref: z.string().optional().describe("Stable element ref (e.g. '@ref_1', 'ref_5')"),
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
      property: z
        .enum(["text", "value", "html", "box", "attr", "count"])
        .optional()
        .describe("What to read. Default 'text'."),
      attr: z.string().optional().describe("Attribute name, required when property='attr' (e.g. 'href', 'src', 'aria-label')"),
      all: z
        .boolean()
        .optional()
        .describe("Read EVERY element matching 'selector' instead of the first. Each row carries its own ref."),
      max: z.number().int().optional().describe("With all=true: max rows to return (default 50)"),
      fields: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.object({
              selector: z.string().optional(),
              property: z.enum(["text", "value", "html", "box", "attr"]).optional(),
              attr: z.string().optional(),
            }),
          ])
        )
        .optional()
        .describe(
          "With all=true: read SEVERAL values from each row in one call. Keys are your names; values are a CSS selector " +
          "(read as text) or {selector, property, attr}. Selectors resolve INSIDE each row."
        ),
    }).refine((v) => v.selector !== undefined || v.ref !== undefined || v.index !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'selector', 'ref', 'index', or 'placeholder'.",
    }).refine((v) => v.property !== "attr" || v.attr !== undefined, {
      message: "property='attr' needs 'attr' — the name of the attribute to read (e.g. attr='href').",
    }).refine((v) => !v.fields || v.all === true, {
      message: "'fields' reads several values per ROW — pass all: true and a row selector with it.",
    }),
  },
  // One name at every layer. browser_get_text / browser_get_attribute / browser_get_count were
  // three MCP faces on this one protocol action, and the cost was not confusion between them:
  // `all` was added to one face and the other two silently stayed narrower, so the tool whose
  // NAME matched "read every href" was the one that could not do it.
  tool("get_property", async ({ selector, ref, index, placeholder, property, attr, all, max, fields }) =>
    text(await callBridge("get_property", { property: property || "text", selector, ref, index, placeholder, attr, all, max, fields }))
  )
);

server.registerTool(
  "browser_get_page_content",
  {
    title: "Get readable page content",
    description: "Extract the main readable prose/article text of the page (title, url, cleaned text). Good for reading articles and documentation. NOTE: Only extracts article prose. For web app UI — headers, icon buttons, badges, unread counts, notifications — use browser_snapshot. For the full text of ONE region of an app (an email thread, a chat log, a message body), use browser_get_property on that region's container or ref; that is the read this tool declines, and it is not a reason to fall back to eval_js.",
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
      "Call this when the target tab is showing a PDF (browser_get_page_content/browser_find/browser_snapshot/browser_click all fail on a PDF tab with 'no readable DOM' — Chrome's built-in PDF viewer isn't a real DOM, so those tools cannot see its text). Returns the tab's URL and an isPdf verdict; this extension does NOT extract PDF text itself (a hand-rolled parser silently mis-reads subset/CID-font PDFs — dangerous for numeric data like a rate sheet). Fetch the returned URL yourself and read it with your own PDF-reading capability instead of retrying the DOM-based tools.",
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


// --- Coordinate input, accessibility, capture, audit (CDP; require attach) ---

server.registerTool(
  "browser_coordinate_click",
  {
    title: "Click at coordinates",
    description: "Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead.",
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
    description: "Press at (fromX,fromY), move to (toX,toY), release. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead.",
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
    description:
      "SECOND OPINION on the page, from Chrome itself. Returns Chrome's own accessibility tree — the role, name and state it computes for every control by the HTML-AAM spec — not browserctl's census. Each node carries a 'ref' where the census has the same control, so results are directly actionable.\n" +
      "Use it when browser_snapshot's answer looks wrong or incomplete: a control you can see but cannot find, a name that does not match what is on screen, or a form whose state you want confirmed independently. 'censusCoverage' says how much of Chrome's control list the census also had, and 'notInCensus' names the difference — usually screen-reader-only text, occasionally a real gap.\n" +
      "COST: attaches the debugger, so Chrome shows a 'browserctl started debugging this browser' banner on that tab, and it is ~3x slower and ~2x larger than browser_snapshot. It is a diagnostic, not a replacement — reach for browser_snapshot first. Attaches on its own; no separate browser_cdp_attach needed.",
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
      "Given a CSS 'selector', 'ref', or 'index', return everything useful for debugging it: tag, full attribute dump, bounding rect, visibility verdict WITH the specific reason ('visible' | 'display:none' | 'visibility:hidden' | 'zero-size rect' | 'opacity:0' | 'disabled'), and whether it matches the interactive selector. Pierces open Shadow DOM.",
    inputSchema: z.object({
      selector: z.string().optional().describe("CSS selector to describe (e.g. 'ytd-active-account-header-renderer', '#submit-btn')"),
      ref: z.string().optional().describe("Stable element ref (e.g. 'ref_5', '@ref_1')"),
      index: z.number().int().optional().describe("Element index from browser_snapshot"),
      placeholder: z.string().optional().describe("Match input by placeholder attribute"),
    }).refine((v) => v.selector !== undefined || v.ref !== undefined || v.index !== undefined || v.placeholder !== undefined, {
      message: "Provide at least one of 'selector', 'ref', 'index', or 'placeholder'.",
    }),
  },
  tool("describe_element", async ({ selector, ref, index, placeholder }) => text(await callBridge("describe_element", { selector, ref, index, placeholder })))
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
    description:
      "Return the cookies that apply to the TARGET TAB's current page (this is the default scope, and the answer to \"what cookies did this page set\"). Pass allDomains:true to read every cookie in the browser profile instead — that returns the user's whole session jar across all sites, so ask for it only when the task really needs it. Capped at 200 cookies; the response says when it truncated. Requires browser_cdp_attach.",
    inputSchema: {
      urlContains: z.string().optional().describe("Keep only cookies whose domain contains this substring"),
      url: z.string().optional().describe("Scope to this URL instead of the target tab's current page"),
      allDomains: z.boolean().optional().describe("Read every cookie in the browser profile, not just this page's. Default false."),
      limit: z.number().int().optional().describe("Max cookies to return (default 200)"),
    },
  },
  tool("get_cookies", async ({ urlContains, url, allDomains, limit }) =>
    text(await callBridge("get_cookies", { urlContains, url, allDomains, limit }))
  )
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

// browser_click_selector and browser_fill_selector were removed in 0.6.4: both were exact
// duplicates of browser_click({selector}) / browser_fill({selector}), which resolve through
// the full escalation ladder instead of a bare querySelector. The PROTOCOL actions stay —
// replay() drives them internally and browser_action can still dispatch them by name.

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
    description:
      "Wait until the target tab has had no in-flight requests for idleMs (default 500), up to timeoutMs (default 10000). For modern SPAs with persistent WebSockets, telemetry, or long-polling (YouTube, Algolia, Twitter, Azure Portal), network-idle may time out waiting for 0 requests; use browser_wait_for({for:'settle'}) instead or set maxInFlight to tolerate background connections.",
    inputSchema: {
      idleMs: z.number().int().optional().describe("Quiet period in ms with <= maxInFlight requests (default 500)"),
      timeoutMs: z.number().int().optional().describe("Maximum wait timeout in ms (default 10000)"),
      maxInFlight: z.number().int().optional().describe("Tolerate up to N background/in-flight requests (e.g. 1 for WebSockets/telemetry, default 0)"),
    },
  },
  tool("wait_network_idle", async ({ idleMs, timeoutMs, maxInFlight }) =>
    text(await callBridge("wait_network_idle", { idleMs, timeoutMs, maxInFlight }))
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
    description:
      "Stop the local browserctl bridge daemon. DO NOT call this to tidy up when a task is finished — " +
      "the daemon is shared with the user and with any other agent driving a tab, it starts and maintains " +
      "itself, and stopping it interrupts their work and records an explicit stopped state that blocks " +
      "auto-restart. Call it only when the user asks you to shut the bridge down.",
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

export { server, TOOL_CATEGORIES, CORE_TOOLS };
