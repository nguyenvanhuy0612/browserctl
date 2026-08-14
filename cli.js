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
  browserctl status                     Check bridge health & extension connection
  browserctl start                      Start bridge daemon in background
  browserctl stop                       Stop running bridge daemon
  browserctl restart                    Restart bridge daemon

Navigation & Tabs:
  browserctl open <url>                 Navigate target tab to url (alias: navigate)
  browserctl back | forward | reload    History navigation
  browserctl tab [list]                 List open tabs and target tab (alias: tabs)
  browserctl tab new [url]              Open new tab (alias: new_tab)
  browserctl tab switch <id>            Switch target to tab ID (alias: switch_tab)
  browserctl tab close [id]             Close tab (alias: close_tab)

Inspection & Query (get):
  browserctl snapshot [-c|--compact]    Capture interactive DOM elements (compact saves ~75% tokens)
  browserctl read_page [mode]           Read accessibility tree & text (mode: interactive | all)
  browserctl get text <target>          Get visible text of element (@e1, ref_1, selector)
  browserctl get value <target>         Get value of input/textarea/select
  browserctl get attr <target> <name>   Get attribute value (e.g. href, src, placeholder)
  browserctl get title                  Get current page title
  browserctl get url                    Get current page URL
  browserctl get html [<target>]        Get HTML of element or whole document
  browserctl get box <target>           Get bounding box coordinates (x, y, width, height)
  browserctl get count <selector>       Count matching elements

Interaction:
  browserctl click <target>             Click element (@e1, ref_1, 0, --text "...", --selector "...")
  browserctl dblclick <target>          Double-click element
  browserctl fill <target> <text>       Clear input and fill text (@e1, ref_1, --placeholder "...")
  browserctl type <target> <text>       Type into input field (appends/types text)
  browserctl clear <target>             Clear input/textarea field
  browserctl check <target>             Check checkbox or radio button
  browserctl uncheck <target>           Uncheck checkbox
  browserctl select <target> <val...>   Select option in dropdown by value or --label "..."
  browserctl hover <target>             Hover over element
  browserctl focus <target>             Focus target element
  browserctl scroll [up|down] [amount]  Scroll current page
  browserctl scrollintoview <target>    Scroll element into view
  browserctl press <key>                Press key (Enter, Tab, Escape, etc.)

Wait & Synchronization:
  browserctl wait <ms>                  Sleep for specified milliseconds (e.g. wait 2000)
  browserctl wait <target>              Wait for element to appear in DOM
  browserctl wait --text "..."          Wait for visible text to appear
  browserctl wait --selector "..."      Wait for CSS selector to appear
  browserctl wait --network-idle        Wait for network activity to settle
  browserctl wait --settle              Wait for DOM mutations and animations to finish

Capture & Export:
  browserctl screenshot [file.png] [-f] Take viewport or fullpage screenshot (saves to file or returns base64)
  browserctl pdf [file.pdf]             Print page to PDF (saves to file or returns base64)
  browserctl eval <expression> [-r]     Evaluate JavaScript (use -r / --raw for raw stdout output)

System & Raw Protocols:
  browserctl exec_system_cmd <cmd>      Run host system command
  browserctl <action> [key=value ...]   Run any of the 68+ protocol actions

Global Flags:
  -c, --compact                         Output compact token-efficient representation
  -r, --raw                             Output raw unformatted value (for eval and get)
  -f, --full, --fullpage                Capture fullpage screenshot
  -t, --tab <id>                        Direct command to specific tab ID
  --settle <ms>                         Auto-settle delay after action (default: 150ms)
  --json                                Force JSON output
  --no-daemon                           Do not auto-start bridge daemon if not running

Environment:
  BROWSERCTL_BRIDGE_URL                 Default: http://127.0.0.1:8765
  BROWSERCTL_MCP_PROFILE                'core' (default) or 'all'
`);
}

async function isBridgeRunning() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startBridgeDaemon() {
  const serverPath = join(__dirname, "bridge", "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Bridge server not found at: ${serverPath}`);
  }

  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: "8765" },
  });
  child.unref();

  // Poll up to 2.5s for bridge to become ready
  const start = Date.now();
  while (Date.now() - start < 2500) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isBridgeRunning()) {
      return true;
    }
  }
  return false;
}

function stopBridgeDaemon() {
  try {
    const pids = execSync("lsof -ti :8765 -sTCP:LISTEN", { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      process.kill(parseInt(pid, 10), "SIGTERM");
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

async function ensureBridge(autoDaemon = true) {
  if (await isBridgeRunning()) return true;
  if (!autoDaemon) {
    process.stderr.write("[browserctl] Error: Bridge daemon is not running. Start it with 'browserctl start'.\n");
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

  // Matches @e1, @1, e1, ref_1, ref1, 1, 0
  const m = trimmed.match(/^@?(?:e|ref_?)?(\d+)$/i);
  if (m) {
    params.ref = trimmed;
    return;
  }

  if (trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.includes(">") || trimmed.includes("[")) {
    params.selector = trimmed;
  } else {
    params.ref = trimmed;
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("-h") || rawArgs.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  let action = rawArgs[0];
  let args = rawArgs.slice(1);

  let jsonOutput = false;
  let rawOutput = false;
  let compactMode = false;
  let fullpageMode = false;
  let autoDaemon = true;
  let explicitTabId = null;
  let settleMs = null;

  // Filter global flags
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      jsonOutput = true;
    } else if (a === "-r" || a === "--raw") {
      rawOutput = true;
    } else if (a === "-c" || a === "--compact") {
      compactMode = true;
    } else if (a === "-f" || a === "--full" || a === "--fullpage") {
      fullpageMode = true;
    } else if (a === "--no-daemon") {
      autoDaemon = false;
    } else if (a === "-t" || a === "--tab") {
      explicitTabId = parseInt(args[++i], 10);
    } else if (a.startsWith("--tab=")) {
      explicitTabId = parseInt(a.slice(6), 10);
    } else if (a === "--settle") {
      settleMs = parseInt(args[++i], 10);
    } else if (a.startsWith("--settle=")) {
      settleMs = parseInt(a.slice(9), 10);
    } else {
      filteredArgs.push(a);
    }
  }
  args = filteredArgs;

  // Daemon control actions
  if (action === "start" || action === "daemon") {
    if (await isBridgeRunning()) {
      console.log(JSON.stringify({ ok: true, message: "Bridge is already running", url: BRIDGE_URL }, null, 2));
      process.exit(0);
    }
    const started = await startBridgeDaemon();
    if (started) {
      console.log(JSON.stringify({ ok: true, message: "Bridge started", url: BRIDGE_URL }, null, 2));
      process.exit(0);
    } else {
      console.error(JSON.stringify({ ok: false, error: "Failed to start bridge daemon" }, null, 2));
      process.exit(1);
    }
  }

  if (action === "stop") {
    const stopped = stopBridgeDaemon();
    console.log(JSON.stringify({ ok: true, message: stopped ? "Bridge stopped" : "Bridge was not running" }, null, 2));
    process.exit(0);
  }

  if (action === "restart") {
    stopBridgeDaemon();
    await new Promise((r) => setTimeout(r, 200));
    const started = await startBridgeDaemon();
    console.log(JSON.stringify({ ok: started, message: started ? "Bridge restarted" : "Failed to restart" }, null, 2));
    process.exit(started ? 0 : 1);
  }

  if (action === "status") {
    try {
      const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(1000) });
      const data = await res.json();
      console.log(JSON.stringify({ ok: res.ok, ...data }, null, 2));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: `Bridge unreachable: ${err.message}` }, null, 2));
      process.exit(1);
    }
    return;
  }

  // Ensure bridge is up for other actions
  await ensureBridge(autoDaemon);

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
      console.log(ms);
    } else {
      console.log(JSON.stringify({ ok: true, waitedMs: ms }, null, 2));
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
        if (compactMode) params.compact = true;
        if (args[0] && /^\d+$/.test(args[0])) params.maxText = parseInt(args[0], 10);
        break;

      case "read_page":
        if (args[0]) params.mode = args[0];
        break;

      case "get": {
        const prop = args[0] || "text";
        params.property = prop;
        if (prop === "title" || prop === "url") {
          // No target needed
        } else if (prop === "attr") {
          if (args[1]) parseTarget(args[1], params);
          if (args[2]) params.attr = args[2];
        } else if (prop === "count") {
          if (args[1]) params.selector = args[1];
        } else {
          if (args[1]) parseTarget(args[1], params);
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
      case "describe_element":
      case "element_screenshot": {
        let i = 0;
        while (i < args.length) {
          if (args[i] === "--text" && args[i + 1]) {
            params.text = args[++i];
          } else if (args[i] === "--selector" && args[i + 1]) {
            params.selector = args[++i];
          } else {
            parseTarget(args[i], params);
          }
          i++;
        }
        break;
      }

      case "type": {
        let i = 0;
        let textArg = null;
        while (i < args.length) {
          if (args[i] === "--placeholder" && args[i + 1]) {
            params.placeholder = args[++i];
          } else if (args[i] === "--selector" && args[i + 1]) {
            params.selector = args[++i];
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
          } else if (args[i] === "--settle") {
            action = "wait_settle";
            hasType = true;
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
        if (fullpageMode || action === "screenshot_fullpage") {
          action = "screenshot_fullpage";
        } else {
          action = "screenshot";
        }
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

      case "scroll":
        if (args[0] === "up" || args[0] === "down") params.direction = args[0];
        if (args[1] && /^\d+$/.test(args[1])) params.amount = parseInt(args[1], 10);
        break;

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

      default:
        // Parse key=value pairs
        for (const arg of args) {
          const eq = arg.indexOf("=");
          if (eq > 0) {
            const k = arg.slice(0, eq);
            let v = arg.slice(eq + 1);
            if (v === "true") v = true;
            else if (v === "false") v = false;
            else if (/^\d+$/.test(v)) v = parseInt(v, 10);
            params[k] = v;
          }
        }
        break;
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
      console.error(JSON.stringify({ ok: false, error: data.error || `HTTP ${res.status}` }, null, 2));
      process.exit(1);
    }

    const result = data.result !== undefined ? data.result : data;

    // Handle binary file saving for screenshot and pdf
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
        if (jsonOutput) {
          console.log(JSON.stringify({ ok: true, saved: saveFilePath, bytes: buf.length }, null, 2));
        } else {
          console.log(`Saved ${action === "print_pdf" ? "PDF" : "screenshot"} to ${saveFilePath} (${buf.length} bytes)`);
        }
        return;
      }
    }

    // Raw string / unformatted output mode
    if (rawOutput) {
      if (typeof result?.value === "string" || typeof result?.value === "number") {
        console.log(result.value);
        return;
      }
      if (typeof result?.text === "string") {
        console.log(result.text);
        return;
      }
      if (typeof result?.url === "string") {
        console.log(result.url);
        return;
      }
    }

    // Friendly compact formatting for snapshot if requested and not forced JSON
    if (action === "snapshot" && compactMode && result?.compactView && !jsonOutput) {
      console.log(`Page: ${result.title || "Untitled"} (${result.url})`);
      console.log(`Interactive elements (${result.elements?.length || 0}):\n`);
      console.log(result.compactView);
      return;
    }

    // Friendly string formatting for get_property when not forced JSON
    if (action === "get_property" && !jsonOutput && result?.value !== undefined) {
      if (typeof result.value === "object") {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(result.value);
      }
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
