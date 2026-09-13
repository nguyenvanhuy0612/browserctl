// Behavioural tests for helpers inside extension/background.js.
//
// background.js is a service worker that registers chrome.* listeners at load time, so it
// cannot be imported under Node. Same approach as content_helpers.test.mjs: slice the real
// function source out of the shipped file by name and evaluate it in a node:vm context with
// a chrome stub, so the test breaks when the real implementation does.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "..", "extension", "background.js"), "utf8");

function extractFunction(name) {
  const m = SRC.match(new RegExp(`async function\\s+${name}\\s*\\(`));
  if (!m) throw new Error(`function ${name} not found in background.js`);
  const braceStart = SRC.indexOf("{", SRC.indexOf(")", m.index));
  let depth = 0;
  for (let i = braceStart; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(m.index, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

// `tabs` is the sequence chrome.tabs.get answers with, one per poll.
function load(tabs) {
  const seen = [];
  const ctx = vm.createContext({
    setTimeout,
    chrome: {
      tabs: {
        async get() {
          const t = tabs[Math.min(seen.length, tabs.length - 1)];
          seen.push(t);
          return t;
        },
      },
    },
  });
  vm.runInContext(extractFunction("confirmNothingHappened") + "\nglobalThis.__fn = confirmNothingHappened;", ctx);
  return { fn: ctx.__fn, seen };
}

const nothingHappened = () => ({
  ok: true,
  result: {
    clicked: "@ref_1",
    effect: { measured: true, domMutated: false, mutationCount: 0, urlChanged: false, targetStillPresent: true },
    warning: "the page did not change at all (0 mutations, same URL): treat this click as NOT confirmed",
  },
});

test("a click that answered before its navigation committed is corrected, not left as a false negative", async () => {
  // Measured on example.com's "Learn more": the content script replied in 554ms with
  // 0 mutations and the same location, while the tab was already navigating to iana.org.
  const { fn } = load([
    { status: "loading", url: "https://example.com/" },
    { status: "loading", url: "https://www.iana.org/help/example-domains" },
  ]);
  const out = await fn(nothingHappened(), 1, "https://example.com/");
  assert.equal(out.result.effect.urlChanged, true);
  assert.equal(out.result.effect.navigatedTo, "https://www.iana.org/help/example-domains");
  assert.ok(!out.result.warning, "the 'NOT confirmed' warning must not survive a proven navigation");
  assert.match(out.result.note, /navigated the page/);
  assert.match(out.result.note, /refs from before it are gone/i);
});

test("a click that really did nothing keeps its warning, and costs one tab read", async () => {
  const { fn, seen } = load([{ status: "complete", url: "https://example.com/" }]);
  const out = await fn(nothingHappened(), 1, "https://example.com/");
  assert.equal(out.result.effect.urlChanged, false);
  assert.match(out.result.warning, /NOT confirmed/);
  assert.equal(seen.length, 1, "a settled tab must not be polled again");
});

test("a click that visibly changed the page is not re-checked at all", async () => {
  const { fn, seen } = load([{ status: "complete", url: "https://elsewhere.test/" }]);
  const reply = nothingHappened();
  reply.result.effect.domMutated = true;
  reply.result.effect.mutationCount = 12;
  delete reply.result.warning;
  const out = await fn(reply, 1, "https://example.com/");
  assert.equal(out.result.effect.urlChanged, false, "a mutation is already proof; no tab read is needed");
  assert.equal(seen.length, 0);
});

test("an unmeasured effect (autoSettle off) is left alone", async () => {
  const { fn, seen } = load([{ status: "loading", url: "https://elsewhere.test/" }]);
  const reply = nothingHappened();
  reply.result.effect.measured = false;
  const out = await fn(reply, 1, "https://example.com/");
  assert.equal(out.result.effect.urlChanged, false);
  assert.equal(seen.length, 0);
});
