// @ts-check
// Site checks (kind "site" in the specs) on the owner's real Chrome through the running daemon.
// Harmless actions only: no posting, no sending, no Enter in search boxes. Every tab it opens is
// closed at the end. Usage: node tests/site/real-chrome.js
import fs from "node:fs";

const base = `http://127.0.0.1:${process.env.BROWSERCTL_PORT ?? 8765}`;
const session = `site-${Date.now()}`;
/** @type {{id: string, pass: boolean | null, detail: unknown}[]} */
const results = [];

/** @param {string} tool @param {object} [params] */
async function call(tool, params = {}) {
  const res = await fetch(`${base}/v1/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-browserctl-session": session, "x-browserctl-client": "site-check" },
    body: JSON.stringify(params),
  });
  return /** @type {Promise<any>} */ (res.json());
}

/** @param {string} id @param {boolean | null} pass @param {unknown} detail */
function check(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass === null ? "INFO" : pass ? "PASS" : "FAIL"}  ${id}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/** @param {string} snapshot @param {RegExp} pattern */
const refIn = (snapshot, pattern) => /\[ref=((?:f\d+)?e\d+)\]/.exec(snapshot.split("\n").find((l) => pattern.test(l)) ?? "")?.[1];
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

try {
  let t = Date.now();
  const nav = await call("navigate", { url: "https://www.facebook.com/" });
  check("NAV-S01 Facebook home in a background tab", nav.ok && nav.settled, { ms: Date.now() - t, title: nav.title, error: nav.error });
  await sleep(3000);

  t = Date.now();
  const compact = await call("snapshot", { maxChars: 200000 });
  const full = await call("snapshot", { full: true, maxChars: 200000 });
  const search = refIn(compact.snapshot ?? "", /combobox "Search Facebook"/);
  const market = refIn(compact.snapshot ?? "", /link "Marketplace"/);
  check("SNAP-S01 Facebook compact snapshot at least 55% smaller, search and nav keep refs", compact.ok && compact.snapshot.length <= full.snapshot.length * 0.45 && Boolean(search && market), {
    ms: Date.now() - t,
    compactChars: compact.snapshot?.length,
    fullChars: full.snapshot?.length,
    cut: full.snapshot ? Math.round((1 - compact.snapshot.length / full.snapshot.length) * 100) + "%" : null,
    folded: compact.folded,
    background: compact.background,
    search,
    market,
  });

  const typed = await call("type", { target: search ?? 'role=combobox[name="Search Facebook"]', text: "playwright" });
  check("TYPE-S01 Facebook search box, no Enter, no bar", typed.ok && typed.value === "playwright" && typed.lane === "dom", { value: typed.value, error: typed.error });

  const hover = await call("hover", { target: 'role=button[name="Messenger"]' });
  check("HOV-S01 hover a nav button (DOM lane)", hover.ok ? null : false, { domChanged: hover.outcome?.domChanged, hint: hover.hint, error: hover.error });

  const title = await call("evaluate", { function: "() => document.title" });
  check("EVAL-S01 Facebook evaluate without the bar", title.ok && title.lane === "dom", { value: title.value, error: title.error });

  const requests = await call("network_requests", { limit: 5 });
  check("NET-S01 Facebook request log", requests.ok && requests.requests.length > 0, { count: requests.requests?.length, first: requests.requests?.[0]?.url?.slice(0, 80) });

  const quiet = await call("status", {});
  check("DOM-S01 snapshot, type, hover, evaluate and the request log on Facebook attached no debugger", quiet.ok && (quiet.browsers?.[0]?.attached ?? []).length === 0, { attached: quiet.browsers?.[0]?.attached });

  const domScroll = await call("scroll", { direction: "down", amount: 3000 });
  check("SCR-S02 DOM lane on the feed (background)", domScroll.ok ? null : false, { after: domScroll.after, contentGrew: domScroll.contentGrew, hint: domScroll.hint, error: domScroll.error });

  // Facebook keeps only a window of posts in the DOM and numbers none of them; the page height
  // growing is what shows posts were loaded (measured: 1590 -> 8587 -> 13555 px).
  const height = "() => document.scrollingElement.scrollHeight";
  const first = (await call("evaluate", { function: height })).value;
  const realScroll = await call("scroll", { direction: "down", amount: 4000, trusted: true });
  await sleep(2500);
  const grown = (await call("evaluate", { function: height })).value - first;
  check("SCR-S01 Facebook feed loads more with trusted scroll", realScroll.ok && realScroll.contentGrew && grown > 1000, { grownPx: grown, contentGrew: realScroll.contentGrew, lane: realScroll.lane, error: realScroll.error });

  const shot = await call("take_screenshot", {});
  const shotBytes = shot.ok ? fs.statSync(shot.path).size : 0;
  check("SHOT-S01 background screenshot", shot.ok && shotBytes > 20_000, { lane: shot.lane, width: shot.width, height: shot.height, bytes: shotBytes, error: shot.error });
  if (shot.ok) fs.rmSync(shot.path);

  await call("navigate", { url: "https://www.facebook.com/" });
  await sleep(2500);
  const snap2 = await call("snapshot", {});
  const market2 = refIn(snap2.snapshot ?? "", /link "Marketplace"/);
  t = Date.now();
  const click = await call("click", { target: market2 ?? 'role=link[name="Marketplace"]' });
  const clickMs = Date.now() - t;
  const after2 = await call("snapshot", {});
  check("CLICK-S01 / SET-S01 Marketplace by ref, then the snapshot shows it", click.ok && click.outcome.urlChanged && /marketplace/i.test(after2.url ?? ""), {
    ms: clickMs,
    lane: click.lane,
    settled: click.outcome?.settled,
    url: click.outcome?.url,
    snapshotMentionsMarketplace: /Marketplace/.test(after2.snapshot ?? ""),
    error: click.error,
  });

  const gh = await call("tabs", { action: "new", url: "https://github.com/microsoft/playwright" });
  const read = await call("read", { main: true, maxChars: 4000 });
  check("READ-S01 GitHub repository page, main content", read.ok && /Playwright/.test(read.text) && !/Sign in/.test(read.text.slice(0, 300)), {
    total: read.total,
    start: read.text?.slice(0, 160),
    error: read.error ?? gh.error,
  });

  const status = await call("status", {});
  check("STAT-S01 status after the run", status.ok, { attached: status.browsers?.[0]?.attached, setup: status.setup });
} catch (error) {
  results.push({ id: "aborted", pass: false, detail: String(/** @type {any} */ (error)?.message ?? error) });
  console.log(`FAIL  aborted  ${results.at(-1)?.detail}`);
} finally {
  const list = await call("tabs", { action: "list" });
  for (const t of list.tabs ?? []) if (t.mine) await call("tabs", { action: "close", tab: t.tab });
  await fetch(`${base}/v1/sessions/${session}`, { method: "DELETE" }).catch(() => {});
  const graded = results.filter((r) => r.pass !== null);
  console.log(`\n${graded.filter((r) => r.pass).length} passed, ${graded.filter((r) => !r.pass).length} failed, ${results.length - graded.length} info`);
}
