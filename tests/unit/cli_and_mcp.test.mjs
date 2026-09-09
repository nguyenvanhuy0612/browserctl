import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import util from "node:util";
import {
  getDaemonState,
  markDaemonRunning,
  markDaemonStopped,
  isDaemonExplicitlyStopped,
} from "../../bridge/state.js";

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "cli.js");

test("CLI: prints help text when invoked with --help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.ok(stdout.includes("browserctl CLI"));
  assert.ok(stdout.includes("browserctl click"));
  assert.ok(stdout.includes("browserctl snapshot"));
  assert.ok(stdout.includes("--compact"));
});

test("CLI: status supports --json and default human output", async () => {
  const { stdout: jsonOut } = await execFileAsync(process.execPath, [cliPath, "status", "--json"]);
  const data = JSON.parse(jsonOut);
  assert.equal(typeof data.ok, "boolean");
  assert.ok(data.daemonState);

  const { stdout: defaultOut } = await execFileAsync(process.execPath, [cliPath, "status"]);
  assert.ok(defaultOut.includes("Bridge:"));
});

test("CLI: wait supports default, --json, --pretty, and -r modes", async () => {
  // 1. JSON mode
  const { stdout: jsonOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "--json"]);
  const jsonData = JSON.parse(jsonOut);
  assert.ok(jsonData.ok);
  assert.equal(jsonData.waitedMs, 50);

  // 2. Pretty mode
  const { stdout: prettyOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "--pretty"]);
  assert.ok(prettyOut.includes("\n  \"waitedMs\": 50\n"));

  // 3. Raw mode
  const { stdout: rawOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "-r"]);
  assert.equal(rawOut.trim(), "50");

  // 4. Default mode
  const { stdout: defaultOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50"]);
  assert.ok(defaultOut.includes("Waited 50ms"));
});

test("MCP: core profile registers lifecycle and dynamic load/unload tools", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server, TOOL_CATEGORIES } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const initialTools = Object.values(server._registeredTools).filter(t => t.enabled !== false);
    const initialCount = initialTools.length;

    // 1. Check browser_list_available_tools
    const listHandler = server._registeredTools["browser_list_available_tools"].handler;
    const listRes = await listHandler();
    if (!listRes.content[0].text.includes("categories")) throw new Error("List failed");

    // 2. Load 'network' category
    const loadHandler = server._registeredTools["browser_load_tools"].handler;
    await loadHandler({ profile: "network" });
    const afterLoadCount = Object.values(server._registeredTools).filter(t => t.enabled !== false).length;
    if (afterLoadCount <= initialCount) throw new Error("Load profile network failed: count did not increase");

    // 3. Unload back to core
    const unloadHandler = server._registeredTools["browser_unload_tools"].handler;
    await unloadHandler();
    const afterUnloadCount = Object.values(server._registeredTools).filter(t => t.enabled !== false).length;
    if (afterUnloadCount !== initialCount) throw new Error("Reset to core failed: count did not match initial");

    console.log("DYNAMIC_LOAD_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("DYNAMIC_LOAD_OK"));
});

test("State Manager: transitions between running, stopped, and uninitialized correctly", () => {
  // Test running state
  const runState = markDaemonRunning({ pid: 12345, port: 8765 });
  assert.equal(runState.state, "running");
  assert.equal(runState.pid, 12345);
  assert.equal(isDaemonExplicitlyStopped(), false);

  // Test stopped state
  const stopState = markDaemonStopped({ stoppedBy: "cli_stop" });
  assert.equal(stopState.state, "stopped");
  assert.equal(stopState.stoppedBy, "cli_stop");
  assert.equal(isDaemonExplicitlyStopped(), true);

  // Recover back to running
  markDaemonRunning({ pid: 54321, port: 8765 });
  assert.equal(isDaemonExplicitlyStopped(), false);
});

test("CLI: prints full subcommands in help output", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.ok(stdout.includes("browserctl get"));
  assert.ok(stdout.includes("browserctl fill"));
  assert.ok(stdout.includes("browserctl paste"));
  assert.ok(stdout.includes("browserctl clear"));
  assert.ok(stdout.includes("browserctl check"));
  assert.ok(stdout.includes("browserctl select"));
  assert.ok(stdout.includes("browserctl wait"));
  assert.ok(stdout.includes("browserctl pdf"));
  assert.ok(stdout.includes("browserctl dismiss"));
  assert.ok(stdout.includes("--pretty"));
  assert.ok(stdout.includes("--raw"));
  assert.ok(stdout.includes("--auto-daemon"));
});

test("MCP: core profile registers get_* tools and browser_dismiss_modal", async () => {
  const script = `
    import { TOOL_CATEGORIES } from "./mcp/index.js";
    if (!TOOL_CATEGORIES.core.includes("browser_get_text")) throw new Error("missing browser_get_text in core");
    if (!TOOL_CATEGORIES.core.includes("browser_get_attribute")) throw new Error("missing browser_get_attribute in core");
    if (!TOOL_CATEGORIES.core.includes("browser_get_count")) throw new Error("missing browser_get_count in core");
    if (!TOOL_CATEGORIES.core.includes("browser_dismiss_modal")) throw new Error("missing browser_dismiss_modal in core");
    console.log("CORE_GET_TOOLS_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("CORE_GET_TOOLS_OK"));
});

test("CLI: parseTarget resolves custom elements and frame-qualified refs", async () => {
  const script = `
    const HTML_TAGS = new Set(["button", "input", "a", "div", "span"]);
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

      if (trimmed.startsWith("@")) {
        params.ref = trimmed;
        return;
      }

      if (/^(?:f\\w+:)?(?:ref_?|e)\\w+$/i.test(trimmed)) {
        params.ref = "@" + trimmed;
        return;
      }

      if (/^\\d+$/.test(trimmed)) {
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

    const p1 = {};
    parseTarget("ytd-active-account-header-renderer", p1);
    if (p1.selector !== "ytd-active-account-header-renderer") throw new Error("Failed custom tag 1");

    const p2 = {};
    parseTarget("tp-yt-paper-icon-item", p2);
    if (p2.selector !== "tp-yt-paper-icon-item") throw new Error("Failed custom tag 2");

    const p3 = {};
    parseTarget("@ref_12", p3);
    if (p3.ref !== "@ref_12") throw new Error("Failed ref");

    const p4 = {};
    parseTarget("--text=Normal Text", p4);
    if (p4.text !== "Normal Text") throw new Error("Failed text prefix");

    const p5 = {};
    parseTarget("@f898:ref_54", p5);
    if (p5.ref !== "@f898:ref_54") throw new Error("Failed frame-qualified ref with @");

    const p6 = {};
    parseTarget("f898:ref_54", p6);
    if (p6.ref !== "@f898:ref_54") throw new Error("Failed frame-qualified ref without @");

    console.log("PARSE_TARGET_OK");
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("PARSE_TARGET_OK"));
});

test("MCP: schemas and descriptions document SPA settle, tolerance, and CSP fallback", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "all";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");

    // 1. Check browser_wait_network_idle schema has maxInFlight
    const waitNet = server._registeredTools["browser_wait_network_idle"];
    if (!waitNet) throw new Error("browser_wait_network_idle not registered");
    if (!waitNet.description.includes("SPAs")) throw new Error("Missing SPA guidance in wait_network_idle");
    const netShape = waitNet.inputSchema.shape;
    if (!netShape.maxInFlight) throw new Error("Missing maxInFlight parameter in wait_network_idle schema");

    // 2. Check browser_wait_settle description
    const waitSettle = server._registeredTools["browser_wait_settle"];
    if (!waitSettle) throw new Error("browser_wait_settle not registered");
    if (!waitSettle.description.includes("SPAs")) throw new Error("Missing SPAs in wait_settle description");

    // 3. Check browser_eval_js description
    const evalJs = server._registeredTools["browser_eval_js"];
    if (!evalJs) throw new Error("browser_eval_js not registered");
    if (!evalJs.description.includes("CSP") || !evalJs.description.includes("Trusted Types")) {
      throw new Error("Missing CSP / Trusted Types in eval_js description");
    }

    // 4. Check browser_snapshot description
    const snap = server._registeredTools["browser_snapshot"];
    if (!snap) throw new Error("browser_snapshot not registered");
    if (!snap.description.includes("key inputs") || !snap.description.includes("folded")) {
      throw new Error("Missing key inputs preservation or folding in snapshot description");
    }

    console.log("MCP_TOOL_DESCRIPTIONS_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_TOOL_DESCRIPTIONS_OK"));
});

test("Network Idle: waitNetworkIdle supports maxInFlight tolerance and emits recoveryHint on timeout", async () => {
  const { waitNetworkIdle } = await import("../../extension/netlog.js");

  // On a non-existent/idle tabId with no in-flight requests, it resolves immediately
  const res = await waitNetworkIdle(999999, 50, 200, 0);
  assert.equal(res.idle, true);
  assert.equal(res.inFlight, 0);
});

// Every action the content script can handle must also be routable to it. The routing
// allowlist (background.js CONTENT_ACTIONS) and the content dispatch table (content.js
// `handlers`) are edited in different files, so a handler added to one and forgotten in
// the other produces a tool that registers fine, passes every registration test, and
// then fails at runtime with a transport-shaped "unknown action" error. That is exactly
// how browser_dismiss_modal shipped dead. Assert the invariant instead of the symptom.
test("Extension: every content.js handler is routable (CONTENT_ACTIONS or background-handled)", async () => {
  const fs = await import("node:fs/promises");
  const extDir = join(__dirname, "..", "..", "extension");
  const content = await fs.readFile(join(extDir, "content.js"), "utf8");
  const background = await fs.readFile(join(extDir, "background.js"), "utf8");

  const tableSrc = content.match(/const handlers = \{([\s\S]*?)\n  \};/);
  assert.ok(tableSrc, "content.js must expose a `const handlers = { ... }` dispatch table");
  const handlerNames = [...tableSrc[1].matchAll(/^\s{4}([a-z_0-9]+)\s*(?::|,)/gm)].map((m) => m[1]);
  assert.ok(handlerNames.length > 20, `expected many content handlers, got ${handlerNames.length}`);

  const allowSrc = background.match(/const CONTENT_ACTIONS = \[([\s\S]*?)\];/);
  assert.ok(allowSrc, "background.js must expose a `const CONTENT_ACTIONS = [ ... ]` allowlist");
  const allowlisted = new Set([...allowSrc[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));

  const unroutable = handlerNames.filter(
    (name) =>
      !allowlisted.has(name) &&
      // a handler may instead be served by background.js itself (e.g. wait_for, record_*)
      !new RegExp(`case "${name}"|"${name}":`).test(background)
  );
  assert.deepEqual(
    unroutable,
    [],
    `content.js handles these actions but nothing routes them: ${unroutable.join(", ")}`
  );
});

// Mirror of the above from the caller side: an action name typed into callBridge() that
// no layer implements is a dead tool, and the failure surfaces to the agent as a bridge
// connectivity error rather than a missing capability.
test("MCP: every callBridge action name is implemented somewhere", async () => {
  const fs = await import("node:fs/promises");
  const root = join(__dirname, "..", "..");
  const mcp = await fs.readFile(join(root, "mcp", "index.js"), "utf8");
  const content = await fs.readFile(join(root, "extension", "content.js"), "utf8");
  const background = await fs.readFile(join(root, "extension", "background.js"), "utf8");
  const cdp = await fs.readFile(join(root, "extension", "cdp.js"), "utf8");
  const netlog = await fs.readFile(join(root, "extension", "netlog.js"), "utf8");
  const bridge = await fs.readFile(join(root, "bridge", "server.js"), "utf8");
  const impl = content + background + cdp + netlog + bridge;

  const called = new Set(
    [...mcp.matchAll(/callBridge\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1])
  );
  assert.ok(called.size > 30, `expected many bridge actions, got ${called.size}`);

  const missing = [...called].filter(
    (name) => !new RegExp(`"${name}"|\\b${name}\\b\\s*[,:)]`).test(impl)
  );
  assert.deepEqual(missing, [], `MCP calls actions no layer implements: ${missing.join(", ")}`);
});

// A command that the bridge answered and the page rejected is an APPLICATION error, not
// a transport error. Two things must hold: it is not retried (a retried click dispatches
// the action twice), and its structured fields survive to the agent. Both were broken —
// the catch-all rethrew every failure as "cannot reach bridge at ...", discarding
// code/diagnostics/recoveryHint, which is every structured error the extension produces.
test("MCP: application errors keep their code/recoveryHint and are not retried", async () => {
  const script = `
    import http from "node:http";
    let requestCount = 0;
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { action } = JSON.parse(body || "{}");
        if (action === "click") requestCount++;
        if (action === "status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result: { ready: true } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: 'ref "ref_4" not found or stale',
          code: "STALE_REF",
          recoveryHint: "Call snapshot again to refresh refs.",
        }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + port;
    process.env.BROWSERCTL_AUTO_START = "manual";
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");

    const clickHandler = server._registeredTools["browser_click"].handler;
    const before = requestCount;
    let out = "";
    try {
      const res = await clickHandler({ ref: "ref_4" });
      out = JSON.stringify(res);
    } catch (err) {
      out = String(err?.message || err);
    }
    const commandRequests = requestCount - before;

    if (!out.includes("STALE_REF")) throw new Error("lost error code, got: " + out);
    if (!out.includes("refresh refs")) throw new Error("lost recoveryHint, got: " + out);
    if (out.includes("cannot reach bridge")) throw new Error("app error mislabelled as transport: " + out);
    if (commandRequests !== 1) throw new Error("action dispatched " + commandRequests + " times, expected 1");

    console.log("APP_ERROR_OK");
    srv.close();
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("APP_ERROR_OK"), stdout);
});

// The MCP layer is where several capability and honesty fixes live, and it cannot be
// exercised by reloading the extension — so assert it here with a stub bridge.
test("MCP: get_text forwards the property enum, and qualifiers survive formatting", async () => {
  const script = `
    import http from "node:http";
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { action, params } = JSON.parse(body || "{}");
        seen.push({ action, params });
        res.writeHead(200, { "content-type": "application/json" });
        if (action === "status") return res.end(JSON.stringify({ ok: true, result: { ready: true } }));
        if (params && params.property === "html") {
          return res.end(JSON.stringify({ ok: true, result: { property: "html", value: "<h1>Hi</h1>", matchCount: 3, note: "selector matched 3 elements; this is the first" } }));
        }
        return res.end(JSON.stringify({ ok: true, result: { property: "attr", name: "open", present: false, value: null } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + srv.address().port;
    process.env.BROWSERCTL_AUTO_START = "manual";
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");

    // property is forwarded, not hardcoded to "text"
    const getText = server._registeredTools["browser_get_text"].handler;
    const htmlRes = await getText({ selector: "h1", property: "html" });
    const sent = seen.filter((s) => s.action === "get_property").pop();
    if (sent.params.property !== "html") throw new Error("property not forwarded: " + JSON.stringify(sent.params));
    const htmlText = htmlRes.content[0].text;
    if (!htmlText.includes("<h1>Hi</h1>")) throw new Error("lost value: " + htmlText);
    if (!htmlText.includes("matched 3 elements")) throw new Error("dropped multi-match note: " + htmlText);

    // an absent attribute must not render as empty output
    const getAttr = server._registeredTools["browser_get_attribute"].handler;
    const attrText = (await getAttr({ selector: "dialog", attr: "open" })).content[0].text;
    if (!/not present/.test(attrText)) throw new Error("absent attribute rendered as: " + JSON.stringify(attrText));

    console.log("MCP_PROPERTY_OK");
    srv.close();
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_PROPERTY_OK"), stdout);
});

// Capability discovery. A small model given no prompt concluded that network capture,
// cookies, HAR, recording and profiling were impossible — all of them exist behind
// browser_load_tools. The prompt has to live in the tool surface, so assert it is there.
test("MCP: unloaded capabilities are advertised, and browser_action lists its catalogue", async () => {
  const script = `
    import http from "node:http";
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        const { action } = JSON.parse(body || "{}");
        if (action === "status") return res.end(JSON.stringify({ ok: true, result: { ready: true } }));
        return res.end(JSON.stringify({ ok: true, result: {
          url: "https://example.com", title: "Example", scope: "viewport",
          viewport: { width: 800, height: 600, scrollY: 0, scrollHeight: 600, scrollPercent: 0 },
          elements: [], compactView: "  [@ref_1] <button> \\"Go\\"",
        } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + srv.address().port;
    process.env.BROWSERCTL_AUTO_START = "manual";
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");

    // 1. every snapshot carries a one-line pointer to what is not loaded
    const snapText = (await server._registeredTools["browser_snapshot"].handler({})).content[0].text;
    if (!/more capabilities not loaded/.test(snapText)) throw new Error("no capability hint on snapshot: " + snapText);
    for (const profile of ["network", "cookies", "storage", "console"]) {
      if (!snapText.includes(profile)) throw new Error("hint omits profile " + profile + ": " + snapText);
    }

    // 2. browser_action with no arguments returns the dispatchable action catalogue
    const cat = (await server._registeredTools["browser_action"].handler({})).content[0].text;
    for (const a of ["export_har", "get_cookies", "dismiss", "get_property"]) {
      if (!cat.includes(a)) throw new Error("catalogue omits " + a + ": " + cat.slice(0, 400));
    }

    // 3. load_tools describes capabilities, not just profile names
    const desc = server._registeredTools["browser_load_tools"].description || "";
    for (const phrase of ["capture every request", "cookies", "localStorage", "console messages"]) {
      if (!desc.includes(phrase)) throw new Error("load_tools description omits: " + phrase);
    }

    console.log("MCP_DISCOVERY_OK");
    srv.close();
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_DISCOVERY_OK"), stdout);
});

// The v2 working tree had shortened these two descriptions, deleting the scope facts an
// agent needs to interpret an empty result, in exchange for a "parameter is REQUIRED"
// nag the schema already enforces. Pin the facts so that cannot silently happen again.
test("MCP: find and find_text descriptions state their real scope", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const ft = server._registeredTools["browser_find_text"].description || "";
    const f = server._registeredTools["browser_find"].description || "";
    const checks = [
      [ft, "NOT iframes", "find_text must say it does not search iframes"],
      [ft, "Shadow DOM", "find_text must say it searches shadow DOM"],
      [ft, "nearestInteractive", "find_text must document nearestInteractive"],
      [ft, "searchedScope", "find_text must point at searchedScope"],
      [f, "f3:ref_5", "find must document frame-qualified refs"],
      [f, "verbatim", "find must say frame refs are passed back verbatim"],
      [f, "matchedBy", "find must document matchedBy"],
    ];
    for (const [text, needle, msg] of checks) {
      if (!text.includes(needle)) throw new Error(msg + " (missing: " + needle + ")");
    }
    console.log("MCP_DESC_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_DESC_OK"), stdout);
});

// ---------------------------------------------------------------------------
// Round-2 regression guards (F27, F30, F33, F34, F35, F36, F38, F39)
//
// Six of the round-2 defects were wording or a single default, and every one of them
// survived a fully green suite. These pin the corrections at source level, which is the
// only coverage content.js has.
// ---------------------------------------------------------------------------


// Runs an assertion script against the MCP server in a subprocess (importing it starts a
// server, so it must not be pulled into the test process). Mirrors the pattern above.
async function mcpDescriptions() {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "all";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const out = {};
    for (const [name, t] of Object.entries(server._registeredTools)) {
      out[name] = { description: t.description || "", shape: {} };
      const shape = t.inputSchema && t.inputSchema.shape;
      if (shape) for (const [k, v] of Object.entries(shape)) out[name].shape[k] = (v && v.description) || "";
    }
    console.log("JSON_START" + JSON.stringify(out) + "JSON_END");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  const m = stdout.match(/JSON_START([\s\S]*)JSON_END/);
  assert.ok(m, "MCP description dump failed");
  return JSON.parse(m[1]);
}

test("Snapshot description states real scope semantics, not the 75-85% claim", async () => {
  const tools = await mcpDescriptions();
  const snap = tools["browser_snapshot"];
  assert.ok(snap, "browser_snapshot must be registered");
  const d = snap.description;

  assert.ok(!/75-85%/.test(d), "F36: the measured saving is ~3-35%, not 75-85% — claim must not return");
  assert.ok(
    /every element currently in the DOM|everything currently in the DOM/i.test(d),
    "F39: 'all' must be described as DOM contents, not 'everything'"
  );
  assert.ok(/not everything the page can show|keep most rows out of the DOM/i.test(d),
    "F39: description must warn that lazy lists are not covered by any scope");
  assert.ok(/count|complete list/i.test(d), "F38: must tell the agent when to prefer 'all'");

  const scopeDesc = snap.shape.scope || "";
  assert.ok(!/token-efficient/.test(scopeDesc) || /NOT every row/.test(scopeDesc),
    "F39: the scope parameter itself must not promise more than it delivers");
});

test("find documents whole-page scope and the zero-match near-miss", async () => {
  const tools = await mcpDescriptions();
  const d = tools["browser_find"].description;
  assert.ok(/WHOLE PAGE/i.test(d), "F38: find's page-wide scope must be explicit next to snapshot's viewport default");
  assert.ok(/nearest/.test(d), "F34: a zero-match must advertise near-miss candidates");
  assert.ok(/diacritic/i.test(d), "F34: name the folding that produces the candidates");
  assert.ok(/truncatedBy/.test(d), "F35: truncated labels must advertise how to get the rest");
});

test("read_page defaults deep enough for a real SPA and reports when it clips", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  const sig = content.match(/function read_page\(\{[^}]*depth\s*=\s*(\d+)/);
  assert.ok(sig, "read_page must declare a depth default");
  const depth = Number(sig[1]);
  assert.ok(depth >= 40, `F33: depth default ${depth} is too shallow — a Comet/React SPA nests 25-45 levels`);

  assert.ok(/depthClipped/.test(content), "F33: read_page must report when the walk stopped early");

  // F43: a zero-size portal wrapper must not prune its painted children. Only a
  // definitively hidden element (display:none / visibility:hidden) skips a subtree.
  assert.ok(
    /reason === "display:none" \|\| reason === "visibility:hidden"/.test(content),
    "F43: read_page must prune only definitively hidden subtrees"
  );
  assert.ok(!/if \(!isVisible\(child\)\) continue;/.test(content),
    "F43: pruning on isVisible(child) hides React-portal dialogs that are on screen");
  assert.ok(/SKIP_TAGS[\s\S]{0,200}SCRIPT/.test(content), "F33: mode='all' must not emit script bodies as a11y nodes");

  const tools = await mcpDescriptions();
  const d = tools["browser_read_page"].description;
  assert.ok(/depthClipped/.test(d), "F33: the empty-tree failure mode must be documented");
});

test("Snapshot notices name what was withheld and flag load-on-demand content", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // F30: the offscreen notice must describe kinds, not only a count.
  assert.ok(/describeElements/.test(content), "F30: notice must summarise what is offscreen");
  const notice = content.match(/\[Notice: \$\{elements\.length\}[^`]*`/);
  assert.ok(notice, "viewport notice must still be emitted");
  assert.ok(/including \$\{kinds/.test(content) || /\$\{detail\}/.test(content),
    "F30: the notice must interpolate a description of the withheld elements");

  // F38: 'all' must not be silent about its own folding.
  assert.ok(/scope === "all" && foldedCount > 0/.test(content),
    "F38: full-page scope must report folded elements too");

  // F39: load-more controls and overflowing regions must be surfaced.
  assert.ok(/Possible hidden content/.test(content), "F39: hidden-content hint line must exist");
  assert.ok(/LOAD_MORE_RE/.test(content), "F39: load-more controls must be detected");
  assert.ok(/will NOT reveal/.test(content), "F39: must say that --all cannot reveal undrawn rows");

  // F27: open dialogs are reported separately from blocking modals.
  assert.ok(/findOpenDialogs/.test(content), "F27: non-blocking dialogs must be detected");
  assert.ok(/openDialogs/.test(content), "F27: pageState must carry openDialogs");
  assert.ok(/does not block the page/.test(content), "F27: the compact view must announce a non-blocking dialog");

  // F35 / F36 / F28: census hygiene.
  assert.ok(/chars: get text @/.test(content), "F35: truncated labels must name the call that returns the rest");
  assert.ok(/OPAQUE_VALUE_CHARS/.test(content),
    "F36: href reduction must key on value opacity, not a per-site parameter list");
  assert.ok(/CONVENTIONAL_TRACKING/.test(content), "F36: cross-web tracking conventions must also be dropped");
  assert.ok(!/__cft__|fbclid|igshid/.test(content),
    "generality: no site-specific parameter names in the census — the heuristic must be site-agnostic");
  assert.ok(/aria-expanded=false/.test(content),
    "F39: load-more detection must use the platform flag, not only English labels");
  assert.ok(/duplicate link\$\{/.test(content) || /duplicate links? suppressed/.test(content),
    "F28: duplicate rows must be collapsed and reported");

  // F41: the content script's compact view must survive a multi-frame page.
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  assert.ok(!/compactLines\.push\(`\[Quick Actions/.test(bg),
    "F41: background.js must not rebuild a flat compact view — every real page has iframes, and the rebuild discarded landmarks, folding and every notice");
  assert.ok(/top\.result\.compactView/.test(bg) && /frame-qualified/.test(bg),
    "F41: sub-frame views must be appended with frame-qualified refs, not merged away");
});

test("Bridge can record a per-call log, and never records parameter values", async () => {
  const fs = await import("node:fs/promises");
  const server = await fs.readFile(join(__dirname, "..", "..", "bridge", "server.js"), "utf8");

  assert.ok(/BROWSERCTL_CALL_LOG/.test(server), "F32: an opt-in call log must exist");
  assert.ok(/function paramShape/.test(server), "F32: parameters must be reduced to a shape");

  const shape = server.match(/function paramShape\([\s\S]*?\n\}/);
  assert.ok(shape, "paramShape must be a standalone function");
  assert.ok(
    !/out\[k\] = v;\s*$/m.test(shape[0].replace(/typeof v === "number" \|\| typeof v === "boolean"\) out\[k\] = v;/, "")),
    "F32: string values must never be written to the log"
  );
  assert.ok(/str:\$\{v\.length\}/.test(shape[0]), "F32: strings must be recorded as a length only");
  assert.ok(/runId/.test(server) && /durationMs/.test(server), "F32: rows need a run id and a duration");
});

test("The two readers agree on what counts as interactive (F48)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  const selSrc = content.match(/const INTERACTIVE_SELECTOR = \[([\s\S]*?)\]\.join/);
  assert.ok(selSrc, "INTERACTIVE_SELECTOR must be a list literal");
  const selectorRoles = new Set([...selSrc[1].matchAll(/\[role=([a-z]+)\]/g)].map((m) => m[1]));

  const rolesSrc = content.match(/const INTERACTIVE_ROLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(rolesSrc, "INTERACTIVE_ROLES must be a Set literal");
  const treeRoles = new Set([...rolesSrc[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));

  // snapshot (selector) and read_page (role set) are edited in different places and used
  // interchangeably by agents. A role in one and not the other means the two tools
  // disagree about whether a control exists — which is how an open menu stayed invisible.
  const missingFromTree = [...selectorRoles].filter((r) => !treeRoles.has(r));
  assert.deepEqual(missingFromTree, [],
    `roles matched by INTERACTIVE_SELECTOR but not INTERACTIVE_ROLES: ${missingFromTree.join(", ")}`);

  // The widget families whose absence produced F48. Named explicitly so a future trim
  // has to argue with the test rather than silently shrink the census.
  for (const r of ["menuitemradio", "menuitemcheckbox", "option", "switch", "treeitem", "combobox"]) {
    assert.ok(selectorRoles.has(r), `INTERACTIVE_SELECTOR must match role=${r}`);
    assert.ok(treeRoles.has(r), `INTERACTIVE_ROLES must include ${r}`);
  }

  assert.ok(/STATE_ATTRS/.test(content), "ARIA state must be exposed as fields, not left inside label text");
});

test("Tool surface is navigable by intent, not just by name (F51)", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");

  // The server instructions are read once at connect, before any tool description, so
  // they are the only place an intent->tool mapping is guaranteed to be seen.
  assert.ok(/WHAT YOU WANT -> WHAT TO CALL/.test(src), "instructions must carry an intent index");
  for (const t of ["browser_get_count", "browser_get_attribute", "browser_find_text", "browser_load_tools"]) {
    assert.ok(new RegExp(`${t}`).test(src.split("WHAT YOU WANT")[1].slice(0, 2000)),
      `intent index must name ${t}`);
  }
  assert.ok(/browser_eval_js\s*\n?[^\n]*costs far more tokens|instead costs far more tokens/.test(src),
    "instructions must say why eval_js is the expensive fallback");

  // Group labels are injected in the registerTool wrapper, so every tool gets one.
  assert.ok(/const TOOL_GROUPS = \{/.test(src), "tools must be grouped");
  assert.ok(/const GROUP_NOTE = \{/.test(src), "each group needs a one-line note");
  assert.ok(/\[\$\{group\}\] \$\{GROUP_NOTE\[group\]\}/.test(src), "the group note must be prefixed onto descriptions");
  assert.ok(/TEXT census of the page's controls, not an image|not an image/i.test(src),
    "READ note must say snapshot returns text — the name reads as 'screenshot'");

  // browser_stop is shared infrastructure; an agent tidying up must not kill it.
  const stopIdx = src.indexOf('"browser_stop"', src.indexOf("Stop bridge daemon") - 400);
  assert.ok(stopIdx > 0, "browser_stop must be registered");
  assert.ok(/DO NOT call this to tidy up/.test(src), "browser_stop must warn against cleanup calls");
});

test("Every tool name dispatches through browser_action (F49)", async () => {
  const fs = await import("node:fs/promises");
  const mcp = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");

  // The aliases must exist at the EXTENSION layer, so the raw-HTTP endpoint the README
  // documents and the CLI get them too — not only MCP callers.
  const table = bg.match(/const ACTION_ALIASES = \{([\s\S]*?)\};/);
  assert.ok(table, "background.js must define ACTION_ALIASES");
  for (const name of ["get_text", "get_value", "get_html", "get_box", "get_attribute", "get_count"]) {
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(table[1]), `${name} must dispatch (it is a tool name, not an action name)`);
  }
  assert.ok(/NOT_A_PAGE_ACTION/.test(bg),
    "names the extension cannot serve must say so, not return 'unknown action'");
  assert.ok(/const ACTION_ALIASES = \{/.test(mcp), "the MCP layer keeps its own alias table for the catalogue");
});

test("Counting answers zero and separates invalid syntax (F52)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // count must be answered BEFORE a single target is resolved, or "how many" fails with
  // ELEMENT_NOT_FOUND when the honest answer is 0.
  const fn = content.slice(content.indexOf("function get_property("));
  const countIdx = fn.indexOf('property === "count"');
  const resolveIdx = fn.indexOf("resolveTarget({ ref, index, selector, text, placeholder })");
  assert.ok(countIdx > 0 && resolveIdx > 0, "both branches must exist");
  assert.ok(countIdx < resolveIdx, "F52: count must be handled before target resolution");

  assert.ok(/INVALID_SELECTOR/.test(content), "invalid CSS must be distinguishable from a zero match");
  assert.ok(/This is an answer, not a failure/.test(content), "a zero count must say it is a real answer");
  assert.ok(/createDocumentFragment\(\)\.querySelector/.test(content),
    "selector syntax must be validated explicitly — deepQueryAll swallows the error and returns []");
});

test("URL attributes come back resolved (F54)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const mcp = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");
  assert.ok(/new URL\(raw, document\.baseURI\)/.test(content),
    "a relative href must be resolved against the document base");
  assert.ok(/href\|src\|action\|poster/.test(content), "cover the URL-bearing attributes");
  assert.ok(/resolves to \$\{obj\.resolved\}/.test(mcp), "the formatter must show both raw and resolved");
});

test("The two alias tables cannot drift apart", async () => {
  const fs = await import("node:fs/promises");
  const read = async (file, name) => {
    const src = await fs.readFile(join(__dirname, "..", "..", ...file), "utf8");
    const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
    assert.ok(m, `${file.join("/")} must define ${name}`);
    return new Set([...m[1].matchAll(/^\s*(\w+):\s*\{/gm)].map((x) => x[1]));
  };
  // The extension resolves aliases for every caller; the MCP copy exists so the
  // browser_action catalogue can advertise them. Two hand-maintained tables of the same
  // facts is exactly the shape that let dismiss_modal ship unroutable (F4), so pin them.
  const bg = await read(["extension", "background.js"], "ACTION_ALIASES");
  const mcp = await read(["mcp", "index.js"], "ACTION_ALIASES");
  const only = (a, b) => [...a].filter((k) => !b.has(k)).sort();
  assert.deepEqual(only(bg, mcp), [], "aliases the extension resolves but browser_action never advertises");
  assert.deepEqual(only(mcp, bg), [], "aliases browser_action advertises but the extension cannot resolve");
});

test("A census leads with the page's shape, and says what it folded (F55)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  assert.ok(/function summarizeStructure\(/.test(content), "the census must be able to describe the page's shape");
  assert.ok(/\[Structure: /.test(content), "the shape must be emitted before the element list");
  // Volume is not structure: a fold that only says how many it hid forces an agent to
  // spend calls rediscovering that the page is a list.
  assert.ok(/folded \$\{foldedRefs\.length\} links\$\{what\}/.test(content),
    "the fold line must name the kinds of element it folded");
  // Noise control: a one-element page has no shape worth a line.
  assert.ok(/shapeBits\.length > 0 \|\| nodes\.length >= 8/.test(content),
    "the shape line must be suppressed on trivial pages");

  // The offscreen notice is emitted once, by the content script, because only it knows
  // the kinds. The transport layers must not print a second count-only copy.
  const cli = await fs.readFile(join(__dirname, "..", "..", "cli.js"), "utf8");
  const mcp = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");
  assert.ok(!/VIEWPORT-ONLY snapshot/.test(cli), "cli must not duplicate the viewport notice");
  assert.ok(!/VIEWPORT-ONLY snapshot/.test(mcp), "mcp must not duplicate the viewport notice");
});

test("Load-more detection needs a phrase, not a bare nav word (F47)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const m = content.match(/const LOAD_MORE_RE = (\/.*?\/i);/);
  assert.ok(m, "LOAD_MORE_RE must be a literal regex");
  const LOAD_MORE_RE = eval(m[1]);
  const s3m = content.match(/(\/\^\(more\|older[^\n]*?\/i)\.test\(t\)\)/);
  assert.ok(s3m, "the end-of-run signal must be a literal regex");
  const S3 = eval(s3m[1]);
  const hit = (t) => LOAD_MORE_RE.test(t) || S3.test(t);

  // Bare nav words are not load-more controls. "show" is Hacker News' Show HN link;
  // flagging it put a wrong hint on the page every single call.
  for (const t of ["show", "view", "load", "new", "past", "ask", "All", "Back to previous page"]) {
    assert.equal(hit(t), false, `must NOT flag ${JSON.stringify(t)}`);
  }
  for (const t of ["Show more", "See all", "See previous notifications", "Load more", "More", "Next", "View all comments"]) {
    assert.equal(hit(t), true, `must flag ${JSON.stringify(t)}`);
  }
});

test("Both readers orient, and the CLI stops dropping read_page flags (F56)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const cli = await fs.readFile(join(__dirname, "..", "..", "cli.js"), "utf8");

  // Agents choose freely between snapshot and read_page; orientation must not depend on
  // which one they picked. A probe that reached for read_page fell back to a 108 KB
  // screenshot to learn the page was a list.
  const rp = content.slice(content.indexOf("function read_page("));
  assert.ok(/summarizeStructure\(/.test(rp.slice(0, 8000)), "read_page must emit the same shape line as the census");

  // A clipped tree is not the page. The note has to say so, not merely suggest a bigger number.
  assert.ok(/most of this page is MISSING from the tree above/.test(content),
    "a depth-clipped read must say the result is incomplete, in those terms");

  // `read_page --depth 8` used to be accepted and silently ignored.
  assert.ok(/--depth\(\?:=\(\\d\+\)\)\?\$/.test(cli) || /--depth/.test(cli.slice(cli.indexOf('case "read_page"'), cli.indexOf('case "read_page"') + 900)),
    "cli must parse --depth for read_page");
  assert.ok(/--depth needs a number/.test(cli), "a malformed --depth must be rejected, not dropped");
});

test("A stale ref names its replacement instead of dead-ending (F57)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // SPA menus re-render between the snapshot and the click that follows it. "re-run
  // snapshot" throws away which control was wanted; the label we recorded at snapshot
  // time can point straight at its replacement.
  assert.ok(/const refLabels = Object\.create\(null\)/.test(content), "refs must remember their label");
  assert.ok(/function relocateByLabel\(/.test(content), "a stale ref must be relocatable by that label");
  assert.ok(/relocatedTo/.test(content), "the error must name the replacement ref");
  assert.ok(/No re-snapshot needed/.test(content), "the hint must say a retry is enough");
  // "@ref_2", "ref_2" and "2" all arrive here; the registry is keyed "ref_2".
  assert.ok(/const canonical = atMatch \? `ref_\$\{parseInt\(atMatch\[1\], 10\)\}`/.test(content),
    "the ref key must be canonicalised before the label lookup");
});

test("A missed find shows the page's own vocabulary (F58)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");

  assert.ok(/function pageVocabulary\(/.test(content), "a zero match must be able to list real labels");
  assert.ok(/pageLabels: pageVocabulary\(/.test(content), "find must return them");
  // Viewport-limiting the vocabulary makes it useless in a background window.
  const fn = content.slice(content.indexOf("function pageVocabulary("), content.indexOf("function find({"));
  assert.ok(!/isInViewport/.test(fn), "vocabulary must not be limited to the viewport");

  // The frame merge must not drop fields it has not heard of — it silently lost
  // `nearest`, then `pageLabels`, by enumerating what to keep instead of what to replace.
  const merge = bg.slice(bg.indexOf('if (action === "find")'), bg.indexOf('if (action === "find")') + 2600);
  assert.ok(/\.\.\.\(top\.result \|\| \{\}\)/.test(merge),
    "the find merge must pass the top frame's result through, overriding only what it owns");
});

test("A click on a stateful control proves the state moved (F60)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // "The DOM mutated" is not evidence the intended thing happened. A Facebook audience
  // radio produced 34 then 320 mutations across eight attempts while the selection never
  // committed — and every one of those clicks reported success.
  assert.ok(/const STATEFUL = \["aria-checked", "aria-selected", "aria-pressed", "aria-expanded"\]/.test(content),
    "the control's own state attributes must be sampled");
  assert.ok(/controlState/.test(content), "the effect block must carry the before/after state");
  assert.ok(/the selection did not take/.test(content),
    "a mutation without a state change must be called out, not reported as success");

  // The covered check hit-tests the element's centre, so it must run AFTER scrollIntoView
  // or it tests coordinates the click will never use.
  const clickFn = content.slice(content.indexOf("const warning = actionability(el);"));
  const scrollIdx = clickFn.indexOf("scrollIntoView");
  const coveredIdx = clickFn.indexOf("checkElementCovered(el)");
  assert.ok(scrollIdx > 0 && coveredIdx > 0, "both steps must exist in click");
  assert.ok(coveredIdx > scrollIdx, "F60: the covered check must run after scrollIntoView");
});

test("An unlabelled form control still gets a name (F61)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // Facebook's audience dialog listed eleven radios as `<input>[type=radio] (value: "on")`
  // — nothing to tell "Public" from "Only me". An agent cannot pick one, so it clicks the
  // visible text instead, which is a plain container and never commits the selection.
  assert.ok(/function controlLabelOf\(/.test(content), "form controls need their own name resolution");
  assert.ok(/aria-labelledby/.test(content), "aria-labelledby must be honoured");
  assert.ok(/label\[for=/.test(content), "an explicit <label for> must be honoured");
  assert.ok(/el\.closest && el\.closest\("label"\)/.test(content), "a wrapping <label> must be honoured");
  // Custom widgets use none of the above, so the row's own text is the last resort.
  const fn = content.slice(content.indexOf("function controlLabelOf("));
  const walk = fn.slice(0, 2600);
  assert.ok(/t\.length > 60/.test(walk), "the row-text fallback must reject section-sized text");
  // The decisive test: a label belongs to exactly one control. Without this the walk
  // climbed to a page-level wrapper and named a <select> after the whole page, which
  // then matched unrelated queries and sent hover to the wrong element.
  assert.ok(/querySelectorAll\(INTERACTIVE_SELECTOR\)\.length/.test(walk) && /controls > 1/.test(walk),
    "the row must contain exactly one control, or it is a container and its text is not a label");

  // `value` must not be a name at all for a submitted-token control: `<input
  // type="radio" value="on">` is not named "on". It stays only where the value IS the
  // caption (button/submit/reset) or the typed content of a text field.
  const full = content.slice(content.indexOf("function fullElementText("), content.indexOf("function elementText("));
  const labelIdx = full.indexOf("controlLabelOf(el)");
  const valueIdx = full.indexOf('el.getAttribute("value")');
  assert.ok(labelIdx > 0, "fullElementText must consult controlLabelOf");
  assert.ok(valueIdx < 0 || labelIdx < valueIdx, "the label must be resolved before any value fallback");
  assert.ok(/\["button", "submit", "reset"\]/.test(full), "value is a caption only for button/submit/reset");

  // Both label paths must agree. read_page and find go through accessibleName, so the
  // fix landing only in the census left them anonymous.
  const acc = content.slice(content.indexOf("function accessibleName("));
  assert.ok(/controlLabelOf\(el\)/.test(acc.slice(0, 2500)),
    "accessibleName (read_page, find) must resolve control labels the same way the census does");

  // A <select>'s text is its option list, not its name.
  assert.ok(/const TEXT_IS_CONTENT = new Set\(\["SELECT"/.test(content),
    "elements whose text is data must not be named by it");
});

test("Names resolve the way Chrome resolves them (F66-F68)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const full = content.slice(content.indexOf("function fullElementText("), content.indexOf("function elementText("));

  // Measured against Chrome's own accessibility tree on five real sites, these three were
  // the whole gap. A hand-written fixture had missed all of them.
  assert.ok(/aria-labelledby/.test(full), "F66: aria-labelledby must be honoured on ANY element, not only form controls");
  assert.ok(/img\[alt\]/.test(full), "F67: name-from-content includes a descendant image's alt text");

  // A control the user operates through its label, and one revealed on hover/focus, are
  // both real controls; excluding them meant an agent could not tick Booking's
  // "I'm travelling for work" or page any carousel.
  assert.ok(/function isOperableDespiteHidden\(/.test(content), "F68: label-operated hidden controls must be censused");
  assert.ok(/function isRevealable\(/.test(content), "F68: hover/focus-revealed controls must be censused");
  assert.ok(/function isCensusVisible\(/.test(content), "the census must use the widened filter");
  assert.ok(!/deepQueryAll\(INTERACTIVE_SELECTOR\)\.filter\(isVisible\)/.test(content),
    "no census site may still use the bare visibility filter");

  // Bounded: only opacity, never display:none / visibility:hidden.
  const rev = content.slice(content.indexOf("function isRevealable("));
  assert.ok(/visibilityReason\(el\) !== "opacity:0"/.test(rev.slice(0, 900)),
    "revealable must be opacity-only — display:none is out of the a11y tree for a reason");

  // And declared, so the agent knows why the element has no box.
  assert.ok(/\[via label\]/.test(content) && /\[hidden until hover\/focus\]/.test(content),
    "non-visible controls must be marked in the row");
});

test("The accessibility tree is exposed as an actionable second opinion (F69)", async () => {
  const fs = await import("node:fs/promises");
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  const cdp = await fs.readFile(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");

  // Raw AX nodes are a read-only curiosity: an agent can see a control and not act on it.
  assert.ok(/function enrichAxWithRefs\(/.test(bg), "AX nodes must be paired with census refs");
  assert.ok(/AX_STATE_PROPS/.test(cdp), "AX state (checked/expanded/disabled) must survive collection");

  // Coverage must be scoped to roles the census is FOR. Counting landmarks, headings and
  // StaticText reported 53% on a page with no gap — a metric that cries wolf gets ignored.
  const fn = bg.slice(bg.indexOf("async function enrichAxWithRefs("));
  assert.ok(/const ACTIONABLE = new Set/.test(fn.slice(0, 3000)), "coverage must count only actionable roles");
  assert.ok(/namedActionableNodes/.test(fn.slice(0, 4000)), "the metric must say what it counted");
  assert.ok(/notInCensus/.test(fn.slice(0, 4000)), "the disagreement is the useful part — it must be reported");

  const tools = await mcpDescriptions();
  const d = tools["browser_a11y_snapshot"].description;
  assert.ok(/debugging this browser|banner/i.test(d), "the debugger banner cost must be stated up front");
  assert.ok(/browser_snapshot first|not a replacement/i.test(d), "it is a diagnostic, not the default reader");
});

test("Exactly one insertion path runs on paste (F70)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // `execCommand("insertText")` and a ClipboardEvent each insert the whole payload. The
  // old condition `if (!inserted || paste)` ran insertText, saw it succeed, and dispatched
  // the ClipboardEvent anyway — a pasted email body landed in Gmail's composer TWICE.
  // Same shape as F1's double click.
  // Strip comments first: the fix's own comment quotes the old condition verbatim, and a
  // test that matches its own explanation is a test that can never pass.
  const code = content.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/if \(!inserted \|\| paste\)/.test(code),
    "F70: the unconditional second insertion must not return");
  assert.ok(/if \(paste\) inserted = tryClipboardEvent\(\) \|\| tryInsertText\(\);/.test(code),
    "paste semantics must try the ClipboardEvent first, with insertText as the fallback");
  assert.ok(/else inserted = tryInsertText\(\) \|\| tryClipboardEvent\(\);/.test(code),
    "typing semantics must try insertText first, with the ClipboardEvent as the fallback");
  // Short-circuit alone is not enough: execCommand can report true without changing
  // anything in a custom editor, which would suppress a fallback that was actually needed.
  assert.ok(/const changed = \(\) =>/.test(code),
    "success must be measured by the content actually changing, not by the command's return value");
});

test("Activation happens exactly once, everywhere it can be doubled (F71)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  const code = content.replace(/^\s*\/\/.*$/gm, "");

  // The recurring shape: dispatch the real event, then call the programmatic equivalent
  // as well. click had it (F1), type was fixed, paste had it (F70) — press_key still did:
  // `if (key === "Enter" && target.form) target.form.requestSubmit?.()` right after
  // dispatching keydown, so a page that submits from its own handler submitted twice.
  assert.ok(!/if \(key === "Enter" && target\.form\) target\.form\.requestSubmit/.test(code),
    "F71: press_key must not call requestSubmit unconditionally after dispatching Enter");

  // Every place that may fall back to requestSubmit must first observe whether the page
  // already submitted, and must respect preventDefault on keydown.
  for (const fn of ["async function type(", "function press_key("]) {
    const idx = content.indexOf(fn);
    assert.ok(idx > 0, `${fn} must exist`);
    const body = content.slice(idx, idx + 3000);
    if (!/requestSubmit/.test(body)) continue;
    assert.ok(/submittedByKey/.test(body), `${fn}: must observe whether the page already submitted`);
    assert.ok(/addEventListener\("submit"/.test(body), `${fn}: must listen for the page's own submit`);
  }
  // press_key additionally reports who handled it, so a caller can tell.
  assert.ok(/submittedByPage/.test(code) && /keydownPrevented/.test(code),
    "press_key must report whether the page handled Enter itself");
});

test("The specs describe the code that exists", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [content, bg, spec] = await Promise.all([
    read("extension", "content.js"),
    read("extension", "background.js"),
    read("docs", "spec", "errors.md"),
  ]);

  // A spec that drifts from the code is worse than no spec: it is a confident wrong answer.
  // Every error code the taxonomy documents must exist somewhere in the stack.
  const documented = [...spec.matchAll(/^\| `([A-Z_]{4,})` \|/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 10, `expected a real taxonomy, found ${documented.length} codes`);
  // Every file that can throw a coded error — netlog.js and cdp.js own several, and
  // leaving them out of the scan made the check report false drift on its first run.
  const stack = content + bg
    + (await read("extension", "netlog.js"))
    + (await read("extension", "cdp.js"))
    + (await read("mcp", "index.js"))
    + (await read("bridge", "server.js"));
  const missing = documented.filter((c) => !stack.includes(`"${c}"`));
  assert.deepEqual(missing, [], `codes documented in spec/errors.md but absent from the code: ${missing}`);

  // And the reverse: a structured code thrown by the content script must be documented,
  // or an agent meets an error the taxonomy never told it how to recover from.
  const thrown = new Set([...content.matchAll(/createStructuredError\([\s\S]{0,200}?"([A-Z_]{4,})"/g)].map((m) => m[1]));
  const undocumented = [...thrown].filter((c) => !documented.includes(c));
  assert.deepEqual(undocumented, [], `codes thrown but not in spec/errors.md: ${undocumented}`);
});

test("Every spec file is reachable from its index", async () => {
  const fs = await import("node:fs/promises");
  const dir = join(__dirname, "..", "..", "docs", "spec");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md");
  const index = await fs.readFile(join(dir, "README.md"), "utf8");
  const orphans = files.filter((f) => !index.includes(f));
  assert.deepEqual(orphans, [], `spec files not listed in spec/README.md: ${orphans}`);
});

test("Guidance reaches the CLI, not only MCP (F73)", async () => {
  const fs = await import("node:fs/promises");
  const cli = await fs.readFile(join(__dirname, "..", "..", "cli.js"), "utf8");
  const readme = await fs.readFile(join(__dirname, "..", "..", "README.md"), "utf8");

  // An agent with a shell and no MCP client sees only `--help` and the README. Guidance
  // added to a tool description does not reach it: browser_stop got a "do not call this to
  // tidy up" warning after a probe shut down the shared daemon, and the CLI's `stop` kept
  // its neutral one-liner.
  const help = cli.slice(cli.indexOf("browserctl CLI —"), cli.indexOf("browserctl CLI —") + 1600);
  assert.ok(/DO NOT run this to tidy up/.test(help), "F73: cli --help must carry the same browser_stop warning");
  assert.ok(/RARELY NEEDED|starts it automatically/.test(help),
    "help must say the daemon auto-starts, or `start` reads as a prerequisite");
  assert.ok(/browser_snapshot -> snapshot/.test(help),
    "help must map MCP tool names onto CLI commands for an agent that only knows one surface");

  // The README must offer a CLI-first path before the MCP setup, or an agent that cannot
  // run MCP concludes the tool is unavailable.
  const beforeQuickstart = readme.slice(0, readme.indexOf("## Quickstart & Installation"));
  assert.ok(/No MCP\? Start here/.test(beforeQuickstart), "the CLI path must come before the MCP setup");
  assert.ok(/node cli\.js/.test(beforeQuickstart), "a clone with nothing installed must be covered");
  assert.ok(/npx -y -p browserctl-mcp browserctl/.test(beforeQuickstart), "the no-clone path must be covered");
});

test("Documented CLI commands can actually be formed (F74)", async () => {
  const fs = await import("node:fs/promises");
  const cli = await fs.readFile(join(__dirname, "..", "..", "cli.js"), "utf8");

  // `find <query>` was in the README's command catalog with no case in the CLI, so the
  // positional argument fell into the key=value parser, matched nothing, and the action
  // was dispatched empty: "find requires 'query'" — a page-level error for a CLI gap.
  assert.ok(/case "find":\s*\n\s*case "find_text":/.test(cli),
    "F74: find/find_text must map their positional argument");
  assert.ok(/needs a query, e\.g\. browserctl/.test(cli), "a missing query must be rejected, not dispatched");

  // And the general case: a command with no mapping must say so rather than send an empty
  // action and let the page produce a confusing error.
  assert.ok(/takes no positional arguments in the CLI/.test(cli),
    "an unmappable positional argument must be reported, not silently dropped");
});

test("Docs do not claim a completeness they lack (F75)", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [readme, protocol, ref] = await Promise.all([read("README.md"), read("PROTOCOL.md"), read("docs", "REFERENCE.md")]);

  // PROTOCOL.md details 24 of 81 actions. README used to send raw-HTTP callers there "for
  // the full list" — and the bridge has no enumeration endpoint, so that was a dead end
  // for the one audience that cannot use browser_action.
  assert.ok(!/See `PROTOCOL\.md` for the full list/.test(readme),
    "F75: README must not present PROTOCOL.md as the complete action index");
  assert.ok(/(\*\*)?not(\*\*)? the action index|does not list all/.test(protocol),
    "PROTOCOL.md must state its own scope");
  assert.ok(/browserctl --help/.test(readme.slice(readme.indexOf("raw HTTP"))),
    "the raw-HTTP section must name a list that is actually complete");

  // REFERENCE listed browser_clear / browser_check / browser_uncheck as MCP tools. They
  // are protocol actions with no dedicated tool; calling browser_check fails.
  // Only the TABLE may not list them — prose explaining that they are not tools is the fix,
  // not a violation of it.
  const rows = ref.split("\n").filter((l) => /^\|\s*`browser_/.test(l));
  for (const ghost of ["browser_clear", "browser_check", "browser_uncheck"]) {
    assert.ok(!rows.some((r) => r.includes("`" + ghost + "`")),
      `${ghost} is not a registered MCP tool and must not appear as a row in the tool table`);
  }
  // ...and the rows that replaced them must be marked, with the marker explained in terms of
  // how to actually call them. Keyed on the mechanism, not on one phrasing of it.
  for (const action of ["clear", "check", "uncheck"]) {
    assert.ok(ref.split("\n").some((l) => new RegExp("^\\|\\s*`" + action + "` ?\u00b9").test(l)),
      `the ${action} row must be marked as an action with no MCP tool`);
  }
  assert.ok(/\u00b9[^\n]*\n?[^\n]*browser_action\(\{\s*action: "check"/.test(ref),
    "the marker must be explained by showing the browser_action call that reaches those actions");

  // Counts that were measured once and then drifted.
  assert.ok(!/~24 tools|70\+ tools|67 MCP tools/.test(ref), "stale tool counts must not return");
});

test("The e2e coverage denominator is derived, not hand-kept (F76)", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [run, mcp] = await Promise.all([read("tests", "e2e", "run.mjs"), read("mcp", "index.js")]);

  // A hardcoded ALL_ACTIONS silently stopped counting 19 actions and reported 59/61 against a
  // surface of 80 — a metric that lies upward is never questioned (I7).
  assert.ok(!/const ALL_ACTIONS = \[/.test(run),
    "F76: ALL_ACTIONS must be derived from the registry, not written out as a literal");
  assert.ok(/function protocolActions\(\)/.test(run), "F76: the derivation must be named and reusable");

  // The derivation is a regex over another file, so it can rot into silence. Re-run it here:
  // an empty or implausibly small surface means the parse broke, not that the surface shrank.
  const registered = [...mcp.matchAll(/\btool\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
  const aliasBlock = mcp.match(/const ACTION_ALIASES\s*=\s*\{([\s\S]*?)\n\};/);
  const aliases = aliasBlock ? [...aliasBlock[1].matchAll(/^\s*([a-z_0-9]+)\s*:/gm)].map((m) => m[1]) : [];
  const surface = new Set([...registered, ...aliases]);
  assert.ok(surface.size > 60, `F76: derivation found only ${surface.size} actions — the parse has broken`);
  for (const must of ["snapshot", "click", "fill", "paste", "find_text", "get_text", "get_count"]) {
    assert.ok(surface.has(must), `F76: derivation missed '${must}' — the parse has broken`);
  }

  // Anything excused from coverage must say why, in the output.
  const excused = run.match(/const NOT_EXERCISED = \{([\s\S]*?)\n\};/);
  assert.ok(excused, "F76: excused actions must be declared in one place");
  for (const line of excused[1].split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"))) {
    assert.ok(/:\s*"[^"]{10,}"/.test(line), `F76: excused action needs a stated reason -> ${line.trim()}`);
  }
});

test("Inline hints reach an MCP agent in a syntax it can call (F78)", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");

  // A Gmail session spent 28 of 44 calls on eval_js, hand-rolling reads that
  // browser_get_text answers exactly. The snapshot footer that exists to prevent that
  // was written in CLI syntax ("get text @ref", "snapshot --all") — names no MCP client
  // has. Invariant I3: guidance reaching one surface but not its twin.
  const mod = src.slice(src.indexOf("const CLI_TO_MCP"), src.indexOf("function text(obj"));
  assert.ok(mod.includes("CLI_TO_MCP"), "F78: the hint rewriter must exist");
  const { mcpifyHints } = new Function(mod + "; return {mcpifyHints};")();

  const footer =
    '[Next: click/type @ref · read one value: get text @ref · one attribute: get attr @ref href · ' +
    'count: get count <css> · locate a control: find "label" · a value in plain text: find text "label" ' +
    '· more of the page: scroll down or snapshot --all]';
  const out = mcpifyHints(footer);
  for (const cli of ["get text @", "get attr @", "get count <", "snapshot --all", 'find "label"', "scroll down"]) {
    assert.ok(!out.includes(cli), `F78: CLI syntax "${cli}" still reaches an MCP client`);
  }
  for (const tool of ["browser_get_text", "browser_get_attribute", "browser_get_count",
                      "browser_find({", "browser_find_text({", "browser_snapshot({scope:\"all\"})",
                      "browser_scroll({"]) {
    assert.ok(out.includes(tool), `F78: rewritten footer must name ${tool}`);
  }

  // A real ref keeps its number; the bare placeholder stays a placeholder.
  assert.ok(mcpifyHints("[+168 chars: get text @ref_48]").includes('browser_get_text({ref:"ref_48"})'),
    "F78: a concrete ref must survive the rewrite");
  assert.ok(mcpifyHints("[read: get text @ref]").includes('{ref:"<ref>"}'),
    "F78: the bare @ref placeholder must not become a literal ref named 'ref'");

  // Page text is not a hint. Rewriting outside brackets would report words the page
  // never said.
  const pageText = 'link "Read our snapshot --all guide" · heading "get text @ref tips"';
  assert.equal(mcpifyHints(pageText), pageText, "F78: content outside brackets must be untouched");

  // Every response goes through one funnel, so no tool can bypass the rewrite.
  assert.ok(/function text\(obj[^)]*\)\s*\{[\s\S]{0,600}?withMcpHints\(textRaw\(/.test(src),
    "F78: text() must route every response through withMcpHints");
});

test("The tools that answer 'read this region' say so (F79)", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");

  // get_text returns el.innerText, so it reads a whole container — but it was described
  // as "read one property of an element", and the agent that wanted a thread body never
  // recognised it.
  const getText = src.slice(src.indexOf("Read one property of an element"), src.indexOf("Read one property of an element") + 1600);
  assert.ok(/WHOLE REGION|whole region/.test(getText), "F79: get_text must say it reads a container, not just a field");
  assert.ok(/eval_js/.test(getText), "F79: get_text must name the fallback it replaces");

  // get_page_content used to send web-app readers to snapshot, which truncates — a loop
  // whose only exit was eval_js.
  const gpc = src.slice(src.indexOf("Extract the main readable prose"), src.indexOf("Extract the main readable prose") + 900);
  assert.ok(/browser_get_text/.test(gpc), "F79: get_page_content must point at the tool that does answer");

  // read_page was called once, bare, then blamed for what ref_id fixes.
  const rp = src.slice(src.indexOf("SPECIALISED reader"), src.indexOf("SPECIALISED reader") + 1600);
  assert.ok(/ref_id/.test(rp), "F79: read_page must name ref_id for narrowing to a subtree");
});

test("Runtime logs are bounded and never escape the repo (F80)", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [server, bench, ignore] = await Promise.all([
    read("bridge", "server.js"), read("test", "benchmark", "run_benchmark.js"), read(".gitignore"),
  ]);

  // Both appenders rotate, so each is capped at 2x its limit rather than growing forever.
  for (const [name, sourceText] of [["call log", server], ["telemetry", bench]]) {
    assert.ok(/MAX_BYTES/.test(sourceText), `F80: the ${name} needs a size cap`);
    assert.ok(/renameSync\(/.test(sourceText), `F80: the ${name} must rotate at the cap`);
  }

  // The cap must be reachable without editing source.
  assert.ok(/BROWSERCTL_CALL_LOG_MAX_MB/.test(server), "F80: the call-log cap must be configurable");

  // Size tracked in memory: a stat() per command is a syscall per command.
  assert.ok(!/statSync\(CALL_LOG_PATH\)[\s\S]{0,120}appendFileSync/.test(server),
    "F80: do not stat the log on every call");

  // A recorder of the user's browsing announces itself.
  assert.ok(/call log ON/.test(server), "F80: the bridge must say when the call log is on");

  // Rotated files must be ignored too — 'telemetry.jsonl' without the star let
  // 'telemetry.jsonl.1' show up as untracked, which is how runtime data reaches a commit.
  for (const line of ["bridge/calls.jsonl*", "bridge/telemetry.jsonl*"]) {
    assert.ok(ignore.split("\n").includes(line), `F80: .gitignore must contain ${line}`);
  }
});
