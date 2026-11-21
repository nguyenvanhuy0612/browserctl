// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { annotate, compact, cut, fit, nestFrames, noticeLines, parse, PDF_NOTICE, render } from "../../src/daemon/snapshot-text.js";

const { yaml } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
/** @param {string} text */
const assertYaml = (text) => assert.doesNotThrow(() => yaml.parse(text), text.slice(0, 2000));

const fixture = `- generic [ref=e1]:
  - heading "Spike fixture" [level=1] [ref=e2]
  - button "Native button" [ref=e3]
  - generic [ref=e5] [cursor=pointer]: Open conversation
  - generic [ref=e6]:
    - text: Name
    - textbox "Name" [ref=e7]
  - generic [ref=e8]:
    - generic [ref=e9]:
      - link "Home" [ref=e10] [cursor=pointer]:
        - /url: /`;

test("SNAP-U01 parse and render round-trip", () => {
  assert.equal(render(parse(fixture)), fixture);
});

test("SNAP-U01 compaction drops wrappers, keeps every ref-carrying actionable node", () => {
  const { text } = compact(fixture);
  assert.ok(!text.includes("[ref=e1]"), "outer wrapper gone");
  assert.ok(!text.includes("[ref=e8]") && !text.includes("[ref=e9]"), "wrapper chain collapsed");
  for (const ref of ["e2", "e3", "e5", "e7", "e10"]) assert.ok(text.includes(`[ref=${ref}]`), `${ref} kept`);
  assert.ok(text.includes("[cursor=pointer]: Open conversation"), "clickable generic kept");
  assert.ok(!text.includes("- text: Name"), "label echo of the textbox dropped (SNAP-U11)");
  assert.ok(text.includes("  - /url: /"), "link url kept under its link");
  assert.ok(text.length < fixture.length);
});

test("SNAP-U02 50 identical list items fold to 5 + 2", () => {
  const items = Array.from({ length: 50 }, (_, i) => `  - listitem [ref=e${i + 2}]: item ${i + 1}`).join("\n");
  const { text, folded } = compact(`- list [ref=e1]:\n${items}`);
  assert.equal(folded, 43);
  assert.ok(text.includes("item 1") && text.includes("item 5") && !text.includes("item 6]") && text.includes("item 50"));
  assert.match(text, /43 more listitem, refs e7\.\.e49; snapshot target=e1 full=true, or read target=e1/);
});

test("SNAP-U04 long URLs lose their query; cursor markers only where they tell something", () => {
  const long = "https://www.facebook.com/some/very/long/path?__cft__[0]=" + "x".repeat(200) + "&__tn__=R";
  const { text } = compact(`- link "Post" [ref=e2] [cursor=pointer]:\n  - /url: ${long}\n- generic [ref=e3] [cursor=pointer]: Open`);
  assert.ok(text.includes("- /url: https://www.facebook.com/some/very/long/path?…"), text);
  assert.ok(text.includes('link "Post" [ref=e2]:'), text);
  assert.ok(text.includes("generic [ref=e3] [cursor=pointer]: Open"), text);
  assert.ok(compact("- link \"x\" [ref=e1]:\n  - /url: /short?a=1").text.includes("/url: /short?a=1"));
});

test("SNAP-U03 cut at a line boundary reports the cut", () => {
  const { text, cutChars } = cut(fixture, 100);
  assert.ok(cutChars > 0);
  assert.ok(text.length <= 100, `${text.length} chars`);
  assert.ok(text.split("\n").slice(0, -1).every((line) => fixture.includes(line)));
  assert.match(text, /more characters/);
});

test("TGT-U04 frame snapshots nest under their iframe; an unread frame is marked", () => {
  const nested = nestFrames(`- generic [ref=e1]:\n  - iframe [ref=e4]\n  - iframe [ref=e5]`, new Map([["e4", `- button "Inside" [ref=f7e2]`]]), new Set(["e5"]));
  assert.equal(nested, `- generic [ref=e1]:\n  - iframe [ref=e4]:\n    - button "Inside" [ref=f7e2]\n  - iframe [ref=e5] [not read]`);
});

test("SNAP-U05 a quoted role line (name with a colon) loses a redundant cursor marker", () => {
  const { text } = compact(`- 'link "Perplexity Decider v1.3: Training" [ref=e355] [cursor=pointer]':\n  - /url: /x\n- 'generic "A: B" [ref=e9] [cursor=pointer]'`);
  assert.ok(text.includes(`- 'link "Perplexity Decider v1.3: Training" [ref=e355]':`), text);
  assert.ok(text.includes(`[ref=e9] [cursor=pointer]`), "generic keeps it");
});

test("SNAP-U06 obfuscated names and per-letter nodes are dropped, the ref and the rest stay", () => {
  const letters = ["t͏", "n͏", "S͏", "o͏"].map((c, i) => `    - generic [ref=e${720 + i}]: ${c}`).join("\n");
  const { text } = compact(`- heading [level=2] [ref=e691]:\n  - link "t͏ n͏ S͏ o͏" [ref=e711]:\n    - /url: "?…"\n${letters}\n  - button "Follow" [ref=e704]`);
  assert.ok(!text.includes("͏"), text);
  assert.ok(text.includes("link [ref=e711]:"), text);
  assert.ok(text.includes('button "Follow" [ref=e704]'), text);
  assert.ok(!text.includes("e720"), "letter nodes gone");
});

test("SNAP-U07 icon-font glyphs are removed; nodes left empty go, a glyph-only name is dropped", () => {
  const { text } = compact(`- navigation [ref=e7]:\n  - button "" [ref=e29]\n  - text:  \n  - link "Zoom In" [ref=e57]:\n    - generic [ref=e58]: \n  - text: 50 km`);
  assert.ok(!/[-]/.test(text), text);
  assert.ok(text.includes("button [ref=e29]"), text);
  assert.ok(text.includes('link "Zoom In" [ref=e57]'), text);
  assert.ok(text.includes("- text: 50 km"), text);
  assert.ok(!text.includes("- text:\n") && !text.endsWith("- text:"), text);
});

test("SNAP-U08 tooltips that only echo a nearby name are dropped; an unmatched one stays", () => {
  const { text } = compact(`- banner [ref=e3]:\n  - button "Settings" [ref=e44]\n  - tooltip [aria-hidden] [ref=e49]: Settings\n  - tooltip "tooltip"\n  - tooltip [aria-hidden] [ref=e50]: Unique hint`);
  assert.ok(!text.includes("[ref=e49]") && !text.includes('tooltip "tooltip"'), text);
  assert.ok(text.includes("Unique hint"), text);
});

test("SNAP-U09 identical non-adjacent siblings with nothing to act on fold; interactive ones never do", () => {
  const mark = (/** @type {number} */ i) => `  - blockquote [ref=e${100 + i}]:\n    - generic [ref=e${200 + i}]: Facebook`;
  const post = (/** @type {number} */ i) => `  - article "Post ${i}" [ref=e${300 + i}]:\n    - button "Like" [ref=e${400 + i}]`;
  const body = Array.from({ length: 14 }, (_, i) => [mark(i), post(i)]).flat().join("\n");
  const { text, folded } = compact(`- feed [ref=e1]:\n${body}`);
  assert.equal((text.match(/blockquote \[ref=/g) ?? []).length, 2, text);
  assert.match(text, /12 more identical blockquote, refs e102\.\.e113/);
  assert.ok(folded >= 12);
  for (let i = 0; i < 14; i++) assert.ok(text.includes(`[ref=e${400 + i}]`) || /more article/.test(text), `like ${i} kept or folded visibly`);
  assert.ok(text.includes("Post 0") && text.includes("Post 13") || /more article/.test(text));
});

// ---------- revision 2 ----------

test("SNAP-U11 label echoes next to a control are dropped; different text stays", () => {
  const { text } = compact(`- generic [ref=e1]:\n  - generic [ref=e110]: Gender\n  - radio "Male" [ref=e113]\n  - generic [ref=e114]: Male\n  - text: Name\n  - textbox "Name" [ref=e7]\n  - checkbox "Sports" [ref=e151]\n  - generic [ref=e152]: Sports news`);
  assert.ok(!text.includes("[ref=e114]"), text);
  assert.ok(!text.includes("- text: Name"), text);
  assert.ok(text.includes("Gender") && text.includes("Sports news"), text);
  for (const ref of ["e113", "e7", "e151"]) assert.ok(text.includes(`[ref=${ref}]`), ref);
});

test("SNAP-U12 facts go after the ref; quoted keys stay valid; refless nodes get their reason in order", () => {
  const src = [
    `- textbox "Email" [ref=e3]`,
    `- 'link "A: B" [ref=e4] [cursor=pointer]':`,
    `  - /url: /x`,
    `- combobox [ref=e5]`,
    `- link "Edit"`,
    `- button "Go"`,
    `- link "Edit"`,
    `- slider "Volume" [ref=e9]`,
  ].join("\n");
  const out = annotate(src, {
    facts: { e3: ["[type=email]", "[empty]"], e4: ['[ctx="Post - one"]'], e5: ['[near="Select State"]'], e9: ["[value=40]"] },
    refless: [
      { role: "link", name: "Edit", reason: "[hidden]" },
      { role: "button", name: "Go", reason: "[no-pointer-events]" },
      { role: "link", name: "Edit", reason: "[no-pointer-events]" },
    ],
  });
  assert.ok(out.includes(`- textbox "Email" [ref=e3] [type=email] [empty]`), out);
  assert.ok(out.includes(`- 'link "A: B" [ref=e4] [cursor=pointer] [ctx="Post - one"]':`), out);
  assert.ok(out.includes(`- combobox [ref=e5] [near="Select State"]`), out);
  assert.deepEqual(out.split("\n").filter((l) => /hidden|no-pointer/.test(l)), [`- link "Edit" [hidden]`, `- button "Go" [no-pointer-events]`, `- link "Edit" [no-pointer-events]`]);
  assert.ok(out.includes(`- slider "Volume" [ref=e9] [value=40]`), out);
  assertYaml(out);
});

test("SNAP-U13 tables get rows and cols; long lists get items; short lists nothing", () => {
  const row = (/** @type {number} */ i) => `    - row "r${i}" [ref=e${10 + i}]:\n` + [1, 2, 3, 4].map((c) => `      - cell "c${c}" [ref=e${100 + i * 10 + c}]`).join("\n");
  const table = `- table "Data" [ref=e1]:\n  - rowgroup [ref=e2]:\n${[1, 2, 3].map(row).join("\n")}`;
  const long = `- list [ref=e50]:\n${Array.from({ length: 12 }, (_, i) => `  - listitem [ref=e${200 + i}]: item ${i}`).join("\n")}`;
  const short = `- list [ref=e60]:\n  - listitem [ref=e61]: a\n  - listitem [ref=e62]: b\n  - listitem [ref=e63]: c`;
  const out = annotate([table, long, short].join("\n"));
  assert.ok(out.includes(`- table "Data" [ref=e1] [rows=3] [cols=4]:`), out);
  assert.ok(out.includes(`- list [ref=e50] [items=12]:`), out);
  assert.ok(out.includes(`- list [ref=e60]:`), out);
  assertYaml(out);
});

test("SNAP-U14 prose folds after maxText per run; headings and controls stay; a long paragraph is cut", () => {
  const paras = Array.from({ length: 30 }, (_, i) => `    - paragraph [ref=e${100 + i}]: ${"word ".repeat(59)}p${i}`).join("\n");
  const src = `- main [ref=e1]:\n  - heading "Quarterly report" [level=2] [ref=e2]\n  - generic [ref=e3]:\n${paras}\n  - heading "Next" [level=2] [ref=e4]\n  - paragraph [ref=e5]: ${"x".repeat(5000)}\n  - button "Reply" [ref=e6]`;
  const { text, textFolded } = compact(src, 2000);
  for (const kept of ['heading "Quarterly report"', 'heading "Next"', 'button "Reply" [ref=e6]', "p0"]) assert.ok(text.includes(kept), kept);
  assert.ok(!text.includes("p29"), "tail of the run folded");
  assert.match(text, /\(\+\d+ chars in \d+ blocks; read target=e\d+\)/);
  assert.match(text, /x… \(\+\d+ chars; read target=e5\)/);
  assert.ok(textFolded > 5000, String(textFolded));
  assertYaml(text);
});

test("SNAP-U15 budget: long prose is folded harder before anything is cut; headings survive", () => {
  const sections = Array.from({ length: 20 }, (_, s) => `  - heading "Section ${s}" [level=2] [ref=e${s * 100}]\n` + Array.from({ length: 10 }, (_, i) => `  - paragraph [ref=e${s * 100 + i + 1}]: s${s}p${i} ${"lorem ipsum ".repeat(25)}`).join("\n")).join("\n");
  const src = `- main [ref=e9999]:\n${sections}`;
  assert.ok(src.length > 60000, String(src.length));
  const out = fit(src, { maxChars: 20000, maxText: 2000 });
  assert.equal(out.cutChars, 0, "no hard cut");
  assert.ok(out.text.length <= 20000, String(out.text.length));
  for (let s = 0; s < 20; s++) assert.ok(out.text.includes(`heading "Section ${s}"`), `section ${s}`);
  assertYaml(out.text);
});

test("SNAP-U16 notice lines for a page not ready, a modal, canvases and a PDF are valid YAML", () => {
  const lines = noticeLines({ ready: false, readyState: "interactive", quiet: false, pendingRequests: 2 }, { ref: "e5", role: "dialog", name: 'Welcome: "Hug" {x}' });
  assert.match(lines[0], /^- \(page not ready; document interactive, DOM still changing, 2 requests pending; snapshot again or wait_for\)$/);
  assert.match(lines[1], /^- \(a modal dialog "Welcome - Hug x" covers the page, starting at \[ref=e5\]; act inside it or close it first\)$/);
  assertYaml(lines.join("\n") + "\n- button \"OK\" [ref=e9]");
  assert.deepEqual(noticeLines({ ready: true, readyState: "complete", quiet: null, pendingRequests: 0 }, null), []);
  const drawn = noticeLines({ ready: true, readyState: "complete", quiet: null, pendingRequests: 0 }, null, { count: 2, largest: "1200x800" });
  assert.deepEqual(drawn, ["- (2 canvas areas drawn on the page, largest 1200x800 px; their content is pixels, not text; take_screenshot shows it)"]);
  assertYaml(drawn.concat(PDF_NOTICE).join("\n"));
});

test("SNAP-U10 every compacted output, fold and cut line parses as YAML", () => {
  const items = Array.from({ length: 50 }, (_, i) => `  - listitem [ref=e${i + 2}]: item ${i + 1}`).join("\n");
  assertYaml(compact(`- list [ref=e1]:\n${items}`).text);
  assertYaml(compact(fixture).text);
  assertYaml(cut(fixture, 100).text);
  assertYaml(compact(`- 'link "Perplexity Decider v1.3: Training" [ref=e355] [cursor=pointer]':\n  - /url: /x`).text);
  const marks = Array.from({ length: 14 }, (_, i) => `  - blockquote [ref=e${100 + i}]:\n    - generic [ref=e${200 + i}]: Facebook\n  - article "Post ${i}" [ref=e${300 + i}]:\n    - button "Like" [ref=e${400 + i}]`).join("\n");
  assertYaml(compact(`- feed [ref=e1]:\n${marks}`).text);
});

test("SNAP-U17 a page over budget becomes an outline: headings stay, big subtrees collapse", () => {
  let n = 1;
  const section = (/** @type {number} */ i) => {
    const links = Array.from({ length: 40 }, (_, k) => `    - link "Link ${i}-${k}" [ref=e${n++}]:\n      - /url: /wiki/L${i}_${k}`).join("\n");
    const rows = Array.from({ length: 20 }, (_, k) => `    - row "r${k}" [ref=e${n++}]:\n      - cell "value ${i}-${k}" [ref=e${n++}]`).join("\n");
    return `  - heading "Section ${i}" [level=2] [ref=e${n++}]\n  - paragraph [ref=e${n++}]:\n    - text: Words about ${i}\n${links}\n  - table "T${i}" [ref=e${n++}]:\n${rows}`;
  };
  const src = `- main [ref=e0]:\n${Array.from({ length: 30 }, (_, i) => section(i)).join("\n")}`;
  assert.ok(src.length > 100000, String(src.length));
  const out = fit(src, { maxChars: 20000, maxText: 2000 });
  assert.equal(out.cutChars, 0, "no hard cut");
  assert.ok(out.collapsed > 0);
  for (let i = 0; i < 30; i++) assert.ok(out.text.includes(`heading "Section ${i}"`), `section ${i}`);
  assert.match(out.text, /- \(folded; \d+ lines(, \d+ links)?(, \d+ controls)?; snapshot target=e\d+\)/);
  assertYaml(out.text);
});

test("SNAP-U18 readiness: a page that stops answering ends the wait with what was measured", async () => {
  const { waitReady } = await import("../../src/daemon/tools/read-tools.js");
  let calls = 0;
  const daemon = /** @type {any} */ ({
    requests: new Map(),
    async dom() {
      if (calls++ === 0) return { age: 100, visibility: "visible", readyState: "interactive", structure: 1 };
      throw new Error("the page is navigating");
    },
  });
  const r = await waitReady(daemon, { instanceId: "i", tabId: 1 });
  assert.equal(r.ready, false);
  assert.equal(r.quiet, false);
  assert.equal(r.readyState, "interactive");
});

test("SNAP-U19 echoes next to searchbox, spinbutton, slider; note and time runs fold as prose", () => {
  const echoes = compact(`- generic [ref=e1]:\n  - searchbox "Find" [ref=e2]\n  - text: Find\n  - spinbutton "Qty" [ref=e3]\n  - generic [ref=e4]: Qty\n  - text: Volume\n  - slider "Volume" [ref=e5]`).text;
  assert.ok(!/- text: Find|\[ref=e4\]|- text: Volume/.test(echoes), echoes);
  for (const ref of ["e2", "e3", "e5"]) assert.ok(echoes.includes(`[ref=${ref}]`), ref);
  const notes = Array.from({ length: 12 }, (_, i) => `  - ${i % 2 ? "time" : "note"} [ref=e${100 + i}]: ${"word ".repeat(80)}n${i}`).join("\n");
  const { text, textFolded } = compact(`- main [ref=e9]:\n  - heading "H" [level=2] [ref=e10]\n${notes}`, 1000);
  assert.ok(textFolded > 0 && /chars in \d+ blocks; read target=e9/.test(text), text);
});

test("SNAP-U20 outline keeps regions holding a modal or an iframe; fold lines do not break the prose budget", () => {
  const links = (/** @type {number} */ from) => Array.from({ length: 300 }, (_, k) => `    - link "L${from + k}" [ref=e${from + k}]:\n      - /url: /x${k}`).join("\n");
  const src = `- main [ref=e1]:\n  - region "Dialog area" [ref=e2]:\n    - button "Accept" [ref=e3] [modal]\n${links(1000)}\n  - region "Frame area" [ref=e4]:\n    - iframe [ref=e5]:\n      - button "Inside" [ref=f1e1]\n${links(2000)}\n  - region "Other" [ref=e6]:\n${links(3000)}`;
  const out = fit(src, { maxChars: 20000, maxText: 2000 });
  assert.ok(out.text.includes('button "Accept" [ref=e3] [modal]'), "modal kept");
  assert.ok(out.text.includes('button "Inside" [ref=f1e1]'), "frame content kept");
  const items = Array.from({ length: 20 }, (_, i) => `  - listitem [ref=e${100 + i}]:\n` + Array.from({ length: 10 }, (_, k) => `    - paragraph [ref=e${1000 + i * 10 + k}]: ${"lorem ipsum ".repeat(25)}`).join("\n")).join("\n");
  const list = compact(`- list [ref=e50]:\n${items}`, 2000).text;
  assert.ok(list.length < 4000, `${list.length} chars kept for a 2000-char budget`);
});
