// The MCP session target: which browser and tab every call of one agent session goes to, and
// which browser owns a tab id that a call names explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTarget } from "../../mcp/target.js";

test("no target and no tabId: empty route, the bridge resolves the default", () => {
  assert.deepEqual(createTarget().route({}), { browser: null, tabId: null, needsLookup: false });
});

test("the target applies to every call that names no tab", () => {
  const t = createTarget();
  t.set({ browser: "chrome-1", tabId: 10 });
  assert.deepEqual(t.route({}), { browser: "chrome-1", tabId: 10, needsLookup: false });
  assert.deepEqual(t.route({}), { browser: "chrome-1", tabId: 10, needsLookup: false });
});

test("a per-call tabId routes to its owner and leaves the target alone", () => {
  const t = createTarget();
  t.set({ browser: "edge-1", tabId: 1 });
  t.noteTabs([{ id: 77, browser: "chrome-2" }]);
  assert.deepEqual(t.route({ tabId: 77 }), { browser: "chrome-2", tabId: 77, needsLookup: false });
  assert.deepEqual(t.get(), { browser: "edge-1", tabId: 1 });
});

test("an unknown tabId asks for a lookup instead of guessing a browser", () => {
  const t = createTarget();
  t.set({ browser: "edge-1", tabId: 1 });
  assert.deepEqual(t.route({ tabId: 99 }), { browser: null, tabId: 99, needsLookup: true });
});

test("a tabId owned by two browsers reports both owners", () => {
  const t = createTarget();
  t.noteTabs([
    { id: 7, browser: "chrome-1" },
    { id: 7, browser: "edge-1" },
  ]);
  assert.deepEqual(t.ownersOf(7).sort(), ["chrome-1", "edge-1"]);
});

test("a tabId with two known owners asks for a lookup rather than picking one", () => {
  const t = createTarget();
  t.noteTabs([
    { id: 7, browser: "chrome-1" },
    { id: 7, browser: "edge-1" },
  ]);
  assert.deepEqual(t.route({ tabId: 7 }), { browser: null, tabId: 7, needsLookup: true });
});

test("noteTabs replaces what one browser owns, so a closed tab is forgotten", () => {
  const t = createTarget();
  t.noteTabs([
    { id: 5, browser: "chrome-1" },
    { id: 6, browser: "chrome-1" },
  ]);
  t.noteTabs([{ id: 6, browser: "chrome-1" }]);
  assert.deepEqual(t.ownersOf(5), []);
});

test("noteTabs leaves the tabs of a browser absent from the listing alone", () => {
  const t = createTarget();
  t.noteTabs([
    { id: 5, browser: "chrome-1" },
    { id: 8, browser: "edge-1" },
  ]);
  t.noteTabs([{ id: 6, browser: "chrome-1" }]);
  assert.deepEqual(t.ownersOf(8), ["edge-1"]);
});

test("noteTabs with the listed browsers named forgets a browser that now has no tabs", () => {
  const t = createTarget();
  t.noteTabs([{ id: 8, browser: "edge-1" }]);
  t.noteTabs([], ["edge-1"]);
  assert.deepEqual(t.ownersOf(8), []);
});

test("clear drops the target and set replaces it", () => {
  const t = createTarget();
  t.set({ browser: "chrome-1", tabId: 3 });
  t.set({ browser: "edge-1", tabId: 4 });
  assert.deepEqual(t.get(), { browser: "edge-1", tabId: 4 });
  t.clear();
  assert.equal(t.get(), null);
  assert.deepEqual(t.route({}), { browser: null, tabId: null, needsLookup: false });
});

test("get returns a copy, so a caller cannot move the target by editing it", () => {
  const t = createTarget();
  t.set({ browser: "chrome-1", tabId: 3 });
  t.get().tabId = 99;
  assert.equal(t.get().tabId, 3);
});

test("a closed target leaves no target but remembers where it was, until set", () => {
  const t = createTarget();
  t.set({ browser: "edge-1", tabId: 5, url: "https://a/", title: "A" });
  t.markGone("TARGET_CLOSED");
  assert.equal(t.get(), null);
  assert.deepEqual(t.gone(), { browser: "edge-1", tabId: 5, code: "TARGET_CLOSED" });
  t.resumed();
  assert.ok(t.gone(), "only a select or new clears a closed target");
  t.set({ browser: "edge-1", tabId: 6 });
  assert.equal(t.gone(), null);
});

test("a disconnected target is kept, and a call that reaches it again clears the gone state", () => {
  const t = createTarget();
  t.set({ browser: "edge-1", tabId: 5 });
  t.markGone("BROWSER_DISCONNECTED");
  assert.deepEqual(t.get(), { browser: "edge-1", tabId: 5 });
  assert.equal(t.gone().code, "BROWSER_DISCONNECTED");
  t.resumed();
  assert.equal(t.gone(), null);
});

test("described carries the url and title the target was set with", () => {
  const t = createTarget();
  assert.equal(t.described(), null);
  t.set({ browser: "chrome-1", tabId: 1, url: "https://x/", title: "X" });
  assert.deepEqual(t.described(), { browser: "chrome-1", tabId: 1, url: "https://x/", title: "X" });
  assert.deepEqual(t.get(), { browser: "chrome-1", tabId: 1 });
});
