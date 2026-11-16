// @ts-check
// status, tabs, navigate (specs/tools/status.md, tabs.md, navigate.md).
import { BctlError } from "../errors.js";
import { heldByOther, tabKey } from "../sessions.js";
import { checkWait, tab, waitCondition } from "./common.js";
import { afterWait } from "./read-tools.js";

/** How long a forced adopt waits for the holder's action in flight (specs/sessions.md). */
const TAKE_WAIT_MS = 5000;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @type {import("../registry.js").Tool} */
export const status = {
  name: "status",
  description:
    "Show connected browsers, setup problems, your tabs, and where Chrome's debugging bar comes from. Call it first when a tool reports NO_BROWSER, USER_SCRIPTS_OFF or DEBUGGER_CANCELED.",
  inputSchema: {
    type: "object",
    properties: { allowDebugger: { type: "boolean", default: false, description: "Clear DEBUGGER_CANCELED after asking the user." } },
  },
  async handler({ allowDebugger }, { daemon, session }) {
    if (allowDebugger) for (const b of daemon.browsers.connected()) b.debuggerCanceled = false;
    const cdp = daemon.cdp;
    const browsers = [];
    /** @type {string[]} */
    const setup = [];
    for (const b of daemon.browsers.connected()) {
      const info = await /** @type {any} */ (b.link).request("ext.info").catch(() => b.hello);
      const mine = daemon.sessions.tabsOf(session.id).filter((t) => t.instanceId === b.instanceId);
      const myTabs = [];
      for (const t of mine) {
        const meta = await /** @type {any} */ (b.link).request("tabs.get", { tabId: t.tabId }).catch(() => null);
        myTabs.push({ tab: t.tabId, url: meta?.url ?? "", title: meta?.title ?? "", current: session.current?.tabId === t.tabId && session.current?.instanceId === b.instanceId });
      }
      if (!info.userScripts) setup.push(`${b.alias}: turn on "Allow User Scripts" for browserctl in chrome://extensions (Details) so evaluate works without the debugging bar.`);
      if (b.outdated) setup.push(`${b.alias}: reload the browserctl extension in chrome://extensions; it is older than the daemon.`);
      browsers.push({
        alias: b.alias,
        name: b.hello.browser?.name ?? "",
        version: b.hello.browser?.version ?? "",
        extension: { version: b.hello.extensionVersion, protocol: b.hello.protocol, outdated: b.outdated },
        userScripts: Boolean(info.userScripts),
        debuggerCanceled: b.debuggerCanceled,
        attached: cdp ? cdp.attachmentsOf(b.instanceId) : [],
        myTabs,
      });
    }
    if (!browsers.length) setup.push("No browser is connected: load the browserctl extension (browserctl extension path) in chrome://extensions with Developer mode on.");
    return {
      daemon: { version: daemon.version, startedAt: new Date(daemon.startedAt).toISOString() },
      session: { id: session.id, client: session.client, currentTab: session.current?.tabId ?? null },
      browsers,
      setup,
    };
  },
};

/**
 * Waits for a main-frame navigation to finish (specs/tools/navigate.md).
 * @param {{events: {name: string, data: any}[], stop: () => void}} observer
 * @param {number} timeoutMs
 */
async function waitForLoad(observer, timeoutMs, wantsBlank = false) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      // A new tab's own about:blank load can still be reporting; it is not the navigation asked for.
      const main = observer.events.filter((e) => e.data?.frameId === 0 && (wantsBlank || e.data.url !== "about:blank"));
      const error = main.find((e) => e.name === "nav.error");
      if (error && !/ERR_ABORTED/.test(error.data.error)) throw new BctlError("NAVIGATION_FAILED", `${error.data.url}: ${error.data.error}`);
      const start = main.findIndex((e) => e.name === "nav.beforeNavigate" || e.name === "nav.committed");
      if (start >= 0 && main.slice(start).some((e) => e.name === "nav.domContentLoaded" || e.name === "nav.completed")) return true;
      if (start < 0 && main.some((e) => e.name === "nav.historyStateUpdated")) return true;
      await sleep(50);
    }
    return false;
  } finally {
    observer.stop();
  }
}

/**
 * Opens a background tab for the session (specs/sessions.md).
 * @param {import("../app.js").Daemon} daemon
 * @param {import("../sessions.js").Session} session
 * @param {string | undefined} url
 * @param {string | undefined} alias
 */
async function openTab(daemon, session, url, alias) {
  const browser = alias ? daemon.browsers.pick(alias) : session.current ? daemon.browserOf(session.current) : daemon.browsers.pick();
  const link = /** @type {any} */ (browser.link);
  const created = await link.request("tabs.create", { url: "about:blank" });
  const ref = { instanceId: browser.instanceId, tabId: created.tabId };
  daemon.sessions.own(session, browser.instanceId, created.tabId, "owned");
  daemon.sessions.setCurrent(session, ref);
  let settled = true;
  if (url) {
    const observer = daemon.observe(ref);
    await link.request("tabs.navigate", { tabId: created.tabId, url: normalizeUrl(url) });
    settled = await waitForLoad(observer, 10_000, normalizeUrl(url) === "about:blank");
  }
  return { ref, settled };
}

/** @param {string} url */
function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

/**
 * @param {import("../app.js").Daemon} daemon
 * @param {import("./../sessions.js").TabRef} ref
 */
async function describeTab(daemon, ref) {
  const meta = await pageMeta(daemon, ref);
  return { tab: ref.tabId, url: meta.url, title: meta.title, browser: daemon.browserOf(ref).alias };
}

/**
 * URL and title from the document itself; chrome.tabs can lag behind right after a navigation.
 * @param {import("../app.js").Daemon} daemon
 * @param {import("./../sessions.js").TabRef} ref
 */
async function pageMeta(daemon, ref) {
  try {
    const info = await daemon.dom(ref, "info", {}, { timeoutMs: 3000 });
    return { url: info.url, title: info.title };
  } catch {
    const meta = await daemon.linkOf(ref).request("tabs.get", { tabId: ref.tabId });
    return { url: meta.url, title: meta.title };
  }
}

/** @type {import("../registry.js").Tool} */
export const tabs = {
  name: "tabs",
  description:
    "Manage tabs. action: list | new | select | close | adopt | release. New tabs open in the background and become your current tab. adopt takes an existing tab (e.g. one the user opened) so you can act on it. select with focus: true shows the tab to the user.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "new", "select", "close", "adopt", "release"] },
      tab,
      url: { type: "string", minLength: 1, description: "For new: the page to open." },
      focus: { type: "boolean", default: false, description: "For select: bring the tab and its window to the front." },
      force: { type: "boolean", default: false, description: "For adopt: take a tab another session holds." },
      browser: { type: "string", minLength: 1, description: "Browser alias from status, when several are connected." },
      all: { type: "boolean", default: false, description: "For list: every tab, not only yours." },
    },
    required: ["action"],
  },
  async handler(p, { daemon, session }) {
    const needsTab = ["select", "close", "adopt", "release"].includes(p.action);
    if (needsTab && p.tab === undefined) throw new BctlError("INVALID_PARAMS", `tabs ${p.action} needs tab`, { hint: "Pass tab: an id from tabs({action: \"list\"})." });
    const current = () => session.current?.tabId ?? null;

    if (p.action === "list") {
      const out = [];
      const browsers = p.browser ? [daemon.browsers.pick(p.browser)] : daemon.browsers.connected();
      for (const b of browsers) {
        const { tabs: list } = await /** @type {any} */ (b.link).request("tabs.list");
        for (const t of list) {
          const owner = daemon.sessions.ownerOf(b.instanceId, t.tabId);
          const mine = owner?.sessionId === session.id;
          if (!p.all && !mine && !t.active) continue;
          out.push({
            tab: t.tabId,
            url: t.url,
            title: t.title,
            mine,
            current: mine && current() === t.tabId,
            active: t.active,
            holder: owner ? (mine ? "you" : owner.sessionId) : null,
            browser: b.alias,
          });
        }
      }
      return { tabs: out, current: current() };
    }

    if (p.action === "new") {
      const { ref } = await openTab(daemon, session, p.url, p.browser);
      return { tab: await describeTab(daemon, ref), current: current() };
    }

    if (p.action === "adopt") {
      await daemon.refreshKnownTabs();
      const holders = daemon.browsers.connected().filter((b) => daemon.knownTabs.get(b.instanceId)?.has(p.tab) && (!p.browser || b.alias === p.browser));
      if (holders.length === 0) throw new BctlError("TAB_CLOSED", `no tab ${p.tab} in a connected browser`);
      if (holders.length > 1) throw new BctlError("AMBIGUOUS_BROWSER", `tab ${p.tab} exists in several browsers`, { browsers: holders.map((b) => b.alias) });
      const ref = { instanceId: holders[0].instanceId, tabId: p.tab };
      const owner = daemon.sessions.ownerOf(ref.instanceId, ref.tabId);
      if (owner && owner.sessionId !== session.id) {
        if (!p.force) throw heldByOther(p.tab, owner.sessionId);
        // a tab is not taken in the middle of an action (specs/sessions.md)
        await daemon.actionEnded(ref, TAKE_WAIT_MS);
      }
      daemon.sessions.own(session, ref.instanceId, ref.tabId, owner?.sessionId === session.id ? owner.kind : "adopted");
      daemon.sessions.setCurrent(session, ref);
      await daemon.armDialogs(ref).catch(() => {});
      return { tab: await describeTab(daemon, ref), current: current() };
    }

    const ref = await daemon.tab(session, p.tab);
    const link = daemon.linkOf(ref);
    if (p.action === "select") {
      daemon.sessions.setCurrent(session, ref);
      if (p.focus) await link.request("tabs.activate", { tabId: ref.tabId, focusWindow: true });
      return { tab: await describeTab(daemon, ref), current: current() };
    }
    if (p.action === "close") {
      const described = await describeTab(daemon, ref).catch(() => ({ tab: ref.tabId }));
      await daemon.cdp?.detach(ref).catch(() => {});
      daemon.sessions.release(ref.instanceId, ref.tabId);
      await link.request("tabs.close", { tabId: ref.tabId });
      return { tab: described, current: current() };
    }
    // release
    const described = await describeTab(daemon, ref);
    await daemon.cdp?.detach(ref).catch(() => {});
    daemon.sessions.release(ref.instanceId, ref.tabId);
    await daemon.linkOf(ref).request("dom.call", { tabId: ref.tabId, allFrames: true, op: "armDialogs", args: [null] }).catch(() => {});
    return { tab: described, current: current() };
  },
};

/** @type {import("../registry.js").Tool} */
export const navigate = {
  name: "navigate",
  description:
    "Open a URL in your current tab (opens a background tab if you have none), or action: back | forward | reload. Waits for the page to load. Does not change what the user is looking at.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Absolute URL, or a host (https:// is added)." },
      action: { type: "string", enum: ["back", "forward", "reload"] },
      wait: waitCondition,
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    checkWait(p.wait);
    if ((p.url === undefined) === (p.action === undefined)) {
      throw new BctlError("INVALID_PARAMS", "navigate takes exactly one of url and action", { hint: "Pass url: \"https://...\" or action: \"back\" | \"forward\" | \"reload\"." });
    }
    let ref;
    if (p.tab === undefined && !session.current) {
      if (p.action) throw new BctlError("NO_TAB", "this session has no current tab");
      ref = (await openTab(daemon, session, undefined, undefined)).ref;
    } else ref = await daemon.tab(session, p.tab);
    const link = daemon.linkOf(ref);
    const before = await link.request("tabs.get", { tabId: ref.tabId });
    const observer = daemon.observe(ref);
    let moved = true;
    try {
      if (p.url) await link.request("tabs.navigate", { tabId: ref.tabId, url: normalizeUrl(p.url) });
      else if (p.action === "reload") await link.request("tabs.history", { tabId: ref.tabId, action: "reload" });
      else {
        try {
          await daemon.dom(ref, "historyGo", { delta: p.action === "back" ? -1 : 1 }, { timeoutMs: 3000 });
        } catch {
          ({ moved } = await link.request("tabs.history", { tabId: ref.tabId, action: p.action }));
        }
        if (moved) {
          const deadline = Date.now() + 2000;
          const started = () => observer.events.some((e) => e.data?.frameId === 0 && ["nav.beforeNavigate", "nav.committed", "nav.historyStateUpdated"].includes(e.name));
          while (!started() && Date.now() < deadline) await sleep(50);
          moved = started();
        }
      }
    } catch (error) {
      observer.stop();
      throw error;
    }
    const settled = moved ? await waitForLoad(observer, 30_000, p.url !== undefined && normalizeUrl(p.url) === "about:blank") : (observer.stop(), true);
    const w = await afterWait(daemon, ref, p.wait);
    const after = await pageMeta(daemon, ref);
    return { lane: "dom", tab: ref.tabId, url: after.url, title: after.title, urlChanged: after.url !== before.url, settled, waited: w.waited, hint: w.hint };
  },
};

export { tabKey };
