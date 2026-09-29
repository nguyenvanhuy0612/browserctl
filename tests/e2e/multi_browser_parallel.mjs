#!/usr/bin/env node
// Parallel multi-browser gate. For every connected browser (up to three) one MCP session
// (mcp/index.js over stdio, as one agent session) runs the full core-action scenario on a local
// fixture site this script serves, and every action is verified by a read-back. All sessions
// start together behind a barrier. The run then checks that:
//   - each session's call-log lines name only its own browser and its own tab id;
//   - the sessions' windows overlap by more than half;
//   - no call failed (a background capture included);
//   - every tab the run opened is closed.
//
// The sessions only open, drive and close their own tabs on the fixture site; no other tab is
// selected, navigated or closed. Every path closes those tabs and the fixture server.
//
// Exits 0 when every check passes (or with fewer than two browsers, "SKIPPED (one browser)"),
// 1 when any check fails, 2 when the bridge cannot be reached.
//
// Usage: node tests/e2e/multi_browser_parallel.mjs [--bridge-url <url>]
//   The bridge is --bridge-url, else BROWSERCTL_BRIDGE_URL, else http://127.0.0.1:8765.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = join(HERE, "..", "..", "mcp", "index.js");
const MAX_BROWSERS = 3;
const CALL_TIMEOUT_MS = 30000;
const MIN_OVERLAP = 0.5;

// ---------------------------------------------------------------- fixture site

// /form: inputs, select, checkbox, radios, textarea, a click counter, a hover target, a key
// input, a file input, a list of rows, a link to /next, and #ready appearing 1.5 s after load.
// /next: the page the link leads to. /long: a tall page. /submit: echoes the submitted query.
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>browserctl test form</title>
<style>body{font:14px sans-serif;margin:24px} .box{padding:8px;margin:6px 0;border:1px solid #ccc}
#hoverme{display:inline-block;padding:10px;background:#eef}</style></head><body>
<h1 id="title">browserctl test form</h1>
<form id="f" action="/submit" method="get">
  <label for="name">Full name</label> <input id="name" name="name" placeholder="Your name"><br>
  <label for="email">Email</label> <input id="email" name="email" type="email" placeholder="you@example.com"><br>
  <label for="color">Favourite color</label>
  <select id="color" name="color"><option value="">--</option><option value="red">Red</option>
    <option value="green">Green</option><option value="blue">Blue</option></select><br>
  <label><input id="agree" name="agree" type="checkbox"> I agree</label><br>
  <label><input type="radio" name="size" value="s"> Small</label>
  <label><input type="radio" name="size" value="l"> Large</label><br>
  <label for="notes">Notes</label><br><textarea id="notes" name="notes"></textarea><br>
  <label for="upload">Attachment</label> <input id="upload" name="upload" type="file"><br>
  <button id="submit" type="submit">Send form</button>
</form>
<div class="box">Clicks: <span id="count">0</span> <button id="inc" type="button" onclick="document.getElementById('count').textContent=String(+document.getElementById('count').textContent+1)">Add one</button></div>
<div class="box"><span id="hoverme" onmouseover="document.getElementById('hoverstate').textContent='hovered'">Hover me</span> state: <span id="hoverstate">idle</span></div>
<div class="box">Key: <input id="keys" placeholder="press keys here" onkeydown="document.getElementById('lastkey').textContent=event.key"> last: <span id="lastkey">none</span></div>
<div class="box">Upload: <span id="uploaded">none</span></div>
<ul id="items">
  <li class="row"><span class="t">Alpha</span> <a class="u" href="/next?i=1">one</a> <span class="n">10</span></li>
  <li class="row"><span class="t">Beta</span> <a class="u" href="/next?i=2">two</a> <span class="n">20</span></li>
  <li class="row"><span class="t">Gamma</span> <a class="u" href="/next?i=3">three</a> <span class="n">30</span></li>
</ul>
<p><a id="nextlink" href="/next">Go to next page</a></p>
<div id="late"></div>
<script>
  document.getElementById('upload').addEventListener('change', e => {
    document.getElementById('uploaded').textContent = [...e.target.files].map(f => f.name).join(',') || 'none';
  });
  setTimeout(() => { document.getElementById('late').innerHTML = '<p id="ready">Loaded later</p>'; }, 1500);
</script>
</body></html>`;

const escape = (s) => s.replace(/[<>&]/g, "");
const NEXT = (
  q
) => `<!doctype html><html><head><meta charset="utf-8"><title>browserctl next page</title></head>
<body><h1 id="title">Next page</h1><p id="query">${escape(q)}</p><a href="/form">Back to form</a></body></html>`;
const LONG = `<!doctype html><html><head><meta charset="utf-8"><title>browserctl long page</title></head><body>
${Array.from({ length: 200 }, (_, i) => `<p id="p${i}">Paragraph ${i}</p>`).join("\n")}
<p id="bottom">Bottom of the page</p></body></html>`;
const SUBMITTED = (q) =>
  `<!doctype html><title>browserctl submitted</title><h1 id="title">Submitted</h1><pre id="echo">${escape(q)}</pre>`;

export async function startFixture() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/form" || u.pathname === "/") return res.end(FORM);
    if (u.pathname === "/next") return res.end(NEXT(u.search));
    if (u.pathname === "/long") return res.end(LONG);
    if (u.pathname === "/submit") return res.end(SUBMITTED(u.search));
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------- analysis

// The share of the sessions' combined span during which all of them were running.
export function overlapRatio(windows) {
  if (windows.length < 2) return 1;
  const start = Math.max(...windows.map((w) => w.start));
  const end = Math.min(...windows.map((w) => w.end));
  const span = Math.max(...windows.map((w) => w.end)) - Math.min(...windows.map((w) => w.start));
  if (span <= 0) return 1;
  return Math.max(0, end - start) / span;
}

// Tab ids a call-log line names: the tab it ran on, and the tab a close or select acted on.
function tabIdsOf(entry) {
  const ids = [];
  if (entry.tabId != null) ids.push(entry.tabId);
  if (
    (entry.action === "close_tab" || entry.action === "switch_tab") &&
    typeof entry.params?.id === "number"
  ) {
    ids.push(entry.params.id);
  }
  return ids;
}

// Checks the bridge's call-log lines against the run's sessions ({alias, tabId} each). A session
// is found in the log by its tab id: exactly one MCP session must have named that tab. Apart from
// list_tabs (a read that fans out to every browser by design), each of its lines must name its
// own browser and no tab but its own. Returns { problems, lines: {alias: count} }.
export function checkCallLog(entries, runs) {
  const problems = [];
  const lines = {};
  const mcp = entries.filter((e) => e.source === "mcp" && e.session);
  const bySession = new Map();
  for (const e of mcp) {
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const claimed = new Map();
  for (const run of runs) {
    if (run.tabId == null) continue;
    const owners = [...bySession.entries()].filter(([, es]) =>
      es.some((e) => tabIdsOf(e).includes(run.tabId))
    );
    if (owners.length !== 1) {
      problems.push(
        `${run.alias}: tab ${run.tabId} is named by ${owners.length} MCP sessions in the call log, expected 1`
      );
      continue;
    }
    const [session, es] = owners[0];
    if (claimed.has(session)) {
      problems.push(
        `${run.alias}: its session ${session} also ran ${claimed.get(session)}'s scenario`
      );
      continue;
    }
    claimed.set(session, run.alias);
    lines[run.alias] = es.length;
    for (const e of es) {
      if (e.action === "list_tabs") continue;
      if (e.browser !== run.alias) {
        problems.push(
          `${run.alias}: session ${session} sent ${e.action} (seq ${e.seq}) to ${e.browser}`
        );
      }
      const foreign = tabIdsOf(e).filter((id) => id !== run.tabId);
      if (foreign.length) {
        problems.push(
          `${run.alias}: session ${session} sent ${e.action} (seq ${e.seq}) to tab ${foreign.join(", ")}, not its own tab ${run.tabId}`
        );
      }
    }
  }
  return { problems, lines };
}

// ---------------------------------------------------------------- the scenario

// One step per core action, each followed by a read that proves it worked. `check` gets the
// call's result ({isError, text, json, images}) and the session's saved values, and returns an
// error string or nothing.
export function scenario({ alias, base, uploadFile, uploadName }) {
  const formUrl = `${base}/form?session=${encodeURIComponent(alias)}`;
  const value = (want) => (r) =>
    r.json?.value === want
      ? null
      : `read back ${JSON.stringify(r.json?.value)}, expected ${JSON.stringify(want)}`;
  const includes = (needle) => (r) =>
    r.text.includes(needle) ? null : `result does not mention ${JSON.stringify(needle)}`;
  const noWarning = (r) => (r.json?.warning ? `warned: ${r.json.warning}` : null);
  const image = (r) =>
    r.images.length === 1 && r.images[0].bytes > 500
      ? null
      : `expected one image, got ${r.images.length}${r.images[0] ? ` of ${r.images[0].bytes} bytes` : ""}`;
  const listed = (want) => (r, saved) => {
    const tab = (r.json?.tabs || []).find((t) => t.id === saved.tabId);
    if (!tab) return want ? `tab ${saved.tabId} is not listed` : null;
    return want ? null : `tab ${saved.tabId} is still listed`;
  };
  return [
    {
      name: "tabs new",
      tool: "browser_tabs",
      args: { action: "new", url: formUrl, browser: alias },
      check: (r, saved) => {
        if (!Number.isInteger(r.json?.id)) return "no tab id";
        saved.tabId = r.json.id;
        return null;
      },
      essential: true,
    },
    {
      name: "tabs list",
      tool: "browser_tabs",
      args: { action: "list", browser: alias, query: "browserctl test form" },
      check: listed(true),
    },
    {
      name: "wait_for #ready",
      tool: "browser_wait_for",
      args: { selector: "#ready" },
      check: (r) => (r.json?.found === true ? null : "not found"),
    },
    { name: "snapshot", tool: "browser_snapshot", args: {}, check: includes("Add one") },
    { name: "read_page", tool: "browser_read_page", args: {}, check: includes("Full name") },
    {
      name: "find",
      tool: "browser_find",
      args: { query: "Add one" },
      check: (r) => (r.json?.count >= 1 ? null : "no match"),
    },
    { name: "get_content", tool: "browser_get_content", args: {}, check: includes("Gamma") },
    {
      name: "extract",
      tool: "browser_extract",
      args: { selector: "li.row", fields: { title: ".t", n: ".n" } },
      check: (r) =>
        /title=Alpha\s+n=10/.test(r.text) &&
        /title=Beta\s+n=20/.test(r.text) &&
        /title=Gamma\s+n=30/.test(r.text)
          ? null
          : `rows were ${r.text.slice(0, 200)}`,
    },
    { name: "click #inc", tool: "browser_click", args: { target: "#inc" } },
    { name: "click #inc again", tool: "browser_click", args: { target: "#inc" } },
    {
      name: "#count reads 2",
      tool: "browser_get_property",
      args: { target: "#count", property: "text" },
      check: value("2"),
    },
    { name: "type #name", tool: "browser_type", args: { target: "#name", text: "Ada Lovelace" } },
    {
      name: "#name reads back",
      tool: "browser_get_property",
      args: { target: "#name", property: "value" },
      check: value("Ada Lovelace"),
    },
    {
      name: "fill_form",
      tool: "browser_fill_form",
      args: {
        fields: [
          { target: "#email", value: "ada@example.com" },
          { target: "#notes", value: "two\nlines" },
        ],
      },
    },
    {
      name: "#email reads back",
      tool: "browser_get_property",
      args: { target: "#email", property: "value" },
      check: value("ada@example.com"),
    },
    {
      name: "#notes reads back",
      tool: "browser_get_property",
      args: { target: "#notes", property: "value" },
      check: value("two\nlines"),
    },
    {
      name: "select_option",
      tool: "browser_select_option",
      args: { target: "#color", value: "green" },
    },
    {
      name: "#color reads back",
      tool: "browser_get_property",
      args: { target: "#color", property: "value" },
      check: value("green"),
    },
    { name: "click #agree", tool: "browser_click", args: { target: "#agree" }, check: noWarning },
    {
      name: "#agree is checked",
      tool: "browser_get_property",
      args: { target: "#agree", property: "checked" },
      check: value(true),
    },
    {
      name: "click radio Large",
      tool: "browser_click",
      args: { target: "input[value=l]" },
      check: noWarning,
    },
    {
      name: "radio Large is checked",
      tool: "browser_get_property",
      args: { target: "input[value=l]", property: "checked" },
      check: value(true),
    },
    { name: "hover", tool: "browser_hover", args: { target: "#hoverme" } },
    {
      name: "#hoverstate reads hovered",
      tool: "browser_get_property",
      args: { target: "#hoverstate", property: "text" },
      check: value("hovered"),
    },
    { name: "press_key", tool: "browser_press_key", args: { key: "a", target: "#keys" } },
    {
      name: "#lastkey reads a",
      tool: "browser_get_property",
      args: { target: "#lastkey", property: "text" },
      check: value("a"),
    },
    {
      name: "file_upload",
      tool: "browser_file_upload",
      args: { target: "#upload", file: uploadFile },
    },
    {
      name: "#uploaded names the file",
      tool: "browser_get_property",
      args: { target: "#uploaded", property: "text" },
      check: value(uploadName),
    },
    {
      name: "evaluate",
      tool: "browser_evaluate",
      args: { expression: "document.title" },
      check: value("browserctl test form"),
    },
    {
      name: "tab is in the background",
      tool: "browser_tabs",
      args: { action: "list", browser: alias },
      check: (r, saved) => {
        const tab = (r.json?.tabs || []).find((t) => t.id === saved.tabId);
        if (!tab) return `tab ${saved.tabId} is not listed`;
        saved.background = tab.active === false;
        return null;
      },
    },
    {
      name: "screenshot (background)",
      tool: "browser_take_screenshot",
      args: {},
      check: image,
      timed: true,
      note: (saved) => (saved.background ? "tab in the background" : "tab was the active tab"),
    },
    {
      name: "still in the background",
      tool: "browser_tabs",
      args: { action: "list", browser: alias },
      check: (r, saved) => {
        if (!saved.background) return null;
        const tab = (r.json?.tabs || []).find((t) => t.id === saved.tabId);
        return tab && tab.active === false ? null : "the capture brought the tab to the front";
      },
    },
    {
      name: "page is hidden again",
      tool: "browser_evaluate",
      args: { expression: "document.visibilityState" },
      check: (r, saved) =>
        !saved.background || r.json?.value === "hidden"
          ? null
          : `visibilityState is ${r.json?.value}`,
    },
    {
      name: "element screenshot",
      tool: "browser_take_screenshot",
      args: { target: "#f" },
      check: image,
      timed: true,
    },
    { name: "click #nextlink", tool: "browser_click", args: { target: "#nextlink" } },
    {
      name: "#title reads Next page",
      tool: "browser_get_property",
      args: { target: "#title", property: "text" },
      check: value("Next page"),
    },
    { name: "navigate /long", tool: "browser_navigate", args: { url: `${base}/long` } },
    {
      name: "scroll to the bottom",
      tool: "browser_scroll",
      args: { direction: "down", amount: 20000 },
      check: (r) => (r.json?.scrolledY > 0 ? null : `scrolledY ${r.json?.scrolledY}`),
    },
    {
      name: "#bottom is in view",
      tool: "browser_evaluate",
      args: {
        expression:
          "(() => { const r = document.getElementById('bottom').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()",
      },
      check: value(true),
    },
    {
      name: "full-page screenshot",
      tool: "browser_take_screenshot",
      args: { fullPage: true },
      check: image,
      timed: true,
    },
    { name: "navigate /form", tool: "browser_navigate", args: { url: formUrl } },
    {
      name: "type #name for submit",
      tool: "browser_type",
      args: { target: "#name", text: "Grace" },
    },
    { name: "click #submit", tool: "browser_click", args: { target: "#submit" } },
    {
      name: "#title reads Submitted",
      tool: "browser_get_property",
      args: { target: "#title", property: "text" },
      check: value("Submitted"),
    },
    {
      name: "#echo carries the name",
      tool: "browser_get_property",
      args: { target: "#echo", property: "text" },
      check: (r) =>
        /name=Grace/.test(r.json?.value || "") ? null : `echo was ${JSON.stringify(r.json?.value)}`,
    },
    {
      name: "action current_tab",
      tool: "browser_action",
      args: { action: "current_tab" },
      check: (r, saved) => (r.json?.id === saved.tabId ? null : `current tab is ${r.json?.id}`),
    },
    {
      name: "tabs close",
      tool: "browser_tabs",
      args: (saved) => ({ action: "close", tabId: saved.tabId }),
      check: (r, saved) => {
        saved.closed = true;
        return null;
      },
    },
    {
      name: "tab is gone",
      tool: "browser_tabs",
      args: { action: "list", browser: alias },
      check: listed(false),
    },
  ];
}

// ---------------------------------------------------------------- sessions

function parseResult(res) {
  const images = [];
  let text = "";
  for (const c of res.content || []) {
    if (c.type === "image") images.push({ bytes: Math.round((c.data.length * 3) / 4) });
    else if (c.type === "text") text += c.text || "";
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // extract answers in text rows, and screenshots with an image only
  }
  return { isError: res.isError === true, text, json, images };
}

async function openSession(bridgeUrl) {
  const env = { ...process.env };
  delete env.BROWSERCTL_CALL_LOG;
  env.BROWSERCTL_BRIDGE_URL = bridgeUrl;
  env.BROWSERCTL_AUTO_START = "manual";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "multi-browser-parallel", version: "1.0.0" });
  await client.connect(transport);
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      return parseResult(res);
    },
    close: () => client.close().catch(() => {}),
  };
}

// Resolves when `count` parties have arrived, so every session starts its first step together.
function barrier(count) {
  let arrived = 0;
  let release;
  const all = new Promise((r) => (release = r));
  return () => {
    arrived++;
    if (arrived === count) release(Date.now());
    return all;
  };
}

async function runSession({ alias, session, steps, arrive }) {
  const saved = {};
  const out = { alias, results: [], saved, window: null };
  const start = await arrive();
  for (const step of steps) {
    const args = typeof step.args === "function" ? step.args(saved) : step.args;
    const t0 = Date.now();
    let status = "PASS";
    let detail = "";
    try {
      const r = await session.call(step.tool, args);
      const ms = Date.now() - t0;
      if (r.isError) {
        status = "FAIL";
        detail = r.text.slice(0, 300);
      } else if (r.json && r.json.browser !== undefined && r.json.browser !== alias) {
        status = "FAIL";
        detail = `answered by ${r.json.browser}`;
      } else {
        const problem = step.check ? step.check(r, saved) : null;
        if (problem) {
          status = "FAIL";
          detail = problem;
        }
      }
      if (step.timed) {
        const note = step.note ? `, ${step.note(saved)}` : "";
        detail = `${ms} ms${note}${detail ? `, ${detail}` : ""}`;
      }
    } catch (err) {
      status = "FAIL";
      detail = err.message;
    }
    out.results.push({ step: step.name, status, detail });
    if (status === "FAIL" && step.essential) break;
  }
  out.window = { start, end: Date.now() };
  return out;
}

// ---------------------------------------------------------------- main

async function bridgeGet(bridgeUrl, path) {
  const res = await fetch(`${bridgeUrl}${path}`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function bridgeCommand(bridgeUrl, action, params, browser) {
  const res = await fetch(`${bridgeUrl}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      params,
      browser,
      client: { session: "parallel-gate", source: "e2e" },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${action}: ${j.error}`);
  return j.result;
}

function callLogSince(path, since) {
  if (!path) return [];
  let buf;
  try {
    buf = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return buf
    .slice(since)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const flag = argv.indexOf("--bridge-url");
  const bridgeUrl =
    (flag >= 0 && argv[flag + 1]) || process.env.BROWSERCTL_BRIDGE_URL || "http://127.0.0.1:8765";

  let status;
  try {
    status = await bridgeGet(bridgeUrl, "/status");
  } catch (err) {
    console.error(`bridge unreachable at ${bridgeUrl}: ${err.message}`);
    return 2;
  }
  // --browsers a,b (or BROWSERCTL_PARALLEL_BROWSERS) runs only those aliases, in that order
  const only = (() => {
    const i = argv.indexOf("--browsers");
    const v = (i >= 0 && argv[i + 1]) || process.env.BROWSERCTL_PARALLEL_BROWSERS || "";
    return v
      ? v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : null;
  })();
  const connected = Array.isArray(status.browsers) ? status.browsers : [];
  const browsers = (
    only ? only.map((a) => connected.find((b) => b.alias === a)).filter(Boolean) : connected
  ).slice(0, MAX_BROWSERS);
  if (!status.extensionConnected || browsers.length < 2) {
    console.log("SKIPPED (one browser)");
    return 0;
  }
  const aliases = browsers.map((b) => b.alias);
  console.log(`bridge: ${bridgeUrl}`);
  console.log(`browsers: ${aliases.join(", ")}`);

  const checks = [];
  const record = (status_, name, detail) => {
    checks.push({ status: status_, name });
    console.log(`[${status_}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const fixture = await startFixture();
  const uploadDir = mkdtempSync(join(tmpdir(), "browserctl-parallel-"));
  const uploadName = "parallel-upload.txt";
  const uploadFile = join(uploadDir, uploadName);
  writeFileSync(uploadFile, "browserctl parallel gate\n");
  const logPath = status.callLog || null;
  const logFrom = fileSize(logPath);

  const sessions = [];
  let runs = [];
  try {
    for (const alias of aliases) sessions.push({ alias, session: await openSession(bridgeUrl) });
    const arrive = barrier(sessions.length);
    runs = await Promise.all(
      sessions.map(({ alias, session }) =>
        runSession({
          alias,
          session,
          arrive,
          steps: scenario({ alias, base: fixture.base, uploadFile, uploadName }),
        })
      )
    );
  } finally {
    // Every tab a session opened is closed here if its own scenario did not get to it.
    for (const run of runs) {
      if (run.saved.tabId != null && !run.saved.closed) {
        try {
          await bridgeCommand(bridgeUrl, "close_tab", { id: run.saved.tabId }, run.alias);
        } catch (err) {
          record(
            "FAIL",
            `${run.alias}: close tab ${run.saved.tabId}`,
            `${err.message} — close it by hand`
          );
        }
      }
    }
    await Promise.all(sessions.map(({ session }) => session.close()));
    await fixture.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }

  const stepCount = scenario({ alias: "", base: "", uploadFile, uploadName }).length;
  for (const run of runs) {
    for (const r of run.results) {
      if (r.status === "FAIL" || r.detail) record(r.status, `${run.alias}: ${r.step}`, r.detail);
      else checks.push({ status: r.status, name: `${run.alias}: ${r.step}` });
    }
    const passed = run.results.filter((r) => r.status === "PASS").length;
    console.log(`${run.alias}: ${passed}/${stepCount} steps passed`);
  }

  const ratio = overlapRatio(runs.map((r) => r.window));
  record(
    ratio > MIN_OVERLAP ? "PASS" : "FAIL",
    "sessions ran in parallel",
    `windows overlap ${Math.round(ratio * 100)}% (${runs.map((r) => `${r.alias} ${r.window.end - r.window.start} ms`).join(", ")})`
  );

  if (!logPath) {
    record(
      "SKIP",
      "call log names only each session's own browser and tab",
      "call log not configured on the bridge"
    );
  } else {
    const { problems, lines } = checkCallLog(
      callLogSince(logPath, logFrom),
      runs.map((r) => ({ alias: r.alias, tabId: r.saved.tabId }))
    );
    record(
      problems.length ? "FAIL" : "PASS",
      "call log names only each session's own browser and tab",
      problems.length
        ? problems.slice(0, 5).join("; ")
        : Object.entries(lines)
            .map(([a, n]) => `${a} ${n} lines`)
            .join(", ")
    );
  }

  const left = [];
  for (const alias of aliases) {
    try {
      const { tabs } = await bridgeCommand(bridgeUrl, "list_tabs", {}, alias);
      for (const t of tabs || []) {
        if ((t.url || "").startsWith(fixture.base)) left.push(`${alias} tab ${t.id}`);
      }
    } catch (err) {
      left.push(`${alias}: list_tabs failed (${err.message})`);
    }
  }
  record(
    left.length ? "FAIL" : "PASS",
    "every opened tab is closed",
    left.length
      ? `left open: ${left.join(", ")} — close by hand`
      : `${runs.filter((r) => r.saved.tabId != null).length} opened, 0 left`
  );

  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const skipped = checks.filter((c) => c.status === "SKIP").length;
  const perBrowser = runs
    .map((r) => `${r.alias} ${r.results.filter((x) => x.status === "PASS").length}/${stepCount}`)
    .join(", ");
  console.log(`SUMMARY: ${perBrowser}; overlap ${Math.round(ratio * 100)}%`);
  console.log(
    `RESULT: ${passed}/${checks.length} checks passed, ${skipped} skipped, ${failed} failed`
  );
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    }
  );
}
