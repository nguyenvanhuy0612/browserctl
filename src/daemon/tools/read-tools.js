// @ts-check
// snapshot, read, wait_for (specs/tools/snapshot.md, read.md, wait_for.md).
import { Daemon } from "../app.js";
import { BctlError, toBctlError } from "../errors.js";
import { annotate, fit, nestFrames, noticeLines, PDF_NOTICE } from "../snapshot-text.js";
import { tabKey } from "../sessions.js";
import { by, checkWait, tab, target, timeout, urlMatcher } from "./common.js";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Frames nest at most this deep in a snapshot or read (specs/tools/snapshot.md). */
const FRAME_LEVELS = 10;

/**
 * Reads each child frame for its iframe element, matched by the handshake (specs/targets.md),
 * level by level; the iframes whose frame was not read (not found, failed, or too deep) come back
 * as `unread`. The caller has already made every frame load the runtime.
 * @param {Daemon} daemon
 * @param {import("../sessions.js").TabRef} ref
 * @param {string[]} iframeRefs
 * @param {(frameId: number) => Promise<{text: string, iframes: string[]}>} read
 */
async function collectFrames(daemon, ref, iframeRefs, read) {
  /** @type {Map<string, string>} */
  const byRef = new Map();
  /** @type {Set<string>} */
  const unread = new Set();
  let pending = iframeRefs;
  for (let level = 0; level < FRAME_LEVELS && pending.length; level++) {
    await sleep(60);
    const frames = await daemon.domAll(ref, "info");
    /** @type {string[]} */
    const next = [];
    for (const iframeRef of pending) {
      const frame = frames.find((f) => f.result?.ok && f.result.probe === iframeRef && f.frameId !== 0);
      try {
        if (!frame) throw new Error("no frame answered for this iframe");
        const part = await read(frame.frameId);
        byRef.set(iframeRef, part.text);
        next.push(...part.iframes);
      } catch {
        // not scriptable, or it navigated away meanwhile
        unread.add(iframeRef);
      }
    }
    pending = next;
  }
  for (const iframeRef of pending) unread.add(iframeRef);
  return { byRef, unread };
}

const READY_TYPES = new Set(["main_frame", "sub_frame", "script", "xmlhttprequest"]);

/**
 * Waits for a young page to be ready (specs/tools/snapshot.md, step 2): document complete, no
 * element added or removed for 300 ms (1.1 s in a background tab), no recent document/script/XHR
 * request pending. At most 3 s (5 s in a background tab); pages older than 15 s are not waited for.
 * @param {Daemon} daemon @param {import("../sessions.js").TabRef} ref
 */
export async function waitReady(daemon, ref) {
  const started = Date.now();
  const pending = () =>
    (daemon.requests.get(tabKey(ref.instanceId, ref.tabId)) ?? []).filter(
      (/** @type {any} */ r) => r.status === null && !r.error && READY_TYPES.has(r.type) && Date.now() - r.startedAt < 5000,
    ).length;
  let info = await daemon.dom(ref, "info");
  if (info.age >= 15_000) {
    // an old page is not waited for; quiet is not measured
    return { ready: info.readyState === "complete", readyState: info.readyState, quiet: null, pendingRequests: pending(), waitedMs: 0 };
  }
  // background tabs run page timers once a second, so work comes in 1 s bursts: a 300 ms gap proves nothing
  const background = info.visibility === "hidden";
  const quietMs = background ? 1100 : 300;
  const deadline = background ? 5000 : 3000;
  let last = info.structure;
  let stableSince = Date.now();
  for (;;) {
    const quiet = Date.now() - stableSince >= quietMs;
    const state = { readyState: info.readyState, quiet, pendingRequests: pending() };
    const settled = state.readyState === "complete" && quiet;
    if (settled && state.pendingRequests === 0) return { ready: true, ...state, waitedMs: Date.now() - started };
    // requests that hang (ads, analytics, long polls) and slow subresources only extend the wait;
    // at the deadline a quiet DOM after DOMContentLoaded is ready
    if (Date.now() - started >= deadline) return { ready: quiet && state.readyState !== "loading", ...state, waitedMs: Date.now() - started };
    await sleep(100);
    try {
      info = await daemon.dom(ref, "info");
    } catch (error) {
      // the page is navigating or busy: stop waiting and report the last readyState measured
      if (toBctlError(error).code === "TAB_CLOSED") throw error;
      return { ready: false, readyState: info.readyState, quiet: false, pendingRequests: pending(), waitedMs: Date.now() - started };
    }
    if (info.structure !== last) {
      last = info.structure;
      stableSince = Date.now();
    }
  }
}

/** @type {import("../registry.js").Tool} */
export const snapshot = {
  name: "snapshot",
  description:
    "Read the page as an accessibility tree (YAML); each element you can act on has a ref ([ref=e5]) to pass as target to click, type, fill_form, evaluate. A ref stays valid until its element is removed or the page navigates. Extra brackets tell state: [empty], [type=email], [value=42], [near=\"label\"] for unnamed fields, [ctx=\"...\"] to tell identical buttons apart, [modal], [hidden] (no ref: open its menu first). Long lists and long text are folded; each fold line says how to see the rest (read target=eX). target: a ref to read only that part. If the first line says the page is not ready, snapshot again. Works in background tabs without the debugging bar.",
  inputSchema: {
    type: "object",
    properties: {
      target: { ...target, description: "Snapshot only this element's subtree." },
      depth: { type: "integer", minimum: 1, maximum: 50, description: "Cut the tree below this depth. Default: no limit." },
      full: { type: "boolean", default: false, description: "Skip compaction and text folding." },
      maxChars: { type: "integer", minimum: 1000, maximum: 200000, default: 20000, description: "Size budget; long text is folded harder before anything is cut." },
      maxText: { type: "integer", minimum: 200, maximum: 200000, default: 2000, description: "Characters of running text kept before it is folded." },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    await daemon.domAll(ref, "info").catch(() => []);
    const readiness = await waitReady(daemon, ref);
    const main = await daemon.dom(ref, "snapshot", { target: p.target, depth: p.depth }, { frameId });
    let text = main.pdf ? PDF_NOTICE : annotate(main.snapshot, main);
    if (main.iframes.length) {
      const { byRef, unread } = await collectFrames(daemon, ref, main.iframes, async (id) => {
        const part = await daemon.dom(ref, "snapshot", { depth: p.depth }, { frameId: id });
        return { text: annotate(part.snapshot, part), iframes: part.iframes };
      });
      text = nestFrames(text, byRef, unread);
    }
    const notices = noticeLines(readiness, main.modal, main.canvas);
    const maxChars = p.maxChars ?? 20000;
    // notice lines and their newlines count toward maxChars
    const noticeChars = notices.reduce((sum, line) => sum + line.length + 1, 0);
    const fitted = fit(text, { full: p.full, maxChars: maxChars - noticeChars, maxText: p.maxText ?? 2000 });
    const info = await daemon.dom(ref, "info");
    const { dialogs } = await daemon.dom(ref, "dialogLog", { since: 0 });
    return {
      lane: "dom",
      url: info.url,
      title: info.title,
      background: info.visibility === "hidden",
      ready: readiness.ready,
      readiness: { readyState: readiness.readyState, quiet: readiness.quiet, pendingRequests: readiness.pendingRequests, waitedMs: readiness.waitedMs },
      modal: main.modal ?? null,
      snapshot: [...notices, fitted.text].join("\n"),
      folded: fitted.folded,
      textFolded: fitted.textFolded,
      collapsed: fitted.collapsed,
      cut: fitted.cutChars || p.depth ? { depth: p.depth ?? null, chars: fitted.cutChars } : null,
      dialogs: dialogs.slice(-5).map((/** @type {any} */ d) => ({ type: d.type, message: d.message, answer: d.answer })),
    };
  },
};

/** @param {string} text @param {number} offset @param {number} maxChars */
export function sliceText(text, offset, maxChars) {
  if (offset >= text.length) return { text: "", nextOffset: null };
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length) {
    const lineEnd = text.lastIndexOf("\n", end);
    if (lineEnd > offset && end - lineEnd <= 200) end = lineEnd + 1;
  }
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}

/** @type {import("../registry.js").Tool} */
export const read = {
  name: "read",
  description:
    "Read the page (or target) as text: headings, paragraphs, lists, full tables, links, and form fields with their values and refs. main: true skips navigation and footers. Long pages come in slices: pass nextOffset as offset to continue.",
  inputSchema: {
    type: "object",
    properties: {
      target: { ...target, description: "Read only this element." },
      main: { type: "boolean", default: false, description: "Only the main content (main, [role=main], or the largest article)." },
      offset: { type: "integer", minimum: 0, default: 0 },
      maxChars: { type: "integer", minimum: 1000, maximum: 200000, default: 20000 },
      links: { type: "boolean", default: true, description: "Write links as [text](url)." },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    if (p.main && p.target) throw new BctlError("INVALID_PARAMS", "main and target cannot be combined");
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    await daemon.domAll(ref, "info").catch(() => []);
    const main = await daemon.dom(ref, "read", { target: p.target, main: p.main, links: p.links }, { frameId });
    let text = main.pdf ? PDF_NOTICE : main.text;
    const frameMarkers = [...text.matchAll(/\[frame ((?:f\d+)?e\d+)\]/g)].map((m) => m[1]);
    if (frameMarkers.length) {
      const { byRef: frames } = await collectFrames(daemon, ref, frameMarkers, async (id) => {
        const part = await daemon.dom(ref, "read", { links: p.links }, { frameId: id });
        return { text: part.text, iframes: [...part.text.matchAll(/\[frame ((?:f\d+)?e\d+)\]/g)].map((m) => m[1]) };
      });
      for (let pass = 0; pass < FRAME_LEVELS; pass++) {
        text = text.replace(/\[frame ((?:f\d+)?e\d+)\]/g, (/** @type {string} */ whole, /** @type {string} */ r) => (frames.has(r) ? `--- frame ${r} ---\n${frames.get(r)}\n--- end of frame ${r} ---` : whole));
      }
    }
    const info = await daemon.dom(ref, "info");
    const slice = sliceText(text, p.offset, p.maxChars);
    return { lane: "dom", url: info.url, title: info.title, text: slice.text, offset: p.offset, total: text.length, nextOffset: slice.nextOffset };
  },
};

/** @type {import("../registry.js").Tool} */
export const get = {
  name: "get",
  description:
    "Read one thing about an element: what: text (default) | value | attribute | property | html | state | box; name: the attribute or property (href, dataset.id). target: a ref or a locator. all: true returns every match of a selector. Use it instead of evaluate to read a value.",
  inputSchema: {
    type: "object",
    properties: {
      target,
      what: { type: "string", enum: ["text", "value", "attribute", "property", "html", "state", "box"], default: "text" },
      name: { type: "string", minLength: 1, description: "Attribute name, or property path (dataset.id), for what: attribute | property." },
      all: { type: "boolean", default: false, description: "Every element the selector matches (at most 100) instead of AMBIGUOUS_TARGET." },
      maxChars: { type: "integer", minimum: 100, maximum: 200000, default: 5000, description: "Cut text and html values." },
      timeout: { ...timeout, description: "Seconds to wait for the target to exist (it need not be visible)." },
      tab,
    },
    required: ["target"],
  },
  async handler(p, { daemon, session }) {
    const needsName = p.what === "attribute" || p.what === "property";
    if (needsName && !p.name) throw new BctlError("INVALID_PARAMS", `get: what: ${p.what} needs name`, { hint: "Pass name, e.g. name: \"href\"." });
    if (!needsName && p.name) throw new BctlError("INVALID_PARAMS", `get: name is only for what: attribute or property`);
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    const args = { target: p.target, what: p.what, name: p.name, all: p.all, maxChars: p.maxChars };
    const r = await daemon.retrying(() => daemon.dom(ref, "get", args, { frameId }), p.timeout * 1000);
    if (p.all) return { lane: "dom", count: r.count, items: r.items.map((/** @type {any} */ i) => ({ resolved: { by: by(p.target), ...i.resolved }, value: i.value, cut: i.cut })) };
    return { lane: "dom", resolved: { by: by(p.target), ...r.resolved }, value: r.value, cut: r.cut };
  },
};

/**
 * Polls one wait_for condition (specs/tools/wait_for.md) until it holds or `timeout` seconds pass.
 * @param {Daemon} daemon @param {import("../sessions.js").TabRef} ref
 * @param {{text?: string, textGone?: string, target?: string, state?: string, url?: string, time?: number, timeout?: number}} p
 * @returns {Promise<{ok: true, waitedMs: number, matched: any} | {ok: false, waitedMs: number, lastSeen: any}>}
 */
export async function waitUntil(daemon, ref, p) {
  const started = Date.now();
  const timeoutS = p.timeout ?? 10;
  const state = p.state ?? "visible";
  if (p.time !== undefined) {
    await sleep(p.time * 1000);
    return { ok: true, waitedMs: Date.now() - started, matched: null };
  }
  const deadline = started + timeoutS * 1000;
  const urlMatches = p.url !== undefined ? urlMatcher(p.url, "url") : null;
  /** @type {any} */
  let last = null;
  for (;;) {
    try {
      if (p.url !== undefined) {
        const { url } = await daemon.linkOf(ref).request("tabs.get", { tabId: ref.tabId });
        last = url;
        if (/** @type {(url: string) => boolean} */ (urlMatches)(url)) return { ok: true, waitedMs: Date.now() - started, matched: null };
      } else if (p.target !== undefined) {
        const r = await daemon.dom(ref, "elementState", { target: p.target }, { frameId: Daemon.frameOf(p.target) });
        last = r.element ? `${r.state} ${r.element.role} "${r.element.name}"` : r.state;
        const ok = state === "attached" ? r.state !== "detached" : r.state === state;
        if (ok) return { ok: true, waitedMs: Date.now() - started, matched: r.element ?? null };
      } else {
        const needle = /** @type {string} */ (p.text ?? p.textGone);
        const frames = await daemon.domAll(ref, "findText", { text: needle });
        const hit = frames.find((f) => f.result?.ok && f.result.found);
        last = hit ? "present" : "absent";
        if (p.text !== undefined && hit) return { ok: true, waitedMs: Date.now() - started, matched: hit.result.element };
        if (p.textGone !== undefined && !hit) return { ok: true, waitedMs: Date.now() - started, matched: null };
      }
    } catch (error) {
      const e = toBctlError(error);
      if (["TAB_CLOSED", "NO_BROWSER", "INVALID_TARGET", "AMBIGUOUS_TARGET", "PAGE_UNSCRIPTABLE"].includes(e.code)) throw e;
      last = e.code;
    }
    if (Date.now() >= deadline) return { ok: false, waitedMs: Date.now() - started, lastSeen: last };
    await sleep(200);
  }
}

/**
 * The `wait` of an action (specs/actions.md): runs after the action; a timeout is reported, not thrown.
 * @param {Daemon} daemon @param {import("../sessions.js").TabRef} ref @param {any} wait
 */
export async function afterWait(daemon, ref, wait) {
  if (!wait) return { waited: null, hint: null };
  const waited = await waitUntil(daemon, ref, wait);
  const hint = waited.ok ? null : `The action ran, but the wait condition did not hold within ${wait.timeout ?? 10} s (last seen: ${waited.lastSeen}). Take a snapshot before acting again.`;
  return { waited, hint };
}

/** @type {import("../registry.js").Tool} */
export const wait_for = {
  name: "wait_for",
  description:
    "Wait for text to appear (text) or disappear (textGone), for target to become visible / hidden / attached / detached, for the URL to match (url), or for time seconds. timeout defaults to 10 s.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      textGone: { type: "string", minLength: 1 },
      target,
      state: { type: "string", enum: ["visible", "hidden", "attached", "detached"], default: "visible" },
      url: { type: "string", minLength: 1, description: "Substring of the URL, or /regex/." },
      time: { type: "number", minimum: 0.1, maximum: 60 },
      timeout: { type: "number", minimum: 0.1, maximum: 60, default: 10 },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    checkWait(p);
    if (p.time !== undefined) {
      await sleep(p.time * 1000);
      return { lane: "dom", waitedMs: p.time * 1000, matched: null };
    }
    const ref = await daemon.tab(session, p.tab);
    const r = await waitUntil(daemon, ref, p);
    if (!r.ok) throw new BctlError("TIMEOUT", `waited ${p.timeout} s; last seen: ${r.lastSeen}`, { lastSeen: r.lastSeen });
    return { lane: "dom", waitedMs: r.waitedMs, matched: r.matched };
  },
};
