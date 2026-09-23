// Multi-frame e2e regression suite for browserctl.
//
// tests/e2e/run.mjs's page (testpage.html) is single-frame apart from one cross-origin
// iframe used only for the frame-routing tests — it never exercises the compact-view
// MERGE path with a page that also has landmark grouping, key-input hoisting,
// repetitive-run folding, duplicate-link suppression, a long-label truncation hint, an
// open-but-not-blocking dialog, a React-portal (zero-size wrapper) panel, or a
// menuitemradio-built menu. That blind spot let a severe defect ship silently:
// extension/background.js's snapshot merge had `if (top.result.compactView && parts.length
// === 1)` — so ANY page with an iframe (i.e. every real site) discarded the content
// script's compact view and rebuilt a flat one, losing every feature above. All 42
// tests on the single-frame page stayed green throughout.
//
// This suite drives a purpose-built multi-frame fixture (multiframe.html + a same-origin
// child document) through the REAL bridge -> extension -> Chrome stack, the same way
// run.mjs does, and asserts the compact view/read_page tree still carry every one of
// those features once a second frame is in play.
//
// Prereqs: same as run.mjs — bridge running (`browserctl start` or `npm start`) and the
// extension connected. If the bridge is unreachable or the extension isn't connected,
// this SKIPS (exit 0) with a clear message instead of failing, since it cannot drive a
// real Chrome in that state.
// Run:  node tests/e2e/run_multiframe.mjs
// Not part of `npm test` (unit tests only) — same as run.mjs, this needs a real Chrome
// with the extension loaded, so it is a separate, manually-invoked command.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BRIDGE, cmd, assert, test, pollFind,
  openMainTab, teardown, verifyClean, installReaper, report,
} from "./harness.mjs";

installReaper();

const HERE = dirname(fileURLToPath(import.meta.url));
const TOP_PAGE = readFileSync(join(HERE, "multiframe.html"), "utf8");
const CHILD_PAGE = readFileSync(join(HERE, "multiframe-child.html"), "utf8");

async function main() {
  // --- readiness gate: SKIP cleanly rather than fail if there's no real Chrome to drive ---
  let status;
  try {
    const r = await fetch(`${BRIDGE}/status`);
    status = await r.json();
  } catch (e) {
    console.log(`SKIP: bridge not reachable at ${BRIDGE} (${e.message}). Start it with 'browserctl start' or 'npm start', load the extension in Chrome, then re-run.`);
    process.exit(0);
  }
  if (!status || !status.extensionConnected) {
    console.log(`SKIP: bridge is up at ${BRIDGE} but the Chrome extension is not connected. Load the unpacked extension (extension/) in Chrome and re-run.`);
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) { res.writeHead(200, { "content-type": "text/html" }); res.end(TOP_PAGE); }
    else if (req.url.startsWith("/child.html")) { res.writeHead(200, { "content-type": "text/html" }); res.end(CHILD_PAGE); }
    else { res.writeHead(404); res.end("no"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`multiframe fixture served at ${base}\nrunning against bridge ${BRIDGE}\n`);

  let tabId;
  try {
    await test("new_tab (multiframe fixture)", async () => {
      const r = { id: await openMainTab(base + "/") };
      tabId = r.id;
      assert(tabId != null, "no tab id");
    });
    await cmd("wait_settle", {});
    await test("group_tab (no activation)", async () => {
      const r = await cmd("group_tab", { title: "e2e-multiframe", color: "orange" });
      assert(r.tabId === tabId, "grouped wrong tab");
    });
    await pollFind("Iframe Action"); // wait for the same-origin child iframe to finish loading

    // --- the headline regression: compact view merge must NOT flatten a multi-frame page ---
    let snap;
    await test("snapshot(compact, scope=all) succeeds on a multi-frame page", async () => {
      snap = await cmd("snapshot", { compact: true, scope: "all" });
      assert(typeof snap.compactView === "string" && snap.compactView.length > 0, "no compactView returned");
    });

    await test("compact view keeps landmark grouping (not rebuilt flat)", async () => {
      assert(/\[Header \/ Banner\]/.test(snap.compactView), "missing [Header / Banner] landmark header");
      assert(/\[Navigation\]/.test(snap.compactView), "missing [Navigation] landmark header");
    });

    await test("compact view keeps hoisted key-inputs block", async () => {
      assert(/\[Key Inputs & Search Fields\]/.test(snap.compactView), "missing [Key Inputs & Search Fields] block");
      const idx = snap.compactView.indexOf("[Key Inputs & Search Fields]");
      assert(idx >= 0 && /Search site/.test(snap.compactView.slice(idx, idx + 300)), "key-inputs block missing the hoisted search field");
    });

    await test("compact view keeps repetitive-run folding (5 identical Remove buttons)", async () => {
      assert(/folded 3 repetitive <button> "Remove"/.test(snap.compactView), `no folded-run line found:\n${snap.compactView}`);
    });

    await test("the merge keeps duplicate-link suppression, and counts it", async () => {
      // The notice line became a field when results stopped carrying prose (0.7.1). The
      // behaviour under test is the same: one row printed, and the page says how many it
      // collapsed — the count is what tells a reader the census is not the whole DOM.
      assert(snap.duplicateCount >= 1, `expected a duplicate to be counted, got ${snap.duplicateCount}`);
      // Only ONE "View Details" *anchor row* should be printed, not two. (Matched on the
      // `<a> "View Details"` listing form specifically — not on the substring anywhere in
      // the page, which would also catch the unrelated "(row: ...)" context annotations
      // the Remove-button run picks up; see the report for that separate finding.)
      const count = (snap.compactView.match(/<a> "View Details"/g) || []).length;
      assert(count === 1, `expected exactly 1 "View Details" anchor row, found ${count}`);
    });

    await test("scope=all still folds repetitive runs, and says how many", async () => {
      // scope:"all" is what an agent escalates to for completeness, so it folding silently
      // was the worst case of a census not admitting what it withheld.
      assert(snap.foldedCount >= 3, `expected folding to be reported at full scope, got ${snap.foldedCount}`);
    });

    await test("compact view keeps the truncation hint for a 200+ char label", async () => {
      const el = (snap.elements || []).find((e) => (e.href || "").includes("/product/999"));
      assert(el, "long-label anchor not found in elements");
      assert(el.textTruncatedBy > 0, `expected textTruncatedBy > 0, got ${JSON.stringify(el.textTruncatedBy)}`);
      assert(new RegExp(`\\[\\+${el.textTruncatedBy} chars: get text @${el.ref}\\]`).test(snap.compactView),
        "compact view missing the truncation-hint annotation for the long label");
    });

    await test("compact view reports the open, non-blocking dialog", async () => {
      assert(snap.pageState && snap.pageState.hasActiveModal === false, `dialog wrongly reported as blocking: ${JSON.stringify(snap.pageState)}`);
      assert(snap.pageState.openDialogs.some((d) => d.label === "Notifications"), `open dialog not reported: ${JSON.stringify(snap.pageState && snap.pageState.openDialogs)}`);
      assert(/\[Open dialog: "Notifications"/.test(snap.compactView), "compact view missing the open-dialog line");
      assert(!/\[Active Modal\/Drawer:/.test(snap.compactView), "non-blocking dialog was reported as a blocking Active Modal/Drawer");
    });

    await test("sub-frame content is appended under an [iframe f<id> ...] header, not merged flat", async () => {
      assert(/\[iframe f\d+ /.test(snap.compactView), `missing [iframe f<id> ...] section header:\n${snap.compactView}`);
      assert(/f\d+:ref_\d+/.test(snap.compactView), "no frame-qualified ref (f<id>:ref_N) found in compact view");
    });

    await test("the merged census carries no server prose at all", async () => {
      // There used to be a guidance footer, and the merge could emit one per frame. Results
      // are data now: the census is page content and nothing else, so the invariant is
      // stronger and simpler — no footer, from any frame.
      const strays = snap.compactView.match(/\[(Quick Actions|Next|More):/g) || [];
      assert(strays.length === 0, `the census must carry no advice, found: ${strays.join(", ")}`);
    });

    // --- menuitemradio: present in both readers, with ARIA state, clickable by ref ---
    let sortNewestRef, sortRelevanceRef;
    await test("snapshot elements carry menuitemradio role + aria-checked state", async () => {
      const items = (snap.elements || []).filter((e) => e.role === "menuitemradio");
      assert(items.length === 3, `expected 3 menuitemradio items, found ${items.length}`);
      const relevance = items.find((e) => e.text === "Relevance");
      const newest = items.find((e) => e.text === "Newest");
      assert(relevance && relevance.state && relevance.state.checked === "true", `expected Relevance checked=true, got ${JSON.stringify(relevance)}`);
      assert(newest && newest.state && newest.state.checked === "false", `expected Newest checked=false, got ${JSON.stringify(newest)}`);
      sortNewestRef = newest.ref;
      sortRelevanceRef = relevance.ref;
    });

    await test("read_page tree also carries the menuitemradio items with state", async () => {
      const r = await cmd("read_page", { mode: "interactive" });
      assert(/menuitemradio "Newest"/.test(r.tree), `read_page tree missing Newest menuitemradio:\n${r.tree}`);
      assert(/menuitemradio "Relevance" \[checked\]/.test(r.tree), `read_page tree missing checked Relevance menuitemradio:\n${r.tree}`);
    });

    await test("menuitemradio item is clickable by ref and its ARIA state moves", async () => {
      await cmd("click", { ref: sortNewestRef });
      const after = await cmd("snapshot", { compact: false, scope: "all" });
      const newest = after.elements.find((e) => e.ref === sortNewestRef);
      const relevance = after.elements.find((e) => e.ref === sortRelevanceRef);
      assert(newest.state && newest.state.checked === "true", `click did not check Newest: ${JSON.stringify(newest)}`);
      assert(relevance.state && relevance.state.checked === "false", `click did not uncheck Relevance: ${JSON.stringify(relevance)}`);
    });

    // --- read_page: portal-rendered panel behind a zero-size wrapper must NOT be pruned ---
    await test("read_page returns the portal-rendered panel's contents (through the merge)", async () => {
      const r = await cmd("read_page", { mode: "interactive" });
      assert(/heading "Portal Panel"/.test(r.tree), `portal panel heading missing from read_page tree:\n${r.tree}`);
      const m = r.tree.match(/button "Portal Action" \[(f\d+:ref_\d+)\]/);
      assert(m, `portal panel button missing / not frame-qualified in read_page tree:\n${r.tree}`);
    });

    // --- a frame-qualified ref round-trips through click AND get_text ---
    let iframeBtnRef;
    await test("snapshot finds the same-origin iframe button with a frame-qualified ref", async () => {
      const el = (snap.elements || []).find((e) => (e.text || "").includes("Iframe Action"));
      assert(el && /^f\d+:/.test(el.ref), `iframe button missing / not frame-qualified (ref=${el && el.ref})`);
      iframeBtnRef = el.ref;
    });
    await test("frame-qualified ref clicks the right element in the right frame", async () => {
      await cmd("click", { ref: iframeBtnRef });
    });
    await test("frame-qualified ref reads text (get_text) from the right frame after the click", async () => {
      const r = await cmd("get_property", { property: "text", ref: iframeBtnRef });
      assert(/Iframe Clicked/.test(r.value || r.text || JSON.stringify(r)), `expected "Iframe Clicked", got ${JSON.stringify(r)}`);
    });
    // The MCP surface passes the same ref as 'target', so the frame has to be read from there too.
    await test("frame-qualified ref passed as target reaches the right frame", async () => {
      const r = await cmd("get_property", {
        property: "text",
        target: "@" + iframeBtnRef.replace(/^@/, ""),
      });
      assert(
        /Iframe Clicked/.test(r.value || JSON.stringify(r)),
        `target missed the iframe: ${JSON.stringify(r)}`
      );
      const c = await cmd("click", { target: iframeBtnRef });
      assert(
        c.resolved && c.resolved.matchCount === 1,
        `click by target did not resolve in the frame: ${JSON.stringify(c)}`
      );
    });
  } finally {
    await teardown();
    await test("cleanup leaves no tab and no synced group behind", async () => {
      await verifyClean(`127.0.0.1:${PORT}`);
    });
    server.close();
  }

  process.exit(report() ? 1 : 0);
}

main().catch((e) => { console.error("runner crashed:", e); process.exit(2); });
