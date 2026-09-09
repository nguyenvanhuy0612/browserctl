#!/usr/bin/env node
// CLI Helper for browserctl bridge & MCP client
//
// Usage:
//   browserctl status
//   browserctl start | stop | restart
//   browserctl open https://example.com
//   browserctl snapshot [--compact]
//   browserctl click @e1 | ref_1 | 0 | --text "Sign In" | --selector "#btn"
//   browserctl fill @e1 "text" | type @e2 "text" [--submit]
//   browserctl get text @e1 | value @e1 | attr @e1 href | title | url | html
//   browserctl clear @e1 | check @e1 | uncheck @e1 | select @e1 <value>
//   browserctl wait 2000 | @e1 | --text "Success" | --network-idle | --settle
//   browserctl screenshot [output.png] [--full] | pdf [output.pdf]
//   browserctl eval "document.title" [-r|--raw]
//   browserctl tab [list | new | switch | close]

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import {
  getDaemonState,
  markDaemonRunning,
  markDaemonStopped,
  isDaemonExplicitlyStopped,
} from "./bridge/state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

const BRIDGE_URL = envStr("BROWSERCTL_BRIDGE_URL", envStr("BRIDGE_URL", "http://127.0.0.1:8765"));

function printHelp() {
  console.log(`
browserctl CLI — Fast, Ergonomic Browser Automation for AI Agents & Developers

Usage:
  browserctl status                     Check bridge health, daemon state & extension
  browserctl start                      Start bridge daemon (RARELY NEEDED — any command
                                        starts it automatically on first use)
  browserctl stop                       Stop the daemon. DO NOT run this to tidy up after a
                                        task: it is shared with the user and other agents,
                                        and it records a stopped state that blocks restart.
  browserctl restart                    Restart bridge daemon

You do not need to start anything before your first command, and you do not need to leave a
terminal open. Every MCP tool has a CLI equivalent: browser_snapshot -> snapshot,
browser_get_text -> get text, browser_click -> click.

Navigation & Tabs:
  browserctl open <url>                 Navigate target tab to url (alias: navigate)
  browserctl back | forward | reload    History navigation
  browserctl tab [list]                 List open tabs and target tab (alias: tabs)
  browserctl tab new [url]              Open new tab (alias: new_tab)
  browserctl tab switch <id>            Switch target to tab ID (alias: switch_tab)
  browserctl tab close [id]             Close tab (alias: close_tab)

Inspection & Query (get):
  browserctl snapshot [--all]           Capture interactive DOM elements (--all = everything in the DOM)
  browserctl read_page [mode] [--depth N] [--max-chars N] [--ref @ref_1]
                                        Read accessibility tree & text (mode: interactive | all)
  browserctl get text <target>          Get visible text of element (@e1, ref_1, selector)
  browserctl get value <target>         Get value of input/textarea/select
  browserctl get attr <target> <name>   Get attribute value (e.g. href, src, placeholder)
  browserctl get title                  Get current page title
  browserctl get url                    Get current page URL
  browserctl get html [<target>]        Get HTML of element or whole document
  browserctl get box <target>           Get bounding box coordinates (x, y, width, height)
  browserctl get count <selector>       Count matching elements

Interaction:
  browserctl click <target>             Click element (@e1, ref_1, 0, --text "...", custom elements, ARIA roles)
  browserctl dblclick <target>          Double-click element
  browserctl fill <target> <text>       Clear input and fill text (recovers with candidate input refs if targeted element is not editable)
  browserctl paste <target> <text>      Paste text/markdown into field or rich-text editor
  browserctl type <target> <text>       Type into input field (appends/types text)
  browserctl clear <target>             Clear input/textarea field
  browserctl check <target>             Check checkbox or radio button
  browserctl uncheck <target>           Uncheck checkbox
  browserctl select <target> <val...>   Select option in dropdown by value or --label "..."
  browserctl hover <target>             Hover over element
  browserctl scroll [up|down] [amount] [target] Scroll page or container (@ref, selector)
  browserctl scrollintoview <target>    Scroll element into view
  browserctl press <key>                Press key (Enter, Tab, Escape, etc.)
  browserctl dismiss [target]           Dismiss active modal, drawer, or flyout (Escape or close button)

Wait & Synchronization:
  browserctl wait [<ms>]                Sleep for specified milliseconds (e.g. wait 2000)
  browserctl wait [--settle|--auto]     Wait for DOM mutations and animations to finish (default)
  browserctl wait <target>              Wait for element to appear in DOM
  browserctl wait --text "..."          Wait for visible text to appear
  browserctl wait --selector "..."      Wait for CSS selector to appear
  browserctl wait --network-idle [--tolerance N] Wait for network activity to settle (tolerates N background requests)

Capture & Export:
  browserctl screenshot [file.png] [-f] Take viewport or fullpage screenshot (saves to file or returns base64)
  browserctl pdf [file.pdf]             Print page to PDF (saves to file or returns base64)
  browserctl eval <expression> [-r]     Evaluate JavaScript (auto-bypasses CSP/Trusted Types via CDP)

System & Raw Protocols:
  browserctl exec_system_cmd <cmd>      Run host system command
  browserctl <action> [key=value ...]   Run any of the 68+ protocol actions

Formatting & Global Flags:
  -r, --raw                             Output raw unformatted value (for piping)
  --json                                Force compact valid JSON output
  --pretty                              Force 2-space indented pretty JSON output
  -c, --compact                         Output compact token-efficient representation
  -f, --full, --fullpage                Capture fullpage screenshot
  -t, --tab <id>                        Direct command to specific tab ID
  --settle <ms>                         Auto-settle delay after action (default: 150ms)
  --no-daemon                           Do not auto-start bridge daemon if not running
  --auto-daemon                         Force auto-start even if previously stopped

Environment:
  BROWSERCTL_BRIDGE_URL                 Default: http://127.0.0.1:8765
  BROWSERCTL_AUTO_START                 'auto' (default) or 'manual'/'false'
  BROWSERCTL_MCP_PROFILE                'core' (default) or 'all'
`);
}

let isStartingDaemon = null;

async function isBridgeRunning() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startBridgeDaemon() {
  if (isStartingDaemon) return isStartingDaemon;

  isStartingDaemon = (async () => {
    const serverPath = join(__dirname, "bridge", "server.js");
    if (!fs.existsSync(serverPath)) return false;

    try {
      const child = spawn(process.execPath, [serverPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PORT: "8765" },
      });
      child.unref();

      // Poll up to 2.5s (bounded 25 x 100ms)
      const start = Date.now();
      while (Date.now() - start < 2500) {
        await new Promise((r) => setTimeout(r, 100));
        if (await isBridgeRunning()) {
          try {
            markDaemonRunning({ pid: child.pid, port: 8765, url: BRIDGE_URL });
          } catch {}
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      isStartingDaemon = null;
    }
  })();

  return isStartingDaemon;
}

function stopBridgeDaemon() {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano | findstr :8765", { encoding: "utf8" });
      const lines = out.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (/^\d+$/.test(pid) && pid !== "0") {
          try { execSync(`taskkill /F /PID ${pid}`); } catch {}
        }
      }
      markDaemonStopped({ stoppedBy: "cli_stop" });
      return true;
    } else {
      const pids = execSync("lsof -ti :8765 -sTCP:LISTEN", { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const pid of pids) {
        process.kill(parseInt(pid, 10), "SIGTERM");
      }
      markDaemonStopped({ stoppedBy: "cli_stop" });
      return pids.length > 0;
    }
  } catch {
    markDaemonStopped({ stoppedBy: "cli_stop" });
    return false;
  }
}

async function ensureBridge(autoDaemon = true, forceAuto = false) {
  if (await isBridgeRunning()) return true;

  if (!autoDaemon && !forceAuto) {
    process.stderr.write("[browserctl] Error: Bridge daemon is not running. Start it with 'browserctl start'.\n");
    process.exit(1);
  }

  // If user/agent explicitly ran 'browserctl stop', do not auto-start unless forced
  if (isDaemonExplicitlyStopped() && !forceAuto) {
    process.stderr.write(
      "[browserctl] Error: Bridge daemon is currently stopped (stopped by user/agent).\n" +
      "             Run 'browserctl start' to restart the daemon, or pass --auto-daemon.\n"
    );
    process.exit(1);
  }

  const autoStartPolicy = envStr("BROWSERCTL_AUTO_START", "auto");
  if ((autoStartPolicy === "manual" || autoStartPolicy === "false") && !forceAuto) {
    process.stderr.write(
      "[browserctl] Error: Bridge daemon is not running and BROWSERCTL_AUTO_START=manual.\n" +
      "             Run 'browserctl start' to start the daemon.\n"
    );
    process.exit(1);
  }

  process.stderr.write("[browserctl] Bridge daemon not detected. Starting bridge on http://127.0.0.1:8765...\n");
  const started = await startBridgeDaemon();
  if (started) {
    process.stderr.write("[browserctl] Bridge daemon started successfully.\n");
    return true;
  }
  process.stderr.write("[browserctl] Warning: Bridge daemon failed to respond. Attempting command anyway...\n");
  return false;
}

const HTML_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "input", "textarea", "select",
  "div", "span", "img", "form", "header", "footer", "article", "section", "nav", "main",
  "ul", "ol", "li", "table", "tr", "td", "th", "label", "meta", "link", "body", "svg"
]);

// Parse target element identifier (@e1, @1, ref_1, 1, 0, selector, text, placeholder)
function parseTarget(arg, params) {
  if (!arg) return;
  const trimmed = arg.trim();

  if (trimmed.startsWith("--text=")) {
    params.text = trimmed.slice(7);
    return;
  }
  if (trimmed.startsWith("--selector=")) {
    params.selector = trimmed.slice(11);
    return;
  }
  if (trimmed.startsWith("--placeholder=")) {
    params.placeholder = trimmed.slice(14);
    return;
  }

  // Matches any @-prefixed target identifier: @ref_1, @1, @e1, @f898:ref_54, @f12:e5
  if (trimmed.startsWith("@")) {
    params.ref = trimmed;
    return;
  }

  // Matches frame-qualified or local refs without @: f898:ref_54, f1:e2, ref_1, ref1, e1
  if (/^(?:f\w+:)?(?:ref_?|e)\w+$/i.test(trimmed)) {
    params.ref = `@${trimmed}`;
    return;
  }

  // Matches single digit index if pure number
  if (/^\d+$/.test(trimmed)) {
    params.index = parseInt(trimmed, 10);
    return;
  }

  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith(".") ||
    trimmed.includes(">") ||
    trimmed.includes("[") ||
    trimmed.includes(":") ||
    trimmed.includes(" ") ||
    HTML_TAGS.has(trimmed.toLowerCase()) ||
    (!trimmed.startsWith("-") && /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/i.test(trimmed))
  ) {
    params.selector = trimmed;
  } else {
    params.ref = trimmed;
  }
}

// Format a clean ASCII table for list_tabs
function formatTabsTable(tabs = []) {
  if (!Array.isArray(tabs) || tabs.length === 0) return "No open tabs.";
  const header = `ID         ACTIVE   TITLE                                          URL`;
  const separator = `--------------------------------------------------------------------------------`;
  const rows = tabs.map((t) => {
    const id = String(t.id || "").padEnd(10);
    const active = (t.active ? "*" : " ").padEnd(8);
    let title = (t.title || "(untitled)").replace(/\n/g, " ");
    if (title.length > 44) title = title.slice(0, 41) + "...";
    title = title.padEnd(46);
    let url = t.url || "";
    if (url.length > 60) url = url.slice(0, 57) + "...";
    return `${id} ${active} ${title} ${url}`;
  });
  return [header, separator, ...rows].join("\n");
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("-h") || rawArgs.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  let jsonOutput = false;
  let prettyOutput = false;
  let rawOutput = false;
  let compactMode = false;
  let fullpageMode = false;
  let autoDaemon = true;
  let forceAutoDaemon = false;
  let explicitTabId = null;
  let settleMs = null;

  // Filter global flags from ANY position in rawArgs
  const positionalArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--json") {
      jsonOutput = true;
    } else if (a === "--pretty") {
      prettyOutput = true;
    } else if (a === "-r" || a === "--raw") {
      rawOutput = true;
    } else if (a === "-c" || a === "--compact") {
      compactMode = true;
    } else if (a === "-f" || a === "--full" || a === "--fullpage") {
      fullpageMode = true;
    } else if (a === "--no-daemon") {
      autoDaemon = false;
    } else if (a === "--auto-daemon") {
      forceAutoDaemon = true;
    } else if (a === "-t" || a === "--tab") {
      explicitTabId = parseInt(rawArgs[++i], 10);
    } else if (a.startsWith("--tab=")) {
      explicitTabId = parseInt(a.slice(6), 10);
    } else if (a === "--settle") {
      settleMs = parseInt(rawArgs[++i], 10);
    } else if (a.startsWith("--settle=")) {
      settleMs = parseInt(a.slice(9), 10);
    } else {
      positionalArgs.push(a);
    }
  }

  if (positionalArgs.length === 0) {
    printHelp();
    process.exit(0);
  }

  let action = positionalArgs[0];
  let args = positionalArgs.slice(1);

  // Friendly action aliases for agent ergonomics
  if (action === "tabs" || action === "tab_list") {
    action = "tab";
    args = ["list", ...args];
  } else if (action === "switch") {
    action = "tab";
    args = ["switch", ...args];
  } else if (action === "get_text") {
    action = "get";
    args = ["text", ...args];
  } else if (action === "get_count") {
    action = "get";
    args = ["count", ...args];
  } else if (action === "close_modal") {
    action = "dismiss";
  }

  // Daemon control actions
  if (action === "start" || action === "daemon") {
    if (await isBridgeRunning()) {
      markDaemonRunning({ port: 8765, url: BRIDGE_URL });
      const out = { ok: true, message: "Bridge is already running", url: BRIDGE_URL };
      if (prettyOutput) console.log(JSON.stringify(out, null, 2));
      else if (jsonOutput) console.log(JSON.stringify(out));
      else console.log(`Bridge is already running on ${BRIDGE_URL}`);
      process.exit(0);
    }
    const started = await startBridgeDaemon();
    if (started) {
      const out = { ok: true, message: "Bridge started", url: BRIDGE_URL };
      if (prettyOutput) console.log(JSON.stringify(out, null, 2));
      else if (jsonOutput) console.log(JSON.stringify(out));
      else console.log(`Bridge started successfully on ${BRIDGE_URL}`);
      process.exit(0);
    } else {
      const out = { ok: false, error: "Failed to start bridge daemon" };
      if (prettyOutput) console.error(JSON.stringify(out, null, 2));
      else console.error(JSON.stringify(out));
      process.exit(1);
    }
  }

  if (action === "stop") {
    const stopped = stopBridgeDaemon();
    const out = { ok: true, message: stopped ? "Bridge stopped" : "Bridge was not running" };
    if (prettyOutput) console.log(JSON.stringify(out, null, 2));
    else if (jsonOutput) console.log(JSON.stringify(out));
    else console.log(stopped ? "Bridge stopped (daemon state: stopped)" : "Bridge was not running");
    process.exit(0);
  }

  if (action === "restart") {
    stopBridgeDaemon();
    await new Promise((r) => setTimeout(r, 200));
    const started = await startBridgeDaemon();
    const out = { ok: started, message: started ? "Bridge restarted" : "Failed to restart" };
    if (prettyOutput) console.log(JSON.stringify(out, null, 2));
    else if (jsonOutput) console.log(JSON.stringify(out));
    else console.log(started ? `Bridge restarted on ${BRIDGE_URL}` : "Failed to restart bridge");
    process.exit(started ? 0 : 1);
  }

  if (action === "status") {
    const stateInfo = getDaemonState();
    try {
      const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(1000) });
      const data = await res.json();
      const statusObj = { ok: res.ok, daemonState: "running", ...data };
      if (prettyOutput) {
        console.log(JSON.stringify(statusObj, null, 2));
      } else if (jsonOutput) {
        console.log(JSON.stringify(statusObj));
      } else {
        console.log(`Bridge: RUNNING (${BRIDGE_URL})`);
        console.log(`Extension: ${data.extensionConnected ? "CONNECTED" : "DISCONNECTED"}`);
        // The bridge announces the call log at startup, but the daemon is spawned with
        // stdio "ignore" — that line reaches nobody in the mode everyone actually runs.
        // This is the surface a person looks at, so the notice belongs here too.
        if (data.callLog) {
          const mb = (n) => (n / 1024 / 1024).toFixed(1);
          const size = data.callLogBytes != null ? `${mb(data.callLogBytes)}MB` : "?";
          const cap = data.callLogMaxBytes != null ? `, rotates at ${mb(data.callLogMaxBytes)}MB` : "";
          console.log(`Call log: ON  ${data.callLog} (${size}${cap}; parameter values never written)`);
        }
      }
    } catch (err) {
      const statusObj = { ok: false, daemonState: stateInfo.state || "stopped", error: err.message };
      if (prettyOutput) {
        console.log(JSON.stringify(statusObj, null, 2));
      } else if (jsonOutput) {
        console.log(JSON.stringify(statusObj));
      } else {
        console.log(`Bridge: ${stateInfo.state === "stopped" ? "STOPPED (explicitly)" : "OFFLINE"}`);
        console.log(`Error: ${err.message}`);
      }
      process.exit(1);
    }
    return;
  }

  // Ensure bridge is up for other actions
  await ensureBridge(autoDaemon, forceAutoDaemon);

  // Tab subcommand router
  if (action === "tab") {
    const sub = args[0] || "list";
    if (sub === "list" || sub === "ls") {
      action = "list_tabs";
      args = args.slice(1);
    } else if (sub === "new" || sub === "create") {
      action = "new_tab";
      args = args.slice(1);
    } else if (sub === "switch" || sub === "focus") {
      action = "switch_tab";
      args = args.slice(1);
    } else if (sub === "close") {
      action = "close_tab";
      args = args.slice(1);
    } else if (/^\d+$/.test(sub)) {
      action = "switch_tab";
    } else {
      action = "list_tabs";
    }
  }

  // Alias mappings
  if (action === "open") action = "navigate";
  if (action === "tabs") action = "list_tabs";
  if (action === "back") action = "go_back";
  if (action === "forward") action = "go_forward";
  if (action === "press") action = "press_key";
  if (action === "eval" || action === "browser_eval_js") action = "eval_js";
  if (action === "fill") action = "type";
  if (action === "scrollintoview") action = "scrollintoview";

  // Handle local sleep wait if wait <number>
  if (action === "wait" && args.length > 0 && /^\d+$/.test(args[0])) {
    const ms = parseInt(args[0], 10);
    await new Promise((r) => setTimeout(r, ms));
    if (rawOutput) {
      process.stdout.write(String(ms));
    } else if (prettyOutput) {
      console.log(JSON.stringify({ ok: true, waitedMs: ms }, null, 2));
    } else if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, waitedMs: ms }));
    } else {
      console.log(`Waited ${ms}ms`);
    }
    process.exit(0);
  }

  let saveFilePath = null;
  let params = {};
  if (explicitTabId != null) params.tabId = explicitTabId;
  if (settleMs != null) params.settleMs = settleMs;

  // JSON argument payload
  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      params = { ...params, ...JSON.parse(args[0]) };
    } catch (e) {
      console.error("Invalid JSON params:", args[0]);
      process.exit(1);
    }
  } else {
    switch (action) {
      case "navigate":
      case "new_tab":
        if (args[0]) params.url = args[0];
        break;

      case "snapshot":
        if (compactMode || (!jsonOutput && !prettyOutput)) params.compact = true;
        if (rawArgs.includes("--all")) params.scope = "all";
        if (args[0] && /^\d+$/.test(args[0])) params.maxText = parseInt(args[0], 10);
        break;

      case "read_page":
        if (args[0] && !args[0].startsWith("-")) params.mode = args[0];
        // --depth and --max-chars were parsed by nobody: the flags were accepted on the
        // command line and silently dropped, so `read_page --depth 8` quietly ran at the
        // default. A parameter that vanishes without a word is worse than one rejected.
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          const val = (inline) => (inline !== undefined ? inline : args[++i]);
          let m;
          if ((m = /^--depth(?:=(\d+))?$/.exec(a))) params.depth = Number(val(m[1]));
          else if ((m = /^--max-?chars(?:=(\d+))?$/.exec(a))) params.maxChars = Number(val(m[1]));
          else if ((m = /^--ref(?:=(.+))?$/.exec(a))) params.ref_id = val(m[1]);
        }
        if (params.depth !== undefined && !Number.isFinite(params.depth)) {
          console.error("read_page: --depth needs a number, e.g. --depth 60");
          process.exit(2);
        }
        break;

      case "get": {
        let prop = args[0] || "text";
        if (prop === "attribute") prop = "attr";
        params.property = prop;
        if (prop === "title" || prop === "url") {
          // No target needed
        } else if (prop === "attr") {
          let i = 1;
          while (i < args.length) {
            if (args[i] === "--selector" && args[i + 1]) {
              params.selector = args[++i];
            } else if (args[i] === "--attr" && args[i + 1]) {
              params.attr = args[++i];
            } else if (!params.ref && !params.index && !params.selector) {
              parseTarget(args[i], params);
            } else if (!params.attr) {
              params.attr = args[i];
            }
            i++;
          }
        } else if (prop === "count") {
          if (args[1]) params.selector = args[1];
        } else {
          let i = 1;
          while (i < args.length) {
            if (args[i] === "--selector" && args[i + 1]) {
              params.selector = args[++i];
            } else if (args[i] === "--text" && args[i + 1]) {
              params.text = args[++i];
            } else if (!params.ref && !params.index && !params.selector) {
              parseTarget(args[i], params);
            }
            i++;
          }
        }
        action = "get_property";
        break;
      }

      case "click":
      case "dblclick":
      case "hover":
      case "focus":
      case "clear":
      case "check":
      case "uncheck":
      case "scrollintoview":
      case "describe":
      case "describe_element":
      case "element_screenshot": {
        let i = 0;
        while (i < args.length) {
          if (args[i] === "--text" && args[i + 1]) {
            params.text = args[++i];
          } else if (args[i] === "--selector" && args[i + 1]) {
            params.selector = args[++i];
          } else if (args[i] === "--wait-for" && args[i + 1]) {
            params.waitFor = args[++i];
          } else {
            parseTarget(args[i], params);
          }
          i++;
        }
        if (action === "describe") action = "describe_element";
        break;
      }

      case "paste":
      case "type": {
        let i = 0;
        let textArg = null;
        while (i < args.length) {
          if (args[i] === "--placeholder" && args[i + 1]) {
            params.placeholder = args[++i];
          } else if (args[i] === "--selector" && args[i + 1]) {
            params.selector = args[++i];
          } else if (args[i] === "--wait-for" && args[i + 1]) {
            params.waitFor = args[++i];
          } else if (args[i] === "--submit") {
            params.submit = true;
          } else if (!params.ref && !params.index && !params.selector && !params.placeholder) {
            parseTarget(args[i], params);
          } else if (textArg === null) {
            textArg = args[i];
          }
          i++;
        }
        if (textArg !== null) params.text = textArg;
        break;
      }

      case "select":
      case "select_option": {
        action = "select_option";
        let i = 0;
        while (i < args.length) {
          if (args[i] === "--label" && args[i + 1]) {
            params.label = args[++i];
          } else if (!params.ref && !params.index && !params.selector) {
            parseTarget(args[i], params);
          } else if (params.value === undefined && params.label === undefined) {
            params.value = args[i];
          }
          i++;
        }
        break;
      }

      case "wait": {
        let i = 0;
        let hasType = false;
        while (i < args.length) {
          if (args[i] === "--network-idle") {
            action = "wait_network_idle";
            hasType = true;
          } else if (args[i] === "--settle" || args[i] === "--auto") {
            action = "wait_settle";
            hasType = true;
          } else if (args[i] === "--tolerance" || args[i] === "--max-inflight") {
            if (args[i + 1]) params.maxInFlight = parseInt(args[++i], 10);
          } else if (args[i] === "--text" && args[i + 1]) {
            action = "wait_for";
            params.text = args[++i];
            hasType = true;
          } else if (args[i] === "--selector" && args[i + 1]) {
            action = "wait_for";
            params.selector = args[++i];
            hasType = true;
          } else if (args[i] === "--timeout" && args[i + 1]) {
            params.timeoutMs = parseInt(args[++i], 10);
          } else if (!hasType) {
            action = "wait_for";
            parseTarget(args[i], params);
            hasType = true;
          }
          i++;
        }
        if (!hasType) action = "wait_settle";
        break;
      }

      case "screenshot":
      case "screenshot_fullpage": {
        action = "screenshot";
        if (fullpageMode) params.format = "png";
        if (args[0] && !args[0].startsWith("-")) {
          saveFilePath = args[0];
        }
        break;
      }

      case "pdf":
      case "print_pdf": {
        action = "print_pdf";
        if (args[0] && !args[0].startsWith("-")) {
          saveFilePath = args[0];
        }
        break;
      }

      case "dismiss": {
        let i = 0;
        while (i < args.length) {
          if (args[i] === "--selector" && args[i + 1]) {
            params.selector = args[++i];
          } else {
            parseTarget(args[i], params);
          }
          i++;
        }
        break;
      }

      case "scroll": {
        for (const arg of args) {
          if (arg === "up" || arg === "down" || arg === "left" || arg === "right") {
            params.direction = arg;
          } else if (/^\d+$/.test(arg) && !params.amount) {
            params.amount = parseInt(arg, 10);
          } else if (arg.startsWith("--selector=") || arg === "--selector") {
            if (arg.startsWith("--selector=")) params.selector = arg.slice(11);
          } else {
            parseTarget(arg, params);
          }
        }
        break;
      }

      case "press_key":
        if (args[0]) params.key = args[0];
        break;

      case "eval_js":
      case "browser_eval_js":
        if (args[0]) params.expression = args.join(" ");
        break;

      case "switch_tab":
      case "close_tab":
        if (args[0]) params.id = parseInt(args[0], 10);
        break;

      case "exec_system_cmd":
        if (args[0]) params.command = args.join(" ");
        break;

      // Documented in the README's command catalog, but they had no case here, so the
      // positional argument fell into the key=value parser below, matched nothing, and the
      // action was dispatched with empty params: `browserctl find login` returned
      // "find requires 'query'".
      case "find":
      case "find_text":
        if (args.length) {
          params.query = args.filter((a) => !a.startsWith("-")).join(" ");
          const max = rawArgs.indexOf("--max");
          if (max >= 0 && rawArgs[max + 1]) params.max = parseInt(rawArgs[max + 1], 10);
        }
        if (!params.query) {
          console.error(`${action}: needs a query, e.g. browserctl ${action} "Sign in"`);
          process.exit(2);
        }
        break;

      default: {
        // Parse key=value pairs
        let mapped = 0;
        for (const arg of args) {
          const eq = arg.indexOf("=");
          if (eq > 0) {
            const k = arg.slice(0, eq);
            let v = arg.slice(eq + 1);
            if (v === "true") v = true;
            else if (v === "false") v = false;
            else if (/^\d+$/.test(v)) v = parseInt(v, 10);
            params[k] = v;
            mapped++;
          }
        }
        // A command with no case here and positional arguments that are not key=value
        // cannot be formed, and dispatching it anyway produced a confusing error from the
        // page ("X requires 'query'") for what is really a CLI gap. Say so instead.
        const positional = args.filter((a) => !a.startsWith("-") && a.indexOf("=") < 0);
        if (positional.length && mapped === 0) {
          console.error(
            `${action}: this command takes no positional arguments in the CLI, so ` +
            `${JSON.stringify(positional[0])} was ignored.\n` +
            `Pass them explicitly as key=value (e.g. ${action} query="${positional[0]}"), ` +
            `or run 'browserctl --help' for the commands that do take arguments.`
          );
          process.exit(2);
        }
        break;
      }
    }
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const errPayload = { ok: false, error: data.error || `HTTP ${res.status}` };
      if (data.code) errPayload.code = data.code;
      if (data.diagnostics) errPayload.diagnostics = data.diagnostics;
      if (data.recoveryHint) errPayload.recoveryHint = data.recoveryHint;
      if (prettyOutput) console.error(JSON.stringify(errPayload, null, 2));
      else console.error(JSON.stringify(errPayload));
      process.exit(1);
    }

    const result = data.result !== undefined ? data.result : data;

    // Binary file saving for screenshot and pdf
    if (saveFilePath) {
      let b64 = null;
      if (typeof result?.dataUrl === "string") {
        b64 = result.dataUrl.replace(/^data:[^;]+;base64,/, "");
      } else if (typeof result?.data === "string") {
        b64 = result.data.replace(/^data:[^;]+;base64,/, "");
      } else if (typeof result?.base64 === "string") {
        b64 = result.base64.replace(/^data:[^;]+;base64,/, "");
      }

      if (b64) {
        const buf = Buffer.from(b64, "base64");
        fs.writeFileSync(saveFilePath, buf);
        if (rawOutput) {
          process.stdout.write(saveFilePath);
        } else if (prettyOutput) {
          console.log(JSON.stringify({ ok: true, saved: saveFilePath, bytes: buf.length }, null, 2));
        } else if (jsonOutput) {
          console.log(JSON.stringify({ ok: true, saved: saveFilePath, bytes: buf.length }));
        } else {
          console.log(`Saved ${action === "print_pdf" ? "PDF" : "screenshot"} to ${saveFilePath} (${buf.length} bytes)`);
        }
        return;
      }
    }

    // 1. Raw Output Mode (-r / --raw): pure string without wrappers or trailing newlines
    if (rawOutput) {
      if (result?.value !== undefined) {
        process.stdout.write(typeof result.value === "object" ? JSON.stringify(result.value) : String(result.value));
        return;
      }
      if (typeof result?.text === "string") {
        process.stdout.write(result.text);
        return;
      }
      if (typeof result?.url === "string") {
        process.stdout.write(result.url);
        return;
      }
      if (Array.isArray(result?.tabs)) {
        process.stdout.write(result.tabs.map((t) => t.id).join(" "));
        return;
      }
      process.stdout.write(typeof result === "object" ? JSON.stringify(result) : String(result));
      return;
    }

    // 2. Pretty JSON Mode (--pretty): 2-space indented full object
    if (prettyOutput) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // 3. Compact JSON Mode (--json): minified 1-line valid JSON object
    if (jsonOutput) {
      console.log(JSON.stringify(result));
      return;
    }

    // 4. Smart Default Mode (Token-Efficient, No Info Loss):
    if (action === "list_tabs" && Array.isArray(result?.tabs)) {
      console.log(formatTabsTable(result.tabs));
      return;
    }

    if (action === "snapshot") {
      if (result?.compactView) {
        console.log(`Page: ${result.title || "Untitled"} (${result.url})`);
        if (result.viewport) {
          const vh = result.viewport.height || 0;
          const sy = result.viewport.scrollY || 0;
          const sh = result.viewport.scrollHeight || vh;
          console.log(`Viewport: Y: ${sy}px-${sy + vh}px of ${sh}px total height (${result.viewport.width}x${vh}, scroll: ${result.viewport.scrollPercent}%, scope: ${result.scope || "viewport"})`);
        }
        if (result.pageState?.hasActiveModal) {
          console.log(`[Active Modal: <${result.pageState.activeModalTag || "dialog"}>]`);
        }
        const total = result.totalElementsCount ?? result.elements?.length ?? 0;
        const visible = result.elements?.length || 0;
        const folded = result.foldedCount ? `, ${result.foldedCount} folded` : "";
        if (result.scope === "viewport" && result.offscreenCount > 0) {
          console.log(`Elements: ${visible} visible in viewport (${total} total on page${folded})`);
          // The compact view's own footer notice names the KINDS of element offscreen,
          // which this line cannot. Printing both wasted tokens and gave two numbers.
        } else {
          console.log(`Interactive elements (${visible}${folded}):`);
        }
        console.log(`\n${result.compactView}`);
        return;
      }
    }

    if (action === "get_property" && result?.value !== undefined) {
      if (typeof result.value === "object") {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(result.value);
      }
      return;
    }

    if (action === "eval_js" && result?.value !== undefined) {
      if (typeof result.value === "object") {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(result.value);
      }
      return;
    }

    // Friendly 1-line action summaries for mutations
    if (result?.clicked) {
      console.log(`Clicked ${result.clicked}`);
      return;
    }
    if (result?.typed) {
      console.log(`Typed into ${result.typed}`);
      return;
    }
    if (result?.pasted) {
      console.log(`Pasted into ${result.pasted} (${result.length || 0} chars)`);
      return;
    }
    if (result?.cleared) {
      console.log(`Cleared ${result.cleared}`);
      return;
    }
    if (result?.checked) {
      console.log(`Checked ${result.checked}`);
      return;
    }
    if (result?.unchecked) {
      console.log(`Unchecked ${result.unchecked}`);
      return;
    }
    if (result?.focused) {
      console.log(`Focused ${result.focused}`);
      return;
    }
    if (result?.scrolledIntoView) {
      console.log(`Scrolled into view: ${result.scrolledIntoView}`);
      return;
    }
    if (result?.selectedOption) {
      console.log(`Selected option on ${result.selectedOption}`);
      return;
    }

    // Fallback: output clean JSON
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const errPayload = { ok: false, error: err.message };
    if (prettyOutput) console.error(JSON.stringify(errPayload, null, 2));
    else console.error(JSON.stringify(errPayload));
    process.exit(1);
  }
}

main();
