// @ts-check
// snapshot, read, wait_for (specs/tools/snapshot.md, read.md, wait_for.md).
import { Daemon } from "../app.js";
import { BctlError, toBctlError } from "../errors.js";
import { compact, cut, nestFrames } from "../snapshot-text.js";
import { tab, target } from "./common.js";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Snapshots each child frame under its iframe element, matched by the handshake
 * (specs/targets.md). The caller has already made every frame load the runtime.
 * @param {Daemon} daemon
 * @param {import("../sessions.js").TabRef} ref
 * @param {string[]} iframeRefs
 * @param {(frameId: number) => Promise<{text: string, iframes: string[]}>} read
 */
async function collectFrames(daemon, ref, iframeRefs, read) {
  /** @type {Map<string, string>} */
  const byRef = new Map();
  let pending = iframeRefs;
  for (let level = 0; level < 4 && pending.length; level++) {
    await sleep(60);
    const frames = await daemon.domAll(ref, "info");
    /** @type {string[]} */
    const next = [];
    for (const iframeRef of pending) {
      const frame = frames.find((f) => f.result?.ok && f.result.probe === iframeRef && f.frameId !== 0);
      if (!frame) continue;
      try {
        const part = await read(frame.frameId);
        byRef.set(iframeRef, part.text);
        next.push(...part.iframes);
      } catch {
        // a frame that navigated away meanwhile
      }
    }
    pending = next;
  }
  return byRef;
}

/** @type {import("../registry.js").Tool} */
export const snapshot = {
  name: "snapshot",
  description:
    "Read the page as an accessibility tree; each element you can act on has a ref ([ref=e5]) to pass as target to click, type, fill_form, evaluate. A ref stays valid until its element is removed or the page navigates. Long repeated lists are shortened; the snapshot says how to see all items. target: a ref to read only that part. Works in background tabs without the debugging bar.",
  inputSchema: {
    type: "object",
    properties: {
      target: { ...target, description: "Snapshot only this element's subtree." },
      depth: { type: "integer", minimum: 1, maximum: 50 },
      full: { type: "boolean", default: false, description: "Skip compaction." },
      maxChars: { type: "integer", minimum: 1000, maximum: 200000, default: 20000 },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    await daemon.domAll(ref, "info").catch(() => []);
    const main = await daemon.dom(ref, "snapshot", { target: p.target, depth: p.depth }, { frameId });
    let text = main.snapshot;
    if (main.iframes.length) {
      const frames = await collectFrames(daemon, ref, main.iframes, async (id) => {
        const part = await daemon.dom(ref, "snapshot", { depth: p.depth }, { frameId: id });
        return { text: part.snapshot, iframes: part.iframes };
      });
      text = nestFrames(text, frames);
    }
    let folded = 0;
    if (!p.full) ({ text, folded } = compact(text));
    const cutResult = cut(text, p.maxChars);
    const info = await daemon.dom(ref, "info");
    const { dialogs } = await daemon.dom(ref, "dialogLog", { since: 0 });
    return {
      lane: "dom",
      url: info.url,
      title: info.title,
      background: info.visibility === "hidden",
      snapshot: cutResult.text,
      folded,
      cut: cutResult.cutChars || p.depth ? { depth: p.depth ?? null, chars: cutResult.cutChars } : null,
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
    let text = main.text;
    const frameMarkers = [...text.matchAll(/\[frame ((?:f\d+)?e\d+)\]/g)].map((m) => m[1]);
    if (frameMarkers.length) {
      const frames = await collectFrames(daemon, ref, frameMarkers, async (id) => {
        const part = await daemon.dom(ref, "read", { links: p.links }, { frameId: id });
        return { text: part.text, iframes: [...part.text.matchAll(/\[frame ((?:f\d+)?e\d+)\]/g)].map((m) => m[1]) };
      });
      for (let pass = 0; pass < 4; pass++) {
        text = text.replace(/\[frame ((?:f\d+)?e\d+)\]/g, (/** @type {string} */ whole, /** @type {string} */ r) => (frames.has(r) ? `--- frame ${r} ---\n${frames.get(r)}\n--- end of frame ${r} ---` : whole));
      }
    }
    const info = await daemon.dom(ref, "info");
    const slice = sliceText(text, p.offset, p.maxChars);
    return { lane: "dom", url: info.url, title: info.title, text: slice.text, offset: p.offset, total: text.length, nextOffset: slice.nextOffset };
  },
};

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
    const conditions = ["text", "textGone", "target", "url", "time"].filter((k) => p[k] !== undefined);
    if (conditions.length !== 1) throw new BctlError("INVALID_PARAMS", "pass exactly one of text, textGone, target, url, time");
    const started = Date.now();
    if (p.time !== undefined) {
      await sleep(p.time * 1000);
      return { lane: "dom", waitedMs: Date.now() - started, matched: null };
    }
    const ref = await daemon.tab(session, p.tab);
    const deadline = started + p.timeout * 1000;
    const urlMatcher = p.url && /^\/.*\/[a-z]*$/.test(p.url) ? new RegExp(p.url.slice(1, p.url.lastIndexOf("/")), p.url.slice(p.url.lastIndexOf("/") + 1)) : null;
    let last = null;
    for (;;) {
      try {
        if (p.url !== undefined) {
          const { url } = await daemon.linkOf(ref).request("tabs.get", { tabId: ref.tabId });
          last = url;
          if (urlMatcher ? urlMatcher.test(url) : url.includes(p.url)) return { lane: "dom", waitedMs: Date.now() - started, matched: null };
        } else if (p.target !== undefined) {
          const r = await daemon.dom(ref, "elementState", { target: p.target }, { frameId: Daemon.frameOf(p.target) });
          last = r.state;
          const ok = p.state === "attached" ? r.state !== "detached" : r.state === p.state;
          if (ok) return { lane: "dom", waitedMs: Date.now() - started, matched: r.element ?? null };
        } else {
          const needle = p.text ?? p.textGone;
          const frames = await daemon.domAll(ref, "findText", { text: needle });
          const hit = frames.find((f) => f.result?.ok && f.result.found);
          last = hit ? "present" : "absent";
          if (p.text !== undefined && hit) return { lane: "dom", waitedMs: Date.now() - started, matched: hit.result.element };
          if (p.textGone !== undefined && !hit) return { lane: "dom", waitedMs: Date.now() - started, matched: null };
        }
      } catch (error) {
        const e = toBctlError(error);
        if (["TAB_CLOSED", "NO_BROWSER", "INVALID_TARGET", "AMBIGUOUS_TARGET", "PAGE_UNSCRIPTABLE"].includes(e.code)) throw e;
        last = e.code;
      }
      if (Date.now() >= deadline) throw new BctlError("TIMEOUT", `waited ${p.timeout} s; last seen: ${last}`, { lastSeen: last });
      await sleep(200);
    }
  },
};
