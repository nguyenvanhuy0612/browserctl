// Shared harness for every e2e runner: one bridge client, one tab lifecycle, one teardown.
//
// It exists because four runners each grew their own copy, and each copy leaked something
// different. The rules it enforces:
//
//   ONE long-lived tab per run.   openMainTab() is called once. Everything else that needs a
//                                 second tab borrows one through withScratchTab(), which closes
//                                 it in a finally — a failing assertion cannot leak it.
//   EVERY tab is on the ledger.   cmd() records any tab id the bridge hands back, whoever asked
//                                 for it, so teardown can reap a tab no test remembers opening.
//   GROUPS ARE UNGROUPED FIRST.   Chrome syncs saved tab groups across machines. A group left
//                                 behind by a failed run reappears on the other machine, which
//                                 is why ungrouping happens before closing and again in teardown.
//   TEARDOWN ALWAYS RUNS.         finally, plus process exit / SIGINT / SIGTERM / unhandled
//                                 rejection. Ctrl-C during a run is not a reason to leak.
//   AND IT IS VERIFIED.           verifyClean() asks the browser what is left and fails the run
//                                 if anything of ours survived. Cleanup that is not checked is
//                                 cleanup that quietly stops happening.

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

export const BRIDGE = envStr("BROWSERCTL_BRIDGE_URL", envStr("BRIDGE_URL", "http://127.0.0.1:8765"));

// Tags every command this run sends, so e2e traffic is distinguishable from an agent's in the
// bridge call log. One daemon and one extension serve every client, so the runs share a log.
const CLIENT = { session: `e2e-${process.pid}`, source: "e2e" };

export const used = new Set();
const ledger = { tabs: new Set(), groups: new Set(), mainTab: null };
const results = [];
let reaperInstalled = false;

export async function cmd(action, params = {}) {
  used.add(action);
  const res = await fetch(`${BRIDGE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params, client: CLIENT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${action}: ${data.error || "HTTP " + res.status}`);
  const r = data.result;
  if (r && typeof r === "object") {
    if (action === "new_tab" && r.id != null) ledger.tabs.add(r.id);
    if (action === "group_tab" && r.groupId != null) ledger.groups.add(r.groupId);
  }
  if (action === "close_tab") ledger.tabs.delete(params.id ?? params.tabId);
  if (action === "ungroup_tab") ledger.groups.clear();
  return r;
}

// Run a command expecting it to FAIL, and return the error message. cmd() throws on failure,
// so this is how a test asserts a guard fires instead of silently succeeding.
export async function cmdFail(action, params = {}) {
  try {
    await cmd(action, params);
  } catch (e) {
    return e.message;
  }
  throw new Error(`${action}: expected failure, but it succeeded`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

export function skip(name, why) {
  results.push({ name, ok: true, skipped: true });
  console.log(`  SKIP  ${name} (${why})`);
}

// Poll find(query) until it matches or the deadline passes, instead of a fixed sleep — de-flakes
// waits on things that finish at variable speed without over- or under-waiting.
export async function pollFind(query, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let r = await cmd("find", { query });
  while (!(r.matches && r.matches.length) && Date.now() < deadline) {
    await sleep(intervalMs);
    r = await cmd("find", { query });
  }
  return r;
}

export async function openMainTab(url) {
  if (ledger.mainTab != null) throw new Error("openMainTab called twice — this suite runs on ONE tab");
  const r = await cmd("new_tab", { url });
  if (r.id == null) throw new Error("new_tab returned no id");
  ledger.mainTab = r.id;
  return r.id;
}

// The only sanctioned way to use a second tab. Opening one re-pins the target, so the pin is
// restored to the main tab afterwards whether or not fn() threw.
export async function withScratchTab(url, fn, { repin = true } = {}) {
  const id = (await cmd("new_tab", { url })).id;
  try {
    return await fn(id);
  } finally {
    try {
      await insist("close_tab", { id });
    } catch {
      /* already gone: some tests close it themselves on purpose */
    }
    // repin:false is for the tests that need the pin to STAY lost — restoring it here would
    // quietly disarm the guard they exist to prove.
    if (repin && ledger.mainTab != null) {
      try {
        await insist("switch_tab", { id: ledger.mainTab });
      } catch {
        /* nothing left to re-pin to */
      }
    }
  }
}

// Chrome refuses tab edits while the user is touching the tab strip ("Tabs cannot be edited
// right now"). That is transient, and a teardown that gives up on it leaves exactly the kind of
// orphan this harness exists to prevent — so cleanup retries instead of shrugging.
const TRANSIENT = /cannot be edited right now|dragging a tab|user may be dragging/i;
export async function insist(action, params, attempts = 8) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await cmd(action, params);
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(e.message)) throw e;
      await sleep(150 * (i + 1));
    }
  }
  throw lastErr;
}

async function ungroupEverything() {
  if (!ledger.groups.size && ledger.mainTab == null) return;
  // Ungroup by tab, which is the only action the protocol exposes. Doing it for every tab we
  // own removes the group as its last member leaves.
  for (const id of [...ledger.tabs, ledger.mainTab].filter((x) => x != null)) {
    try {
      await insist("ungroup_tab", { id });
    } catch {
      /* not grouped, or already gone */
    }
  }
  ledger.groups.clear();
}

export async function teardown() {
  await ungroupEverything();
  for (const id of [...ledger.tabs]) {
    try {
      await insist("close_tab", { id });
    } catch {
      /* already closed */
    }
  }
  if (ledger.mainTab != null) {
    try {
      await insist("close_tab", { id: ledger.mainTab });
    } catch {
      /* already closed */
    }
    ledger.mainTab = null;
  }
  ledger.tabs.clear();
}

// Ask the browser what survived. urlMark is whatever identifies this run's pages, e.g. the
// fixture port. A leak here is a failing check, not a console warning.
export async function verifyClean(urlMark) {
  const open = await cmd("list_tabs", {});
  const mine = (open.tabs || []).filter((t) => String(t.url || "").includes(urlMark));
  assert(mine.length === 0, `left ${mine.length} tab(s) behind: ${mine.map((t) => t.url).join(", ")}`);
  const grouped = (open.tabs || []).filter((t) => t.groupId != null && t.groupId !== -1 && String(t.url || "").includes(urlMark));
  assert(grouped.length === 0, `left ${grouped.length} tab(s) in a group — Chrome syncs saved groups across machines`);
}

// Teardown has to survive Ctrl-C too: a half-run that leaves a synced tab group behind is the
// exact failure this harness exists to prevent.
export function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  let reaping = false;
  const reap = async (signal) => {
    if (reaping) return;
    reaping = true;
    console.log(`\n[harness] ${signal} — closing ${ledger.tabs.size + (ledger.mainTab != null ? 1 : 0)} tab(s) before exit`);
    try {
      await teardown();
    } catch {
      /* best effort */
    }
    process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 130 : 2);
  };
  process.on("SIGINT", () => reap("SIGINT"));
  process.on("SIGTERM", () => reap("SIGTERM"));
  process.on("unhandledRejection", (e) => {
    console.error("[harness] unhandled rejection:", e);
    reap("unhandledRejection");
  });
}

export function report(label = "") {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${passed}/${results.length} checks passed ${label}====`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
  }
  return failed.length;
}
