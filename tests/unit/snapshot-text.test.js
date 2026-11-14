// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, cut, nestFrames, parse, render } from "../../src/daemon/snapshot-text.js";

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
  assert.ok(text.includes("- text: Name"), "text kept");
  assert.ok(text.includes("  - /url: /"), "link url kept under its link");
  assert.ok(text.length < fixture.length);
});

test("SNAP-U02 50 identical list items fold to 5 + 2", () => {
  const items = Array.from({ length: 50 }, (_, i) => `  - listitem [ref=e${i + 2}]: item ${i + 1}`).join("\n");
  const { text, folded } = compact(`- list [ref=e1]:\n${items}`);
  assert.equal(folded, 43);
  assert.ok(text.includes("item 1") && text.includes("item 5") && !text.includes("item 6]") && text.includes("item 50"));
  assert.match(text, /43 more listitem, refs e7\.\.e49: snapshot\(\{target: "e1", full: true\}\)/);
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
  assert.ok(text.split("\n").slice(0, -1).every((line) => fixture.includes(line)));
  assert.match(text, /more characters/);
});

test("frame snapshots nest under their iframe", () => {
  const nested = nestFrames(`- generic [ref=e1]:\n  - iframe [ref=e4]`, new Map([["e4", `- button "Inside" [ref=f7e2]`]]));
  assert.equal(nested, `- generic [ref=e1]:\n  - iframe [ref=e4]:\n    - button "Inside" [ref=f7e2]`);
});
