import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTarget } from "./target.js";

describe("mcp/target.js (Colocated Unit Spec)", () => {
  it("initial state: returns null for get, described, and gone", () => {
    const target = createTarget();
    assert.equal(target.get(), null);
    assert.equal(target.described(), null);
    assert.equal(target.gone(), null);
  });

  it("set: updates active target and detail correctly", () => {
    const target = createTarget();
    target.set({
      browser: "chrome-main",
      tabId: 101,
      url: "https://example.com",
      title: "Example Domain",
    });

    assert.deepEqual(target.get(), { browser: "chrome-main", tabId: 101 });
    assert.deepEqual(target.described(), {
      browser: "chrome-main",
      tabId: 101,
      url: "https://example.com",
      title: "Example Domain",
    });
    assert.equal(target.gone(), null);
  });

  it("defensive copy: modifying returned objects does not mutate internal state", () => {
    const target = createTarget();
    target.set({
      browser: "chrome-main",
      tabId: 101,
      url: "https://example.com",
      title: "Example Domain",
    });

    const current = target.get();
    current.tabId = 999;
    current.browser = "hacked";

    assert.deepEqual(target.get(), { browser: "chrome-main", tabId: 101 });
  });

  it("clear: resets active target and detail to null", () => {
    const target = createTarget();
    target.set({ browser: "chrome-1", tabId: 5, url: "https://foo.bar", title: "Foo" });
    target.clear();

    assert.equal(target.get(), null);
    assert.equal(target.described(), null);
  });

  it("markGone: safe no-op if no active target is currently set", () => {
    const target = createTarget();
    target.markGone("TARGET_CLOSED");

    assert.equal(target.get(), null);
    assert.equal(target.gone(), null);
  });

  it("markGone (TARGET_CLOSED / TARGET_TAKEN): clears target immediately and records failure code", () => {
    for (const code of ["TARGET_CLOSED", "TARGET_TAKEN"]) {
      const target = createTarget();
      target.set({ browser: "chrome-1", tabId: 200, url: "https://close.me", title: "Closing" });

      target.markGone(code);

      // Session target must be cleared immediately
      assert.equal(target.get(), null);
      assert.equal(target.described(), null);
      // Gone state records previous identity and failure reason
      assert.deepEqual(target.gone(), { browser: "chrome-1", tabId: 200, code });
    }
  });

  it("markGone (BROWSER_DISCONNECTED): retains target identity for resumption", () => {
    const target = createTarget();
    target.set({ browser: "chrome-remote", tabId: 50, url: "https://keep.me", title: "Kept" });

    target.markGone("BROWSER_DISCONNECTED");

    // Target is preserved so subsequent calls can resume when browser reconnects
    assert.deepEqual(target.get(), { browser: "chrome-remote", tabId: 50 });
    assert.deepEqual(target.gone(), {
      browser: "chrome-remote",
      tabId: 50,
      code: "BROWSER_DISCONNECTED",
    });
  });

  it("resumed: clears gone state when disconnected browser reconnects", () => {
    const target = createTarget();
    target.set({
      browser: "chrome-reconnect",
      tabId: 88,
      url: "https://recon.com",
      title: "Recon",
    });
    target.markGone("BROWSER_DISCONNECTED");

    assert.ok(target.gone() !== null);

    target.resumed();

    // Gone status must be cleared back to null
    assert.equal(target.gone(), null);
    assert.deepEqual(target.get(), { browser: "chrome-reconnect", tabId: 88 });
  });

  it("resumed: does NOT revive target if failure was TARGET_CLOSED", () => {
    const target = createTarget();
    target.set({ browser: "chrome-temp", tabId: 99, url: "https://temp.com", title: "Temp" });
    target.markGone("TARGET_CLOSED");

    target.resumed();

    // Remains gone and cleared
    assert.equal(target.get(), null);
    assert.deepEqual(target.gone(), { browser: "chrome-temp", tabId: 99, code: "TARGET_CLOSED" });
  });

  it("set: completely resets any prior gone state", () => {
    const target = createTarget();
    target.set({ browser: "chrome-1", tabId: 10, url: "https://a.com", title: "A" });
    target.markGone("TARGET_CLOSED");

    assert.ok(target.gone() !== null);

    // Setting a new target clears the gone state
    target.set({ browser: "chrome-2", tabId: 20, url: "https://b.com", title: "B" });
    assert.equal(target.gone(), null);
    assert.deepEqual(target.get(), { browser: "chrome-2", tabId: 20 });
  });
});
