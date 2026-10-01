#!/usr/bin/env node
// Live acceptance checks for several browsers on one bridge (docs/internal/tool-surface.md §3.9).
// Drives the bridge named by --bridge-url / BROWSERCTL_BRIDGE_URL / BRIDGE_URL (default
// http://127.0.0.1:8765) through real MCP sessions (mcp/index.js over stdio), the way an agent
// does. Every check here is scripted; one check needs a person at the keyboard and runs only
// with --interactive, prompting on stdin. tests/e2e/multi_browser_probes.md covers the agent
// probes this script cannot drive itself.
//
// Exits 0 when every non-skipped check passes (including the whole-script "one browser"
// skip), 1 when any check fails, 2 when the bridge itself cannot be reached.
//
// Usage:
//   node tests/e2e/multi_browser_live.mjs [--interactive] [--bridge-url <url>]
// Every tab it uses is one it opens itself and closes again; the owner's tabs are never touched.
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
    interactive: false,
    bridgeUrl: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--interactive") out.interactive = true;
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
      const images = (res.content || []).filter((c) => c.type === "image").map((c) => c.data);
      return { isError: res.isError === true, text: t, json, images };
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

// A page every browser can open, used for the tabs this script opens itself. The query string makes
// each opened tab unique, so a tabs-list query matches that one tab and none of the owner's.
const PROBE_PAGE = "https://example.com/";
const probeId = () => `bctl-probe-${Math.random().toString(36).slice(2, 10)}`;

// Opens a probe tab in BROWSER through session S and returns { id, marker }, or records a FAIL
async function openProbeTab(check, name, s, browser) {
  const marker = probeId();
  const created = await s.call("browser_tabs", {
    action: "new",
    url: `${PROBE_PAGE}?${marker}`,
    browser,
  });
  if (created.isError || created.json?.id == null) {
    record(check, name, "FAIL", created.text || "new tab returned no id");
    return null;
  }
  return { id: created.json.id, marker };
}

async function closeProbeTab(check, name, s, tab) {
  if (!tab) return;
  try {
    const closed = await s.call("browser_tabs", { action: "close", tabId: tab.id });
    if (closed.isError) {
      record(
        check,
        name,
        "FAIL",
        `could not close the tab it opened (tabId ${tab.id}): ${closed.text} — close it by hand`
      );
    }
  } catch (err) {
    record(
      check,
      name,
      "FAIL",
      `could not close the tab it opened (tabId ${tab.id}): ${err.message} — close it by hand`
    );
  }
}

// 1.2: a tab this script opens in one browser is found by a tabs-list query across every browser,
// exactly once, tagged with that browser.
async function check1_2(status) {
  const name = "tabs list query finds the one tab opened in one browser";
  const browsers = status.browsers || [];
  const target = (browsers.find((b) => b.browserType !== "edge") || browsers[0])?.alias;
  let A = null;
  let tab = null;
  try {
    A = await session();
    tab = await openProbeTab("1.2", name, A, target);
    if (!tab) return;
    const res = await A.call("browser_tabs", { action: "list", query: tab.marker });
    const tabs = res.json?.tabs || [];
    if (res.isError || tabs.length !== 1 || tabs[0].browser !== target || tabs[0].id !== tab.id) {
      record(
        "1.2",
        name,
        "FAIL",
        res.isError
          ? res.text
          : `matched ${tabs.map((t) => `${t.browser}:${t.id}`).join(", ") || "nothing"}, expected ${target}:${tab.id}`
      );
      return;
    }
    record("1.2", name, "PASS", `matched ${target} tab ${tab.id} only`);
  } catch (err) {
    record("1.2", name, "FAIL", err.message);
  } finally {
    if (A) await closeProbeTab("1.2", name, A, tab);
    if (A) await A.close().catch(() => {});
  }
}

// 1.3: a tab this script opens in Edge (or the second browser) is selected and snapshotted, and the
// call-log line the bridge wrote for the snapshot carries that browser's instanceId.
async function check1_3(status, logPath) {
  const name = "snapshot of a tab opened in Edge is served by Edge";
  const browsers = status.browsers || [];
  const target = (browsers.find((b) => b.browserType === "edge") || browsers[1] || browsers[0])
    ?.alias;
  const expectedInstanceId = browsers.find((b) => b.alias === target)?.instanceId;
  let A = null;
  let tab = null;
  try {
    A = await session();
    tab = await openProbeTab("1.3", name, A, target);
    if (!tab) return;
    const before = callLogSize(logPath);
    const selected = await A.call("browser_tabs", { action: "select", tabId: tab.id });
    const snap = selected.isError ? selected : await A.call("browser_snapshot", {});
    if (snap.isError) {
      record("1.3", name, "FAIL", snap.text);
      return;
    }
    if (!logPath) {
      record(
        "1.3",
        name,
        "PASS",
        `served by ${target} (call log not configured — instanceId not cross-checked)`
      );
      return;
    }
    const snapEntry = callLogSince(logPath, before).find((e) => e.action === "snapshot");
    if (!snapEntry || snapEntry.instanceId !== expectedInstanceId) {
      record(
        "1.3",
        name,
        "FAIL",
        `call log line was ${JSON.stringify(snapEntry)}, expected instanceId ${expectedInstanceId}`
      );
      return;
    }
    record("1.3", name, "PASS", `served by ${target}, call log instanceId matches`);
  } catch (err) {
    record("1.3", name, "FAIL", err.message);
  } finally {
    if (A) await closeProbeTab("1.3", name, A, tab);
    if (A) await A.close().catch(() => {});
  }
}

// 1.4: with several browsers connected, a fresh session's first call names no tab and is answered
// NEEDS_TARGET, listing the tabs to choose from, whichever window the owner focused last.
async function check1_4(status) {
  const name = "several browsers: a first call naming no tab is NEEDS_TARGET, listing the tabs";
  if ((status.browsers || []).length < 2) {
    record("1.4", name, "SKIPPED (needs two browsers)");
    return;
  }
  const A = await session();
  try {
    const snap = await A.call("browser_snapshot", {});
    if (!snap.isError || !/NEEDS_TARGET/.test(snap.text) || !/ tab \d+ /.test(snap.text)) {
      record("1.4", name, "FAIL", snap.isError ? snap.text : "the snapshot was served");
      return;
    }
    record("1.4", name, "PASS", "refused before acting, with the tabs listed");
  } finally {
    await A.close();
  }
}

// 1.8: a second session can read another session's tab by its id but not act on it, and only
// the holder can close it.
async function check1_8(status) {
  const name = "another session's tab can be read by id, never acted on";
  const alias = (status.browsers || [])[0]?.alias;
  if (!alias) {
    record("1.8", name, "FAIL", "no browser connected");
    return;
  }
  let scratchServer = null;
  let A = null;
  let B = null;
  let tabId = null;
  try {
    A = await session();
    B = await session();
    scratchServer = await startScratchServer();
    const created = await A.call("browser_tabs", {
      action: "new",
      url: `${scratchServer.base}/held`,
      browser: alias,
    });
    if (created.isError) {
      record("1.8", name, "FAIL", created.text);
      return;
    }
    tabId = created.json?.id;
    const click = await B.call("browser_click", { target: "body", tabId });
    const read = await B.call("browser_snapshot", { tabId });
    const close = await B.call("browser_tabs", { action: "close", tabId });
    const owned = (r) => r.isError && /TAB_OWNED/.test(r.text);
    if (!owned(click) || !owned(close) || read.isError) {
      record(
        "1.8",
        name,
        "FAIL",
        `click ${owned(click) ? "refused" : "NOT refused"}, close ${owned(close) ? "refused" : "NOT refused"}, read ${read.isError ? `failed: ${read.text}` : "served"}`
      );
      return;
    }
    record("1.8", name, "PASS", `on ${alias}: click and close refused TAB_OWNED, snapshot served`);
  } catch (err) {
    record("1.8", name, "FAIL", err.message);
  } finally {
    if (tabId != null && A) {
      const closed = await A.call("browser_tabs", { action: "close", tabId }).catch((e) => ({
        isError: true,
        text: e.message,
      }));
      if (closed.isError) {
        record(
          "1.8",
          name,
          "FAIL",
          `could not close tab ${tabId}: ${closed.text} — close it by hand`
        );
      }
    }
    if (scratchServer) await scratchServer.close();
    if (A) await A.close().catch(() => {});
    if (B) await B.close().catch(() => {});
  }
}

// 1.9: a second session cannot take a tab while its holder is acting there (TAB_BUSY); once the
// holder yields and has been idle long enough, the tab is taken, and the holder is told.
async function check1_9(status) {
  const name = "a tab is never taken mid-action; a yielded tab is taken and its holder told";
  const alias = (status.browsers || [])[0]?.alias;
  if (!alias) {
    record("1.9", name, "FAIL", "no browser connected");
    return;
  }
  let scratchServer = null;
  let A = null;
  let B = null;
  let tabId = null;
  let owner = null;
  try {
    A = await session();
    B = await session();
    scratchServer = await startScratchServer();
    const created = await A.call("browser_tabs", {
      action: "new",
      url: `${scratchServer.base}/take`,
      browser: alias,
    });
    if (created.isError) {
      record("1.9", name, "FAIL", created.text);
      return;
    }
    tabId = created.json?.id;
    owner = A;
    await A.call("browser_snapshot", {});
    const busy = await B.call("browser_tabs", { action: "select", tabId, force: true });
    if (!busy.isError || !/TAB_BUSY/.test(busy.text)) {
      record("1.9", name, "FAIL", `a take right after A acted was not TAB_BUSY: ${busy.text}`);
      return;
    }
    await A.call("browser_tabs", { action: "yield" });
    const waitS = Number((busy.text.match(/Try again in (\d+)s/) || [])[1] || 30);
    await new Promise((r) => setTimeout(r, (waitS + 1) * 1000));
    const took = await B.call("browser_tabs", { action: "select", tabId });
    if (took.isError) {
      record("1.9", name, "FAIL", `the yielded tab was not taken: ${took.text}`);
      return;
    }
    owner = B;
    const told = await A.call("browser_snapshot", {});
    if (!told.isError || !/TARGET_TAKEN/.test(told.text)) {
      record("1.9", name, "FAIL", `A was not told: ${told.text}`);
      return;
    }
    record("1.9", name, "PASS", `on ${alias}: TAB_BUSY, then taken after ${waitS}s, A told`);
  } catch (err) {
    record("1.9", name, "FAIL", err.message);
  } finally {
    if (tabId != null && owner) {
      const closed = await owner.call("browser_tabs", { action: "close", tabId }).catch((e) => ({
        isError: true,
        text: e.message,
      }));
      if (closed.isError) {
        record(
          "1.9",
          name,
          "FAIL",
          `could not close tab ${tabId}: ${closed.text} — close it by hand`
        );
      }
    }
    if (scratchServer) await scratchServer.close();
    if (A) await A.close().catch(() => {});
    if (B) await B.close().catch(() => {});
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

// 1.7: two sessions on one browser take screenshots at the same moment, one tab in front and one
// behind it. None may be refused, and each image must show its own session's page.
async function check1_7(status) {
  const name = "two sessions capture screenshots on one browser at the same time";
  const browsers = status.browsers || [];
  // BROWSERCTL_CAPTURE_BROWSER names the browser to run it on; otherwise the first Chrome
  const alias =
    process.env.BROWSERCTL_CAPTURE_BROWSER ||
    (browsers.find((b) => b.browserType === "chrome") || browsers[0])?.alias;
  if (!alias) {
    record("1.7", name, "FAIL", "no browser connected");
    return;
  }
  const opened = [];
  let scratchServer = null;
  let A = null;
  let B = null;
  try {
    A = await session();
    B = await session();
    scratchServer = await startScratchServer();
    for (const [s, i] of [
      [A, 1],
      [B, 2],
    ]) {
      const created = await s.call("browser_tabs", {
        action: "new",
        url: `${scratchServer.base}/shot-${i}`,
        browser: alias,
        activate: true,
      });
      if (created.isError) {
        record("1.7", name, "FAIL", created.text);
        return;
      }
      opened.push({ tabId: created.json?.id, owner: s });
    }
    // One session's tab is in front and one is behind it: both capture paths run at once
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      jobs.push(A.call("browser_take_screenshot", {}).then((r) => ["A", r]));
      jobs.push(B.call("browser_take_screenshot", {}).then((r) => ["B", r]));
    }
    const settled = await Promise.allSettled(jobs);
    const failures = settled.filter((x) => x.status === "rejected" || x.value[1].isError);
    if (failures.length) {
      const f = failures[0];
      const why = f.status === "rejected" ? f.reason.message : f.value[1].text;
      record(
        "1.7",
        name,
        "FAIL",
        `${failures.length}/6 refused on ${alias}: ${String(why).slice(0, 200)}`
      );
      return;
    }
    // Each session's images must show its own page: no image may appear in both sessions' sets
    const bySession = { A: new Set(), B: new Set() };
    for (const x of settled) bySession[x.value[0]].add((x.value[1].images || [])[0] || "");
    const crossed = [...bySession.A].some((img) => img && bySession.B.has(img));
    const missing = [...bySession.A, ...bySession.B].some((img) => !img);
    if (crossed || missing) {
      record(
        "1.7",
        name,
        "FAIL",
        crossed
          ? "a session received the other session's page in its screenshot"
          : "a screenshot returned no image"
      );
      return;
    }
    record(
      "1.7",
      name,
      "PASS",
      `6 concurrent screenshots on ${alias}, none refused, each of its own page`
    );
  } catch (err) {
    record("1.7", name, "FAIL", err.message);
  } finally {
    // Each scratch tab is its opener's target, so only that session may close it
    for (const { tabId, owner } of opened) {
      try {
        const closed = await owner.call("browser_tabs", { action: "close", tabId });
        if (closed.isError) {
          record(
            "1.7",
            name,
            "FAIL",
            `could not close the scratch tab it opened (tabId ${tabId}): ${closed.text} — close it by hand`
          );
        }
      } catch (err) {
        record(
          "1.7",
          name,
          "FAIL",
          `could not close the scratch tab it opened (tabId ${tabId}): ${err.message} — close it by hand`
        );
      }
    }
    if (scratchServer) await scratchServer.close();
    if (A) await A.close().catch(() => {});
    if (B) await B.close().catch(() => {});
  }
}

// A local page for scratch tabs, so the concurrency check never depends on which pages the owner
// has open.
async function startScratchServer() {
  const server = http.createServer((req, res) => {
    // Each scratch page has its own background colour, so a screenshot shows which page it is
    const colour = { "/shot-1": "#c0392b", "/shot-2": "#2471a3" }[req.url] || "#ffffff";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><title>browserctl scratch ${req.url}</title>` +
        `<body style="background:${colour};margin:0;height:100vh"><button>ok</button></body>`
    );
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

// 1.6: two MCP processes drive two readable Edge tabs concurrently — 20 snapshots each — and every
// call-log line pairs the calling session with the right tabId. It opens its two scratch tabs on a
// local page and closes them again afterward.
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
  const openedTabs = [];
  let scratchServer = null;
  let A = null;
  let B = null;
  try {
    A = await session();
    B = await session();
    // Only tabs this check opens itself, so the owner's tabs are never driven
    let edgeTabs = [];
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
      openedTabs.push({ tabId: created.json?.id, owner: A });
      edgeTabs = [...edgeTabs, { id: created.json?.id, browser: edgeAlias }];
    }
    const [tabA, tabB] = edgeTabs;
    const selA = await A.call("browser_tabs", { action: "select", tabId: tabA.id });
    const selB = await B.call("browser_tabs", { action: "select", tabId: tabB.id });
    openedTabs[1].owner = B;
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
    // Each scratch tab is the target of the session that selected it, which alone may close it
    for (const { tabId, owner } of openedTabs) {
      try {
        const closed = await owner.call("browser_tabs", { action: "close", tabId });
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
    if (A) await A.close().catch(() => {});
    if (B) await B.close().catch(() => {});
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
  await check1_2(status);
  await check1_3(status, status.callLog);
  await check1_4(status);
  await check1_5(status);
  await check1_6(status, status.callLog);
  await check1_7(status);
  await check1_8(status);
  await check1_9(status);

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
