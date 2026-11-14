// @ts-check
// Sessions and tab ownership, the only place that changes them (specs/sessions.md). Tabs are keyed
// by (browser instanceId, tab id) because tab ids are unique only within one browser.
import fs from "node:fs";
import path from "node:path";
import { BctlError } from "./errors.js";

export const DEFAULT_DIALOG_POLICY = Object.freeze({ alert: "accept", confirm: "dismiss", prompt: "dismiss", scope: "always" });
const GROUP_COLORS = ["blue", "cyan", "green", "purple", "pink", "orange", "yellow", "red", "grey"];

/** @typedef {{instanceId: string, tabId: number}} TabRef */
/**
 * @typedef {{
 *   id: string,
 *   client: string,
 *   createdAt: number,
 *   lastSeen: number,
 *   current: TabRef | null,
 *   color: string,
 *   groups: Record<string, number>,
 *   closeTabsOnEnd: boolean,
 * }} Session
 */
/** @typedef {{sessionId: string, kind: "owned" | "adopted", since: number, dialogPolicy: object}} Ownership */

/** @param {string} instanceId @param {number} tabId */
export const tabKey = (instanceId, tabId) => `${instanceId}:${tabId}`;

export class Sessions {
  /** @type {Map<string, Session>} */
  sessions = new Map();
  /** @type {Map<string, Ownership>} */
  owners = new Map();
  /** @type {Map<string, number>} tabs closed while owned, so the next call says TAB_CLOSED */
  closed = new Map();
  #file;
  #idleMs;
  #colorIndex = 0;

  /** @param {{home: string, idleMs?: number}} options */
  constructor({ home, idleMs = 30 * 60_000 }) {
    this.#file = path.join(home, "sessions.json");
    this.#idleMs = idleMs;
    this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      for (const s of data.sessions ?? []) this.sessions.set(s.id, s);
      for (const [key, o] of Object.entries(data.owners ?? {})) this.owners.set(key, /** @type {Ownership} */ (o));
    } catch {
      // first run, or an unreadable file: start empty
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const data = { sessions: [...this.sessions.values()], owners: Object.fromEntries(this.owners) };
      fs.writeFileSync(this.#file, JSON.stringify(data, null, 1));
    } catch {
      // ownership still holds in memory
    }
  }

  /** @param {string} id @param {string} client */
  touch(id, client) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        client,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        current: null,
        color: GROUP_COLORS[this.#colorIndex++ % GROUP_COLORS.length],
        groups: {},
        closeTabsOnEnd: false,
      };
      this.sessions.set(id, session);
      this.persist();
    }
    session.lastSeen = Date.now();
    return session;
  }

  /** @param {string} instanceId @param {number} tabId */
  ownerOf(instanceId, tabId) {
    return this.owners.get(tabKey(instanceId, tabId));
  }

  /** @param {string} sessionId */
  tabsOf(sessionId) {
    /** @type {(TabRef & Ownership)[]} */
    const tabs = [];
    for (const [key, o] of this.owners) {
      if (o.sessionId !== sessionId) continue;
      const split = key.lastIndexOf(":");
      tabs.push({ instanceId: key.slice(0, split), tabId: Number(key.slice(split + 1)), ...o });
    }
    return tabs;
  }

  /**
   * @param {Session} session
   * @param {string} instanceId
   * @param {number} tabId
   * @param {"owned" | "adopted"} kind
   */
  own(session, instanceId, tabId, kind) {
    const key = tabKey(instanceId, tabId);
    const previous = this.owners.get(key);
    this.owners.set(key, { sessionId: session.id, kind, since: Date.now(), dialogPolicy: previous?.dialogPolicy ?? { ...DEFAULT_DIALOG_POLICY } });
    this.closed.delete(key);
    if (previous && previous.sessionId !== session.id) {
      const other = this.sessions.get(previous.sessionId);
      if (other?.current && tabKey(other.current.instanceId, other.current.tabId) === key) other.current = null;
    }
    this.persist();
  }

  /** @param {string} instanceId @param {number} tabId */
  release(instanceId, tabId) {
    const key = tabKey(instanceId, tabId);
    const owner = this.owners.get(key);
    this.owners.delete(key);
    if (owner) {
      const session = this.sessions.get(owner.sessionId);
      if (session?.current && tabKey(session.current.instanceId, session.current.tabId) === key) session.current = null;
    }
    this.persist();
    return owner;
  }

  /** A tab closed in the browser. @param {string} instanceId @param {number} tabId */
  tabClosed(instanceId, tabId) {
    const owner = this.release(instanceId, tabId);
    if (owner) this.closed.set(tabKey(instanceId, tabId), Date.now());
    return owner;
  }

  /** A browser restarted: its tab ids mean nothing any more. @param {string} instanceId */
  browserRestarted(instanceId) {
    for (const key of [...this.owners.keys()]) if (key.startsWith(`${instanceId}:`)) this.owners.delete(key);
    for (const session of this.sessions.values()) if (session.current?.instanceId === instanceId) session.current = null;
    this.persist();
  }

  /** @param {Session} session @param {TabRef | null} tab */
  setCurrent(session, tab) {
    session.current = tab;
    this.persist();
  }

  /** @param {string} sessionId */
  end(sessionId) {
    const tabs = this.tabsOf(sessionId);
    const session = this.sessions.get(sessionId);
    for (const t of tabs) this.owners.delete(tabKey(t.instanceId, t.tabId));
    this.sessions.delete(sessionId);
    this.persist();
    return { session, tabs };
  }

  /** Sessions idle longer than the limit. */
  expired() {
    const cutoff = Date.now() - this.#idleMs;
    return [...this.sessions.values()].filter((s) => s.lastSeen < cutoff).map((s) => s.id);
  }

  /**
   * The tab a call acts on (specs/sessions.md): `tab` if given and owned by the session, else the
   * session's current tab.
   * @param {Session} session
   * @param {number | undefined} tab
   * @param {(tabId: number) => string[]} instancesWithTab connected browsers that have this tab id
   * @returns {TabRef}
   */
  resolveTab(session, tab, instancesWithTab) {
    if (tab === undefined) {
      if (!session.current) throw new BctlError("NO_TAB", "this session has no current tab");
      const key = tabKey(session.current.instanceId, session.current.tabId);
      if (this.closed.has(key)) throw new BctlError("TAB_CLOSED", `tab ${session.current.tabId} was closed`);
      return session.current;
    }
    const mine = this.tabsOf(session.id).filter((t) => t.tabId === tab);
    if (mine.length === 1) return { instanceId: mine[0].instanceId, tabId: tab };
    const holders = instancesWithTab(tab);
    if (holders.length > 1) throw new BctlError("AMBIGUOUS_BROWSER", `tab ${tab} exists in several browsers`);
    for (const [key] of this.closed) if (key.endsWith(`:${tab}`)) throw new BctlError("TAB_CLOSED", `tab ${tab} was closed`);
    if (holders.length === 0) throw new BctlError("TAB_CLOSED", `no tab ${tab} in a connected browser`);
    const owner = this.ownerOf(holders[0], tab);
    if (owner) throw new BctlError("TAB_NOT_OWNED", `tab ${tab} belongs to session ${owner.sessionId}`, { holder: owner.sessionId });
    throw new BctlError("TAB_NOT_OWNED", `tab ${tab} is not yours; adopt it first`, { hint: `tabs({action: "adopt", tab: ${tab}})` });
  }
}
