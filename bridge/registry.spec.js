import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRegistry, matchBrowser } from "./registry.js";

describe("bridge/registry.js (Colocated Unit Spec)", () => {
  let tmpAliasFile;

  beforeEach(() => {
    tmpAliasFile = path.join(
      os.tmpdir(),
      `bctl-test-aliases-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpAliasFile)) fs.rmSync(tmpAliasFile, { force: true });
    } catch {}
  });

  describe("admit() & Alias Persistence", () => {
    it("admit: assigns deterministic aliases across browser types", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });

      const b1 = registry.admit({ connId: "c1", instanceId: "inst-1", browserType: "chrome" });
      const b2 = registry.admit({ connId: "c2", instanceId: "inst-2", browserType: "chrome" });
      const b3 = registry.admit({ connId: "c3", instanceId: "inst-3", browserType: "firefox" });

      assert.equal(b1.alias, "chrome-1");
      assert.equal(b2.alias, "chrome-2");
      assert.equal(b3.alias, "firefox-1");
    });

    it("reconnect: preserves existing alias when instance reconnects with new connId", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });

      registry.admit({ connId: "c1", instanceId: "inst-1", browserType: "chrome" });
      // Reconnect with new connection ID (e.g. extension service worker restarted)
      const recon = registry.admit({
        connId: "c1-fresh",
        instanceId: "inst-1",
        browserType: "chrome",
      });

      assert.equal(recon.alias, "chrome-1");
      assert.equal(registry.list().length, 1);
      assert.equal(registry.byConn("c1"), null);
      assert.ok(registry.byConn("c1-fresh"));
    });

    it("persistence: recovers aliases from disk across new registry instances", () => {
      const registry1 = createRegistry({ aliasFile: tmpAliasFile });
      registry1.admit({ connId: "c1", instanceId: "inst-persisted", browserType: "chrome" });

      // Instantiate completely fresh registry pointing to same aliasFile
      const registry2 = createRegistry({ aliasFile: tmpAliasFile });
      const recovered = registry2.admit({
        connId: "c2",
        instanceId: "inst-persisted",
        browserType: "chrome",
      });

      assert.equal(recovered.alias, "chrome-1");
    });
  });

  describe("resolve() & matchBrowser()", () => {
    it("resolve: returns NO_BROWSER error when no browsers are connected", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });
      const res = registry.resolve();

      assert.ok(res.error);
      assert.equal(res.error.code, "NO_BROWSER");
    });

    it("resolve: default picks the sole connected browser when selector is empty", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });
      registry.admit({ connId: "c1", instanceId: "inst-1", browserType: "chrome" });

      const res = registry.resolve();
      assert.ok(res.entry);
      assert.equal(res.entry.alias, "chrome-1");
    });

    it("resolve: returns NEEDS_BROWSER when multiple browsers are connected and selector is empty", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });
      registry.admit({ connId: "c1", instanceId: "inst-1", browserType: "chrome" });
      registry.admit({ connId: "c2", instanceId: "inst-2", browserType: "chrome" });

      const res = registry.resolve(null);
      assert.ok(res.error);
      assert.equal(res.error.code, "NEEDS_BROWSER");
      assert.equal(res.error.candidates.length, 2);
    });

    it("matchBrowser: matches by alias case-insensitively", () => {
      const entries = [
        { alias: "chrome-1", label: "Work", instanceId: "i1", browserType: "chrome" },
      ];

      assert.ok(matchBrowser(entries, "chrome-1").entry);
      assert.ok(matchBrowser(entries, "CHROME-1").entry);
    });

    it("matchBrowser: matches by label when unique, and rejects ambiguous labels", () => {
      const entries = [
        { alias: "c1", label: "Work", instanceId: "i1", browserType: "chrome" },
        { alias: "c2", label: "Personal", instanceId: "i2", browserType: "chrome" },
        { alias: "c3", label: "Personal", instanceId: "i3", browserType: "chrome" },
      ];

      // Unique label
      assert.equal(matchBrowser(entries, "work").entry.alias, "c1");

      // Ambiguous duplicate label
      const amb = matchBrowser(entries, "personal");
      assert.ok(amb.error);
      assert.equal(amb.error.code, "AMBIGUOUS_BROWSER");
    });

    it("matchBrowser: matches by instanceId and unique browserType", () => {
      const entries = [
        { alias: "c1", label: null, instanceId: "uuid-1234", browserType: "chrome" },
        { alias: "f1", label: null, instanceId: "uuid-5678", browserType: "firefox" },
      ];

      // Match by instanceId
      assert.equal(matchBrowser(entries, "uuid-1234").entry.alias, "c1");

      // Match by unique type
      assert.equal(matchBrowser(entries, "firefox").entry.alias, "f1");
    });

    it("matchBrowser: returns UNKNOWN_BROWSER when selector matches nothing", () => {
      const entries = [{ alias: "c1", label: null, instanceId: "i1", browserType: "chrome" }];
      const res = matchBrowser(entries, "safari");

      assert.ok(res.error);
      assert.equal(res.error.code, "UNKNOWN_BROWSER");
    });
  });

  describe("remove() & touchFocus()", () => {
    it("remove: drops connection entry and returns removed record", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });
      registry.admit({ connId: "conn-x", instanceId: "inst-x", browserType: "chrome" });

      const removed = registry.remove("conn-x");
      assert.equal(removed.connId, "conn-x");
      assert.equal(registry.byConn("conn-x"), null);
      assert.equal(registry.remove("conn-nonexistent"), null);
    });

    it("touchFocus: updates lastFocusedAt timestamp on active connection", () => {
      const registry = createRegistry({ aliasFile: tmpAliasFile });
      registry.admit({
        connId: "conn-1",
        instanceId: "inst-1",
        browserType: "chrome",
        focused: false,
      });

      registry.touchFocus("conn-1", true, 999_999);
      assert.equal(registry.byConn("conn-1").lastFocusedAt, 999_999);

      // Does not update if focused flag is false
      registry.touchFocus("conn-1", false, 1_000_000);
      assert.equal(registry.byConn("conn-1").lastFocusedAt, 999_999);
    });
  });
});
