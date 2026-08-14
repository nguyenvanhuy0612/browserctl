#!/usr/bin/env node
// CLI Helper for browserctl bridge & MCP client
//
// Usage:
//   browserctl status
//   browserctl start | stop | restart
//   browserctl open https://example.com
//   browserctl snapshot [--compact]
//   browserctl click @e1 | ref_1 | 0 | --text "Sign In" | --selector "#btn"
//   browserctl type @e2 "my text" [--submit] | --placeholder "Search" "my query"
//   browserctl hover @e3
//   browserctl scroll [up|down] [amount]
//   browserctl eval "document.title"
//   browserctl screenshot [output.png]
//   browserctl tabs
//   browserctl <action> [key=value ...] [--tab <id>]

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
browserctl CLI — Universal Browser Control for AI Agents & Developers

Usage:
  browserctl status                     Check bridge health & extension connection
  browserctl start                      Start bridge daemon in background
  browserctl stop                       Stop running bridge daemon
  browserctl restart                    Restart bridge daemon

Navigation & Tabs:
  browserctl open <url>                 Navigate target tab to url (alias: navigate)
  browserctl tabs                       List open tabs and target tab (alias: list_tabs)
  browserctl new_tab [url]              Open new tab
  browserctl switch_tab <id>            Switch target to tab ID
  browserctl close_tab [id]             Close tab

Inspection:
  browserctl snapshot [-c|--compact]    Capture interactive DOM elements (compact mode saves 75% tokens)
  browserctl read_page [mode]           Read accessibility tree (mode: interactive | all)
  browserctl screenshot [file.png]      Capture screenshot (returns base64 or saves to file)

Interaction:
  browserctl click <target>             Click element (@e1, ref_1, 0, --text "...", --selector "...")
  browserctl type <target> <text>       Type into input field (@e1, ref_1, --placeholder "...")
  browserctl hover <target>             Hover over element
  browserctl scroll [up|down] [amount]  Scroll current page
  browserctl press_key <key>            Press key (Enter, Tab, Escape, etc.)
  browserctl eval <expression>          Evaluate JavaScript expression

System & Raw Actions:
  browserctl exec_system_cmd <cmd>      Run host system command
  browserctl <action> [key=value ...]   Run any of the 68+ protocol actions

Global Flags:
  -c, --compact                         Output compact token-efficient representation
  -t, --tab <id>                        Direct command to specific tab ID
  --settle <ms>                         Auto-settle delay after action (default: 150ms)
  --json                                Force raw JSON output
  --no-daemon                           Do not auto-start bridge daemon if not running

Environment:
  BROWSERCTL_BRIDGE_URL                 Default: http://127.0.0.1:8765
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

  // Wait up to 2.5s for bridge to become healthy
  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (await isBridgeRunning()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function stopBridgeDaemon() {
  try {
    // Try finding process listening on 8765
    const output = execSync("lsof -ti :8765", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (output) {
      const pids = output.split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
        } catch {}
      }
      return true;
    }
  } catch {
    // lsof failed or no process found
  }
  return false;
}

async function ensureBridge(autoDaemon = true) {
  if (await isBridgeRunning()) return true;
  if (!autoDaemon) return false;

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

  // Check if starts with --text or --selector
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
  let compactMode = false;
  let autoDaemon = true;
  let explicitTabId = null;
  let settleMs = null;

  // Filter global flags
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      jsonOutput = true;
    } else if (a === "-c" || a === "--compact") {
      compactMode = true;
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

  // Alias mappings
  if (action === "open") action = "navigate";
  if (action === "tabs") action = "list_tabs";
  if (action === "eval" || action === "browser_eval_js") action = "eval_js";

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

      case "click":
      case "hover":
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

    // Friendly compact formatting for snapshot if requested and not forced JSON
    if (action === "snapshot" && compactMode && data.result?.compactView && !jsonOutput) {
      console.log(`Page: ${data.result.title || "Untitled"} (${data.result.url})`);
      console.log(`Interactive elements (${data.result.elements?.length || 0}):\n`);
      console.log(data.result.compactView);
      return;
    }

    console.log(JSON.stringify(data.result !== undefined ? data.result : data, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
