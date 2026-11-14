// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { charsOf, parseChord } from "../../src/daemon/keys.js";

test("KEY-U01 chords parse into modifiers and a key", () => {
  assert.deepEqual(parseChord("Shift+Tab").modifiers, ["Shift"]);
  assert.equal(parseChord("Shift+Tab").key.key, "Tab");
  const k = parseChord("Control+Shift+K");
  assert.deepEqual(k.modifiers, ["Control", "Shift"]);
  assert.equal(k.key.code, "KeyK");
  assert.equal(parseChord("+").key.key, "+");
  assert.equal(parseChord("Shift++").key.key, "+");
  assert.equal(parseChord("Enter").key.keyCode, 13);
  assert.equal(parseChord("a").key.text, "a");
  assert.equal(parseChord("Ctrl+a").modifiers[0], "Control");
});

test("KEY-U01 unknown keys and modifiers are INVALID_PARAMS with suggestions", () => {
  assert.throws(() => parseChord("Foo"), (e) => /** @type {any} */ (e).code === "INVALID_PARAMS");
  assert.throws(() => parseChord("Hyper+a"), (e) => /** @type {any} */ (e).code === "INVALID_PARAMS");
  try {
    parseChord("Arrowdown");
  } catch (e) {
    assert.match(/** @type {any} */ (e).hint, /ArrowDown/);
  }
});

test("characters for slow typing keep their text, including ones outside the layout", () => {
  const chars = charsOf("aB é");
  assert.deepEqual(chars.map((c) => c.text), ["a", "B", " ", "é"]);
  assert.equal(chars[1].code, "KeyB");
});
