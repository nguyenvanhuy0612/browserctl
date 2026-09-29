// Pure logic for bridge/registry.js: alias assignment, admission/removal, and selector
// resolution. No sockets, no HTTP — see bridge_multi.test.mjs for the wired-up bridge.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../bridge/registry.js";

let reg, file;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "reg-")), "browsers.json");
  reg = createRegistry({ aliasFile: file });
});

test("aliases are <type>-<n>, lowest free n per type", () => {
  const a = reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  const b = reg.admit({ connId: "c2", instanceId: "i2", browserType: "chrome", focused: false });
  const e = reg.admit({ connId: "c3", instanceId: "i3", browserType: "edge", focused: false });
  assert.deepEqual([a.alias, b.alias, e.alias], ["chrome-1", "chrome-2", "edge-1"]);
});

test("an alias survives disconnect and a new registry over the same file", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "chrome", focused: false });
  reg.remove("c1");
  const again = createRegistry({ aliasFile: file });
  const back = again.admit({
    connId: "c9",
    instanceId: "i2",
    browserType: "chrome",
    focused: false,
  });
  assert.equal(back.alias, "chrome-2", "i2 keeps chrome-2 even with chrome-1 offline");
});

test("same instanceId replaces its own entry only", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  const r = reg.admit({ connId: "c3", instanceId: "i1", browserType: "chrome", focused: false });
  assert.equal(r.alias, "chrome-1");
  assert.equal(reg.byConn("c1"), null);
  assert.ok(reg.byConn("c2"), "the other browser is untouched");
  assert.equal(reg.list().length, 2);
});

test("legacy connections get distinct synthetic ids and legacy-<n> aliases", () => {
  const a = reg.admit({ connId: "c1", instanceId: null, browserType: null, focused: false });
  const b = reg.admit({ connId: "c2", instanceId: null, browserType: null, focused: false });
  assert.notEqual(a.instanceId, b.instanceId);
  assert.deepEqual([a.alias, b.alias, a.legacy], ["legacy-1", "legacy-2", true]);
});

test("a reconnect under the same instanceId keeps the later of its own and the previous focus timestamp", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.touchFocus("c1", true, 100);
  const r = reg.admit({ connId: "c2", instanceId: "i1", browserType: "chrome", focused: false });
  assert.equal(
    r.lastFocusedAt,
    100,
    "a service-worker restart with no focus info keeps the old timestamp"
  );

  const later = reg.admit({ connId: "c3", instanceId: "i1", browserType: "chrome", focused: true });
  assert.ok(
    later.lastFocusedAt > 100,
    "a reconnect that is itself focused wins over the older timestamp"
  );
});

test("a damaged alias file starts empty instead of throwing", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{broken");
  const r = createRegistry({ aliasFile: file });
  assert.equal(
    r.admit({ connId: "c", instanceId: "i", browserType: "edge", focused: false }).alias,
    "edge-1"
  );
});

// ---- resolve(selector) ----

test("selector: alias", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  assert.equal(reg.resolve("edge-1").entry.alias, "edge-1");
});

test("selector: unique type", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  assert.equal(reg.resolve("edge").entry.alias, "edge-1");
});

test("selector: type shared by two", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "edge", label: "Work", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", label: "Test", focused: false });
  const r = reg.resolve("edge");
  assert.equal(r.error.code, "AMBIGUOUS_BROWSER");
  assert.deepEqual(r.error.candidates.map((e) => e.alias).sort(), ["edge-1", "edge-2"]);
  assert.match(r.error.message, /Work/);
  assert.match(r.error.message, /Test/);
});

test("selector: label", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({
    connId: "c2",
    instanceId: "i2",
    browserType: "chrome",
    label: "Test profile",
    focused: false,
  });
  assert.equal(reg.resolve("test profile").entry.alias, "chrome-2");
});

test("selector: label equal to another's alias", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({
    connId: "c2",
    instanceId: "i2",
    browserType: "edge",
    label: "chrome-1",
    focused: false,
  });
  assert.equal(reg.resolve("chrome-1").entry.alias, "chrome-1");
});

test("selector: instanceId", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  assert.equal(reg.resolve("i2").entry.instanceId, "i2");
});

test("selector: unknown", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  const r = reg.resolve("firefox");
  assert.equal(r.error.code, "UNKNOWN_BROWSER");
  assert.equal(r.error.candidates.length, 2);
});

test("default: single", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  assert.equal(reg.resolve(null).entry.alias, "chrome-1");
});

test("default: last focused", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  reg.touchFocus("c1", true, 1);
  reg.touchFocus("c2", true, 2);
  assert.equal(reg.resolve(null).entry.alias, "edge-1");
});

test("default: none focused", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  assert.equal(reg.resolve(null).error.code, "NEEDS_BROWSER");
});

test("default: nothing connected", () => {
  assert.equal(reg.resolve(null).error.code, "NO_BROWSER");
});

test("an alias matches whatever its case", () => {
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "edge", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "chrome", focused: false });
  assert.equal(reg.resolve("Edge-1").entry.alias, "edge-1");
  assert.equal(reg.resolve("CHROME-1").entry.alias, "chrome-1");
});

test("writing the alias file leaves only the file itself in its directory", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { dirname, basename } = await import("node:path");
  reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  reg.admit({ connId: "c2", instanceId: "i2", browserType: "edge", focused: false });
  assert.deepEqual(readdirSync(dirname(file)), [basename(file)]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { i1: "chrome-1", i2: "edge-1" });
});

test("the alias file is replaced by a rename, never rewritten in place", async () => {
  const fs = await import("node:fs");
  const renames = [];
  const realRename = fs.default.renameSync;
  fs.default.renameSync = (from, to) => {
    renames.push([from, to]);
    return realRename(from, to);
  };
  try {
    reg.admit({ connId: "c1", instanceId: "i1", browserType: "chrome", focused: false });
  } finally {
    fs.default.renameSync = realRename;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.notEqual(renames[0][0], file);
});
