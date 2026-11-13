// Multi-frame e2e regression suite for browserctl.
//
// A snapshot of a page with iframes is the top frame's census with each sub-frame's census
// appended under frame-qualified refs, all in 'census'. run.mjs's page has one cross-origin
// iframe used only for frame routing, so the merge itself is exercised here: landmark grouping,
// key-input hoisting, repetitive-run folding, duplicate-link suppression, a long-label
// truncation hint, an open-but-not-blocking dialog, a React-portal (zero-size wrapper) panel and
// a menuitemradio-built menu must all survive it.
//
// This suite drives a purpose-built multi-frame fixture (multiframe.html + a same-origin
// child document) through the REAL bridge -> extension -> Chrome stack, the same way
// run.mjs does, and asserts the census and the read_page tree still carry every one of
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
  BRIDGE,
  cmd,
  assert,
  test,
  pollFind,
  openMainTab,
  teardown,
  verifyClean,
  installReaper,
  report,
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
    console.log(
      `SKIP: bridge not reachable at ${BRIDGE} (${e.message}). Start it with 'browserctl start' or 'npm start', load the extension in Chrome, then re-run.`
    );
    process.exit(0);
  }
  if (!status || !status.extensionConnected) {
    console.log(
      `SKIP: bridge is up at ${BRIDGE} but the Chrome extension is not connected. Load the unpacked extension (extension/) in Chrome and re-run.`
    );
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(TOP_PAGE);
    } else if (req.url.startsWith("/child.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(CHILD_PAGE);
    } else {
      res.writeHead(404);
      res.end("no");
    }
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
      assert(typeof snap.census === "string" && snap.census.length > 0, "no census returned");
    });

    await test("the merged census is the only copy: VOM v1 with Iframe node, no 'compactView'", async () => {
      assert(!("compactView" in snap), "a second copy of the census came back as compactView");
      assert(/^@vom 1\b/m.test(snap.census), `missing @vom 1 header:\n${snap.census}`);
      assert(/Iframe "childframe"/.test(snap.census), "the sub-frame's tree is not in 'census'");
    });

    await test("VOM tree preserves landmark grouping (banner, navigation, main)", async () => {
      assert(/\bbanner\b/.test(snap.census), "missing banner landmark");
      assert(/\bnavigation\b/.test(snap.census), "missing navigation landmark");
      assert(/\bmain\b/.test(snap.census), "missing main landmark");
    });

    await test("VOM tree keeps search input and sign-in control inside banner", async () => {
      assert(
        /@e\d+\s+textbox "Search site"/.test(snap.census),
        `missing Search site textbox in banner:\n${snap.census}`
      );
      assert(
        /@e\d+\s+button "Sign In"/.test(snap.census),
        `missing Sign In button in banner:\n${snap.census}`
      );
    });

    await test("VOM tree renders all 5 repetitive Remove buttons with row context", async () => {
      const matches = snap.census.match(/@e\d+\s+button "Remove" \[ctx: Item [A-E]\]/g) || [];
      assert(
        matches.length === 5,
        `expected 5 contextual Remove buttons, found ${matches.length}:\n${snap.census}`
      );
    });

    await test("VOM tree keeps distinct View Details links and long-label anchor", async () => {
      const count = (snap.census.match(/@e\d+\s+link "View Details"/g) || []).length;
      assert(count === 2, `expected 2 "View Details" link rows, found ${count}`);
      const longEl = (snap.elements || []).find((e) => (e.href || "").includes("/product/999"));
      assert(longEl, "long-label anchor not found in elements");
      assert(
        /hot swappable switches/.test(longEl.text || ""),
        `unexpected long-label text: ${JSON.stringify(longEl)}`
      );
    });

    await test("snapshot reports the open, non-blocking dialog in VOM and pageState", async () => {
      assert(
        snap.pageState && snap.pageState.hasActiveModal === false,
        `dialog wrongly reported as blocking: ${JSON.stringify(snap.pageState)}`
      );
      assert(
        (snap.pageState.openDialogs || []).some((d) => d.label === "Notifications" && !d.blocking),
        `open dialog not reported: ${JSON.stringify(snap.pageState && snap.pageState.openDialogs)}`
      );
      assert(
        /dialog "Notifications"/.test(snap.census),
        `VOM missing dialog "Notifications":\n${snap.census}`
      );
      assert(
        /@layers 1 focus=L1/.test(snap.census),
        `non-blocking dialog promoted to L1 modal layer:\n${snap.census}`
      );
    });

    await test('sub-frame content sits nested under Iframe "childframe" with sequential @eN refs', async () => {
      assert(
        /Iframe "childframe"/.test(snap.census),
        `missing Iframe "childframe":\n${snap.census}`
      );
      assert(
        /@e\d+\s+button "Iframe Action"/.test(snap.census),
        `missing sequential @eN ref for Iframe Action:\n${snap.census}`
      );
    });

    await test("the merged census carries no server prose at all", async () => {
      const strays = snap.census.match(/\[(Quick Actions|Next|More):/g) || [];
      assert(strays.length === 0, `the census must carry no advice, found: ${strays.join(", ")}`);
    });

    // --- menuitemradio: present in VOM + elements, with ARIA state, clickable by ref ---
    let sortNewestRef, sortRelevanceRef;
    await test("snapshot elements carry menuitemradio role + aria-checked state", async () => {
      const items = (snap.elements || []).filter((e) => e.role === "menuitemradio");
      assert(items.length === 3, `expected 3 menuitemradio items, found ${items.length}`);
      const relevance = items.find((e) => e.text === "Relevance");
      const newest = items.find((e) => e.text === "Newest");
      assert(
        relevance && relevance.state && relevance.state.checked === "true",
        `expected Relevance checked=true, got ${JSON.stringify(relevance)}`
      );
      assert(
        newest && newest.state && newest.state.checked === "false",
        `expected Newest checked=false, got ${JSON.stringify(newest)}`
      );
      sortNewestRef = newest.ref;
      sortRelevanceRef = relevance.ref;
    });

    await test("VOM tree carries the menuitemradio items with [checked] / [unchecked] markers", async () => {
      assert(
        /menuitemradio "Newest" \[unchecked\]/.test(snap.census),
        `VOM tree missing Newest menuitemradio:\n${snap.census}`
      );
      assert(
        /menuitemradio "Relevance" \[checked\]/.test(snap.census),
        `VOM tree missing checked Relevance menuitemradio:\n${snap.census}`
      );
    });

    await test("menuitemradio item is clickable by ref and its ARIA state moves", async () => {
      await cmd("click", { ref: sortNewestRef });
      const after = await cmd("snapshot", { compact: false, scope: "all" });
      const newest = after.elements.find((e) => e.ref === sortNewestRef);
      const relevance = after.elements.find((e) => e.ref === sortRelevanceRef);
      assert(
        newest && newest.state && newest.state.checked === "true",
        `click did not check Newest: ${JSON.stringify(newest)}`
      );
      assert(
        relevance && relevance.state && relevance.state.checked === "false",
        `click did not uncheck Relevance: ${JSON.stringify(relevance)}`
      );
    });

    // --- portal-rendered panel behind a zero-size wrapper must NOT be pruned ---
    await test("VOM tree retains the portal-rendered panel behind a zero-size wrapper", async () => {
      assert(
        /heading "Portal Panel"/.test(snap.census),
        `portal panel heading missing from VOM tree:\n${snap.census}`
      );
      const portalEl = (snap.elements || []).find((e) => (e.text || "").includes("Portal Action"));
      assert(
        portalEl && /^e\d+$/.test(portalEl.ref),
        `portal panel button missing from snapshot elements: ${JSON.stringify(portalEl)}`
      );
    });

    // --- an iframe @eN ref round-trips through click AND get_property ---
    let iframeBtnRef;
    await test("snapshot finds the same-origin iframe button with an @eN ref", async () => {
      const el = (snap.elements || []).find((e) => (e.text || "").includes("Iframe Action"));
      assert(
        el && /^e\d+$/.test(el.ref) && el.inIframe === true,
        `iframe button missing / wrong metadata (${JSON.stringify(el)})`
      );
      iframeBtnRef = el.ref;
    });
    await test("iframe ref clicks the right element in the right frame", async () => {
      await cmd("click", { ref: iframeBtnRef });
    });
    await test("iframe ref reads text (get_text) from the right frame after the click", async () => {
      const r = await cmd("get_property", { property: "text", ref: iframeBtnRef });
      assert(
        /Iframe Clicked/.test(r.value || r.text || JSON.stringify(r)),
        `expected "Iframe Clicked", got ${JSON.stringify(r)}`
      );
    });
    // The MCP surface passes the same ref as 'target', so the frame has to be read from there too.
    await test("iframe ref passed as target reaches the right frame", async () => {
      const r = await cmd("get_property", {
        property: "text",
        target: "@" + iframeBtnRef.replace(/^@/, ""),
      });
      assert(
        /Iframe Clicked/.test(r.value || JSON.stringify(r)),
        `target missed the iframe: ${JSON.stringify(r)}`
      );
      const c = await cmd("click", { target: "@" + iframeBtnRef.replace(/^@/, "") });
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

main().catch((e) => {
  console.error("runner crashed:", e);
  process.exit(2);
});
