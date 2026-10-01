// Which browser has which tab id (bridge/owners.js), as the bridge last saw it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwners } from "../../bridge/owners.js";

test("a listing replaces what that browser owns; others keep theirs", () => {
  const o = createOwners();
  o.noteListing("chrome-1", [1, 2]);
  o.noteListing("edge-1", [3]);
  o.noteListing("chrome-1", [2]);
  assert.deepEqual(o.ownersOf(1), []);
  assert.deepEqual(o.ownersOf(2), ["chrome-1"]);
  assert.deepEqual(o.ownersOf(3), ["edge-1"]);
});

test("an id open in two browsers has both as owners", () => {
  const o = createOwners();
  o.noteListing("chrome-1", [7]);
  o.noteListing("edge-1", [7]);
  assert.deepEqual(o.ownersOf(7).sort(), ["chrome-1", "edge-1"]);
});

test("added and closed tabs update the owners", () => {
  const o = createOwners();
  o.noteListing("chrome-1", [1]);
  o.add("chrome-1", 9);
  assert.deepEqual(o.ownersOf(9), ["chrome-1"]);
  o.remove("chrome-1", 9);
  assert.deepEqual(o.ownersOf(9), []);
  assert.deepEqual(o.ownersOf(1), ["chrome-1"]);
});
