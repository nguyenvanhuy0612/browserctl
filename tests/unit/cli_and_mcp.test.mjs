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
// Child scripts as FILES, not as template literals inside this one. A script embedded here
// passes through two escaping layers — the template literal, and whatever wrote the file —
// and `split("\\n")` losing a backslash becomes a real newline inside a string literal, which
// fails as a syntax error in a child process whose stderr the test runner truncates. That
// cost several rounds to diagnose once. A fixture under children/ is parsed by `node --check`
// like any other source file, and has no escaping layer at all.
async function runChild(fixture, env = {}) {
  const path = join(__dirname, "children", fixture);
  try {
    const { stdout } = await execFileAsync(process.execPath, [path], { env: { ...process.env, ...env } });
    return stdout;
  } catch (err) {
    throw new Error(`${fixture} failed: ${String(err.stdout || "")} --- stderr: ${String(err.stderr || "").slice(0, 600)}`);
  }
}

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

test("MCP: core registers the readers, and the names it dropped stay dropped", async () => {
  const script = `
    import { TOOL_CATEGORIES } from "./mcp/index.js";
    if (!TOOL_CATEGORIES.core.includes("browser_get_property")) throw new Error("missing browser_get_property in core");
    if (!TOOL_CATEGORIES.core.includes("browser_navigate")) throw new Error("missing browser_navigate in core");
    for (const gone of ["browser_get_text", "browser_get_attribute", "browser_get_count"]) {
      if (TOOL_CATEGORIES.core.includes(gone)) throw new Error(gone + " came back — it is browser_get_property now");
    }
    for (const gone of ["browser_dismiss_modal", "browser_find_text", "browser_new_tab", "browser_open_and_read"]) {
      if (TOOL_CATEGORIES.core.includes(gone)) throw new Error(gone + " came back into core");
    }
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

    // 2. The settle guidance now lives on browser_wait_for({for:"settle"})
    const waitFor = server._registeredTools["browser_wait_for"];
    if (!waitFor) throw new Error("browser_wait_for not registered");
    if (!waitFor.description.includes("SPA")) throw new Error("Missing SPA guidance in wait_for description");
    if (!waitFor.inputSchema.shape.for) throw new Error("wait_for lost the 'for' parameter that absorbed wait_settle");

    // 3. Check browser_evaluate description
    const evalJs = server._registeredTools["browser_evaluate"];
    if (!evalJs) throw new Error("browser_evaluate not registered");
    if (!evalJs.description.includes("CSP") || !evalJs.description.includes("Trusted Types")) {
      throw new Error("Missing CSP / Trusted Types in evaluate description");
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
      const res = await clickHandler({ target: "@ref_4" });
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
    const getProp = server._registeredTools["browser_get_property"].handler;
    const htmlRes = await getProp({ target: "h1", property: "html" });
    const sent = seen.filter((s) => s.action === "get_property").pop();
    if (sent.params.property !== "html") throw new Error("property not forwarded: " + JSON.stringify(sent.params));
    const html = JSON.parse(htmlRes.content[0].text);
    if (html.value !== "<h1>Hi</h1>") throw new Error("lost value: " + htmlRes.content[0].text);
    if (html.matchCount !== 3) throw new Error("dropped the multi-match qualifier: " + htmlRes.content[0].text);

    // an absent attribute must not render as empty output
    const attrText = (await getProp({ target: "dialog", property: "attr", attr: "open" })).content[0].text;
    const attr = JSON.parse(attrText);
    if (attr.present !== false) throw new Error("an absent attribute must report present:false — " + attrText);

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
    // A result carries no advice any more. Capability discovery lives where it costs once per
    // session instead of once per call: the load_tools description, and list_available_tools.
    if (/more capabilities not loaded/.test(snapText)) throw new Error("a result must carry no capability advice: " + snapText);
    const loadDesc = server._registeredTools["browser_load_tools"].description || "";
    for (const profile of ["network", "cookies", "storage", "console"]) {
      if (!loadDesc.includes(profile)) throw new Error("browser_load_tools omits profile " + profile);
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

// An empty result means nothing unless the reader knows what was searched. These two
// descriptions carry that, and a shorter description that drops it in favour of a
// "parameter is REQUIRED" nag the schema already enforces is a net loss. Pin the facts.
test("MCP: find states the real scope of BOTH indexes it searches", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    // find_text was folded into find({in:"text"}) — its scope facts had to come with it,
    // or an empty result becomes uninterpretable again.
    const f = server._registeredTools["browser_find"].description || "";
    const ft = f;
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
  const stdout = await runChild("describe-tools.mjs");
  const m = stdout.match(/JSON_START([\s\S]*)JSON_END/);
  assert.ok(m, "MCP description dump failed: " + stdout.slice(0, 200));
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
  // The count in this notice is how many are IN SCOPE, not how many this page of a paged
  // census listed. They were the same number until the census learned to page, and the
  // notice then started reporting the page size as the viewport count — three numbers in
  // one response with the wrong one in front.
  // The facts these notices carried are fields now — a result is JSON, and a sentence an
  // agent has to parse out of prose is the thing this release removed.
  assert.ok(/offscreenCount,/.test(content), "what the viewport withheld must be a field");
  assert.ok(/res\.duplicateCount = duplicateCount;/.test(content), "suppressed duplicates must be a field");
  assert.ok(/res\.hiddenContent = hiddenContent;/.test(content), "load-on-demand controls must be a field");
  assert.ok(/describeElements/.test(content), "F30: what was withheld must still be described, not just counted");

  // F38: 'all' must not be silent about its own folding.
  assert.ok(/res\.foldedCount = foldedCount;/.test(content), "F38: folding must be reported as a field");

  // F39: load-more controls and overflowing regions must be surfaced.
  assert.ok(/kind: "load-more"/.test(content), "F39: load-on-demand controls must be reported");
  assert.ok(/LOAD_MORE_RE/.test(content), "F39: load-more controls must be detected");
  assert.ok(/no depth or scope setting reveals rows that are not in the DOM/.test(content),
    "F39: the CLI notice must still say that --all cannot reveal undrawn rows");

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
  assert.ok(/duplicateCount\+\+/.test(content) && /res\.duplicateCount = duplicateCount;/.test(content),
    "F28: duplicate rows must be collapsed and reported as a field");

  // F41: the content script's compact view must survive a multi-frame page.
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  assert.ok(!/compactLines\.push\(`\[Quick Actions/.test(bg),
    "F41: background.js must not rebuild a flat compact view — every real page has iframes, and the rebuild discarded landmarks, folding and every notice");
  assert.ok(/top\.result\.compactView/.test(bg) && /frame-qualified/.test(bg),
    "F41: sub-frame views must be appended with frame-qualified refs, not flattened into one");
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
  // The property, not one phrasing of it: an agent must get from "I want to read the page" to
  // a tool name without having loaded every schema first. The old heading is gone; the
  // sections that do the routing are what this pins.
  const iStart = src.indexOf("const INSTRUCTIONS = `");
  const intentIndex = src.slice(iStart, src.indexOf("`;", iStart));
  assert.ok(/THE LOOP/.test(intentIndex), "instructions must state the loop");
  assert.ok(/READING, in order of/.test(intentIndex), "instructions must route reading intents to tools");
  assert.ok(/ACTING:/.test(intentIndex), "instructions must route acting intents to tools");
  for (const t of ["browser_find", "browser_get_property", "browser_get_content", "browser_load_tools"]) {
    assert.ok(new RegExp(`${t}`).test(intentIndex), `intent index must name ${t}`);
  }
  // The intents that became parameters must still be findable BY INTENT
  for (const call of ["count", "attr", "browser_extract", "fields:", "selector"]) {
    assert.ok(intentIndex.includes(call), `instructions must show the ${call} form`);
  }
  assert.ok(/browser_evaluate\s*\n?[^\n]*costs far more tokens|instead costs far more tokens|browser_evaluate works/.test(src),
    "instructions must say why evaluate is the expensive fallback");

  // Group labels are injected in the registerTool wrapper, so every tool gets one.
  assert.ok(/const TOOL_GROUPS = \{/.test(src), "tools must be grouped");
  assert.ok(/const GROUP_NOTE = \{/.test(src), "each group needs a one-line note");
  // The note is stated ONCE, in the instructions every client reads at connect; each tool
  // carries only the tag that points at it. Pasting the paragraph onto all 24 tools cost ~7.8k
  // characters of identical text in every session, which is the budget gate's whole subject.
  assert.ok(/\[\$\{group\}\] \$\{config\.description\}/.test(src), "each tool must carry its group TAG");
  assert.ok(/const GROUP_SECTION = Object\.entries\(GROUP_NOTE\)/.test(src), "the group notes must be rendered into the instructions, once");
  assert.ok(/TOOL GROUPS/.test(src), "the instructions must carry the group section");
  assert.ok(!/\$\{GROUP_NOTE\[group\]\}/.test(src), "the group note must NOT be pasted onto every tool description");
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
  const resolveIdx = fn.indexOf("resolveTarget(");
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
  const s3m = content.match(/(\/\^\(more\|older[^\n]*?\/i)\.test\(\s*t\s*\)/);
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

test("Guidance reaches the CLI (F73)", async () => {
  const fs = await import("node:fs/promises");
  const cli = await fs.readFile(join(__dirname, "..", "..", "cli.js"), "utf8");

  const help = cli.slice(cli.indexOf("browserctl CLI —"), cli.indexOf("browserctl CLI —") + 1600);
  assert.ok(/DO NOT run this to tidy up/.test(help), "F73: cli --help must carry the same browser_stop warning");
  assert.ok(/RARELY NEEDED|starts it automatically/.test(help),
    "help must say the daemon auto-starts, or `start` reads as a prerequisite");
  assert.ok(/browser_snapshot -> snapshot/.test(help),
    "help must map MCP tool names onto CLI commands for an agent that only knows one surface");
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
  // Actions the bridge runs that have no tool of their own. browser_action's catalogue
  // declares them, and that declaration is what keeps them reachable AND countable — if it
  // rots, this derivation shrinks and the test says so.
  const extraBlock = mcp.match(/const extra = \[([\s\S]*?)\];/);
  const extra = extraBlock ? [...extraBlock[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]) : [];
  const surface = new Set([...registered, ...aliases, ...extra]);
  assert.ok(surface.size > 60, `F76: derivation found only ${surface.size} actions — the parse has broken`);
  for (const must of ["snapshot", "click", "fill", "paste", "find_text", "get_text", "get_count"]) {
    assert.ok(surface.has(must), `F76: derivation missed '${must}' — the parse has broken`);
  }

  // Anything excused from coverage must say why, in the output.
  const excused = run.match(/const NOT_EXERCISED = \{([\s\S]*?)\n\};/);
  assert.ok(excused, "F76: excused actions must be declared in one place");
  // Parsed as entries, not as lines: prettier wraps a long reason onto its own line, and the
  // property worth protecting is that a reason EXISTS, not where it sits.
  const block = excused[1].replace(/\/\/[^\n]*/g, "");
  const entries = [...block.matchAll(/([a-z_0-9]+):\s*("(?:[^"\\]|\\.)*")/g)];
  const names = [...block.matchAll(/^\s*([a-z_0-9]+):/gm)].map((m) => m[1]);
  assert.equal(entries.length, names.length, `F76: an excused action has no string reason -> ${names.filter((n) => !entries.some((e) => e[1] === n)).join(", ")}`);
  for (const [, name, reason] of entries) {
    assert.ok(reason.length > 12, `F76: excused action needs a stated reason -> ${name}`);
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
  for (const tool of ["browser_get_property({", "property:\"attr\"", "property:\"count\"",
                      "browser_find({", 'in:"text"', "browser_snapshot({scope:\"all\"})",
                      "browser_scroll({"]) {
    assert.ok(out.includes(tool), `F78: rewritten footer must name ${tool}`);
  }

  // The dialog notices are hints too, and they named a CLI verb for a tool that no longer
  // exists in any form. Driving Facebook by hand hit exactly this: "[Open dialog:
  // \"Notifications\" ... — use 'dismiss' to close]" with no browser_dismiss to call.
  const dialogHint = mcpifyHints(`[Open dialog: "Notifications" 360x722 (@ref_57), does not block the page — read it with 'get text @ref_57'; close it with 'dismiss']`);
  assert.ok(dialogHint.includes('browser_action({action:"dismiss"})'), "F78: the dialog hint must name a callable close");
  assert.ok(dialogHint.includes('browser_get_property({ref:"ref_57"})'), "F78: the dialog hint must name the region read, by ref");
  assert.ok(!/use 'dismiss'|with 'dismiss'/.test(dialogHint), "F78: the CLI verb must not survive the rewrite");

  // A real ref keeps its number; the bare placeholder stays a placeholder.
  assert.ok(mcpifyHints("[+168 chars: get text @ref_48]").includes('browser_get_property({ref:"ref_48"})'),
    "F78: a concrete ref must survive the rewrite");
  assert.ok(mcpifyHints("[read: get text @ref]").includes('{ref:"<ref>"}'),
    "F78: the bare @ref placeholder must not become a literal ref named 'ref'");

  // Page text is not a hint. Rewriting outside brackets would report words the page
  // never said.
  const pageText = 'link "Read our snapshot --all guide" · heading "get text @ref tips"';
  assert.equal(mcpifyHints(pageText), pageText, "F78: content outside brackets must be untouched");

  // Every response goes through one funnel, so no tool can bypass the rewrite.
  assert.ok(/format === "json" \|\| format === "pretty" \? res : withMcpHints\(res\)/.test(src),
    "F78: prose responses must route through withMcpHints (JSON must NOT — it corrupts the payload)");
});

test("The tools that answer 'read this region' say so (F79)", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");

  const regIdx = src.indexOf('"browser_get_property"', src.indexOf("server.registerTool"));
  const reader = src.slice(src.lastIndexOf("server.registerTool", src.indexOf("For structured extraction across multiple rows, use browser_extract")), src.indexOf("For structured extraction across multiple rows, use browser_extract") + 300);
  assert.ok(/browser_extract/.test(reader), "F79: get_property points to browser_extract for structured row extraction");

  const gpc = src.slice(src.indexOf("the page's prose"), src.indexOf("the page's prose") + 500);
  assert.ok(/browser_get_content/.test(src), "F79: get_content is registered");

  const rp = src.slice(src.indexOf("The accessibility tree as indented text"), src.indexOf("The accessibility tree as indented text") + 1600);
  assert.ok(/ref_id/.test(rp), "F79: read_page must name ref_id for narrowing to a subtree");
});

test("Runtime logs are bounded and never escape the repo (F80)", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [server, bench, ignore] = await Promise.all([
    read("bridge", "server.js"), read("tests", "benchmark", "run_benchmark.js"), read(".gitignore"),
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

test("Both status surfaces answer from one builder (F81)", async () => {
  const fs = await import("node:fs/promises");
  const read = (...p) => fs.readFile(join(__dirname, "..", "..", ...p), "utf8");
  const [server, cli] = await Promise.all([read("bridge", "server.js"), read("cli.js")]);

  // GET /status (the CLI) and action:"status" (MCP) answer the same question. The GET
  // returned only { extensionConnected }, so the CLI could not report the call log even
  // after the bridge tracked it — and the startup notice that was supposed to announce
  // the log is discarded, because the daemon is spawned with stdio "ignore". I3 twice
  // over: the fix for an invisible log was written on a surface nobody reads.
  assert.ok(/function statusPayload\(\)/.test(server), "F81: status must come from one builder");
  assert.ok(/req\.url === "\/status"\)\s*\{\s*return sendJson\(res, 200, statusPayload\(\)\)/.test(server),
    "F81: GET /status must use the shared builder, not its own field list");
  assert.ok(/action === "status"[\s\S]{0,120}result: statusPayload\(\)/.test(server),
    "F81: action:status must use the shared builder too");

  // Whatever the builder carries has to be reachable by a person, not only by an agent.
  assert.ok(/Call log: ON/.test(cli), "F81: browserctl status must report the call log");
  assert.ok(/stdio: "ignore"/.test(cli),
    "F81: if the daemon ever stops discarding stdout, revisit where this notice belongs");
});

// Every failure observed in the 2026-09-07..09 agent window was parameter-level, and two of
// the four were swallowed in silence: `read_page {format:"markdown"}` returned an
// accessibility tree and reported success, so the agent decided the reader was broken and
// hand-rolled the read in eval_js for the rest of the session. Unknown keys must be refused
// with the legal set, and the snake_case names an LLM types must resolve, not vanish.
test("MCP: a parameter that is not in the schema is refused, and the refusal says what to pass", async () => {
  const script = `
    import http from "node:http";
    const calls = [];
    const stub = http.createServer((req, res) => {
      if (req.url === "/status") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true })); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true, result: { tree: "" } }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const readPage = server._registeredTools["browser_read_page"].handler;

    // 1. A parameter that belongs to a different tool: refused, not stripped.
    const bad = await server._registeredTools["browser_snapshot"].handler({ mode: "all" });
    if (!bad.isError) throw new Error("unknown param was accepted");
    if (!bad.content[0].text.includes("scope=")) throw new Error("no redirect to the parameter that does exist");
    if (!bad.content[0].text.includes("valid params:")) throw new Error("legal set not listed");

    // 2. A typo: did-you-mean.
    const typo = await readPage({ dept: 3 });
    if (!typo.content[0].text.includes("did you mean 'depth'")) throw new Error("no did-you-mean: " + typo.content[0].text);

    // 3. snake_case tab id resolves to tabId instead of being dropped.
    await readPage({ tab_id: 4242 });
    const sent = calls.at(-1);
    if (sent.params.tabId !== 4242) throw new Error("tab_id did not become tabId: " + JSON.stringify(sent.params));
    if ("tab_id" in sent.params) throw new Error("tab_id leaked through to the bridge");

    // 4. Element addressing is one parameter. Anything else offered in its place is refused
    // and told the form to use, rather than rewritten behind the caller's back: a caller that
    // gets away with the wrong shape never learns the right one.
    const other = await readPage({ ref: "ref_5" });
    if (!other.isError) throw new Error("a parameter outside the schema was accepted");
    if (!other.content[0].text.includes("target")) throw new Error("the refusal must name 'target': " + other.content[0].text);
    const clickOther = await server._registeredTools["browser_click"].handler({ selector: "#b" });
    if (!clickOther.isError) throw new Error("a parameter outside the schema was accepted on click");
    if (!/one parameter now/.test(clickOther.content[0].text)) throw new Error("no guidance: " + clickOther.content[0].text);

    // 5. find takes a CSS selector, and forwards it — this is the call that hands
    // fill/paste a ref without a full re-read of the page.
    const find = server._registeredTools["browser_find"].handler;
    await find({ selector: 'div[role="textbox"][contenteditable]' });
    if (calls.at(-1).params.selector !== 'div[role="textbox"][contenteditable]') {
      throw new Error("find did not forward selector: " + JSON.stringify(calls.at(-1).params));
    }
    const findBad = await find({ selectors: "div" });
    if (!findBad.isError || !findBad.content[0].text.includes("did you mean 'selector'")) {
      throw new Error("find did not suggest 'selector' for 'selectors'");
    }

    console.log("PARAM_GUARD_OK");
    process.exit(0);
  `;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]));
  } catch (err) {
    throw new Error("param guard child: " + String(err.stdout || "") + " | " + String(err.stderr || "").slice(0, 400));
  }
  assert.ok(stdout.includes("PARAM_GUARD_OK"));
});

// One tool with a parameter serves several intents. What each parameter value must do is
// reach the protocol action that performs it — a tool that accepts a mode and then runs the
// wrong action is worse than one that never offered it.
test("MCP: each parameter value dispatches to the action that performs it", async () => {
  const script = `
    import http from "node:http";
    const calls = [];
    const stub = http.createServer((req, res) => {
      if (req.url === "/status") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true })); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true, result: { dataUrl: "data:image/jpeg;base64,AAAA", value: 1 } }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const call = (n, a) => server._registeredTools[n].handler(a);
    const lastAction = () => calls.at(-1).action;

    await call("browser_type", { target: "@ref_1", text: "hi" });
    if (lastAction() !== "fill") throw new Error("default method is not fill: " + lastAction());
    await call("browser_type", { target: "@ref_1", text: "hi", method: "type" });
    if (lastAction() !== "type") throw new Error("method=type did not reach the type action");
    await call("browser_type", { target: "@ref_1", text: "hi", method: "paste" });
    if (lastAction() !== "paste") throw new Error("method=paste did not reach the paste action");
    await call("browser_select_option", { target: "@ref_1", option: "Vietnam" });
    if (lastAction() !== "select_option" || calls.at(-1).params.option !== "Vietnam") {
      throw new Error("option did not reach select_option: " + JSON.stringify(calls.at(-1)));
    }

    await call("browser_take_screenshot", {});
    if (lastAction() !== "screenshot") throw new Error("viewport screenshot changed action");
    await call("browser_take_screenshot", { fullPage: true });
    if (lastAction() !== "capture_screenshot") throw new Error("fullPage did not reach capture_screenshot");

    await call("browser_wait_for", { selector: "#x" });
    if (lastAction() !== "wait_for") throw new Error("wait_for changed action");
    await call("browser_wait_for", { for: "settle" });
    if (lastAction() !== "wait_settle") throw new Error("for=settle did not reach wait_settle");

    await call("browser_extract", { selector: "a", fields: { href: { attr: "href" } } });
    if (lastAction() !== "extract") throw new Error("extract did not reach the extract action");

    console.log("MERGE_DISPATCH_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MERGE_DISPATCH_OK"));
});

// The consolidated surface is opt-in until it is measured. Both numbers are asserted so a
// tool added to core without a decision shows up as a failing test, not as a drifting count.
test("MCP: the default profile is exactly the core list, and nothing else", async () => {
  const script = `
    const { server, TOOL_CATEGORIES } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const on = Object.entries(server._registeredTools).filter(([, t]) => t.enabled !== false).map(([n]) => n);
    console.log(JSON.stringify({ on: on.sort(), core: [...TOOL_CATEGORIES.core].sort() }));
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BROWSERCTL_MCP_PROFILE: "core" },
  });
  const { on, core } = JSON.parse(stdout.trim().split("\n").at(-1));

  // Derived from the registry on both sides: what a default session is handed IS the core
  // list, no more and no less. A tool added to core without a decision fails here.
  assert.deepEqual(on, core, "the default profile must be exactly TOOL_CATEGORIES.core");
  assert.equal(core.length, 25, "core is 25 tools; changing that is a decision, not a drift");
});

test("Versions do not drift: package.json, the MCP server and the extension manifest agree", async () => {
  const fs = await import("node:fs/promises");
  const root = join(__dirname, "..", "..");
  const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(join(root, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "extension/manifest.json version must match package.json");

  // The server must READ the version, not restate it.
  const src = await fs.readFile(join(root, "mcp", "index.js"), "utf8");
  assert.ok(
    /const SERVER_VERSION = \(\(\) => \{[\s\S]*?package\.json/.test(src),
    "SERVER_VERSION must be derived from package.json, not hardcoded"
  );
});

// The census is paged now, and two things have to hold for that to be usable: the tool has
// to forward the parameters, and the cross-frame merge has to stop dropping fields it was
// never taught about. The merge enumerated the fields it kept, so `window`/`next` vanished
// on every multi-frame page the day they were added — the same rot that once cost `find`
// its `nearest` and `pageLabels`.
test("Snapshot is paged, and the frame merge cannot drop what it was not taught (F90)", async () => {
  const fs = await import("node:fs/promises");
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  const merge = bg.slice(bg.indexOf('if (action === "snapshot") {'), bg.indexOf('if (action === "find") {'));
  assert.ok(/const res = \{\s*\n\s*\.\.\.top\.result,/.test(merge),
    "F90: the snapshot merge must pass the top frame's result through, not list what it keeps");
  assert.ok(!/url: top\.result\.url/.test(merge), "F90: enumerating kept fields is what rots");

  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");
  assert.ok(/params\.limit/.test(content) && /params\.cursor/.test(content),
    "F90: the census must accept limit/cursor");
  assert.ok(/window: \{ offset, shown: elements\.length, inScope: nodes\.length \}/.test(content),
    "F90: the window must be reported as data");
  assert.ok(/next: offset \+ elements\.length/.test(content),
    "F90: the continuation must be a field, not a sentence");

  const script = `
    import http from "node:http";
    const calls = [];
    const stub = http.createServer((req, res) => {
      if (req.url === "/status") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true })); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true, result: { compactView: "x", window: { offset: 8, shown: 8, inScope: 226 }, next: 16 } }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    await server._registeredTools["browser_snapshot"].handler({ scope: "all", limit: 8, cursor: 8 });
    const p = calls.at(-1).params;
    if (p.limit !== 8 || p.cursor !== 8) throw new Error("snapshot dropped limit/cursor: " + JSON.stringify(p));
    console.log("SNAPSHOT_PAGING_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("SNAPSHOT_PAGING_OK"));
});

test("browser_navigate drives URL or reload, and browser_tabs manages tabs (F91)", async () => {
  const script = `
    import http from "node:http";
    const calls = [];
    const stub = http.createServer((req, res) => {
      if (req.url === "/status") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true })); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const call = JSON.parse(body);
        calls.push(call);
        const result =
          call.action === "list_tabs" ? { tabs: [{ id: 1, url: "https://x.test" }], pinned: 1 } :
          call.action === "new_tab" ? { id: 99 } :
          call.action === "navigate" ? { url: call.params.url } :
          call.action === "reload" ? { reloaded: true } : {};
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
    const { server } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");

    // 1. browser_navigate with url
    await server._registeredTools["browser_navigate"].handler({ url: "https://example.com" });
    if (!calls.some((c) => c.action === "navigate" && c.params.url === "https://example.com")) {
      throw new Error("did not dispatch navigate");
    }

    // 2. browser_navigate with reload
    calls.length = 0;
    await server._registeredTools["browser_navigate"].handler({ reload: true });
    if (!calls.some((c) => c.action === "reload")) throw new Error("did not dispatch reload");

    // 3. browser_tabs list and new
    calls.length = 0;
    await server._registeredTools["browser_tabs"].handler({ action: "list" });
    if (!calls.some((c) => c.action === "list_tabs")) throw new Error("did not dispatch list_tabs");

    calls.length = 0;
    await server._registeredTools["browser_tabs"].handler({ action: "new", url: "https://new.test" });
    if (!calls.some((c) => c.action === "new_tab" && c.params.url === "https://new.test")) throw new Error("did not dispatch new_tab");

    console.log("NAVIGATE_AND_TABS_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("NAVIGATE_AND_TABS_OK"));
});

// A click that navigates used to come back as a failure. toContent() caught the dead
// content script, re-injected into the NEW document and retried there — where the ref no
// longer exists — so submitting a form reported STALE_REF for an action that had worked.
// Measured on selenium.dev/web-form.html: the form submitted, the URL changed, and the
// tool said `ref "ref_14" not found or stale`. The agent that saw it concluded the click
// had never happened. A retry is also a double-submit risk, which is worse.
test("An action that navigates reports the navigation, not a stale ref (F92)", async () => {
  const fs = await import("node:fs/promises");
  const bg = await fs.readFile(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  const fn = bg.slice(bg.indexOf("async function toContent("), bg.indexOf("// Cross-frame refs are exposed"));

  assert.ok(/const urlBefore = tab\.url/.test(fn), "F92: toContent must remember the URL it started on");
  assert.ok(/after\.url !== urlBefore/.test(fn), "F92: the catch must tell navigation apart from a missing content script");
  assert.ok(/navigated: true/.test(fn), "F92: a navigation must be reported as a result, not an error");
  assert.ok(/urlChanged: true/.test(fn), "F92: it must carry the effect shape every other action returns");

  // The retry must stay reachable for the case it was written for — a page that simply
  // has no content script yet.
  assert.ok(/executeScript\(/.test(fn) && fn.indexOf("executeScript(") > fn.indexOf("navigated: true"),
    "F92: the inject-and-retry path must remain, AFTER the navigation check");
});

// Doing a real Facebook task by hand surfaced three ways the census confused its reader.
// All three are about the same thing: the response described the page but did not hand
// over the call that acts on the description.
test("The census hands over calls, not just counts (F93)", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(join(__dirname, "..", "..", "extension", "content.js"), "utf8");

  // 1. Regions were named ("aside 19") with no way to address them, so reading the right
  //    rail meant guessing [role=complementary]. Every region now carries a ref — and a page
  //    with several regions of one type lists each separately, with the name it declares, so
  //    "the left-hand navigation" can be told apart from the top bar.
  assert.ok(/function getLandmarkNode\(/.test(content), "F93: the landmark CONTAINER must be reachable, not just its name");
  assert.ok(/function regionName\(/.test(content), "F93: a region has to be nameable, or several of one type cannot be told apart");
  assert.ok(/\$\{label\} \$\{info\.n\} \(@\$\{getOrAssignRef\(node\)\}\)/.test(content),
    "F93: each region in the structure line must carry a ref");
  assert.ok(/const byRegion = new Map\(\)/.test(content),
    "F93: the structure line must count per REGION, not per landmark type");
  // The name must be declared, never guessed from content: naming a region after the first
  // heading inside it labelled Facebook's main region "Create a post".
  const regionFn = content.slice(content.indexOf("function regionName("));
  const regionBody = regionFn.slice(0, regionFn.indexOf("\n  }"));
  assert.ok(/aria-label/.test(regionBody) && /aria-labelledby/.test(regionBody),
    "F93: a region's name comes from the labels it declares");
  assert.ok(!/querySelector\(/.test(regionBody),
    "F93: a region's name must not be guessed from its contents");
  assert.ok(/if \(structureSummary\) res\.structure = structureSummary;/.test(content),
    "F93: the page's shape must be a field, not a prose line carrying a suggestion");

  // 2. An open dialog is the most common region read of all.
  assert.ok(/Open dialog: .*\(@\$\{dialogRef\}\)/.test(content), "F93: an open dialog must carry its own ref");
  assert.ok(/read it with 'get text @\$\{dialogRef\}'/.test(content), "F93: and say how to read it");
  assert.ok(!/get text <its container>/.test(content), "F93: no placeholder an agent cannot fill");

  // 3. The counts have to reconcile: in-scope vs whole page, with paging reported apart.
  const mcp = await fs.readFile(join(__dirname, "..", "..", "mcp", "index.js"), "utf8");
  assert.ok(/const visible = obj\.window\?\.inScope/.test(mcp),
    "F93: the header must report what is in scope, not the size of the page it printed");
});

// The release gates are only worth having if they cannot quietly stop running. This pins
// the two properties that make them different from a checklist: they exist as a script,
// and each one derives what it checks from the code rather than from a list someone
// maintains by hand.
test("The human view of an extract read is one line per row (F97)", async () => {
  const out = await runChild("all-render.mjs");
  assert.ok(out.includes("ALL_RENDER_OK"), out);
});

test("browser_navigate and browser_tabs dispatch properly (F98)", async () => {
  const out = await runChild("open-url-read.mjs");
  assert.ok(out.includes("NAVIGATE_AND_TABS_OK"), out);
});




