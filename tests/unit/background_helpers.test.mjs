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
import { extractFunction as sliceFunction } from "./source-slice.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "..", "extension", "background.js"), "utf8");

function extractFunction(name) {
  return sliceFunction(SRC, name);
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

function loadFrameRoute() {
  const ctx = vm.createContext({});
  vm.runInContext(extractFunction("frameRoute") + "\nglobalThis.__fn = frameRoute;", ctx);
  return ctx.__fn;
}

test("a frame-qualified ref in 'target' routes to that frame", () => {
  const frameRoute = loadFrameRoute();
  for (const target of ["@f3:ref_5", "f3:ref_5", "@f3:@ref_5"]) {
    const out = frameRoute({ target, tabId: 7 });
    assert.equal(out.frameId, 3, target);
    assert.equal(out.params.target, "@ref_5", target);
    assert.equal(out.params.tabId, 7);
  }
});

test("text in 'target' that only looks frame-qualified stays in the top frame", () => {
  const frameRoute = loadFrameRoute();
  for (const target of ["f2: Settings", "f1:help", "css=#a", 4]) {
    const out = frameRoute({ target });
    assert.equal(out.frameId, 0, String(target));
    assert.equal(out.params.target, target);
  }
});

test("the CLI's frame-qualified 'ref' still routes", () => {
  const out = loadFrameRoute()({ ref: "@f12:ref_3" });
  assert.equal(out.frameId, 12);
  assert.equal(out.params.ref, "ref_3");
});

test("a visible-tab element capture crops the element's box, scaled to device pixels", async () => {
  const drawn = [];
  const ctx = vm.createContext({
    chrome: { tabs: { captureVisibleTab: async () => "data:image/png;base64,AAAA" } },
    fetch: async () => ({ blob: async () => "blob" }),
    createImageBitmap: async () => ({ width: 2000, height: 1200, close() {} }),
    OffscreenCanvas: class {
      constructor(w, h) {
        this.size = [w, h];
      }
      getContext() {
        return { drawImage: (...a) => drawn.push(a) };
      }
      async convertToBlob() {
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    String,
    Math,
  });
  vm.runInContext(
    extractFunction("cropVisibleTab") + "\n" + extractFunction("fitsViewport") +
      "\nglobalThis.__crop = cropVisibleTab; globalThis.__fits = fitsViewport;",
    ctx
  );
  const rect = { x: 100, y: 50, width: 80, height: 20, viewport: { width: 1000, height: 600 } };
  assert.equal(ctx.__fits(rect), true);
  const out = await ctx.__crop({ windowId: 1 }, rect, "png");
  assert.match(out.dataUrl, /^data:image\/png;base64,/);
  // A 2x capture: the CSS box (100,50 80x20) is read from (200,100 160x40).
  assert.deepEqual(drawn[0].slice(1, 5), [200, 100, 160, 40]);
  assert.equal(ctx.__fits({ ...rect, y: 590 }), false, "a box past the viewport goes through CDP");
});

test("a11y coverage is measured against the whole census, not its first page", async () => {
  const names = Array.from({ length: 300 }, (_, i) => `Control ${i}`);
  let asked = null;
  const ctx = vm.createContext({
    AX_CENSUS_LIMIT: 100000,
    toContent: async (action, params) => {
      asked = params;
      const all = names.map((t, i) => ({ ref: `ref_${i + 1}`, tag: "button", text: t }));
      return { ok: true, result: { elements: all.slice(0, params.limit ?? 200) } };
    },
  });
  vm.runInContext(extractFunction("enrichAxWithRefs") + "\nglobalThis.__fn = enrichAxWithRefs;", ctx);
  const ax = { nodes: names.map((name) => ({ role: "button", name })) };
  const out = await ctx.__fn(ax, 1);
  assert.ok(asked.limit >= names.length, `census asked for ${asked.limit} elements`);
  assert.equal(out.censusCoverage, 100);
  assert.equal(out.notInCensus, undefined);
});

// A chrome stub whose tabs.update plays one navigation scenario through webNavigation events.
function loadNavigate(play, { commitMs = 60 } = {}) {
  const ev = () => {
    const ls = new Set();
    return { addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f), fire: (d) => [...ls].forEach((f) => f(d)), size: () => ls.size };
  };
  const nav = {
    onCommitted: ev(),
    onReferenceFragmentUpdated: ev(),
    onHistoryStateUpdated: ev(),
    onErrorOccurred: ev(),
    frameError: false,
    getFrame: async () => ({ errorOccurred: nav.frameError }),
  };
  const tab = { id: 7, url: "https://before.test/", status: "complete" };
  const ctx = vm.createContext({
    setTimeout,
    clearTimeout,
    NAV_COMMIT_MS: commitMs,
    targetTab: async () => tab,
    pinTarget: () => {},
    waitForComplete: async () => {},
    toContent: async () => ({ ok: true }),
    chrome: {
      webNavigation: nav,
      tabs: {
        get: async () => ({ ...tab }),
        update: async (id, { url }) => play({ nav, tab, url }),
      },
    },
  });
  vm.runInContext(
    [extractFunction("navigationFailed"), extractFunction("waitForCommit"), extractFunction("navigate")].join("\n") +
      "\nglobalThis.__nav = navigate;",
    ctx
  );
  return { navigate: ctx.__nav, nav };
}

test("navigate answers with the new page once the navigation commits", async () => {
  const { navigate, nav } = loadNavigate(({ nav: n, tab, url }) => {
    setTimeout(() => {
      tab.url = url;
      n.onCommitted.fire({ tabId: 7, frameId: 0 });
    }, 5);
  });
  const out = await navigate({ url: "https://after.test/" });
  assert.equal(out.url, "https://after.test/");
  assert.equal(nav.onCommitted.size(), 0, "listeners are removed afterwards");
});

test("navigate that never commits is an error naming the page the tab is still on", async () => {
  const { navigate } = loadNavigate(() => {});
  await assert.rejects(
    () => navigate({ url: "http://slow.test/" }),
    /had not started loading.*still on https:\/\/before\.test\//
  );
});

test("navigate reports Chrome's network error instead of the old page", async () => {
  const { navigate } = loadNavigate(({ nav: n }) => {
    setTimeout(() => n.onErrorOccurred.fire({ tabId: 7, frameId: 0, error: "net::ERR_NAME_NOT_RESOLVED" }), 5);
  });
  await assert.rejects(() => navigate({ url: "http://nope.test/" }), /ERR_NAME_NOT_RESOLVED/);
});

test("navigate to a fragment of the same page commits without a new document", async () => {
  const { navigate } = loadNavigate(({ nav: n, tab, url }) => {
    setTimeout(() => {
      tab.url = url;
      n.onReferenceFragmentUpdated.fire({ tabId: 7, frameId: 0 });
    }, 5);
  });
  assert.equal((await navigate({ url: "https://before.test/#part" })).url, "https://before.test/#part");
});

test("an aborted earlier navigation is not reported as this one failing", async () => {
  const { navigate } = loadNavigate(({ nav: n, tab, url }) => {
    setTimeout(() => n.onErrorOccurred.fire({ tabId: 7, frameId: 0, error: "net::ERR_ABORTED" }), 2);
    setTimeout(() => {
      tab.url = url;
      n.onCommitted.fire({ tabId: 7, frameId: 0 });
    }, 10);
  });
  assert.equal((await navigate({ url: "https://after.test/" })).url, "https://after.test/");
});

test("an element's frame is named by origin and path, without the iframe's query string", () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(extractFunction("frameLabel") + "\nglobalThis.__fn = frameLabel;", ctx);
  const long = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=" + "x".repeat(3000) + "#frag";
  assert.equal(ctx.__fn(long), "https://www.google.com/recaptcha/api2/anchor");
  assert.equal(ctx.__fn("about:blank"), "about:blank");
  assert.equal(ctx.__fn("data:text/html,<p>hi?x</p>"), "data:text/html,<p>hi");
  assert.equal(ctx.__fn(""), "");
});
