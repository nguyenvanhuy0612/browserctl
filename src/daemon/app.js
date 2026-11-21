// @ts-check
// The daemon's core: browsers, sessions, tab events, DOM-lane calls, settle, and tool dispatch.
import { AsyncLocalStorage } from "node:async_hooks";
import { Browsers } from "./browsers.js";
import { CallLog } from "./calllog.js";
import { BctlError, toBctlError } from "./errors.js";
import { toSelector } from "./targets.js";
import { Registry } from "./registry.js";
import { DEFAULT_DIALOG_POLICY, Sessions, tabKey } from "./sessions.js";

/** @typedef {import("./sessions.js").TabRef} TabRef */
/** @typedef {import("./sessions.js").Session} Session */
/** @typedef {import("./browsers.js").Browser} Browser */

const RETRIABLE = new Set(["TARGET_NOT_FOUND", "TARGET_HIDDEN", "TARGET_DISABLED", "TARGET_COVERED", "TARGET_NOT_EDITABLE", "OPTION_NOT_FOUND"]);
const FRAME_REF = /^f(\d+)e\d+$/;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{name: string, data: any, at: number}} TabEvent */

/** The tool call in progress, so the tab it resolves can be named in its result (specs/interface.md). */
const currentCall = /** @type {AsyncLocalStorage<{tab: number | null}>} */ (new AsyncLocalStorage());

export class Daemon {
  /**
   * The CDP lane, set by whoever starts the daemon (main.js, the live harness); unit tests without
   * a browser leave it null.
   * @type {import("./cdp/lane.js").CdpLane | null}
   */
  cdp = null;
  /** The HTTP port, set once the server listens (a run worker connects back to it). */
  port = 0;

  /** @param {{home: string, version: string, tools: any[], sessionIdleMs?: number}} options */
  constructor({ home, version, tools, sessionIdleMs }) {
    this.home = home;
    this.version = version;
    this.startedAt = Date.now();
    this.browsers = new Browsers({ home });
    this.sessions = new Sessions({ home, idleMs: sessionIdleMs, onChange: () => this.#sendWatch() });
    this.registry = new Registry(tools);
    this.callLog = new CallLog({ home });
    /** @type {Map<string, Set<(e: TabEvent) => void>>} */
    this.observers = new Map();
    /** @type {Map<string, any[]>} webRequest records per owned tab */
    this.requests = new Map();
    /** @type {Map<string, number>} */
    this.requestSeq = new Map();
    this.browsers.on("connected", (browser) => this.#onConnected(browser));
    this.browsers.on("event", (browser, name, data) => this.#onEvent(browser, name, data));
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Ends the sessions idle past the limit (specs/sessions.md). */
  async sweep() {
    for (const id of this.sessions.expired()) await this.endSession(id).catch(() => {});
  }

  /** The tab ids last sent to each extension link as `watch`. @type {WeakMap<object, string>} */
  #watched = new WeakMap();

  /**
   * Tells each browser which of its tabs some session owns, when that changed: the extension sends
   * network events for those tabs only (specs/interface.md).
   */
  #sendWatch() {
    for (const browser of this.browsers.connected()) {
      const link = /** @type {import("./link.js").ExtensionLink} */ (browser.link);
      const tabIds = [...this.sessions.owners.keys()].filter((key) => key.startsWith(`${browser.instanceId}:`)).map((key) => Number(key.slice(key.lastIndexOf(":") + 1)));
      const sent = tabIds.sort((a, b) => a - b).join();
      if (this.#watched.get(link) === sent) continue;
      this.#watched.set(link, sent);
      link.notify("watch", { tabIds });
    }
  }

  /** @param {Browser} browser */
  async #onConnected(browser) {
    const link = browser.link;
    if (!link) return;
    link.notify("welcome", { alias: browser.alias, version: this.version });
    this.#sendWatch();
    // Ownership of tabs this browser no longer has is dropped (specs/sessions.md).
    try {
      const { tabs } = await link.request("tabs.list");
      const alive = new Set(tabs.map((/** @type {any} */ t) => t.tabId));
      this.knownTabs.set(browser.instanceId, alive);
      for (const key of [...this.sessions.owners.keys()]) {
        if (!key.startsWith(`${browser.instanceId}:`)) continue;
        const tabId = Number(key.slice(key.lastIndexOf(":") + 1));
        if (!alive.has(tabId)) this.sessions.tabClosed(browser.instanceId, tabId);
      }
    } catch {
      // the next call reconciles
    }
    // Nothing tracks an attachment across a daemon restart: drop every one (specs/sessions.md).
    try {
      const { tabIds } = await link.request("debugger.list");
      for (const tabId of tabIds) await link.request("debugger.detach", { tabId }).catch(() => {});
    } catch {
      // an older extension or a closing socket
    }
    for (const [key, owner] of this.sessions.owners) {
      if (!key.startsWith(`${browser.instanceId}:`)) continue;
      const tabId = Number(key.slice(key.lastIndexOf(":") + 1));
      this.armDialogs({ instanceId: browser.instanceId, tabId }, owner.dialogPolicy).catch(() => {});
    }
  }

  /** @param {Browser} browser @param {string} name @param {any} data */
  #onEvent(browser, name, data) {
    const tabId = data?.tabId;
    if (typeof tabId !== "number") return;
    const ref = { instanceId: browser.instanceId, tabId };
    const key = tabKey(browser.instanceId, tabId);

    // A tab a page in an owned tab opens joins that tab's session (specs/sessions.md). Only
    // onCreatedNavigationTarget names the source; tabs.onCreated's openerTabId is the window's
    // active tab.
    if (name === "nav.createdTarget" && !this.sessions.ownerOf(browser.instanceId, tabId)) {
      const opener = this.sessions.ownerOf(browser.instanceId, data.sourceTabId);
      const session = opener && this.sessions.sessions.get(opener.sessionId);
      if (session) {
        this.sessions.own(session, browser.instanceId, tabId, "owned");
        this.#notify(tabKey(browser.instanceId, data.sourceTabId), { name: "newTab", data: { tab: tabId, url: data.url }, at: Date.now() });
        this.#keepUserView(browser, tabId).catch(() => {});
      }
    }
    if (name === "tabs.removed") {
      this.sessions.tabClosed(browser.instanceId, tabId);
      this.requests.delete(key);
    }
    const owner = this.sessions.ownerOf(browser.instanceId, tabId);
    if (!owner) return;
    if (name === "net.request") this.#recordRequest(key, data);
    if (name === "nav.domContentLoaded") this.armDialogs(ref, owner.dialogPolicy, data.frameId).catch(() => {});
    this.#notify(key, { name, data, at: Date.now() });
  }

  /**
   * A tab a page opened must not take the user's view: if Chrome made it active, activate again the
   * tab that was active before, which Chrome gives as its openerTabId (specs/sessions.md).
   * @param {Browser} browser @param {number} tabId
   */
  async #keepUserView(browser, tabId) {
    const link = Browsers.usable(browser);
    const tab = await link.request("tabs.get", { tabId });
    if (tab.active && typeof tab.openerTabId === "number" && tab.openerTabId !== tabId) await link.request("tabs.activate", { tabId: tab.openerTabId });
  }

  /** @param {string} key @param {any} data */
  #recordRequest(key, data) {
    let list = this.requests.get(key);
    if (!list) this.requests.set(key, (list = []));
    if (data.phase === "send") {
      const id = (this.requestSeq.get(key) ?? 0) + 1;
      this.requestSeq.set(key, id);
      list.push({ id, requestId: data.requestId, method: data.method, url: data.url, type: data.type, startedAt: data.at, requestHeaders: data.requestHeaders, status: null, ms: null });
      if (list.length > 1000) list.shift();
      return;
    }
    const entry = list.findLast((r) => r.requestId === data.requestId);
    if (!entry) return;
    entry.ms = Math.round(data.at - entry.startedAt);
    if (data.phase === "done") {
      entry.status = data.status;
      entry.responseHeaders = data.responseHeaders;
      entry.fromCache = data.fromCache;
    } else entry.error = data.error;
  }

  /** @param {string} key @param {TabEvent} event */
  #notify(key, event) {
    for (const fn of this.observers.get(key) ?? []) fn(event);
  }

  /**
   * Calls `fn` with each of a tab's events from now on; returns the function that stops it.
   * @param {TabRef} ref @param {(e: TabEvent) => void} fn
   */
  onTabEvent(ref, fn) {
    const key = tabKey(ref.instanceId, ref.tabId);
    if (!this.observers.has(key)) this.observers.set(key, new Set());
    /** @type {Set<any>} */ (this.observers.get(key)).add(fn);
    return () => {
      this.observers.get(key)?.delete(fn);
    };
  }

  /** Collects a tab's events from now until stopped. @param {TabRef} ref */
  observe(ref) {
    /** @type {TabEvent[]} */
    const events = [];
    return { events, stop: this.onTabEvent(ref, (e) => events.push(e)) };
  }

  // ---------- browser access ----------

  /** @param {TabRef} ref */
  browserOf(ref) {
    const browser = this.browsers.byId(ref.instanceId);
    if (!browser) throw new BctlError("NO_BROWSER", "the tab's browser is not connected");
    return browser;
  }

  /** @param {TabRef} ref */
  linkOf(ref) {
    return Browsers.usable(this.browserOf(ref));
  }

  /**
   * Runs a DOM-lane runtime operation.
   * @param {TabRef} ref
   * @param {string} op
   * @param {object} [args]
   * @param {{frameId?: number, timeoutMs?: number}} [options]
   */
  async dom(ref, op, args = {}, { frameId = 0, timeoutMs = 10_000 } = {}) {
    // locator forms Playwright has no engine for are rewritten here, for both lanes (specs/targets.md)
    const original = /** @type {any} */ (args).target;
    const selector = typeof original === "string" ? toSelector(original) : original;
    const sent = selector === original ? args : { ...args, target: selector };
    const result = await this.#domCall(ref, { tabId: ref.tabId, frameId, op, args: [sent] }, timeoutMs);
    if (!result?.ok) {
      const failure = result ?? { code: "INTERNAL_ERROR", message: "empty answer" };
      if (selector !== original && typeof failure.message === "string") failure.message = failure.message.split(selector).join(original);
      throw toBctlError(failure);
    }
    return result;
  }

  /**
   * One dom.call. A main-frame document being replaced (a navigation) is waited out, repeating the
   * call on the new document every 100 ms for at most 2 s (specs/dom-lane.md).
   * @param {TabRef} ref @param {object} params @param {number} timeoutMs
   */
  async #domCall(ref, params, timeoutMs) {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        return await this.linkOf(ref).request("dom.call", params, timeoutMs);
      } catch (error) {
        const e = toBctlError(error);
        if (e.cause !== "DOCUMENT_REPLACED" || /** @type {any} */ (params).frameId !== 0) throw e;
        if (Date.now() >= deadline) throw new BctlError("TIMEOUT", "the page kept replacing its document for 2 s");
        await sleep(100);
      }
    }
  }

  /** @param {TabRef} ref @param {string} op @param {object} [args] */
  async domAll(ref, op, args = {}) {
    const { frames } = await this.linkOf(ref).request("dom.call", { tabId: ref.tabId, allFrames: true, op, args: [args] });
    return /** @type {{frameId: number, result: any}[]} */ (frames);
  }

  /** The frame a target lives in: frame refs carry it, everything else is the main frame. @param {string | undefined} target */
  static frameOf(target) {
    const match = target ? FRAME_REF.exec(target) : null;
    return match ? Number(match[1]) : 0;
  }

  /**
   * Polls an operation while it fails with a code that can change by itself (actionability). The
   * attempt number lets the runtime scroll differently on a retry (specs/tools/click.md).
   * @template T
   * @param {(attempt: number) => Promise<T>} fn
   * @param {number} [timeoutMs]
   * @returns {Promise<T>}
   */
  async retrying(fn, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        const e = toBctlError(error);
        if (!RETRIABLE.has(e.code)) throw e;
        if (Date.now() >= deadline) {
          // name the timeout when the daemon really waited (specs/actions.md)
          if (attempt > 1) e.message = `${e.message} (gave up after ${timeoutMs / 1000} s; raise timeout to wait longer)`;
          throw e;
        }
        await sleep(100);
      }
    }
  }

  /** @param {TabRef} ref @param {object} policy @param {number} [frameId] */
  async armDialogs(ref, policy = DEFAULT_DIALOG_POLICY, frameId) {
    if (frameId === undefined) await this.domAll(ref, "armDialogs", policy);
    else await this.dom(ref, "armDialogs", policy, { frameId });
  }

  // ---------- settle (specs/settle.md) ----------

  /** @param {TabRef} ref */
  async pageState(ref) {
    const info = await this.dom(ref, "info");
    const { dialogs } = await this.dom(ref, "dialogLog", { since: 0 });
    return { url: info.url, title: info.title, mutations: info.mutations, dialogSeq: dialogs.reduce((/** @type {number} */ m, /** @type {any} */ d) => Math.max(m, d.seq), 0), visibility: info.visibility };
  }

  /**
   * Waits for the page to react to an action and reports what changed.
   * @param {TabRef} ref
   * @param {{url: string, title: string, mutations: number, dialogSeq: number}} before
   * @param {{events: TabEvent[], stop: () => void}} observer
   */
  async settle(ref, before, observer) {
    const started = Date.now();
    let settled = true;
    let navigated = false;
    try {
      const navStart = () => observer.events.find((e) => e.name === "nav.beforeNavigate" && e.data.frameId === 0);
      while (Date.now() - started < 500 && !navStart()) await sleep(50);
      if (navStart()) {
        navigated = true;
        const deadline = Date.now() + 10_000;
        const done = () => observer.events.find((e) => (e.name === "nav.domContentLoaded" || e.name === "nav.error") && e.data.frameId === 0);
        while (!done() && Date.now() < deadline) await sleep(50);
        if (!done()) settled = false;
      }
      // attribute changes do not break the quiet: animations make them all the time (specs/settle.md)
      let last = -1;
      let stableSince = Date.now();
      const quietDeadline = started + (navigated ? 13_000 : 3000);
      for (;;) {
        let count;
        try {
          count = (await this.dom(ref, "info", {}, { timeoutMs: 3000 })).content;
        } catch (error) {
          if (toBctlError(error).code === "TAB_CLOSED") throw error;
          count = last;
        }
        if (count !== last) {
          last = count;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= 300) break;
        if (Date.now() >= quietDeadline) {
          settled = false;
          break;
        }
        await sleep(100);
      }
    } finally {
      observer.stop();
    }
    const after = await this.pageState(ref).catch(() => null);
    const { dialogs } = after ? await this.dom(ref, "dialogLog", { since: navigated ? 0 : before.dialogSeq }) : { dialogs: [] };
    // A policy set for the next dialog only goes back to the default once one was answered.
    const owner = this.sessions.ownerOf(ref.instanceId, ref.tabId);
    if (dialogs.length && owner && /** @type {any} */ (owner.dialogPolicy).scope === "next") {
      owner.dialogPolicy = { ...DEFAULT_DIALOG_POLICY };
      this.sessions.persist();
    }
    return {
      urlChanged: (after?.url ?? before.url) !== before.url,
      url: after?.url ?? before.url,
      title: after?.title ?? before.title,
      newTabs: observer.events.filter((e) => e.name === "newTab").map((e) => e.data),
      dialogs: dialogs.map((/** @type {any} */ d) => ({ type: d.type, message: d.message, answer: d.answer })),
      domChanged: navigated || (after ? after.mutations !== before.mutations : true),
      settled,
    };
  }

  /**
   * Runs a page action with settle around it.
   * @param {TabRef} ref
   * @param {() => Promise<any>} action
   */
  async act(ref, action) {
    return this.#inTurn(ref, async () => {
      const before = await this.pageState(ref);
      const observer = this.observe(ref);
      let result;
      try {
        result = await action();
      } catch (error) {
        observer.stop();
        throw error;
      }
      const outcome = await this.settle(ref, before, observer);
      return { result, outcome };
    });
  }

  /** @type {Map<string, Promise<void>>} per tab, settles when the last action queued on it has ended */
  #acting = new Map();

  /**
   * Actions on one tab run one at a time, each after the previous one ended (specs/sessions.md).
   * @template T
   * @param {TabRef} ref
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #inTurn(ref, fn) {
    const key = tabKey(ref.instanceId, ref.tabId);
    const run = (this.#acting.get(key) ?? Promise.resolve()).then(fn);
    const ended = run.then(
      () => {},
      () => {},
    );
    this.#acting.set(key, ended);
    try {
      return await run;
    } finally {
      if (this.#acting.get(key) === ended) this.#acting.delete(key);
    }
  }

  /** Resolves when the tab has no action in flight, or after maxMs. @param {TabRef} ref @param {number} maxMs */
  async actionEnded(ref, maxMs) {
    const running = this.#acting.get(tabKey(ref.instanceId, ref.tabId));
    if (running) await Promise.race([running, sleep(maxMs)]);
  }

  // ---------- sessions ----------

  /** @param {string} sessionId */
  async endSession(sessionId) {
    const { tabs, session } = this.sessions.end(sessionId);
    const cdp = this.cdp;
    cdp?.endSession(sessionId);
    for (const t of tabs) {
      const browser = this.browsers.byId(t.instanceId);
      if (!browser?.link) continue;
      if (cdp) await cdp.detach(t).catch(() => {});
      else await browser.link.request("debugger.detach", { tabId: t.tabId }).catch(() => {});
      if (session?.closeTabsOnEnd && t.kind === "owned") await browser.link.request("tabs.close", { tabId: t.tabId }).catch(() => {});
    }
    return { ended: Boolean(session), tabs: tabs.length };
  }

  /**
   * Validates and runs one tool call (specs/interface.md).
   * @param {string} name
   * @param {unknown} params
   * @param {{sessionId: string, client: string, closeTabsOnEnd?: boolean}} who
   */
  async call(name, params, who) {
    const started = Date.now();
    const session = this.sessions.touch(who.sessionId, who.client, { closeTabsOnEnd: who.closeTabsOnEnd });
    const context = { tab: /** @type {number | null} */ (null) };
    let response;
    this.sessions.begin(session.id);
    try {
      const tool = this.registry.get(name);
      const valid = this.registry.validate(name, params ?? {});
      // Right after the daemon starts, extensions are still reconnecting (they retry every 2 s).
      if (this.browsers.connected().length === 0 && Date.now() - this.startedAt < 40_000 && name !== "status") {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          this.browsers.once("connected", () => {
            clearTimeout(timer);
            setTimeout(resolve, 200);
          });
        });
      }
      const result = await currentCall.run(context, () => tool.handler(valid, { daemon: this, session }));
      // the tab acted on, unless the tool names it itself (specs/interface.md)
      response = { ok: true, ...(context.tab !== null && { tab: context.tab }), ...result };
    } catch (error) {
      response = { ok: false, error: toBctlError(error).toJSON() };
    } finally {
      this.sessions.finish(session.id);
    }
    const browser = session.current ? (this.browsers.byId(session.current.instanceId)?.alias ?? null) : null;
    this.callLog.write({ who, session, browser, name, params, response, ms: Date.now() - started });
    return response;
  }

  /**
   * The tab a call acts on, with its browser checked.
   * @param {Session} session
   * @param {number | undefined} tab
   */
  async tab(session, tab) {
    if (tab !== undefined && !this.sessions.tabsOf(session.id).some((t) => t.tabId === tab)) await this.refreshKnownTabs();
    const connected = this.browsers.connected();
    const ref = this.sessions.resolveTab(session, tab, () => connected.map((b) => b.instanceId).filter((id) => tab !== undefined && this.#hasTab(id, tab)));
    this.linkOf(ref);
    const call = currentCall.getStore();
    if (call) call.tab = ref.tabId;
    return ref;
  }

  /** @type {Map<string, Set<number>>} */
  knownTabs = new Map();

  /** @param {string} instanceId @param {number} tabId */
  #hasTab(instanceId, tabId) {
    return this.knownTabs.get(instanceId)?.has(tabId) ?? false;
  }

  /** Refreshes the tab ids each connected browser has (used to resolve a bare tab id). */
  async refreshKnownTabs() {
    for (const browser of this.browsers.connected()) {
      try {
        const { tabs } = await /** @type {any} */ (browser.link).request("tabs.list");
        this.knownTabs.set(browser.instanceId, new Set(tabs.map((/** @type {any} */ t) => t.tabId)));
      } catch {
        // keep the previous list
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
  }
}
