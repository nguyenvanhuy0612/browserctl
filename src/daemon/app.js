// @ts-check
// The daemon's core: browsers, sessions, tab events, DOM-lane calls, settle, and tool dispatch.
import { Browsers } from "./browsers.js";
import { CallLog } from "./calllog.js";
import { BctlError, toBctlError } from "./errors.js";
import { Registry } from "./registry.js";
import { DEFAULT_DIALOG_POLICY, Sessions, tabKey } from "./sessions.js";

/** @typedef {import("./sessions.js").TabRef} TabRef */
/** @typedef {import("./sessions.js").Session} Session */
/** @typedef {import("./browsers.js").Browser} Browser */

const RETRIABLE = new Set(["TARGET_NOT_FOUND", "TARGET_HIDDEN", "TARGET_DISABLED", "TARGET_COVERED", "TARGET_NOT_EDITABLE", "OPTION_NOT_FOUND"]);
const FRAME_REF = /^f(\d+)e\d+$/;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{name: string, data: any, at: number}} TabEvent */

export class Daemon {
  /** @param {{home: string, version: string, tools: any[], sessionIdleMs?: number}} options */
  constructor({ home, version, tools, sessionIdleMs }) {
    this.home = home;
    this.version = version;
    this.startedAt = Date.now();
    this.browsers = new Browsers({ home });
    this.sessions = new Sessions({ home, idleMs: sessionIdleMs });
    this.registry = new Registry(tools);
    this.callLog = new CallLog({ home });
    /** @type {Map<string, Set<(e: TabEvent) => void>>} */
    this.observers = new Map();
    /** @type {Map<string, any[]>} webRequest records per owned tab */
    this.requests = new Map();
    /** @type {Map<string, number>} */
    this.requestSeq = new Map();
    this.browsers.on("connected", (browser, info) => this.#onConnected(browser, info));
    this.browsers.on("event", (browser, name, data) => this.#onEvent(browser, name, data));
    this.sweeper = setInterval(() => {
      for (const id of this.sessions.expired()) this.endSession(id).catch(() => {});
    }, 60_000);
    this.sweeper.unref();
  }

  /** @param {Browser} browser @param {{restarted: boolean}} info */
  async #onConnected(browser, info) {
    const link = browser.link;
    if (!link) return;
    link.notify("welcome", { alias: browser.alias, version: this.version });
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
    void info;
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

    // A tab opened by an owned tab joins its session (specs/sessions.md). onCreatedNavigationTarget
    // names the source even for noopener links; openerTabId covers the rest.
    const source = name === "nav.createdTarget" ? data.sourceTabId : name === "tabs.created" ? data.openerTabId : undefined;
    if (typeof source === "number" && !this.sessions.ownerOf(browser.instanceId, tabId)) {
      const opener = this.sessions.ownerOf(browser.instanceId, source);
      if (opener) {
        const session = this.sessions.sessions.get(opener.sessionId);
        if (session) {
          this.sessions.own(session, browser.instanceId, tabId, "owned");
          this.groupTab(session, ref).catch(() => {});
        }
        this.#notify(tabKey(browser.instanceId, source), { name: "newTab", data: { tab: tabId, url: data.url }, at: Date.now() });
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

  /** Collects a tab's events from now until stopped. @param {TabRef} ref */
  observe(ref) {
    const key = tabKey(ref.instanceId, ref.tabId);
    /** @type {TabEvent[]} */
    const events = [];
    const fn = (/** @type {TabEvent} */ e) => events.push(e);
    if (!this.observers.has(key)) this.observers.set(key, new Set());
    /** @type {Set<any>} */ (this.observers.get(key)).add(fn);
    return {
      events,
      stop: () => this.observers.get(key)?.delete(fn),
    };
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
    const result = await this.linkOf(ref).request("dom.call", { tabId: ref.tabId, frameId, op, args: [args] }, timeoutMs);
    if (!result?.ok) throw toBctlError(result ?? { code: "INTERNAL_ERROR", message: "empty answer" });
    return result;
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
   * Polls an operation while it fails with a code that can change by itself (actionability).
   * @template T
   * @param {() => Promise<T>} fn
   * @param {number} [timeoutMs]
   * @returns {Promise<T>}
   */
  async retrying(fn, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        const e = toBctlError(error);
        if (!RETRIABLE.has(e.code) || Date.now() >= deadline) throw e;
        await sleep(100);
      }
    }
  }

  /** @param {TabRef} ref @param {object} policy @param {number} [frameId] */
  async armDialogs(ref, policy = DEFAULT_DIALOG_POLICY, frameId) {
    if (frameId === undefined) await this.domAll(ref, "armDialogs", policy);
    else await this.dom(ref, "armDialogs", policy, { frameId });
  }

  /** @param {Session} session @param {TabRef} ref */
  async groupTab(session, ref) {
    const link = this.linkOf(ref);
    const existing = session.groups[ref.instanceId];
    try {
      const { groupId } = await link.request("tabs.group", {
        tabIds: [ref.tabId],
        ...(existing !== undefined ? { groupId: existing } : { title: `agent ${session.client}`, color: session.color }),
      });
      session.groups[ref.instanceId] = groupId;
    } catch {
      // the group was closed by the user: start a new one
      const { groupId } = await link.request("tabs.group", { tabIds: [ref.tabId], title: `agent ${session.client}`, color: session.color });
      session.groups[ref.instanceId] = groupId;
    }
    this.sessions.persist();
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
      let last = -1;
      let stableSince = Date.now();
      const quietDeadline = started + (navigated ? 13_000 : 3000);
      for (;;) {
        let count;
        try {
          count = (await this.dom(ref, "info", {}, { timeoutMs: 3000 })).mutations;
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
  }

  // ---------- sessions ----------

  /** @param {string} sessionId */
  async endSession(sessionId) {
    const { tabs, session } = this.sessions.end(sessionId);
    const cdp = /** @type {any} */ (this).cdp;
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
   * @param {{sessionId: string, client: string}} who
   */
  async call(name, params, who) {
    const started = Date.now();
    const session = this.sessions.touch(who.sessionId, who.client);
    let response;
    try {
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
      const tool = this.registry.get(name);
      const valid = this.registry.validate(name, params ?? {});
      const result = await tool.handler(valid, { daemon: this, session });
      response = { ok: true, ...result };
    } catch (error) {
      response = { ok: false, error: toBctlError(error).toJSON() };
    }
    this.callLog.write({ who, session, name, params, response, ms: Date.now() - started });
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
