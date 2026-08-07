#!/usr/bin/env node
// CLI Helper for browserctl bridge
//
// Usage:
//   node cli.js status
//   node cli.js navigate https://example.com
//   node cli.js read_page
//   node cli.js snapshot
//   node cli.js click ref_1  (or index 0)
//   node cli.js type ref_2 "hello text"
//   node cli.js exec_system_cmd "echo hello"
//   node cli.js <action> '{"key": "value"}'

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

const BRIDGE_URL = envStr("BROWSERCTL_BRIDGE_URL", envStr("BRIDGE_URL", "http://127.0.0.1:8765"));

const [,, action, ...args] = process.argv;

if (!action || action === "--help" || action === "-h") {
  console.log(`
browserctl CLI Helper

Usage:
  node cli.js status
  node cli.js navigate <url>
  node cli.js read_page
  node cli.js snapshot
  node cli.js click <ref_or_index>
  node cli.js type <ref_or_index> <text>
  node cli.js exec_system_cmd <command>
  node cli.js <action> [paramsJSON]
  node cli.js <action> [key=value ...]

Environment:
  BROWSERCTL_BRIDGE_URL (default: http://127.0.0.1:8765)
`);
  process.exit(0);
}

async function run() {
  if (action === "status") {
    try {
      const res = await fetch(`${BRIDGE_URL}/status`);
      const data = await res.json();
      console.log(JSON.stringify({ ok: res.ok, ...data }, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
      process.exit(1);
    }
    return;
  }

  let params = {};

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      params = JSON.parse(args[0]);
    } catch (e) {
      console.error("Invalid JSON params:", args[0]);
      process.exit(1);
    }
  } else {
    // Positional shortcuts for common actions
    switch (action) {
      case "navigate":
      case "new_tab":
        if (args[0]) params.url = args[0];
        break;
      case "click":
      case "hover":
      case "describe_element":
      case "element_screenshot":
        if (args[0]) {
          if (/^\d+$/.test(args[0])) params.index = parseInt(args[0], 10);
          else params.ref = args[0];
        }
        break;
      case "type":
        if (args[0]) {
          if (/^\d+$/.test(args[0])) params.index = parseInt(args[0], 10);
          else params.ref = args[0];
        }
        if (args[1]) params.text = args[1];
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
    console.log(JSON.stringify(data, null, 2));
    if (!data.ok) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

run();
