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
  // Skip the parameter list before hunting for the body: a destructured parameter
  // (`function find({ query, selector })`) opens a brace that is not the body, and
  // counting from it stops at the end of the signature.
  const parenStart = src.indexOf("(", startMatch.index);
  let parenDepth = 0;
  let afterParams = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameter list for function ${name}`);
  const braceStart = src.indexOf("{", afterParams);
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

// =====================================================================================
// find() — selector mode
// =====================================================================================
//
// The Gmail session of 2026-09-09 had a CSS selector for the reply composer and no tool
// that would take one: `find {selector}` was refused by the schema, `find {query:"<css>"}`
// matched nothing (it is a text matcher), and the only other source of a ref — snapshot —
// had already been abandoned as too large. Twenty eval_js calls followed. Selector mode
// closes that loop, so it is asserted here on the real implementation.

function loadFind(elements) {
  const findSrc = extractFunction(SRC, "find");
  const stubs = {
    INTERACTIVE_SELECTOR: "button,a,input",
    deepQueryAll: (sel) => {
      if (sel === "!!bad!!") throw new Error("bad selector");
      return elements.filter((el) => el.__sel === sel);
    },
    isVisible: (el) => el.__visible !== false,
    getOrAssignRef: (el) => el.__ref,
    roleOf: (el) => el.__role || null,
    accessibleName: (el) => el.__name || "",
    elementTextInfo: () => ({ text: "", truncatedBy: null }),
    matchesByText: () => [],
    nearestLabels: () => [],
    pageVocabulary: () => [],
  };
  const { find } = loadFromContentJs([findSrc], ["find"], stubs);
  return find;
}

const composer = {
  __sel: 'div[role="textbox"][contenteditable]',
  __ref: "ref_266",
  __role: "textbox",
  __name: "Message Body",
  tagName: "DIV",
  matches: (sel) => sel === "div[role=\"textbox\"][contenteditable]",
};

test("find: a CSS selector returns the same ref shape as a text match", () => {
  const find = loadFind([composer]);
  const res = find({ selector: 'div[role="textbox"][contenteditable]' });
  assert.equal(res.count, 1);
  assert.equal(res.matches[0].ref, "ref_266");
  assert.equal(res.matches[0].matchedBy, "selector");
  assert.equal(res.matches[0].role, "textbox");
  assert.equal(res.matches[0].clickable, false); // a contenteditable div is not INTERACTIVE_SELECTOR
});

test("find: requires query or selector, and neither is a silent no-op", () => {
  const find = loadFind([]);
  assert.throws(() => find({}), /requires 'query' or 'selector'/);
});

test("find: an unmatched selector says so instead of returning a bare count of zero", () => {
  const find = loadFind([]);
  const res = find({ selector: "div.nope" });
  assert.equal(res.count, 0);
  assert.match(res.note, /No element matched that CSS selector/);
  assert.ok(res.searchedScope.includes("Shadow DOM"));
});

test("find: an invalid selector is reported as invalid, not as 'not found'", () => {
  const find = loadFind([]);
  const res = find({ selector: "!!bad!!" });
  assert.equal(res.count, 0);
  assert.match(res.note, /not a valid CSS selector/);
});

test("find: hidden matches still return refs, and visible ones are preferred", () => {
  const hidden = { ...composer, __ref: "ref_9", __visible: false };
  const find = loadFind([composer, hidden]);
  const res = find({ selector: 'div[role="textbox"][contenteditable]' });
  assert.equal(res.count, 1);
  assert.equal(res.matches[0].ref, "ref_266");
  assert.match(res.note, /1 further match\(es\) are hidden/);
});

// =====================================================================================
// get_property — all-matches mode
// =====================================================================================
//
// The LinkedIn session of 2026-09-09 wanted the href of every Apply link. get_count could
// say how many there were and get_property could read the first, so the agent wrote
// Array.from(document.querySelectorAll('a')).map(...) in eval_js — the one eval_js call in
// that session that no tool could have replaced. all:true is that tool.

function mkEl(sel, ref, { text = "", attrs = {} } = {}) {
  return {
    __sel: sel,
    __ref: ref,
    tagName: "A",
    innerText: text,
    textContent: text,
    outerHTML: `<a>${text}</a>`,
    hasAttribute: (n) => n in attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
  };
}

function loadGetProperty(elements) {
  const slices = [
    extractConst(SRC, "MATCH_COUNTED"),
    extractFunction(SRC, "get_property"),
    extractFunction(SRC, "readOneProperty"),
  ];
  const stubs = {
    document: {
      documentElement: mkEl("html", "ref_0"),
      title: "T",
      baseURI: "https://site.test/jobs",
      createDocumentFragment: () => ({
        querySelector: (sel) => {
          if (sel.includes("!!")) throw new Error("invalid");
          return null;
        },
      }),
    },
    location: { href: "https://site.test/jobs" },
    URL,
    deepQueryAll: (sel) => elements.filter((el) => el.__sel === sel),
    getOrAssignRef: (el) => el.__ref,
    resolveTarget: ({ selector }) => elements.find((el) => el.__sel === selector) || elements[0],
  };
  const { get_property } = loadFromContentJs(slices, ["get_property"], stubs);
  return get_property;
}

test("get_property: all=true returns one row per match, each with its own ref", () => {
  const els = [
    mkEl("a", "ref_1", { text: "Apply on company site", attrs: { href: "/go/1" } }),
    mkEl("a", "ref_2", { text: "Easy Apply", attrs: { href: "https://wd.example/job/R7940" } }),
  ];
  const get_property = loadGetProperty(els);
  const res = get_property({ property: "attr", attr: "href", selector: "a", all: true });
  assert.equal(res.all, true);
  assert.equal(res.count, 2);
  assert.deepEqual(res.matches.map((m) => m.ref), ["ref_1", "ref_2"]);
  // A relative href is resolved, which is the whole reason the read was re-derived in JS.
  assert.equal(res.matches[0].resolved, "https://site.test/go/1");
  assert.equal(res.matches[1].value, "https://wd.example/job/R7940");
});

test("get_property: all=true reads text as happily as attributes", () => {
  const get_property = loadGetProperty([mkEl("li", "ref_7", { text: "  Row one  " })]);
  const res = get_property({ property: "text", selector: "li", all: true });
  assert.equal(res.matches[0].value, "Row one");
});

test("get_property: all=true without a selector says why, instead of reading one element", () => {
  const get_property = loadGetProperty([]);
  assert.throws(() => get_property({ property: "text", ref: "ref_1", all: true }), /'all' reads every match/);
});

test("get_property: all=true on zero matches is an answer, not a failure", () => {
  const get_property = loadGetProperty([]);
  const res = get_property({ property: "text", selector: "div.nope", all: true });
  assert.equal(res.count, 0);
  assert.deepEqual(res.matches, []);
  assert.match(res.note, /This is an answer, not a failure/);
});

test("get_property: all=true caps at max and says how many it left", () => {
  const els = Array.from({ length: 5 }, (_, i) => mkEl("a", `ref_${i}`, { text: `row ${i}` }));
  const get_property = loadGetProperty(els);
  const res = get_property({ property: "text", selector: "a", all: true, max: 2 });
  assert.equal(res.count, 5);
  assert.equal(res.matches.length, 2);
  assert.match(res.note, /5 elements matched; the first 2 are listed/);
});

test("get_property: single-element reads are unchanged by the all-matches path", () => {
  const get_property = loadGetProperty([mkEl("h1", "ref_3", { text: "Senior QA" })]);
  const res = get_property({ property: "text", selector: "h1" });
  assert.equal(res.property, "text");
  assert.equal(res.value, "Senior QA");
  assert.equal(res.all, undefined);
});

// =====================================================================================
// select_option — one 'option' string, matched as value or label
// =====================================================================================

function loadSelectOption(options) {
  const el = {
    tagName: "SELECT",
    value: "",
    options: options.map((o) => ({ ...o, selected: false })),
    dispatchEvent: () => true,
  };
  const stubs = {
    resolveTarget: () => el,
    actionability: () => null,
    Event: class { constructor(type) { this.type = type; } },
  };
  const { select_option } = loadFromContentJs([extractFunction(SRC, "select_option")], ["select_option"], stubs);
  return { select_option, el };
}

test("select_option: 'option' matches by value first", () => {
  const { select_option, el } = loadSelectOption([
    { value: "vn", text: "Vietnam" },
    { value: "us", text: "United States" },
  ]);
  const res = select_option({ ref: "ref_1", option: "vn" });
  assert.equal(el.value, "vn");
  assert.equal(res.selected, "vn");
});

test("select_option: 'option' falls back to the visible label", () => {
  const { select_option, el } = loadSelectOption([
    { value: "vn", text: "Vietnam" },
    { value: "us", text: "United States" },
  ]);
  select_option({ ref: "ref_1", option: "United States" });
  assert.equal(el.value, "us");
});

test("select_option: a miss lists what the select actually offers", () => {
  const { select_option } = loadSelectOption([{ value: "vn", text: "Vietnam" }]);
  assert.throws(
    () => select_option({ ref: "ref_1", option: "Vietnaam" }),
    /no option matching "Vietnaam".*available: Vietnam \(value=vn\)/s
  );
});

test("select_option: the explicit value/label params still work", () => {
  const { select_option, el } = loadSelectOption([{ value: "vn", text: "Vietnam" }]);
  select_option({ ref: "ref_1", label: "Vietnam" });
  assert.equal(el.value, "vn");
});

// =====================================================================================
// get_property — several fields per row
// =====================================================================================
//
// all:true reads ONE property across many elements, which still left the common shape —
// a list of rows each with a title, a link and a number — at one call per field. A Haiku
// probe on 0.8.0 used eval_js exactly once, for exactly this, and said so: "1 call instead
// of 30+". Fields close that gap.

function mkRow(sel, ref, children) {
  const row = {
    __sel: sel,
    __ref: ref,
    tagName: "LI",
    innerText: "",
    textContent: "",
    hasAttribute: () => false,
    getAttribute: () => null,
    querySelector: (s) => children[s] || null,
    querySelectorAll: () => [],
  };
  return row;
}

function loadGetPropertyFields(rows) {
  const slices = [
    extractConst(SRC, "MATCH_COUNTED"),
    extractFunction(SRC, "get_property"),
    extractFunction(SRC, "readOneProperty"),
  ];
  const stubs = {
    document: {
      documentElement: {},
      baseURI: "https://site.test/list",
      createDocumentFragment: () => ({ querySelector: () => null }),
    },
    location: { href: "https://site.test/list" },
    URL,
    deepQueryAll: (sel) => rows.filter((r) => r.__sel === sel),
    deepQuery: (sel, root) => (root && root.querySelector ? root.querySelector(sel) : null),
    getOrAssignRef: (el) => el.__ref,
    resolveTarget: () => rows[0],
  };
  const { get_property } = loadFromContentJs(slices, ["get_property"], stubs);
  return get_property;
}

const leaf = (text, attrs = {}) => ({
  tagName: "A",
  innerText: text,
  textContent: text,
  outerHTML: `<a>${text}</a>`,
  hasAttribute: (n) => n in attrs,
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
});

test("get_property: fields reads several values from each row in one call", () => {
  const rows = [
    mkRow("li.result", "ref_1", { h3: leaf("First post"), a: leaf("First post", { href: "/one" }) }),
    mkRow("li.result", "ref_2", { h3: leaf("Second post"), a: leaf("Second post", { href: "https://x.test/two" }) }),
  ];
  const get_property = loadGetPropertyFields(rows);
  const res = get_property({
    selector: "li.result",
    all: true,
    fields: { title: "h3", url: { selector: "a", attr: "href" } },
  });
  assert.equal(res.count, 2);
  // Spread first: the array is built inside the vm realm, so it is not reference-equal
  // to a host Array even when the contents match.
  assert.deepEqual([...res.fields], ["title", "url"]);
  assert.equal(res.matches[0].title, "First post");
  // A URL comes back absolute — that is what the read was for.
  assert.equal(res.matches[0].url, "https://site.test/one");
  assert.equal(res.matches[1].url, "https://x.test/two");
  assert.equal(res.matches[1].ref, "ref_2");
});

test("get_property: a field that matches nothing inside the row says so, and says why", () => {
  const rows = [mkRow("li.result", "ref_1", { h3: leaf("Only a title") })];
  const get_property = loadGetPropertyFields(rows);
  const res = get_property({ selector: "li.result", all: true, fields: { title: "h3", points: ".score" } });
  assert.equal(res.matches[0].points, null);
  assert.match(res.note, /no match inside the row for: points \(1\/1 rows\)/);
  assert.match(res.note, /SIBLING of the row/);
});

test("get_property: the field note and the paging note do not overwrite each other", () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow("li.result", `ref_${i}`, { h3: leaf(`row ${i}`) }));
  const get_property = loadGetPropertyFields(rows);
  const res = get_property({ selector: "li.result", all: true, max: 2, fields: { title: "h3", points: ".score" } });
  assert.match(res.note, /no match inside the row for/);
  assert.match(res.note, /5 elements matched; the first 2 are listed/);
});

test("get_property: fields without all:true explains itself instead of being ignored", () => {
  const get_property = loadGetPropertyFields([]);
  assert.throws(() => get_property({ selector: "li", fields: { title: "h3" } }), /needs all:true/);
});
