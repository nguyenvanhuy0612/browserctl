// @ts-check
// The CDP relay and the attachments over a fake extension link (specs/relay.md, sessions.md).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Attachments } from "../../src/daemon/cdp/attachments.js";
import { CdpRelay } from "../../src/daemon/cdp/relay.js";
import { sleep, until } from "./fake-browser.js";

const TAB = 7;

/** A fake extension link: debugger.* requests answered by `cdp`, every request recorded. */
class FakeLink extends EventEmitter {
  /** @type {{method: string, params: any, at: number}[]} */
  sent = [];
  attaches = 0;
  /** @param {(method: string, params: any) => unknown} [cdp] */
  constructor(cdp = () => ({})) {
    super();
    this.cdp = cdp;
  }
  /** @param {string} method @param {any} params */
  async request(method, params) {
    this.sent.push({ method, params, at: Date.now() });
    if (method === "debugger.attach") {
      this.attaches++;
      return { targetInfo: { targetId: `T${params.tabId}`, type: "page", title: "", url: "about:blank", attached: true, browserContextId: "C", canAccessOpener: false } };
    }
    if (method === "debugger.send") return this.cdp(params.method, params.params);
    return {};
  }
  /** CDP methods sent to the tab, in order. */
  commands() {
    return this.sent.filter((s) => s.method === "debugger.send").map((s) => s.params.method);
  }
}

/** @param {FakeLink} link @param {number} [idleMs] */
function setup(link, idleMs = 0) {
  const browser = /** @type {any} */ ({ link, hello: { browser: { version: "158.0.0.0" } }, debuggerCanceled: false });
  const attachments = new Attachments(browser, { idleMs });
  const relay = new CdpRelay(attachments, { onCreateTarget: async () => TAB + 1 });
  return { browser, attachments, relay };
}

/** A raw client on the relay's in-process transport. @param {CdpRelay} relay */
function client(relay) {
  const transport = relay.transport();
  /** @type {any[]} */
  const received = [];
  let id = 0;
  transport.onmessage = (/** @type {any} */ m) => received.push(m);
  /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
  const send = async (method, params = {}, sessionId) => {
    const my = ++id;
    transport.send({ id: my, method, params, sessionId });
    await until(() => received.some((m) => m.id === my));
    return received.find((m) => m.id === my);
  };
  return { send, received };
}

/** Claims the tab and returns the client's session id on it. @param {CdpRelay} relay @param {ReturnType<typeof client>} c */
async function attachedSession(relay, c) {
  await relay.claim(TAB);
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return c.received.find((m) => m.method === "Target.attachedToTarget").params.sessionId;
}

const frameTree = { frameTree: { frame: { id: `T${TAB}`, loaderId: "L1", url: "about:blank", domainAndRegistry: "", securityOrigin: "://", mimeType: "text/html", secureContextType: "InsecureScheme", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } };

test("RLY-U01 Playwright connects through the relay and lists the claimed tab", async () => {
  const link = new FakeLink((method) => {
    if (method === "Page.getFrameTree") return frameTree;
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "1" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
    return {};
  });
  const { relay } = setup(link);
  const browser = await chromium.connectOverCDP(/** @type {any} */ (relay.transport()), { noDefaults: true });
  const context = browser.contexts()[0];
  const announced = context.waitForEvent("page", { timeout: 5000 });
  await relay.claim(TAB);
  const page = await announced;
  assert.equal(context.pages().length, 1);
  assert.equal(page.url(), "about:blank");
  relay.disconnect();
});

test("RLY-U02 Browser.close is answered by the relay and never forwarded", async () => {
  const link = new FakeLink();
  const { relay } = setup(link);
  const c = client(relay);
  await relay.claim(TAB);
  assert.deepEqual((await c.send("Browser.close")).result, {});
  assert.ok(!link.commands().includes("Browser.close"));
});

test("RLY-U03 after a detach the next command re-attaches and replays the journal in order, mapping script ids", async () => {
  let scripts = 0;
  const link = new FakeLink((method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: String(++scripts) } : {}));
  const { attachments, relay } = setup(link);
  const c = client(relay);
  const session = await attachedSession(relay, c);
  await c.send("Page.enable", {}, session);
  const added = await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "1" }, session);
  await c.send("Emulation.setEmulatedMedia", { media: "print" }, session);
  await attachments.softDetach(TAB);
  const before = link.commands().length;
  await c.send("Runtime.evaluate", { expression: "1" }, session);
  assert.equal(link.attaches, 2);
  assert.deepEqual(link.commands().slice(before), [
    "Emulation.setFocusEmulationEnabled",
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Emulation.setEmulatedMedia",
    "Runtime.evaluate",
  ]);
  assert.ok(c.received.some((m) => m.method === "Runtime.executionContextsCleared" && m.sessionId === session));
  await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.result.identifier }, session);
  const removed = link.sent.findLast((s) => s.params?.method === "Page.removeScriptToEvaluateOnNewDocument");
  assert.equal(removed?.params.params.identifier, "2");
});

test("RLY-U04 Runtime.enable and Page.setLifecycleEventsEnabled wait for a Page.getFrameTree in flight on the same session", async () => {
  for (const method of ["Runtime.enable", "Page.setLifecycleEventsEnabled"]) {
    /** @type {number} */
    let treeAnswered = 0;
    const link = new FakeLink(async (sent) => {
      if (sent !== "Page.getFrameTree") return {};
      await sleep(100);
      treeAnswered = Date.now();
      return frameTree;
    });
    const { relay } = setup(link);
    const c = client(relay);
    const session = await attachedSession(relay, c);
    const tree = c.send("Page.getFrameTree", {}, session);
    await c.send(method, method === "Runtime.enable" ? {} : { enabled: true }, session);
    await tree;
    const enable = link.sent.find((s) => s.params?.method === method);
    assert.ok(enable && enable.at >= treeAnswered, `${method} went out after the frame tree came back`);
  }
});

test("RLY-U05 / SES-U09 canceled_by_user drops every target, raises the event and refuses new attaches", async () => {
  const link = new FakeLink();
  const { browser, attachments, relay } = setup(link);
  const c = client(relay);
  await attachedSession(relay, c);
  let canceled = false;
  attachments.on("canceled", () => (canceled = true));
  link.emit("debugger.detached", { tabId: TAB, reason: "canceled_by_user" });
  assert.equal(canceled, true);
  assert.equal(browser.debuggerCanceled, true);
  assert.equal(relay.claimed(TAB), false);
  assert.ok(c.received.some((m) => m.method === "Target.detachedFromTarget"));
  await assert.rejects(attachments.ensure(TAB), { code: "DEBUGGER_CANCELED" });
});

test("SES-U08 a pinned tab is not detached when idle; unpinning starts the idle timer", async () => {
  const link = new FakeLink();
  const { attachments } = setup(link, 50);
  await attachments.ensure(TAB);
  attachments.pin(TAB, "network");
  await sleep(120);
  assert.ok(!link.sent.some((s) => s.method === "debugger.detach"), "kept while pinned");
  attachments.unpin(TAB, "network");
  await until(() => link.sent.some((s) => s.method === "debugger.detach"), 1000);
});

/**
 * A fake link whose tab reports an execution context on the first Runtime.enable of each attach
 * (and again after a Runtime.disable), as Chrome does.
 */
function chromeLikeLink() {
  let generation = 0;
  /** @type {Set<string>} */
  let enabled = new Set();
  const link = new FakeLink((method, params) => {
    const session = params?.sessionId ?? "";
    if (method === "Runtime.enable" && !enabled.has(session)) {
      enabled.add(session);
      setImmediate(() => link.emit("debugger.event", { tabId: TAB, method: "Runtime.executionContextCreated", params: { context: { id: generation * 10 + 1, uniqueId: `u${generation}`, origin: "", name: "", auxData: { isDefault: true, frameId: `T${TAB}` } } } }));
    }
    if (method === "Runtime.disable") enabled.delete(session);
    return {};
  });
  const request = link.request.bind(link);
  link.request = async (method, params) => {
    if (method === "debugger.attach") {
      generation++;
      enabled = new Set();
    }
    return request(method, params);
  };
  return link;
}

/** Contexts the client got. @param {ReturnType<typeof client>} c @param {string} session */
const contextsOf = (c, session) => c.received.filter((m) => m.method === "Runtime.executionContextCreated" && m.sessionId === session).map((m) => m.params.context.id);

test("RLY-U06 a later client gets the live contexts, also after a detach and the first client's replay", async () => {
  const link = chromeLikeLink();
  const { attachments, relay: first } = setup(link);
  const second = new CdpRelay(attachments, { onCreateTarget: async () => TAB + 1 });
  const a = client(first);
  const b = client(second);
  const sa = await attachedSession(first, a);
  await a.send("Runtime.enable", {}, sa);
  await until(() => contextsOf(a, sa).length === 1);
  const sb = await attachedSession(second, b);
  await b.send("Runtime.enable", {}, sb);
  assert.deepEqual(contextsOf(b, sb), [11]);
  await attachments.softDetach(TAB);
  await a.send("Page.enable", {}, sa); // re-attach: the first client's journal is replayed
  await until(() => contextsOf(a, sa).includes(21));
  const third = new CdpRelay(attachments, { onCreateTarget: async () => TAB + 1 });
  const c = client(third);
  const sc = await attachedSession(third, c);
  await c.send("Runtime.enable", {}, sc);
  assert.deepEqual(contextsOf(c, sc), [21]);
  assert.deepEqual(contextsOf(b, sb), [11, 21]);
});

test("RLY-U07 a domain is disabled only when no relay uses it; a re-enabled Runtime reports each context once", async () => {
  const link = chromeLikeLink();
  const { attachments, relay: first } = setup(link);
  const second = new CdpRelay(attachments, { onCreateTarget: async () => TAB + 1 });
  const a = client(first);
  const b = client(second);
  const sa = await attachedSession(first, a);
  const sb = await attachedSession(second, b);
  await a.send("Network.enable", {}, sa);
  await b.send("Network.enable", {}, sb);
  await b.send("Network.disable", {}, sb);
  assert.ok(!link.commands().includes("Network.disable"), "the other relay still uses Network");
  await a.send("Network.disable", {}, sa);
  assert.ok(link.commands().includes("Network.disable"));
  await a.send("Runtime.enable", {}, sa);
  await a.send("Runtime.disable", {}, sa);
  await a.send("Runtime.enable", {}, sa);
  await sleep(20);
  assert.deepEqual(contextsOf(a, sa), [11, 11]);
});

test("RLY-U08 domain events reach only the relay that used the domain, on the tab's and on a child frame's session", async () => {
  const link = new FakeLink();
  const { attachments, relay: first } = setup(link);
  const second = new CdpRelay(attachments, { onCreateTarget: async () => TAB + 1 });
  const a = client(first);
  const b = client(second);
  const sa = await attachedSession(first, a);
  await attachedSession(second, b);
  await a.send("Fetch.enable", {}, sa);
  link.emit("debugger.event", { tabId: TAB, method: "Fetch.requestPaused", params: { requestId: "main" } });
  link.emit("debugger.event", { tabId: TAB, method: "Target.attachedToTarget", params: { sessionId: "child", targetInfo: { targetId: "C", type: "iframe" } } });
  await a.send("Fetch.enable", {}, "child");
  link.emit("debugger.event", { tabId: TAB, sessionId: "child", method: "Fetch.requestPaused", params: { requestId: "child" } });
  await sleep(20);
  const paused = (/** @type {ReturnType<typeof client>} */ c) => c.received.filter((m) => m.method === "Fetch.requestPaused").map((m) => m.params.requestId);
  assert.deepEqual(paused(a), ["main", "child"]);
  assert.deepEqual(paused(b), []);
});
