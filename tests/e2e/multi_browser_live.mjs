#!/usr/bin/env node
// Live acceptance checks for RFC section 14 ("One Bridge, Many Browsers"), Task 8 step 1.
// Drives the bridge named by --bridge-url / BROWSERCTL_BRIDGE_URL / BRIDGE_URL (default
// http://127.0.0.1:8765) through real MCP sessions (mcp/index.js over stdio), the way an agent
// does. Every check here is scripted; two checks need a person at the keyboard and run only
// with --interactive, prompting on stdin. tests/e2e/multi_browser_probes.md covers the agent
// probes this script cannot drive itself.
//
// Exits 0 when every non-skipped check passes (including the whole-script "one browser"
// skip), 1 when any check fails, 2 when the bridge itself cannot be reached.
//
// Usage:
//   node tests/e2e/multi_browser_live.mjs [--fb-query <text>] [--edge-query <text>]
//     [--interactive] [--bridge-url <url>]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = join(HERE, "..", "..", "mcp", "index.js");

function parseArgs(argv) {
  const out = {
    fbQuery: undefined,
    edgeQuery: undefined,
    interactive: false,
    bridgeUrl: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fb-query") out.fbQuery = argv[++i];
    else if (a === "--edge-query") out.edgeQuery = argv[++i];
    else if (a === "--interactive") out.interactive = true;
    else if (a === "--bridge-url") out.bridgeUrl = argv[++i];
  }
  return out;
}

function resolveOption(cliVal, envName, fallback) {
  if (cliVal !== undefined) return cliVal;
  const envVal = process.env[envName];
  if (envVal) return envVal;
  return fallback;
}

const ARGS = parseArgs(process.argv.slice(2));
const BRIDGE_URL = resolveOption(
  ARGS.bridgeUrl,
  "BROWSERCTL_BRIDGE_URL",
  resolveOption(undefined, "BRIDGE_URL", "http://127.0.0.1:8765")
);
const FB_QUERY = resolveOption(ARGS.fbQuery, "BROWSERCTL_FB_QUERY", "facebook");
const EDGE_QUERY = resolveOption(ARGS.edgeQuery, "BROWSERCTL_EDGE_QUERY", "example.com");
const INTERACTIVE = ARGS.interactive;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeStatus() {
  const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function prompt(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message} `);
  } finally {
    rl.close();
  }
}

function callLogSize(path) {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Every entry the bridge appended to the call log after byte offset `since`. Tolerant of a
// partial trailing line (a write caught mid-append) and of the log not being configured.
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

// ---------------------------------------------------------------- MCP sessions

const sessions = [];

async function session() {
  const env = { ...process.env };
  delete env.BROWSERCTL_CALL_LOG;
  env.BROWSERCTL_BRIDGE_URL = BRIDGE_URL;
  env.BROWSERCTL_AUTO_START = "manual";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "multi-browser-live", version: "1.0.0" });
  await client.connect(transport);
  sessions.push(client);
  return {
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const t = res.content?.[0]?.text ?? "";
      let json = null;
      try {
        json = JSON.parse(t);
      } catch {
        // non-JSON tool replies are reported through .text
      }
      return { isError: res.isError === true, text: t, json };
    },
    async close() {
      await client.close();
      sessions.splice(sessions.indexOf(client), 1);
    },
  };
}

// ---------------------------------------------------------------- reporting

const results = [];

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const label = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${label}] ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- checks

// 1.1: /status lists every connected browser (at least two) with an alias and a non-empty
// instanceId, none of them a pre-hello legacy connection. The instanceIds are printed for the owner
// to cross-check against each extension's Options page by hand — this script has no way to read
// that page without disturbing a live tab.
async function check1_1(status) {
  const name = "status lists every connected browser with its own instanceId";
  const browsers = status.browsers || [];
  if (browsers.length < 2) {
    record("1.1", name, "FAIL", `need at least two browsers, got ${browsers.length}`);
    return;
  }
  const bad = browsers.filter((b) => !b.instanceId || b.legacy);
  if (bad.length) {
    record("1.1", name, "FAIL", `no instanceId (or legacy): ${bad.map((b) => b.alias).join(", ")}`);
    return;
  }
  record(
    "1.1",
    name,
    "PASS",
    `${browsers.map((b) => `${b.alias}(${b.browserType})=${b.instanceId}`).join(", ")} (cross-check each instanceId against that extension's Options page)`
  );
}

// 1.2: tabs list query:"facebook" (default) returns exactly the one profile's tab.
async function check1_2() {
  const A = await session();
  try {
    const res = await A.call("browser_tabs", { action: "list", query: FB_QUERY });
    if (res.isError) {
      record("1.2", `tabs list query:${JSON.stringify(FB_QUERY)}`, "FAIL", res.text);
      return;
    }
    const tabs = res.json?.tabs || [];
    if (tabs.length !== 1) {
      record(
        "1.2",
        `tabs list query:${JSON.stringify(FB_QUERY)}`,
        "FAIL",
        `matched ${tabs.length} tabs (${tabs.map((t) => t.browser).join(", ") || "none"}), expected exactly 1`
      );
      return;
    }
    record(
      "1.2",
      `tabs list query:${JSON.stringify(FB_QUERY)}`,
      "PASS",
      `matched ${tabs[0].browser} tab ${tabs[0].id}`
    );
  } finally {
    await A.close();
  }
}

// 1.3: the browser holding the page found by --edge-query answers a snapshot, and the
// call log line the bridge wrote for it carries that browser's instanceId.
async function check1_3(status, logPath) {
  const A = await session();
  try {
    const list = await A.call("browser_tabs", { action: "list", query: EDGE_QUERY });
    const tabs = list.json?.tabs || [];
    if (list.isError || tabs.length !== 1) {
      record(
        "1.3",
        `snapshot the browser holding query:${JSON.stringify(EDGE_QUERY)}`,
        "FAIL",
        list.isError ? list.text : `matched ${tabs.length} tabs, expected exactly 1`
      );
      return;
    }
    const owner = tabs[0].browser;
    const expectedInstanceId = (status.browsers || []).find((b) => b.alias === owner)?.instanceId;
    const before = callLogSize(logPath);
    await A.call("browser_tabs", { action: "select", tabId: tabs[0].id });
    const snap = await A.call("browser_snapshot", {});
    if (snap.isError) {
      record(
        "1.3",
        `snapshot the browser holding query:${JSON.stringify(EDGE_QUERY)}`,
        "FAIL",
        snap.text
      );
      return;
    }
    if (!logPath) {
      record(
        "1.3",
        `snapshot the browser holding query:${JSON.stringify(EDGE_QUERY)}`,
        "PASS",
        `served by ${owner} (call log not configured — instanceId not cross-checked)`
      );
      return;
    }
    const snapEntry = callLogSince(logPath, before).find((e) => e.action === "snapshot");
    if (!snapEntry || snapEntry.instanceId !== expectedInstanceId) {
      record(
        "1.3",
        `snapshot the browser holding query:${JSON.stringify(EDGE_QUERY)}`,
        "FAIL",
        `call log line was ${JSON.stringify(snapEntry)}, expected instanceId ${expectedInstanceId}`
      );
      return;
    }
    record(
      "1.3",
      `snapshot the browser holding query:${JSON.stringify(EDGE_QUERY)}`,
      "PASS",
      `served by ${owner}, call log instanceId matches`
    );
  } finally {
    await A.close();
  }
}

// 1.4 (needs a person): after the owner focuses Chrome by hand, a fresh session's first
// snapshot (no browser named) reports target.browser as a Chrome alias.
async function check1_4() {
  if (!INTERACTIVE) {
    record(
      "1.4",
      "focus Chrome by hand, then snapshot with no browser named",
      "SKIPPED (needs --interactive)"
    );
    return;
  }
  await prompt("Focus a Chrome window (click into it), then press Enter:");
  const A = await session();
  try {
    const snap = await A.call("browser_snapshot", {});
    const alias = snap.json?.target?.browser;
    if (snap.isError || !alias || !alias.startsWith("chrome")) {
      record(
        "1.4",
        "focus Chrome by hand, then snapshot with no browser named",
        "FAIL",
        snap.isError ? snap.text : `target.browser was ${JSON.stringify(alias)}`
      );
      return;
    }
    record(
      "1.4",
      "focus Chrome by hand, then snapshot with no browser named",
      "PASS",
      `target.browser=${alias}`
    );
  } finally {
    await A.close();
  }
}

// 1.5 (needs a person): after the owner restarts the bridge, every alias maps to the same
// instanceId it had before.
async function check1_5(before) {
  if (!INTERACTIVE) {
    record("1.5", "restart the bridge; aliases are unchanged", "SKIPPED (needs --interactive)");
    return;
  }
  const beforeMap = new Map((before.browsers || []).map((b) => [b.instanceId, b.alias]));
  await prompt("Restart the bridge now, wait for every extension to reconnect, then press Enter:");
  let after;
  for (let i = 0; i < 30; i++) {
    try {
      after = await bridgeStatus();
      if (after.extensionConnected && (after.browsers || []).length >= beforeMap.size) break;
    } catch {
      // bridge still coming back up
    }
    await sleep(1000);
  }
  if (!after) {
    record(
      "1.5",
      "restart the bridge; aliases are unchanged",
      "FAIL",
      "bridge did not come back within 30s"
    );
    return;
  }
  const mismatches = [];
  for (const b of after.browsers || []) {
    const wasAlias = beforeMap.get(b.instanceId);
    if (wasAlias && wasAlias !== b.alias)
      mismatches.push(`${b.instanceId}: ${wasAlias} -> ${b.alias}`);
  }
  if (mismatches.length) {
    record("1.5", "restart the bridge; aliases are unchanged", "FAIL", mismatches.join(", "));
    return;
  }
  record(
    "1.5",
    "restart the bridge; aliases are unchanged",
    "PASS",
    `${after.browsers.length} browsers reconnected`
  );
}

// 1.6: two MCP processes drive two Edge tabs concurrently — 20 snapshots each — and every
// call-log line pairs the calling session with the right tabId. Opens a second Edge tab if
// only one is open, and closes it again afterward.
// A local page for scratch tabs, so the concurrency check never depends on which pages the owner
// has open.
async function startScratchServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>browserctl scratch ${req.url}</title><button>ok</button>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    // A browser keeps its connection alive after the page loads; close() waits on it otherwise
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

async function check1_6(status, logPath) {
  const edgeAlias = (status.browsers || []).find((b) => b.browserType === "edge")?.alias;
  if (!edgeAlias) {
    record(
      "1.6",
      "two sessions drive two Edge tabs concurrently",
      "FAIL",
      "no Edge browser connected"
    );
    return;
  }
  const A = await session();
  const B = await session();
  const openedTabs = [];
  let scratchServer = null;
  try {
    const listed = await A.call("browser_tabs", { action: "list", browser: edgeAlias });
    // Only a web page can be read; edge:// and about: pages refuse the content script
    let edgeTabs = (listed.json?.tabs || []).filter(
      (t) => t.browser === edgeAlias && /^https?:/i.test(t.url || "")
    );
    while (edgeTabs.length < 2) {
      scratchServer ||= await startScratchServer();
      const created = await A.call("browser_tabs", {
        action: "new",
        url: `${scratchServer.base}/scratch-${openedTabs.length + 1}`,
        browser: edgeAlias,
      });
      if (created.isError) {
        record("1.6", "two sessions drive two Edge tabs concurrently", "FAIL", created.text);
        return;
      }
      openedTabs.push(created.json?.id);
      edgeTabs = [...edgeTabs, { id: created.json?.id, browser: edgeAlias }];
    }
    const [tabA, tabB] = edgeTabs;
    const selA = await A.call("browser_tabs", { action: "select", tabId: tabA.id });
    const selB = await B.call("browser_tabs", { action: "select", tabId: tabB.id });
    if (selA.isError || selB.isError) {
      record(
        "1.6",
        "two sessions drive two Edge tabs concurrently",
        "FAIL",
        selA.isError ? selA.text : selB.text
      );
      return;
    }
    const before = callLogSize(logPath);
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(A.call("browser_snapshot", {}).then((r) => ["A", r]));
      jobs.push(B.call("browser_snapshot", {}).then((r) => ["B", r]));
    }
    const outcomes = await Promise.all(jobs);
    const failedCall = outcomes.find(([, r]) => r.isError);
    if (failedCall) {
      record("1.6", "two sessions drive two Edge tabs concurrently", "FAIL", failedCall[1].text);
      return;
    }
    if (!logPath) {
      record(
        "1.6",
        "two sessions drive two Edge tabs concurrently",
        "PASS",
        "40 snapshots served (call log not configured — pairing not cross-checked)"
      );
      return;
    }
    const entries = callLogSince(logPath, before).filter((e) => e.action === "snapshot");
    const bySession = new Map();
    for (const e of entries) {
      if (!bySession.has(e.session)) bySession.set(e.session, new Set());
      bySession.get(e.session).add(e.tabId);
    }
    const sessionIds = [...bySession.keys()];
    const clean =
      entries.length === 40 &&
      sessionIds.length === 2 &&
      sessionIds.every((id) => bySession.get(id).size === 1) &&
      new Set(sessionIds.map((id) => [...bySession.get(id)][0])).size === 2;
    if (!clean) {
      record(
        "1.6",
        "two sessions drive two Edge tabs concurrently",
        "FAIL",
        `${entries.length} call-log lines across ${sessionIds.length} sessions did not pair cleanly by tabId`
      );
      return;
    }
    record(
      "1.6",
      "two sessions drive two Edge tabs concurrently",
      "PASS",
      "40 snapshots, 2 sessions, each paired with one tabId throughout"
    );
  } finally {
    for (const tabId of openedTabs) {
      try {
        const closed = await A.call("browser_tabs", { action: "close", tabId });
        if (closed.isError) {
          record(
            "1.6",
            "two sessions drive two Edge tabs concurrently",
            "FAIL",
            `could not close the scratch tab it opened (tabId ${tabId}): ${closed.text} — close it by hand`
          );
        }
      } catch (err) {
        record(
          "1.6",
          "two sessions drive two Edge tabs concurrently",
          "FAIL",
          `could not close the scratch tab it opened (tabId ${tabId}): ${err.message} — close it by hand`
        );
      }
    }
    if (scratchServer) await scratchServer.close();
    await A.close().catch(() => {});
    await B.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- main

async function main() {
  let status;
  try {
    status = await bridgeStatus();
  } catch (err) {
    console.error(`bridge unreachable at ${BRIDGE_URL}: ${err.message}`);
    process.exit(2);
  }
  const browsers = Array.isArray(status.browsers) ? status.browsers : [];
  if (!status.extensionConnected || browsers.length < 2) {
    console.log("SKIPPED (one browser)");
    process.exit(0);
  }

  console.log(`bridge: ${BRIDGE_URL}`);
  console.log(`browsers: ${browsers.map((b) => `${b.alias}(${b.browserType})`).join(", ")}`);
  console.log(
    status.callLog
      ? `call log: ${status.callLog}`
      : "call log: not configured — set BROWSERCTL_CALL_LOG on the bridge for full checks"
  );

  await check1_1(status);
  await check1_2();
  await check1_3(status, status.callLog);
  await check1_4();
  await check1_5(status);
  await check1_6(status, status.callLog);

  await Promise.all(sessions.map((c) => c.close().catch(() => {})));

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status.startsWith("SKIPPED")).length;
  console.log(
    `RESULT: ${passed}/${results.length} checks passed, ${skipped} skipped, ${failed} failed`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
