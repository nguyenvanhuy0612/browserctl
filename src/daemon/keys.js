// @ts-check
// Key names and chords, from Playwright's US keyboard layout extracted at build time
// (specs/tools/press_key.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BctlError } from "./errors.js";

const layoutFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension/generated/keyboard-layout.json");
/** @type {Record<string, {key: string, code: string, keyCode: number, text: string, location: number, shifted?: any}>} */
let keys;
function layout() {
  keys ??= JSON.parse(fs.readFileSync(layoutFile, "utf8")).keys;
  return keys;
}

const MODIFIERS = ["Alt", "Control", "Meta", "Shift"];
// ControlOrMeta is Playwright's: Meta on macOS, Control elsewhere (the browser runs on this host).
const ALIASES = /** @type {Record<string, string>} */ ({ ControlOrMeta: process.platform === "darwin" ? "Meta" : "Control", Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt", Esc: "Escape", Return: "Enter", Space: " ", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" });

/**
 * Parses "Control+Shift+K", "Shift++", "+", "a" into modifiers, one key description, and the
 * chord with aliases normalized, as Playwright spells it (specs/tools/press_key.md).
 * @param {string} chord
 */
export function parseChord(chord) {
  if (!chord) throw new BctlError("INVALID_PARAMS", "key is empty");
  /** @type {string[]} */
  const parts = [];
  let rest = chord;
  while (rest.length) {
    const plus = rest.indexOf("+", 1);
    if (plus < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, plus));
    rest = rest.slice(plus + 1);
  }
  const names = parts.map((p) => ALIASES[p] ?? p);
  const keyName = /** @type {string} */ (names.pop());
  /** @type {string[]} */
  const modifiers = [];
  for (const m of names) {
    if (!MODIFIERS.includes(m)) throw new BctlError("INVALID_PARAMS", `unknown modifier ${m} in ${chord}`, { hint: `Modifiers: ${MODIFIERS.join(", ")}.` });
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  return {
    modifiers,
    modifierKeys: modifiers.map((m) => describeKey(m, false)),
    key: describeKey(keyName, modifiers.includes("Shift")),
    chord: [...modifiers, keyName].join("+"),
  };
}

/** @param {string} name @param {boolean} shift */
export function describeKey(name, shift) {
  const table = layout();
  const entry = table[name];
  if (!entry) {
    const lower = name.toLowerCase();
    const close = Object.keys(table).filter((k) => k.length > 1 && (k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))).slice(0, 8);
    throw new BctlError("INVALID_PARAMS", `unknown key ${JSON.stringify(name)}`, { hint: close.length ? `Did you mean: ${close.join(", ")}?` : "Use a key name like Enter, Tab, Escape, ArrowDown, a, A." });
  }
  const chosen = shift && entry.shifted ? entry.shifted : entry;
  return { key: chosen.key, code: chosen.code, keyCode: chosen.keyCode, text: chosen.text ?? "", location: chosen.location ?? 0 };
}

/** One key description per character of text, for typing slowly. @param {string} text */
export function charsOf(text) {
  return [...text].map((ch) => {
    const entry = layout()[ch];
    if (entry) return { key: entry.key, code: entry.code, keyCode: entry.keyCode, text: ch, location: 0 };
    return { key: ch, code: "", keyCode: 0, text: ch, location: 0 };
  });
}
