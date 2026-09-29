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
  vm.runInContext(
    extractFunction("confirmNothingHappened") + "\nglobalThis.__fn = confirmNothingHappened;",
    ctx
  );
  return { fn: ctx.__fn, seen };
}

const nothingHappened = () => ({
  ok: true,
  result: {
    clicked: "@ref_1",
    effect: {
      measured: true,
      domMutated: false,
      mutationCount: 0,
      urlChanged: false,
      targetStillPresent: true,
    },
    warning:
      "the page did not change at all (0 mutations, same URL): treat this click as NOT confirmed",
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
  assert.ok(
    !out.result.warning,
    "the 'NOT confirmed' warning must not survive a proven navigation"
  );
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
  assert.equal(
    out.result.effect.urlChanged,
    false,
    "a mutation is already proof; no tab read is needed"
  );
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
    chrome: {
      tabs: {
        captureVisibleTab: async () => "data:image/png;base64,AAAA",
        get: async (id) => ({ id, active: true, windowId: 1 }),
      },
    },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
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
    "const CAPTURE_VISIBLE_SPACING_MS = 0;\nconst CAPTURE_VISIBLE_MS = 5000;\nlet captureVisibleQueue = Promise.resolve();\nlet lastCaptureVisibleAt = 0;\n" +
      extractFunction("captureVisible") +
      "\n" +
      extractFunction("cropVisibleTab") +
      "\n" +
      extractFunction("fitsViewport") +
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
  vm.runInContext(
    extractFunction("enrichAxWithRefs") + "\nglobalThis.__fn = enrichAxWithRefs;",
    ctx
  );
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
    return {
      addListener: (f) => ls.add(f),
      removeListener: (f) => ls.delete(f),
      fire: (d) => [...ls].forEach((f) => f(d)),
      size: () => ls.size,
    };
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
    [
      extractFunction("navigationFailed"),
      extractFunction("waitForCommit"),
      extractFunction("navigate"),
    ].join("\n") + "\nglobalThis.__nav = navigate;",
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
    setTimeout(
      () => n.onErrorOccurred.fire({ tabId: 7, frameId: 0, error: "net::ERR_NAME_NOT_RESOLVED" }),
      5
    );
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
  assert.equal(
    (await navigate({ url: "https://before.test/#part" })).url,
    "https://before.test/#part"
  );
});

test("an aborted earlier navigation is not reported as this one failing", async () => {
  const { navigate } = loadNavigate(({ nav: n, tab, url }) => {
    setTimeout(
      () => n.onErrorOccurred.fire({ tabId: 7, frameId: 0, error: "net::ERR_ABORTED" }),
      2
    );
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

// switch_tab and new_tab set the target without changing what the user sees; only an explicit
// activate makes the tab the visible one.
function loadTabOps() {
  const calls = [];
  const pins = [];
  const tab = { id: 9, windowId: 3, url: "https://t/", title: "T" };
  const ctx = vm.createContext({
    pinTarget: (id) => pins.push(id),
    chrome: {
      tabs: {
        async get(id) {
          calls.push(["get", id]);
          return tab;
        },
        async update(id, props) {
          calls.push(["update", id, props]);
          return tab;
        },
        async create(props) {
          calls.push(["create", props]);
          return { id: 10 };
        },
      },
      windows: {
        async update(id, props) {
          calls.push(["windows.update", id, props]);
        },
      },
    },
  });
  vm.runInContext(
    extractFunction("switchTab") +
      "\n" +
      extractFunction("newTab") +
      "\nglobalThis.__switch = switchTab; globalThis.__new = newTab;",
    ctx
  );
  return { switchTab: ctx.__switch, newTab: ctx.__new, calls, pins };
}

test("switch_tab pins the tab without activating it", async () => {
  const { switchTab, calls, pins } = loadTabOps();
  const res = await switchTab({ id: 9 });
  assert.deepEqual(pins, [9]);
  assert.ok(!calls.some((c) => c[0] === "update"), JSON.stringify(calls));
  assert.deepEqual({ ...res }, { id: 9, url: "https://t/", title: "T" });
});

test("switch_tab with activate makes the tab visible", async () => {
  const { switchTab, calls, pins } = loadTabOps();
  await switchTab({ id: 9, activate: true });
  const update = calls.find((c) => c[0] === "update");
  assert.equal(JSON.stringify(update), JSON.stringify(["update", 9, { active: true }]));
  assert.deepEqual(pins, [9]);
});

test("new_tab opens in the background unless activate is given", async () => {
  const bg = loadTabOps();
  await bg.newTab({});
  assert.equal(JSON.stringify(bg.calls[0]), JSON.stringify(["create", { active: false }]));
  const fg = loadTabOps();
  await fg.newTab({ activate: true });
  assert.equal(JSON.stringify(fg.calls[0]), JSON.stringify(["create", { active: true }]));
});

// A browser that does not paint a background tab (Edge) never answers the CDP capture. The capture
// is bounded, and the error says how to bring the tab to the front.
function loadCaptureBackground(captureViewport, ensureAttached = async () => ({})) {
  const ctx = vm.createContext({
    setTimeout,
    clearTimeout,
    Promise,
    captureViewport,
    ensureAttached,
  });
  vm.runInContext(
    "const BACKGROUND_CAPTURE_MS = 50;\n" +
      extractFunction("captureBackground") +
      "\nglobalThis.__fn = captureBackground;",
    ctx
  );
  return ctx.__fn;
}

test("a background capture the browser never answers fails with a hint instead of hanging", async () => {
  const capture = loadCaptureBackground(() => new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(capture({ id: 7 }, {}), (err) => {
    assert.match(err.message, /tab 7 is in the background/);
    assert.match(err.message, /activate: true/);
    return true;
  });
  assert.ok(Date.now() - started < 1000);
});

test("a background capture the browser answers is returned unchanged", async () => {
  const capture = loadCaptureBackground(async (id) => ({
    dataUrl: `data:image/jpeg;base64,${id}`,
  }));
  assert.deepEqual(await capture({ id: 9 }, {}), { dataUrl: "data:image/jpeg;base64,9" });
});

// Chrome refuses a third captureVisibleTab within a second; every session on one browser shares
// that budget, so concurrent captures are queued and spaced.
function loadCaptureVisible(onCapture, activeOf = (id) => ({ id, active: true, windowId: id })) {
  const ctx = vm.createContext({
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    chrome: {
      tabs: {
        captureVisibleTab: async (windowId, opts) => onCapture(windowId, opts),
        get: async (id) => activeOf(id),
      },
    },
  });
  vm.runInContext(
    "const CAPTURE_VISIBLE_SPACING_MS = 80;\nconst CAPTURE_VISIBLE_MS = 200;\nlet captureVisibleQueue = Promise.resolve();\nlet lastCaptureVisibleAt = 0;\n" +
      extractFunction("captureVisible") +
      "\nglobalThis.__fn = captureVisible;",
    ctx
  );
  return ctx.__fn;
}

test("concurrent visible-tab captures are spaced instead of hitting the per-second quota", async () => {
  const at = [];
  const capture = loadCaptureVisible((windowId) => {
    at.push(Date.now());
    return `shot-${windowId}`;
  });
  const shots = await Promise.all([capture(1, 1, {}), capture(2, 2, {}), capture(3, 3, {})]);
  assert.deepEqual(shots, ["shot-1", "shot-2", "shot-3"]);
  for (let i = 1; i < at.length; i++)
    assert.ok(at[i] - at[i - 1] >= 75, `gap ${at[i] - at[i - 1]} ms`);
});

test("a failed capture does not block the captures queued after it", async () => {
  let n = 0;
  const capture = loadCaptureVisible(() => {
    n++;
    if (n === 1) throw new Error("tab gone");
    return "ok";
  });
  const [first, second] = await Promise.allSettled([capture(1, 1, {}), capture(1, 1, {})]);
  assert.equal(first.status, "rejected");
  assert.equal(second.value, "ok");
});

// captureVisibleTab captures whatever is active when it runs; a tab another session switched away
// from while this capture waited must not come back as someone else's pixels.
test("a queued capture whose tab left the front rejects with TAB_LEFT_FRONT instead of capturing another tab", async () => {
  let activeTab = 10;
  const capture = loadCaptureVisible(
    () => `pixels-of-tab-${activeTab}`,
    (id) => ({ id, active: id === activeTab, windowId: 1 })
  );
  const first = capture(10, 1, {});
  const second = capture(10, 1, {});
  await first;
  activeTab = 11; // another session brings tab 11 to the front while the second capture waits
  await assert.rejects(second, (err) => err.code === "TAB_LEFT_FRONT");
});

test("a visible-tab capture that never answers is bounded and frees the queue", async () => {
  let n = 0;
  const capture = loadCaptureVisible(() => (++n === 1 ? new Promise(() => {}) : "ok"));
  const [hung, next] = await Promise.allSettled([capture(1, 1, {}), capture(1, 1, {})]);
  assert.equal(hung.status, "rejected");
  assert.match(hung.reason.message, /did not answer/);
  assert.equal(next.value, "ok");
});

// Several commands on one background tab can attach CDP at once (two sessions, or one session's
// parallel calls); they must share a single chrome.debugger.attach.
test("concurrent ensureAttached calls on one tab attach the debugger once", async () => {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  let attaches = 0;
  const ctx = vm.createContext({
    Map,
    Promise,
    setTimeout,
    sessions: new Map(),
    attach: async () => {
      attaches++;
      await new Promise((r) => setTimeout(r, 20));
      if (attaches > 1) throw new Error("another debugger is already attached");
    },
    persistAttached: () => {},
    sendRaw: async () => {},
  });
  vm.runInContext(
    "const attaching = new Map();\nconst opening = new Map();\n" +
      sliceFunction(CDP_SRC, "attachShared") +
      "\n" +
      sliceFunction(CDP_SRC, "ensureAttached") +
      "\nglobalThis.__fn = ensureAttached; globalThis.__attachShared = attachShared;",
    ctx
  );
  const results = await Promise.all([ctx.__fn(5), ctx.__fn(5), ctx.__fn(5)]);
  assert.equal(attaches, 1);
  assert.ok(results.every((r) => r && r.network));
  await ctx.__fn(5);
  assert.equal(attaches, 1, "an attached tab is not attached again");
});

// A browser that paints no frame for a hidden tab (Edge) answers Page.captureScreenshot once
// focus emulation makes the page visible. A CDP capture of a tab not in front holds emulation on
// for its own duration, and only when no caller turned it on itself.
function loadCdpCapture(onSend) {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  const calls = [];
  const ctx = vm.createContext({
    Map,
    Promise,
    Math,
    lastCapture: {},
    ensureAttached: async () => ({}),
    send: async (tabId, method, params) => {
      calls.push(
        method === "Emulation.setFocusEmulationEnabled" ? `focus:${params.enabled}` : method
      );
      if (onSend) return onSend(method, params);
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
          visualViewport: { clientWidth: 800 },
        };
      }
      if (method === "Page.captureScreenshot") return { data: "AAAA" };
      return {};
    },
  });
  vm.runInContext(
    "const focusEmulation = new Map();\n" +
      ["withFocusEmulation", "noteCallerFocusEmulation", "captureViewport"]
        .map((n) => sliceFunction(CDP_SRC, n))
        .join("\n") +
      "\nglobalThis.__cdp = { captureViewport, noteCallerFocusEmulation };",
    ctx
  );
  return { ...ctx.__cdp, calls };
}

test("a background CDP capture turns focus emulation on, captures, and turns it off, in order", async () => {
  const { captureViewport, calls } = loadCdpCapture();
  const res = await captureViewport(3, { emulateFocus: true });
  assert.equal(res.dataUrl, "data:image/jpeg;base64,AAAA");
  assert.deepEqual(calls, [
    "focus:true",
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
    "focus:false",
  ]);
});

test("focus emulation is turned off when the capture rejects", async () => {
  const { captureViewport, calls } = loadCdpCapture((method) => {
    if (method === "Page.captureScreenshot") throw new Error("capture failed");
    return {};
  });
  await assert.rejects(captureViewport(3, { emulateFocus: true }), /capture failed/);
  assert.equal(calls.at(-1), "focus:false");
});

test("focus emulation is turned off when the capture's deadline passes first", async () => {
  const { captureViewport, calls } = loadCdpCapture((method) =>
    method === "Page.captureScreenshot" ? new Promise(() => {}) : {}
  );
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("bounded")), 30));
  await assert.rejects(captureViewport(3, { emulateFocus: true, deadline }), /bounded/);
  assert.equal(calls.at(-1), "focus:false");
});

test("a capture of a tab in front sends no focus emulation", async () => {
  const { captureViewport, calls } = loadCdpCapture();
  await captureViewport(3, {});
  assert.deepEqual(calls, ["Page.getLayoutMetrics", "Page.captureScreenshot"]);
});

test("focus emulation a caller turned on is neither re-sent nor turned off by a capture", async () => {
  const { captureViewport, noteCallerFocusEmulation, calls } = loadCdpCapture();
  noteCallerFocusEmulation(3, "Emulation.setFocusEmulationEnabled", { enabled: true });
  await captureViewport(3, { emulateFocus: true });
  assert.deepEqual(calls, ["Page.getLayoutMetrics", "Page.captureScreenshot"]);
  noteCallerFocusEmulation(3, "Emulation.setFocusEmulationEnabled", { enabled: false });
  calls.length = 0;
  await captureViewport(3, { emulateFocus: true });
  assert.deepEqual(calls, [
    "focus:true",
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
    "focus:false",
  ]);
});

test("concurrent background captures of one tab share one on/off pair", async () => {
  const { captureViewport, calls } = loadCdpCapture();
  await Promise.all([
    captureViewport(3, { emulateFocus: true }),
    captureViewport(3, { emulateFocus: true }),
  ]);
  assert.equal(calls.filter((c) => c === "focus:true").length, 1);
  assert.equal(calls.filter((c) => c === "focus:false").length, 1);
  assert.equal(calls.at(-1), "focus:false");
});

test("a bounded background capture asks captureViewport for focus emulation under its deadline", async () => {
  let seen;
  const capture = loadCaptureBackground(async (id, opts) => {
    seen = opts;
    return { dataUrl: "data:image/jpeg;base64,1" };
  });
  await capture({ id: 4 }, { format: "png" });
  assert.equal(seen.emulateFocus, true);
  assert.equal(seen.format, "png");
  assert.ok(seen.deadline && typeof seen.deadline.then === "function");
});

// Which route a viewport screenshot takes: only the active tab of a focused window counts as in
// front; an attached tab anywhere else is a bounded background capture.
function loadScreenshot({ tab, attached, windowFocused }) {
  const routes = [];
  const ctx = vm.createContext({
    Promise,
    targetTab: async () => tab,
    isAttached: () => attached,
    captureViewport: async (id, opts) => (routes.push(["viewport", opts]), { dataUrl: "v" }),
    captureBackground: async () => (routes.push(["background"]), { dataUrl: "b" }),
    wakeIfAsleep: async () => {},
    captureVisible: async () => (routes.push(["visible"]), "data:image/jpeg;base64,x"),
    getDevicePixelRatio: async () => 1,
    setLastCaptureScale: () => {},
    chrome: { windows: { get: async () => ({ focused: windowFocused }) } },
  });
  vm.runInContext(
    extractFunction("inFront") +
      "\n" +
      extractFunction("screenshot") +
      "\nglobalThis.__fn = screenshot;",
    ctx
  );
  return { screenshot: ctx.__fn, routes };
}

test("an attached active tab of a focused window is captured in front, without emulation", async () => {
  const { screenshot, routes } = loadScreenshot({
    tab: { id: 1, active: true, windowId: 2 },
    attached: true,
    windowFocused: true,
  });
  await screenshot({});
  assert.equal(routes[0][0], "viewport");
  assert.ok(!routes[0][1].emulateFocus);
});

test("an attached active tab of an unfocused window takes the background capture", async () => {
  const { screenshot, routes } = loadScreenshot({
    tab: { id: 1, active: true, windowId: 2 },
    attached: true,
    windowFocused: false,
  });
  await screenshot({});
  assert.deepEqual(routes, [["background"]]);
});

test("a failed attach rejects every waiter, leaves no session, and a later call retries", async () => {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  let attaches = 0;
  const ctx = vm.createContext({
    Map,
    Promise,
    setTimeout,
    sessions: new Map(),
    attach: async () => {
      attaches++;
      if (attaches === 1) throw new Error("boom");
    },
    persistAttached: () => {},
    sendRaw: async () => {},
  });
  vm.runInContext(
    "const attaching = new Map();\nconst opening = new Map();\n" +
      sliceFunction(CDP_SRC, "attachShared") +
      "\n" +
      sliceFunction(CDP_SRC, "ensureAttached") +
      "\nglobalThis.__fn = ensureAttached;",
    ctx
  );
  const results = await Promise.allSettled([ctx.__fn(8), ctx.__fn(8)]);
  assert.ok(results.every((r) => r.status === "rejected" && /boom/.test(r.reason.message)));
  assert.equal(ctx.sessions.has(8), false);
  const s = await ctx.__fn(8);
  assert.ok(s && s.network);
  assert.equal(attaches, 2);
});

test("a detach during Page.enable leaves no session and names the detach", async () => {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  const ctx = vm.createContext({
    Map,
    Promise,
    setTimeout,
    sessions: new Map(),
    attach: async () => {},
    persistAttached: () => {},
    sendRaw: async () => {
      throw new Error("Debugger is not attached to the tab with id: 9.");
    },
  });
  vm.runInContext(
    "const attaching = new Map();\nconst opening = new Map();\n" +
      sliceFunction(CDP_SRC, "attachShared") +
      "\n" +
      sliceFunction(CDP_SRC, "ensureAttached") +
      "\nglobalThis.__fn = ensureAttached;",
    ctx
  );
  await assert.rejects(ctx.__fn(9), /detached from tab 9 while attaching/);
  assert.equal(ctx.sessions.has(9), false);
});

test("a background element or full-page capture that never answers is bounded with the hint", async () => {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  const ctx = vm.createContext({ Promise, setTimeout, clearTimeout });
  vm.runInContext(
    "const BACKGROUND_SHOT_MS = 50;\n" +
      sliceFunction(CDP_SRC, "boundBackgroundShot") +
      "\nglobalThis.__fn = boundBackgroundShot;",
    ctx
  );
  await assert.rejects(
    ctx.__fn(12, () => new Promise(() => {})),
    /tab 12 is in the background.*activate: true/
  );
  assert.deepEqual(await ctx.__fn(12, async () => ({ data: "x" })), { data: "x" });
});

// A tab the browser froze in the background stops answering the content script; one it discarded
// has no page at all. Commands wake the first and report the second.
// ping: "answers" | "silent" | "refuses" (no content script). script: whether an injected empty
// script runs (false = a frozen page).
function loadWakeIfAsleep(ping = "answers", script = true, wakeFails = false) {
  const woken = [];
  const pinged = [];
  const probed = [];
  const ctx = vm.createContext({
    Promise,
    setTimeout,
    clearTimeout,
    wakeFrozenTab: async (id) => {
      woken.push(id);
      if (wakeFails) throw new Error("another debugger is already attached");
    },
    chrome: {
      tabs: {
        sendMessage: (id) => {
          pinged.push(id);
          if (ping === "answers") return Promise.resolve({ ok: false });
          if (ping === "refuses") return Promise.reject(new Error("Receiving end does not exist."));
          return new Promise(() => {});
        },
      },
      scripting: {
        executeScript: ({ target }) => (
          probed.push(target.tabId),
          script ? Promise.resolve([{ result: 1 }]) : new Promise(() => {})
        ),
      },
    },
  });
  vm.runInContext(
    "const ASLEEP_PING_MS = 40;\n" +
      extractFunction("answersWithin") +
      "\n" +
      extractFunction("wakeIfAsleep") +
      "\nglobalThis.__fn = wakeIfAsleep;",
    ctx
  );
  return { wake: ctx.__fn, woken, pinged, probed };
}

test("a background page with no content script is probed with a script, and woken when that does not run", async () => {
  const frozen = loadWakeIfAsleep("refuses", false);
  await frozen.wake({ id: 31, active: false });
  assert.deepEqual(frozen.probed, [31]);
  assert.deepEqual(frozen.woken, [31]);
  const awake = loadWakeIfAsleep("refuses", true);
  await awake.wake({ id: 32, active: false });
  assert.deepEqual(awake.probed, [32]);
  assert.deepEqual(awake.woken, []);
});

test("a background page that does not answer a ping is woken (browsers without the frozen flag)", async () => {
  const { wake, woken, pinged } = loadWakeIfAsleep("silent");
  await wake({ id: 21, active: false });
  assert.deepEqual(pinged, [21]);
  assert.deepEqual(woken, [21]);
});

test("a background page that answers the ping, and an active tab, are not woken", async () => {
  const { wake, woken, pinged } = loadWakeIfAsleep("answers");
  await wake({ id: 22, active: false });
  await wake({ id: 23, active: true });
  assert.deepEqual(pinged, [22]);
  assert.deepEqual(woken, []);
});

test("a frozen tab is woken before a command, and an awake one is left alone", async () => {
  const { wake, woken } = loadWakeIfAsleep();
  await wake({ id: 3, frozen: true });
  await wake({ id: 4, frozen: false, active: true });
  assert.deepEqual(woken, [3]);
});

test("a discarded tab is reported with the reload hint instead of hanging", async () => {
  const { wake, woken } = loadWakeIfAsleep();
  await assert.rejects(wake({ id: 5, discarded: true }), /tab 5 was discarded.*reload: true/);
  assert.deepEqual(woken, []);
});

test("waking a frozen tab detaches again only when no session held it", async () => {
  const CDP_SRC = readFileSync(join(__dirname, "..", "..", "extension", "cdp.js"), "utf8");
  const calls = [];
  const make = (held) => {
    const ctx = vm.createContext({
      Map,
      Promise,
      sessions: new Map(held ? [[7, {}]] : []),
      attach: async (id) => calls.push(`attach ${id}`),
      detach: async (id) => calls.push(`detach ${id}`),
      sendRaw: async (id, m, p) => calls.push(`${m} ${p.state}`),
    });
    vm.runInContext(
      "const attaching = new Map();\nconst opening = new Map();\n" +
        sliceFunction(CDP_SRC, "attachShared") +
        "\n" +
        sliceFunction(CDP_SRC, "wakeFrozenTab") +
        "\nglobalThis.__fn = wakeFrozenTab;",
      ctx
    );
    return ctx.__fn;
  };
  await make(false)(7);
  assert.deepEqual(calls, ["attach 7", "Page.setWebLifecycleState active", "detach 7"]);
  calls.length = 0;
  await make(true)(7);
  assert.deepEqual(calls, ["Page.setWebLifecycleState active"]);
});

test("a loading background tab is not checked for sleep", async () => {
  const { wake, woken, pinged } = loadWakeIfAsleep("silent");
  await wake({ id: 41, active: false, status: "loading" });
  assert.deepEqual(pinged, []);
  assert.deepEqual(woken, []);
});

test("a wake chosen by the no-answer check that fails lets the command go ahead", async () => {
  const { wake, woken } = loadWakeIfAsleep("silent", true, true);
  await wake({ id: 42, active: false, status: "complete" });
  assert.deepEqual(woken, [42]);
});

test("a wake the browser's frozen flag asked for still reports its failure", async () => {
  const { wake } = loadWakeIfAsleep("answers", true, true);
  await assert.rejects(wake({ id: 43, frozen: true }), /another debugger/);
});

test("a tab switch during the visible capture itself is caught, not returned as this tab's image", async () => {
  let active = 50;
  let reads = 0;
  const capture = loadCaptureVisible(
    () => {
      active = 51; // the switch lands while captureVisibleTab runs
      return "pixels";
    },
    (id) => (reads++, { id, active: id === active, windowId: 1 })
  );
  await assert.rejects(capture(50, 1, {}), (err) => err.code === "TAB_LEFT_FRONT");
  assert.equal(reads, 2, "checked before and after the capture");
});
