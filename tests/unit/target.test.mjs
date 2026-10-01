// The MCP session target: which browser and tab every call of one agent session goes to, and
// which browser owns a tab id that a call names explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTarget } from "../../mcp/target.js";

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
