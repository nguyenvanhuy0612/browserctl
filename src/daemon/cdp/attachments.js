// @ts-check
// chrome.debugger attachments of one browser: attach on demand, sliding idle detach, pins, and
// restoring every relay's state after a re-attach (specs/relay.md, specs/sessions.md).
import { EventEmitter } from "node:events";
import { BctlError, toBctlError } from "../errors.js";

/**
 * @typedef {{
 *   attached: boolean,
 *   attaching: Promise<void> | null,
 *   ever: boolean,
 *   info: any,
 *   idleTimer: NodeJS.Timeout | null,
 *   idleUntil: number,
 *   pins: Set<string>,
 *   relays: Set<import("./relay.js").CdpRelay>,
 * }} TabAttachment
 */

export class Attachments extends EventEmitter {
  /** @type {Map<number, TabAttachment>} */
  #tabs = new Map();
  #link;
  #idleMs;
  #browser;

  /**
   * @param {import("../browsers.js").Browser} browser
   * @param {{idleMs: number}} options
   */
  constructor(browser, { idleMs }) {
    super();
    this.#browser = browser;
    this.#link = /** @type {import("../link.js").ExtensionLink} */ (browser.link);
    this.#idleMs = idleMs;
    this.#link.on("debugger.event", (e) => this.#onEvent(e));
    this.#link.on("debugger.detached", (e) => this.#onDetached(e));
    this.#link.on("tabs.removed", ({ tabId }) => this.#dropTab(tabId));
  }

  get link() {
    return this.#link;
  }

  browserHello() {
    return this.#browser.hello;
  }

  /** @param {number} tabId */
  #entry(tabId) {
    let entry = this.#tabs.get(tabId);
    if (!entry) {
      entry = { attached: false, attaching: null, ever: false, info: null, idleTimer: null, idleUntil: 0, pins: new Set(), relays: new Set() };
      this.#tabs.set(tabId, entry);
    }
    return entry;
  }

  /** @param {number} tabId */
  info(tabId) {
    return this.#tabs.get(tabId)?.info;
  }

  /** @param {number} tabId @param {import("./relay.js").CdpRelay} relay */
  addRelay(tabId, relay) {
    this.#entry(tabId).relays.add(relay);
  }

  /** @param {number} tabId @param {import("./relay.js").CdpRelay} relay */
  removeRelay(tabId, relay) {
    this.#tabs.get(tabId)?.relays.delete(relay);
  }

  /**
   * Attaches if needed. A re-attach makes every relay on the tab reset its client's contexts and
   * replay its journal before anything else is sent.
   * @param {number} tabId
   */
  async ensure(tabId) {
    if (this.#browser.debuggerCanceled) {
      throw new BctlError("DEBUGGER_CANCELED", "the user pressed Cancel on Chrome's debugging bar in this browser");
    }
    const entry = this.#entry(tabId);
    if (entry.attached) {
      this.touch(tabId);
      return;
    }
    if (!entry.attaching) {
      entry.attaching = (async () => {
        const { targetInfo } = await this.#attachFresh(tabId);
        entry.info = targetInfo;
        entry.attached = true;
        // Background tabs do not render without it; harmless for a foreground tab.
        await this.#raw(tabId, undefined, "Emulation.setFocusEmulationEnabled", { enabled: true });
        if (entry.ever) for (const relay of entry.relays) await relay.restore(tabId);
        entry.ever = true;
      })().finally(() => {
        entry.attaching = null;
      });
    }
    await entry.attaching;
    this.touch(tabId);
  }

  /** @param {number} tabId */
  async #attachFresh(tabId) {
    try {
      return await this.#link.request("debugger.attach", { tabId });
    } catch (error) {
      const e = toBctlError(error);
      if (e.code !== "DEBUGGER_BUSY") throw e;
      // Our own attachment from an earlier daemon run looks the same as another client's: drop ours
      // and try once more; a second refusal is another debugger.
      await this.#link.request("debugger.detach", { tabId }).catch(() => {});
      return this.#link.request("debugger.attach", { tabId });
    }
  }

  /** @param {number} tabId @param {string | undefined} sessionId @param {string} method @param {object} [params] */
  #raw(tabId, sessionId, method, params) {
    return this.#link.request("debugger.send", { tabId, sessionId, method, params }, 30_000);
  }

  /**
   * Sends a command, re-attaching once if the attachment disappeared underneath.
   * @param {number} tabId @param {string | undefined} sessionId @param {string} method @param {object} [params]
   */
  async send(tabId, sessionId, method, params) {
    await this.ensure(tabId);
    try {
      return await this.#raw(tabId, sessionId, method, params);
    } catch (error) {
      const e = /** @type {any} */ (error);
      if (sessionId || !/not attached/i.test(String(e?.message))) throw error;
      const entry = this.#entry(tabId);
      entry.attached = false;
      await this.ensure(tabId);
      return this.#raw(tabId, sessionId, method, params);
    }
  }

  /** @param {number} tabId */
  touch(tabId) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.#idleMs <= 0 || entry.pins.size) return;
    entry.idleUntil = Date.now() + this.#idleMs;
    entry.idleTimer = setTimeout(() => this.softDetach(tabId).catch(() => {}), this.#idleMs);
  }

  /** @param {number} tabId @param {string} reason */
  pin(tabId, reason) {
    this.#entry(tabId).pins.add(reason);
    this.touch(tabId);
  }

  /** @param {number} tabId @param {string} reason */
  unpin(tabId, reason) {
    this.#tabs.get(tabId)?.pins.delete(reason);
    this.touch(tabId);
  }

  /** Detaches; clients keep their pages and are restored on the next command. @param {number} tabId */
  async softDetach(tabId) {
    const entry = this.#tabs.get(tabId);
    if (!entry?.attached || entry.pins.size) return;
    entry.attached = false;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    await this.#link.request("debugger.detach", { tabId }).catch(() => {});
  }

  /** Detaches and tells every client the page is gone. @param {number} tabId */
  async detach(tabId) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    if (entry.attached) await this.#link.request("debugger.detach", { tabId }).catch(() => {});
    this.#dropTab(tabId);
  }

  /** @param {number} tabId */
  #dropTab(tabId) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.#tabs.delete(tabId);
    for (const relay of entry.relays) relay.targetGone(tabId);
  }

  /** @param {{tabId: number, sessionId?: string, method: string, params?: any}} e */
  #onEvent(e) {
    const entry = this.#tabs.get(e.tabId);
    if (!entry) return;
    for (const relay of entry.relays) relay.onEvent(e.tabId, e.sessionId, e.method, e.params ?? {});
  }

  /** @param {{tabId: number, reason: string}} e */
  #onDetached({ tabId, reason }) {
    if (reason === "canceled_by_user") {
      // Cancel on the bar detaches every tab of this extension.
      this.#browser.debuggerCanceled = true;
      for (const id of [...this.#tabs.keys()]) this.#dropTab(id);
      this.emit("canceled");
      return;
    }
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    if (reason === "target_closed") this.#dropTab(tabId);
    else entry.attached = false;
  }

  /** For status: attached tabs, idle time left and pins. */
  list() {
    return [...this.#tabs.entries()]
      .filter(([, e]) => e.attached)
      .map(([tab, e]) => ({ tab, idleSecondsLeft: e.pins.size || !e.idleTimer ? null : Math.max(0, Math.round((e.idleUntil - Date.now()) / 1000)), pins: [...e.pins] }));
  }

  /** Stops the idle timers (daemon shutdown). */
  close() {
    for (const entry of this.#tabs.values()) if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }

  async detachAll() {
    for (const id of [...this.#tabs.keys()]) await this.detach(id);
  }
}
