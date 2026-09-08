// Behavioural tests for pure/near-pure helpers inside extension/content.js.
//
// content.js is a browser IIFE that touches `window`/`document` at load time, so it
// cannot be `import`ed under Node as-is. Instead we read the real file at test time and
// slice out just the function (and const) sources we need by name, then evaluate those
// slices in a `node:vm` context with minimal DOM stubs. Because the slice comes from the
// shipped file, these tests fail the moment the real implementation changes in a way that
// breaks the contract asserted here — that is the property we want, without retyping the
// functions or adding a bundler/dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contentJsPath = join(__dirname, "..", "..", "extension", "content.js");
const SRC = readFileSync(contentJsPath, "utf8");

// --- extraction helpers -----------------------------------------------------------

// Pull `function <name>(...) { ... }` out of SRC by counting braces from the first `{`
// to its match, so nested blocks inside the function don't truncate the slice early.
function extractFunction(src, name) {
  const startMatch = src.match(new RegExp(`function\\s+${name}\\s*\\(`));
  if (!startMatch) throw new Error(`function ${name} not found in content.js`);
  const braceStart = src.indexOf("{", startMatch.index);
  if (braceStart < 0) throw new Error(`no body found for function ${name}`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(startMatch.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces for function ${name}`);
}

// Pull `const <name> = ...;` (single statement, ends at the first top-level `;`).
function extractConst(src, name) {
  const startMatch = src.match(new RegExp(`const\\s+${name}\\s*=`));
  if (!startMatch) throw new Error(`const ${name} not found in content.js`);
  const semi = src.indexOf(";", startMatch.index);
  if (semi < 0) throw new Error(`no terminating ';' found for const ${name}`);
  return src.slice(startMatch.index, semi + 1);
}

// Evaluate a handful of extracted source slices together in a fresh vm context and
// return the requested names off that context (functions and/or consts).
//
// `function` declarations at top level of a vm-run classic script become properties of
// the context's global object, so `ctx.foldText` works directly. Top-level `const`/`let`
// do NOT (they live in a script-local lexical scope invisible from outside) — so any const
// we need (e.g. HREF_CAP) is bridged out explicitly via a `var __exports__` footer.
function loadFromContentJs(slices, exportNames, extraContext = {}) {
  const ctx = vm.createContext({
    console,
    WeakRef,
    WeakMap,
    window: { innerWidth: 1024, innerHeight: 768 },
    ...extraContext,
  });
  const footer = [
    "var __exports__ = {};",
    ...exportNames.map(
      (n) => `__exports__[${JSON.stringify(n)}] = typeof ${n} !== "undefined" ? ${n} : undefined;`
    ),
  ].join("\n");
  vm.runInContext(`${slices.join("\n\n")}\n${footer}`, ctx, { filename: "content.js (extracted)" });
  return ctx.__exports__;
}

// =====================================================================================
// 1. foldText — Vietnamese diacritics + case folding
// =====================================================================================

test("harness sanity: foldText is reachable and callable from the real content.js", () => {
  const foldTextSrc = extractFunction(SRC, "foldText");
  const { foldText } = loadFromContentJs([foldTextSrc], ["foldText"]);
  assert.equal(typeof foldText, "function");
  assert.equal(foldText("HELLO"), "hello");
});

test("foldText: folds Vietnamese diacritics and case so accented/unaccented forms match", () => {
  const foldTextSrc = extractFunction(SRC, "foldText");
  const { foldText } = loadFromContentJs([foldTextSrc], ["foldText"]);

  assert.equal(foldText("Võ Kim Đính"), foldText("Vo Kim Dinh"));
  assert.equal(foldText("Võ Kim Đính"), "vo kim dinh");
});

test("foldText: NFD alone does not fold đ/Đ, so foldText must special-case it", () => {
  // Sanity check on the *problem*: Unicode NFD decomposes accented Latin letters into a
  // base letter + combining marks, but Vietnamese d-with-stroke (đ/Đ) is NOT one of
  // those — it has no combining-mark decomposition. Stripping combining marks after NFD
  // leaves đ/Đ untouched.
  const nfdOnly = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  assert.notEqual(nfdOnly("Đính"), nfdOnly("Dinh"));

  const foldTextSrc = extractFunction(SRC, "foldText");
  const { foldText } = loadFromContentJs([foldTextSrc], ["foldText"]);
  // foldText must succeed exactly where plain NFD-stripping fails.
  assert.equal(foldText("Đính"), foldText("Dinh"));
});

test("foldText: trims whitespace and tolerates null/undefined/non-string input", () => {
  const foldTextSrc = extractFunction(SRC, "foldText");
  const { foldText } = loadFromContentJs([foldTextSrc], ["foldText"]);
  assert.equal(foldText("  Hello World  "), "hello world");
  assert.equal(foldText(null), "");
  assert.equal(foldText(undefined), "");
  assert.equal(foldText(123), "123");
});

// =====================================================================================
// 2 & 3. shortHref / normalizedHref — query-string trimming and dedupe-key normalisation
// =====================================================================================

function loadHrefHelpers() {
  const slices = [
    extractConst(SRC, "HREF_CAP"),
    extractConst(SRC, "OPAQUE_VALUE_CHARS"),
    extractConst(SRC, "KEPT_PARAMS"),
    extractConst(SRC, "CONVENTIONAL_TRACKING"),
    extractFunction(SRC, "shortHref"),
    extractFunction(SRC, "normalizedHref"),
  ];
  return {
    ...loadFromContentJs(slices, ["shortHref", "normalizedHref"]),
    consts: readHrefConsts(),
  };
}

// Read the actual constant values (not re-hardcoded) by evaluating just the const slices.
function readHrefConsts() {
  const slices = [
    extractConst(SRC, "HREF_CAP"),
    extractConst(SRC, "OPAQUE_VALUE_CHARS"),
    extractConst(SRC, "KEPT_PARAMS"),
    extractConst(SRC, "CONVENTIONAL_TRACKING"),
  ];
  return loadFromContentJs(slices, [
    "HREF_CAP",
    "OPAQUE_VALUE_CHARS",
    "KEPT_PARAMS",
    "CONVENTIONAL_TRACKING",
  ]);
}

test("shortHref: drops opaque (long) param values and appends a [+N params] tag", () => {
  const { shortHref, consts } = loadHrefHelpers();
  const opaqueValue = "x".repeat(consts.OPAQUE_VALUE_CHARS + 1);
  const href = `https://example.com/page?id=42&token=${opaqueValue}`;
  const out = shortHref(href);
  assert.ok(!out.includes(opaqueValue), "opaque value must be dropped");
  assert.ok(out.includes("id=42"), "short, non-tracking param must be kept");
  assert.ok(/\[\+1 params\]$/.test(out), `expected a dropped-params tag, got: ${out}`);
});

test("shortHref: drops keys matching CONVENTIONAL_TRACKING even when short", () => {
  const { shortHref, consts } = loadHrefHelpers();
  assert.ok(consts.CONVENTIONAL_TRACKING.test("utm_source"));
  const href = "https://example.com/page?utm_source=ab&id=1";
  const out = shortHref(href);
  assert.ok(!out.includes("utm_source"));
  assert.ok(out.includes("id=1"));
  assert.ok(/\[\+1 params\]$/.test(out));
});

test("shortHref: keeps at most KEPT_PARAMS non-dropped params", () => {
  const { shortHref, consts } = loadHrefHelpers();
  const href = "https://example.com/page?a=1&b=2&c=3&d=4";
  const out = shortHref(href);
  const kept = consts.KEPT_PARAMS;
  const keptParamCount = (out.match(/[?&][a-z]=\d/g) || []).length;
  assert.equal(keptParamCount, kept, `expected exactly KEPT_PARAMS=${kept} kept params, got: ${out}`);
  assert.ok(new RegExp(`\\[\\+${4 - kept} params\\]$`).test(out), out);
});

test("shortHref: caps total length at HREF_CAP and appends an ellipsis", () => {
  const { shortHref, consts } = loadHrefHelpers();
  const longPath = "a".repeat(consts.HREF_CAP + 50);
  const href = `https://example.com/${longPath}`;
  const out = shortHref(href);
  const withoutTag = out.replace(/ \[\+\d+ params\]$/, "");
  assert.ok(withoutTag.length <= consts.HREF_CAP + 1, `expected capped length, got ${withoutTag.length}`);
  assert.ok(withoutTag.endsWith("…"));
});

test("shortHref: keeps a short hash but drops a long one", () => {
  const { shortHref, consts } = loadHrefHelpers();
  const shortHash = "#section";
  assert.ok(shortHash.length <= 24);
  const withShortHash = shortHref(`https://example.com/page${shortHash}`);
  assert.ok(withShortHash.endsWith(shortHash));

  const longHash = "#" + "state".repeat(10);
  assert.ok(longHash.length > 24);
  const withLongHash = shortHref(`https://example.com/page${longHash}`);
  assert.ok(!withLongHash.includes(longHash));
});

test("shortHref: passes through falsy input unchanged", () => {
  const { shortHref } = loadHrefHelpers();
  assert.equal(shortHref(""), "");
  assert.equal(shortHref(null), null);
  assert.equal(shortHref(undefined), undefined);
});

test("normalizedHref: two URLs differing only by tracking/opaque params normalise equal", () => {
  const { normalizedHref, consts } = loadHrefHelpers();
  const opaqueValue = "y".repeat(consts.OPAQUE_VALUE_CHARS + 5);
  const a = `https://example.com/article?id=7&utm_source=newsletter&utm_campaign=fall`;
  const b = `https://example.com/article?id=7&fbclid=${opaqueValue}`;
  assert.equal(normalizedHref(a), normalizedHref(b));
});

test("normalizedHref: genuinely different URLs (different kept params) do not collapse", () => {
  const { normalizedHref } = loadHrefHelpers();
  const a = "https://example.com/article?id=7";
  const b = "https://example.com/article?id=8";
  assert.notEqual(normalizedHref(a), normalizedHref(b));
});

test("normalizedHref: hash fragments are ignored (not part of the dedupe key)", () => {
  const { normalizedHref } = loadHrefHelpers();
  const a = "https://example.com/article?id=7#comments";
  const b = "https://example.com/article?id=7#top";
  assert.equal(normalizedHref(a), normalizedHref(b));
});

test("normalizedHref: kept params are sorted so param order does not affect the key", () => {
  const { normalizedHref } = loadHrefHelpers();
  const a = "https://example.com/article?id=7&page=2";
  const b = "https://example.com/article?page=2&id=7";
  assert.equal(normalizedHref(a), normalizedHref(b));
});

test("normalizedHref: falsy input yields an empty string", () => {
  const { normalizedHref } = loadHrefHelpers();
  assert.equal(normalizedHref(""), "");
  assert.equal(normalizedHref(null), "");
  assert.equal(normalizedHref(undefined), "");
});

// =====================================================================================
// 4. hiddenContentHints — "there is more content behind this control" detection
// =====================================================================================

// A fake DOM element good enough for elementTextInfo/getOrAssignRef/hiddenContentHints:
// plain object with getAttribute + a parentElement for the "run of similar rows" signal.
function fakeEl({ text = "", tag = "BUTTON", attrs = {}, parent = null } = {}) {
  return {
    tagName: tag,
    innerText: text,
    textContent: text,
    parentElement: parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
  };
}

// A shared fake parent standing in for "a run of >=5 similar sibling rows", required by
// hiddenContentHints' third (structural) signal.
function runParent(childCount) {
  return { tagName: "UL", children: { length: childCount } };
}

function loadHiddenContentHints() {
  const slices = [
    extractConst(SRC, "TEXT_CAP"),
    extractConst(SRC, "LOAD_MORE_RE"),
    extractFunction(SRC, "slotLabelOf"),
    extractConst(SRC, "TEXT_IS_CONTENT"),
    extractFunction(SRC, "controlLabelOf"),
    extractFunction(SRC, "fullElementText"),
    extractFunction(SRC, "elementTextInfo"),
    extractFunction(SRC, "getOrAssignRef"),
    extractFunction(SRC, "hiddenContentHints"),
  ];
  const ctx = {
    refCounter: 0,
    refMap: {},
    reverseRefMap: new WeakMap(),
  };
  return loadFromContentJs(slices, ["hiddenContentHints"], ctx);
}

test("hiddenContentHints: reports a 'See previous notifications' control", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  const el = fakeEl({ text: "See previous notifications" });
  const { more } = hiddenContentHints([el]);
  assert.equal(more.length, 1);
  assert.equal(more[0].text, "See previous notifications");
  assert.equal(more[0].why, "load-more label");
});

test("hiddenContentHints: reports a 'load more' control", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  const el = fakeEl({ text: "Load more" });
  const { more } = hiddenContentHints([el]);
  assert.equal(more.length, 1);
  assert.equal(more[0].text, "Load more");
});

test("hiddenContentHints: does NOT flag a 'Sort by Newest' dropdown (aria-haspopup)", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  const el = fakeEl({
    text: "Sort by Newest",
    attrs: { "aria-expanded": "false", "aria-haspopup": "true" },
  });
  const { more } = hiddenContentHints([el]);
  assert.equal(more.length, 0);
});

test("hiddenContentHints: does NOT flag a plain 'All' filter", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  // Even sitting in a run of 5 similar siblings, "All" alone must not match the
  // load-more vocabulary (regression: substring matching on /all/ used to flag this).
  const parent = runParent(5);
  const el = fakeEl({ text: "All", parent });
  const siblings = [el, fakeEl({ text: "Open", parent }), fakeEl({ text: "Closed", parent }),
    fakeEl({ text: "Draft", parent }), fakeEl({ text: "Archived", parent })];
  const { more } = hiddenContentHints(siblings);
  assert.equal(more.length, 0);
});

test("hiddenContentHints: does NOT flag a 'Back to previous page' link", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  const el = fakeEl({ text: "Back to previous page", tag: "A" });
  const { more } = hiddenContentHints([el]);
  assert.equal(more.length, 0);
});

test("hiddenContentHints: an unlabelled control is never reported", () => {
  const { hiddenContentHints } = loadHiddenContentHints();
  const el = fakeEl({ text: "", attrs: { "aria-expanded": "false" } });
  const { more } = hiddenContentHints([el]);
  assert.equal(more.length, 0);
});

// =====================================================================================
// 5. describeElements — groups repeated labels into "N x \"label\"" summaries
// =====================================================================================

function loadDescribeElements() {
  const slices = [
    extractConst(SRC, "TEXT_CAP"),
    extractFunction(SRC, "slotLabelOf"),
    extractConst(SRC, "TEXT_IS_CONTENT"),
    extractFunction(SRC, "controlLabelOf"),
    extractFunction(SRC, "fullElementText"),
    extractFunction(SRC, "elementTextInfo"),
    extractFunction(SRC, "describeElements"),
  ];
  return loadFromContentJs(slices, ["describeElements"]);
}

test("describeElements: groups elements sharing the same leading words and counts them", () => {
  const { describeElements } = loadDescribeElements();
  // The grouping key is the lower-cased first 4 words, so the names (5th word) must be
  // the only thing that differs for these to land in one group.
  const els = [
    fakeEl({ text: "Active contact card here Alice" }),
    fakeEl({ text: "Active contact card here Bob" }),
    fakeEl({ text: "Active contact card here Carol" }),
  ];
  const out = describeElements(els, 3);
  assert.equal(out.length, 1);
  assert.match(out[0], /^3× /);
  // Display keeps the original casing of the first-seen sample; only the grouping key
  // is lower-cased.
  assert.equal(out[0], '3× "Active contact card here Alice"');
});

test("describeElements: a single (non-repeated) label is rendered without a count prefix", () => {
  const { describeElements } = loadDescribeElements();
  const els = [fakeEl({ text: "Only one here" })];
  const out = describeElements(els, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0], '"Only one here"');
});

test("describeElements: respects the limit and sorts groups by descending count", () => {
  const { describeElements } = loadDescribeElements();
  const els = [
    fakeEl({ text: "Foo single item text" }),
    fakeEl({ text: "Bar item three here A" }),
    fakeEl({ text: "Bar item three here B" }),
    fakeEl({ text: "Bar item three here C" }),
  ];
  const out = describeElements(els, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^3× /);
});

test("describeElements: an unlabelled element falls back to '<tag>'", () => {
  const { describeElements } = loadDescribeElements();
  const els = [fakeEl({ text: "", tag: "SPAN" })];
  const out = describeElements(els, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0], "unlabelled <span>");
});
