// @ts-check
// The daemon against fake extensions: browsers, sessions, the HTTP API, and the tools' parameter
// and error handling that need no page (specs/sessions.md, interface.md, tools/*.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { REF } from "../../src/daemon/targets.js";
import { Daemon } from "../../src/daemon/app.js";
import { mapPlaywrightError } from "../../src/daemon/cdp/lane.js";
import { sliceText } from "../../src/daemon/tools/read-tools.js";
import { connectFakeBrowser, startDaemon, until } from "./fake-browser.js";

/** @type {(() => Promise<void> | void)[]} */
const cleanup = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** @param {Parameters<typeof startDaemon>[0]} [options] */
async function daemon(options) {
  const d = await startDaemon(options);
  cleanup.push(() => d.close());
  return d;
}

/** @param {number} port @param {Parameters<typeof connectFakeBrowser>[1]} [options] */
async function browser(port, options) {
  const b = await connectFakeBrowser(port, options);
  cleanup.push(() => b.close());
  return b;
}

test("SES-U01 / SES-U03 / TABS-U03 two browsers keep their own aliases; tabs new without browser is ambiguous", async () => {
  const d = await daemon();
  await browser(d.port, { instanceId: "a" });
  await browser(d.port, { instanceId: "b" });
  await until(() => d.daemon.browsers.connected().length === 2);
  assert.deepEqual(d.daemon.browsers.connected().map((b) => b.alias).sort(), ["chrome-1", "chrome-2"]);
  const r = await d.call("tabs", { action: "new" });
  assert.equal(r.error.code, "AMBIGUOUS_BROWSER");
  assert.deepEqual([...r.error.browsers].sort(), ["chrome-1", "chrome-2"]);
});

test("SES-U02 a reconnect with the same instanceId replaces its socket and keeps the alias", async () => {
  const d = await daemon();
  const first = await browser(d.port, { instanceId: "same" });
  await until(() => d.daemon.browsers.connected().length === 1);
  const alias = d.daemon.browsers.connected()[0].alias;
  await browser(d.port, { instanceId: "same" });
  await until(() => first.socket.readyState === first.socket.CLOSED);
  assert.equal(d.daemon.browsers.connected().length, 1);
  assert.equal(d.daemon.browsers.connected()[0].alias, alias);
});

test("SES-U05 a tab a page opens joins the source tab's session, not the session of Chrome's openerTabId", async () => {
  const d = await daemon();
  const b = await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const source = (await d.call("tabs", { action: "new" }, "s1")).tab.tab;
  const active = (await d.call("tabs", { action: "new" }, "s2")).tab.tab;
  const popup = b.addTab({ openerTabId: active });
  b.emit("tabs.created", { tabId: popup.tabId, openerTabId: active, url: "" });
  b.emit("nav.createdTarget", { tabId: popup.tabId, sourceTabId: source, url: "about:blank" });
  await until(() => Boolean(d.daemon.sessions.ownerOf("fake-1", popup.tabId)));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.daemon.sessions.ownerOf("fake-1", popup.tabId)?.sessionId, "s1");
});

test("SES-U06 an idle session ends: debugger detached, tabs kept", async () => {
  const d = await daemon({ sessionIdleMs: 50 });
  const b = await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "idle")).tab.tab;
  await new Promise((r) => setTimeout(r, 80));
  await d.daemon.sweep();
  assert.equal(d.daemon.sessions.sessions.has("idle"), false);
  assert.ok(b.requests.some((r) => r.method === "debugger.detach" && r.params.tabId === tab));
  assert.ok(b.tabs.some((t) => t.tabId === tab), "tab kept");
});

test("SES-U10 heartbeats keep a session past the idle limit; without them it ends; an unknown session is not created", async () => {
  const d = await daemon({ sessionIdleMs: 150 });
  const beat = async (/** @type {string} */ id) => (await fetch(`http://127.0.0.1:${d.port}/v1/sessions/${id}/heartbeat`, { method: "POST" })).json();
  await d.call("status", {}, "hb");
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 70));
    assert.deepEqual(await beat("hb"), { ok: true, known: true });
    await d.daemon.sweep();
    assert.equal(d.daemon.sessions.sessions.has("hb"), true);
  }
  await new Promise((r) => setTimeout(r, 200));
  await d.daemon.sweep();
  assert.equal(d.daemon.sessions.sessions.has("hb"), false);
  assert.deepEqual(await beat("nobody"), { ok: true, known: false });
  assert.equal(d.daemon.sessions.sessions.has("nobody"), false);
});

test("SES-U11 another session's tab is refused with the holder and the take-over hint, on a tool and on adopt", async () => {
  const d = await daemon();
  await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "owner")).tab.tab;
  for (const r of [await d.call("click", { target: "#x", tab }, "other"), await d.call("tabs", { action: "adopt", tab }, "other")]) {
    assert.equal(r.error.code, "TAB_NOT_OWNED");
    assert.equal(r.error.holder, "owner");
    assert.match(r.error.hint, new RegExp(`tabs\\(\\{action: "adopt", tab: ${tab}, force: true\\}\\)`));
  }
  assert.equal((await d.call("tabs", { action: "adopt", tab, force: true }, "other")).current, tab);
});

test("SES-U12 actions on one tab run one at a time; a forced adopt waits for the action in flight", async () => {
  const d = await daemon();
  /** @type {{start: number, end: number}[]} */
  const clicks = [];
  await browser(d.port, {
    handlers: {
      "dom.call": async ({ tabId, op, allFrames }, b) => {
        if (op === "click") {
          const span = { start: Date.now(), end: 0 };
          clicks.push(span);
          await new Promise((r) => setTimeout(r, 150));
          span.end = Date.now();
          return { ok: true, resolved: {} };
        }
        const tab = b.tabs.find((t) => t.tabId === tabId);
        const result = op === "info" ? { ok: true, url: tab?.url, title: tab?.title, mutations: 0 } : op === "dialogLog" ? { ok: true, dialogs: [] } : { ok: true };
        return allFrames ? { frames: [{ frameId: 0, result }] } : result;
      },
    },
  });
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "a")).tab.tab;
  const [one, two] = await Promise.all([d.call("click", { target: "#x" }, "a"), d.call("click", { target: "#y" }, "a")]);
  assert.equal(one.ok && two.ok, true);
  assert.equal(clicks.length, 2);
  // the first click's settle (500 ms navigation watch + 300 ms quiet) ends before the second starts
  assert.ok(clicks[1].start - clicks[0].end >= 500, `second click started ${clicks[1].start - clicks[0].end} ms after the first ended`);

  /** @type {string[]} */
  const order = [];
  const acting = d.call("click", { target: "#x" }, "a").then(() => order.push("click"));
  await until(() => clicks.length === 3);
  const taking = d.call("tabs", { action: "adopt", tab, force: true }, "b").then((r) => order.push(r.ok ? "adopt" : "adopt failed"));
  await Promise.all([acting, taking]);
  assert.deepEqual(order, ["click", "adopt"]);
});

test("SES-U13 the current tab closed in the browser is TAB_CLOSED; navigate then opens a new tab", async () => {
  const d = await daemon();
  const b = await browser(d.port, {
    handlers: {
      "tabs.navigate": ({ tabId, url }, fake) => {
        for (const name of ["nav.beforeNavigate", "nav.domContentLoaded"]) fake.emit(name, { tabId, frameId: 0, url });
        return {};
      },
    },
  });
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "s")).tab.tab;
  b.tabs = b.tabs.filter((t) => t.tabId !== tab);
  b.emit("tabs.removed", { tabId: tab });
  await until(() => !d.daemon.sessions.ownerOf("fake-1", tab));
  assert.equal((await d.call("get", { target: "#x" }, "s")).error.code, "TAB_CLOSED");
  const opened = await d.call("navigate", { url: "about:blank" }, "s");
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.notEqual(opened.tab, tab);
  assert.equal(d.daemon.sessions.sessions.get("s")?.current?.tabId, opened.tab);
});

test("API-U07 a result names the tab it acted on; tabs keeps its own tab field", async () => {
  const d = await daemon();
  await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "s")).tab.tab;
  const got = await d.call("get", { target: "#x" }, "s");
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.tab, tab);
  const listed = await d.call("tabs", { action: "list" }, "s");
  assert.equal(listed.tab, undefined);
  assert.equal(typeof (await d.call("tabs", { action: "select", tab }, "s")).tab, "object");
});

test("API-U10 the daemon tells the extension which tabs to watch after every change of ownership", async () => {
  const d = await daemon();
  const b = await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const watched = () => b.events.filter((e) => e.event === "watch").map((e) => [...e.data.tabIds].sort());
  await until(() => watched().length === 1);
  assert.deepEqual(watched().at(-1), []);
  const one = (await d.call("tabs", { action: "new" }, "s")).tab.tab;
  await until(() => watched().some((ids) => ids.includes(one)));
  const two = (await d.call("tabs", { action: "new" }, "s")).tab.tab;
  await until(() => watched().some((ids) => ids.length === 2));
  await d.call("tabs", { action: "release", tab: one }, "s");
  await until(() => String(watched().at(-1)) === String([two]));
});

test("SES-U07 ownership survives a daemon restart through sessions.json", async () => {
  const first = await startDaemon();
  const b = await connectFakeBrowser(first.port);
  await until(() => first.daemon.browsers.connected().length === 1);
  const tab = (await first.call("tabs", { action: "new" }, "keep")).tab.tab;
  b.close();
  await first.close();
  const second = await daemon({ home: first.home });
  const again = await browser(second.port);
  again.tabs = b.tabs;
  await until(() => second.daemon.browsers.connected().length === 1);
  const list = await second.call("tabs", { action: "list" }, "keep");
  assert.ok(list.tabs.some((/** @type {any} */ t) => t.tab === tab && t.mine), JSON.stringify(list));
});

test("STAT-U01 no browser: browsers empty, setup names loading the extension", async () => {
  const d = await daemon();
  const r = await d.call("status");
  assert.deepEqual(r.browsers, []);
  assert.match(r.setup.join("\n"), /load the browserctl extension/);
});

test("STAT-U02 / STAT-U03 userScripts off is a setup step; allowDebugger clears a cancel", async () => {
  const d = await daemon();
  await browser(d.port, { userScripts: false });
  await until(() => d.daemon.browsers.connected().length === 1);
  d.daemon.browsers.connected()[0].debuggerCanceled = true;
  const before = await d.call("status");
  assert.equal(before.browsers[0].userScripts, false);
  assert.match(before.setup.join("\n"), /Allow User Scripts/);
  assert.equal(before.browsers[0].debuggerCanceled, true);
  const cleared = await d.call("status", { allowDebugger: true });
  assert.equal(cleared.browsers[0].debuggerCanceled, false);
});

test("TABS-U01 / TABS-U02 close needs a tab; each session sees only its own tabs as mine", async () => {
  const d = await daemon();
  await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  assert.equal((await d.call("tabs", { action: "close" })).error.code, "INVALID_PARAMS");
  const a = (await d.call("tabs", { action: "new" }, "a")).tab.tab;
  const b = (await d.call("tabs", { action: "new" }, "b")).tab.tab;
  const mine = async (/** @type {string} */ s) => (await d.call("tabs", { action: "list", all: true }, s)).tabs.filter((/** @type {any} */ t) => t.mine).map((/** @type {any} */ t) => t.tab);
  assert.deepEqual(await mine("a"), [a]);
  assert.deepEqual(await mine("b"), [b]);
});

test("CLICK-U01 refs and frame refs are told apart from selectors", () => {
  for (const ref of ["e5", "f1e7"]) assert.match(ref, REF);
  for (const selector of ["#save", "text=Save", "e5x", "role=button"]) assert.doesNotMatch(selector, REF);
  assert.equal(Daemon.frameOf("f1e7"), 1);
  assert.equal(Daemon.frameOf("e5"), 0);
  assert.equal(Daemon.frameOf("#save"), 0);
});

test("CLICK-U04 / API-U02 invalid click parameters are INVALID_PARAMS naming the valid ones", async () => {
  const d = await daemon();
  for (const params of [{ target: "#x", modifiers: ["Shift", "Shift"] }, { target: "#x", button: "back" }, { selector: "#x" }]) {
    const r = await d.call("click", params);
    assert.equal(r.error.code, "INVALID_PARAMS", JSON.stringify(params));
    assert.match(r.error.hint, /Valid parameters: target, button, doubleClick, modifiers, timeout, scroll, wait, trusted, tab\./);
  }
});

test("CLICK-U05 a tab another session owns is refused before the extension is asked", async () => {
  const d = await daemon();
  const b = await browser(d.port);
  await until(() => d.daemon.browsers.connected().length === 1);
  const tab = (await d.call("tabs", { action: "new" }, "owner")).tab.tab;
  const asked = b.requests.length;
  const r = await d.call("click", { target: "#x", tab }, "other");
  assert.equal(r.error.code, "TAB_NOT_OWNED");
  assert.ok(!b.requests.slice(asked).some((q) => q.method === "dom.call" || q.method.startsWith("debugger.")));
});

test("CLICK-U06 Playwright errors map to the public codes", () => {
  const cases = [
    ["locator.click: Error: strict mode violation: locator('button') resolved to 2 elements", "AMBIGUOUS_TARGET"],
    ["<div id=\"overlay\"></div> intercepts pointer events\nretrying click action", "TARGET_COVERED"],
    ["element is not enabled", "TARGET_DISABLED"],
    ["locator.click: Timeout 1500ms exceeded.\n  - element is inert", "TARGET_DISABLED"],
    ["element is not visible", "TARGET_HIDDEN"],
    ["Error: Element is not an <input>, <textarea> or [contenteditable] element", "TARGET_NOT_EDITABLE"],
    ["Target page, context or browser has been closed", "TAB_CLOSED"],
    ["Timeout 5000ms exceeded.", "TIMEOUT"],
  ];
  for (const [message, code] of cases) assert.equal(mapPlaywrightError(new Error(message)).code, code, message);
});

test("NAV-U01 / NAV-U02 navigate takes exactly one of url and action; a bare host gets https", async () => {
  const d = await daemon();
  const b = await browser(d.port, {
    handlers: {
      "tabs.navigate": ({ tabId, url }, fake) => {
        const tab = fake.tabs.find((t) => t.tabId === tabId);
        if (tab) tab.url = url;
        for (const name of ["nav.beforeNavigate", "nav.committed", "nav.domContentLoaded"]) fake.emit(name, { tabId, frameId: 0, url });
        return {};
      },
    },
  });
  await until(() => d.daemon.browsers.connected().length === 1);
  assert.equal((await d.call("navigate", { url: "https://a.test", action: "back" })).error.code, "INVALID_PARAMS");
  assert.equal((await d.call("navigate", {})).error.code, "INVALID_PARAMS");
  await d.call("navigate", { url: "example.com" });
  assert.equal(b.requests.find((r) => r.method === "tabs.navigate")?.params.url, "https://example.com");
});

test("READ-U01 slices end at a line boundary and the last one has no nextOffset", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const first = sliceText(text, 0, 100);
  assert.ok(first.text.endsWith("\n"));
  assert.equal(first.nextOffset, first.text.length);
  let offset = 0;
  let joined = "";
  for (;;) {
    const slice = sliceText(text, offset, 100);
    joined += slice.text;
    if (slice.nextOffset === null) break;
    offset = slice.nextOffset;
  }
  assert.equal(joined, text);
  assert.deepEqual(sliceText(text, text.length, 100), { text: "", nextOffset: null });
});

test("EVAL-U01 serialization: undefined, a node, a cycle, a 60 KB string whole, over 1 MB cut", async () => {
  const d = await daemon();
  await browser(d.port, { handlers: { "eval.user": async ({ code }) => ({ ok: true, value: await (0, eval)(code) }) } });
  await until(() => d.daemon.browsers.connected().length === 1);
  await d.call("tabs", { action: "new" });
  const undef = await d.call("evaluate", { function: "() => undefined" });
  assert.deepEqual([undef.value, undef.type], [null, "undefined"]);
  class FakeNode {
    nodeType = 1;
    outerHTML = `<p>${"x".repeat(400)}</p>`;
  }
  /** @type {any} */ (globalThis).Node = FakeNode;
  try {
    const node = await d.call("evaluate", { function: "() => new Node()" });
    assert.equal(node.type, "node");
    assert.equal(node.value.__type, "node");
    assert.ok(node.value.preview.length <= 301);
  } finally {
    delete (/** @type {any} */ (globalThis).Node);
  }
  const cycle = await d.call("evaluate", { function: "() => { const a = { name: 'a' }; a.self = a; return a; }" });
  assert.deepEqual(cycle.value, { name: "a", self: "[circular]" });
  const whole = await d.call("evaluate", { function: "() => 'y'.repeat(60 * 1024)" });
  assert.equal(whole.truncated, false);
  assert.equal(whole.value.length, 60 * 1024);
  const big = await d.call("evaluate", { function: "() => 'y'.repeat(1024 * 1024 + 10)" });
  assert.equal(big.truncated, true);
  assert.equal(big.value.length, 1024 * 1024);
});

test("API-U03 a browser speaking another protocol gets EXTENSION_OUTDATED", async () => {
  const d = await daemon();
  await browser(d.port, { protocol: 999 });
  await until(() => d.daemon.browsers.connected().length === 1);
  assert.equal((await d.call("tabs", { action: "new" })).error.code, "EXTENSION_OUTDATED");
});

test("API-U04 the call log records evaluate's code in full, with the browser alias", async () => {
  const d = await daemon();
  await browser(d.port, { handlers: { "eval.user": async ({ code }) => ({ ok: true, value: await (0, eval)(code) }) } });
  await until(() => d.daemon.browsers.connected().length === 1);
  await d.call("tabs", { action: "new" }, "logged");
  const code = `() => ${JSON.stringify("z".repeat(5000))}.length`;
  await d.call("evaluate", { function: code }, "logged");
  const lines = fs.readFileSync(path.join(d.home, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.tool === "evaluate");
  assert.equal(entry.params.function, code);
  assert.equal(entry.browser, "chrome-1");
  assert.equal(entry.session, "logged");
  assert.equal(entry.ok, true);
});

test("DOM-U01 a call that meets a document being replaced is repeated on the new one; a removed child frame is gone", async () => {
  const d = await daemon();
  let replaced = 0;
  await browser(d.port, {
    handlers: {
      "dom.call": ({ op, frameId }) => {
        if (op === "get" && replaced++ === 0) throw Object.assign(new Error("Frame with ID 0 was removed."), { code: "DOCUMENT_REPLACED" });
        if (op === "get" && frameId === 3) throw Object.assign(new Error("Frame with ID 3 was removed."), { code: "DOCUMENT_REPLACED" });
        return op === "get" ? { ok: true, value: "after", resolved: { ref: null, role: "button", name: "" }, cut: 0 } : { ok: true, url: "", title: "", mutations: 0, dialogs: [] };
      },
    },
  });
  await until(() => d.daemon.browsers.connected().length === 1);
  await d.call("tabs", { action: "new" });
  const r = await d.call("get", { target: "#x" });
  assert.equal(r.value, "after", JSON.stringify(r));
  assert.equal(replaced, 2);
  assert.equal((await d.call("get", { target: "f3e1" })).error.code, "REF_NOT_FOUND");
});
