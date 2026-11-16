// @ts-check
// evaluate, take_screenshot, network_requests, run (specs/tools/*.md).
import fs from "node:fs";
import path from "node:path";
import { Daemon } from "../app.js";
import { BctlError } from "../errors.js";
import { tabKey } from "../sessions.js";
import { cdp, tab, target, trusted, urlMatcher } from "./common.js";

const RESULT_LIMIT = 1024 * 1024;

/**
 * Builds the MAIN-world script for evaluate: the agent's code is part of the source text, so no
 * eval or new Function runs in the page (page CSP would block them). The code is compiled as an
 * argument at the script's top level, where only the page's globals are in scope, not the
 * wrapper's variables (specs/tools/evaluate.md).
 * @param {string} fn
 * @param {string | null} nonce
 */
export function evaluateSource(fn, nonce) {
  return `(async (input) => {
  const mark = ${JSON.stringify(nonce)};
  const find = (root) => {
    const hit = root.querySelector('[data-bctl-target="' + mark + '"]');
    if (hit) return hit;
    for (const e of root.querySelectorAll("*")) if (e.shadowRoot) { const inner = find(e.shadowRoot); if (inner) return inner; }
    return null;
  };
  let element = null;
  if (mark) { element = find(document); if (element) element.removeAttribute("data-bctl-target"); }
  const describe = (v, seen, depth) => {
    if (v === undefined) return { __type: "undefined" };
    if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
    if (typeof v === "symbol") return v.toString();
    if (typeof Node !== "undefined" && v instanceof Node) {
      const html = v.nodeType === 1 ? v.outerHTML : String(v.textContent);
      return { __type: "node", preview: html.length > 300 ? html.slice(0, 300) + "…" : html };
    }
    if (seen.has(v)) return "[circular]";
    if (depth > 20) return "[too deep]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => describe(x, seen, depth + 1));
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), describe(x, seen, depth + 1)]));
    if (v instanceof Set) return [...v].map((x) => describe(x, seen, depth + 1));
    if (v instanceof Error) return { __type: "error", message: v.message };
    const out = {};
    for (const key of Object.keys(v)) { try { out[key] = describe(v[key], seen, depth + 1); } catch { out[key] = "[unreadable]"; } }
    return out;
  };
  try {
    const value = input();
    const result = typeof value === "function" ? await value(element) : await value;
    return { ok: true, type: result === null ? "null" : (typeof Node !== "undefined" && result instanceof Node ? "node" : typeof result), value: describe(result, new Set(), 0) };
  } catch (error) {
    return { ok: false, message: String(error && error.message || error), stack: String(error && error.stack || "").split("\\n")[1] || "" };
  }
})(() => (
${fn}
))`;
}

/** @param {any} value */
function finish(value) {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= RESULT_LIMIT) return { value, truncated: false };
  return { value: text.slice(0, RESULT_LIMIT), truncated: true };
}

/** @type {import("../registry.js").Tool} */
export const evaluate = {
  name: "evaluate",
  description:
    "Run JavaScript in the page (page globals available). function: \"() => document.title\", or \"(el) => el.value\" with target: a ref. Promises are awaited. Use it whenever no other tool fits.",
  inputSchema: {
    type: "object",
    properties: { function: { type: "string", minLength: 1 }, target, trusted, tab },
    required: ["function"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    if (p.trusted) {
      const r = await cdp(daemon).evaluate(ref, p.function, p.target);
      return { lane: "cdp", ...finish(r.value), type: r.type };
    }
    const nonce = p.target ? (await daemon.dom(ref, "mark", { target: p.target }, { frameId })).nonce : null;
    const answer = await daemon.linkOf(ref).request("eval.user", { tabId: ref.tabId, frameId, code: evaluateSource(p.function, nonce) }, 35_000);
    if (!answer.ok) throw new BctlError("EVAL_ERROR", answer.message ?? "evaluation failed");
    const result = answer.value;
    if (!result || typeof result !== "object") throw new BctlError("EVAL_ERROR", "the code did not produce a result");
    if (!result.ok) throw new BctlError("EVAL_ERROR", `${result.message}${result.stack ? ` (${result.stack.trim()})` : ""}`);
    const value = result.value && typeof result.value === "object" && result.value.__type === "undefined" ? null : result.value;
    return { lane: "dom", ...finish(value), type: result.type };
  },
};

const EXTENSION_FORMATS = /** @type {Record<string, "png" | "jpeg">} */ ({ ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" });

/**
 * The image format: given, else from the path's extension, else jpeg (specs/tools/take_screenshot.md).
 * @param {"png" | "jpeg" | undefined} format @param {string | undefined} file
 */
function screenshotFormat(format, file) {
  const fromPath = file ? EXTENSION_FORMATS[path.extname(file).toLowerCase()] : undefined;
  if (format && fromPath && format !== fromPath) throw new BctlError("INVALID_PARAMS", `format ${format} does not match the extension of ${file}`);
  return format ?? fromPath ?? "jpeg";
}

/** @type {import("../registry.js").Tool} */
export const take_screenshot = {
  name: "take_screenshot",
  description:
    "Screenshot the viewport, the full page (fullPage: true) or one element (target). Saved to a file; the path is returned. Background tabs and full pages use Chrome's debugging bar briefly.",
  inputSchema: {
    type: "object",
    properties: {
      target,
      fullPage: { type: "boolean", default: false },
      format: { type: "string", enum: ["jpeg", "png"], description: "Default: from path's extension, else jpeg." },
      path: { type: "string", minLength: 1, description: "Absolute path to save to." },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    if (p.fullPage && p.target) throw new BctlError("INVALID_PARAMS", "fullPage and target cannot be combined");
    if (p.path && !path.isAbsolute(p.path)) throw new BctlError("INVALID_PARAMS", "path must be absolute");
    const format = screenshotFormat(p.format, p.path);
    const ref = await daemon.tab(session, p.tab);
    const link = daemon.linkOf(ref);
    const meta = await link.request("tabs.get", { tabId: ref.tabId });
    const info = await daemon.dom(ref, "info").catch(() => null);
    const rendered = meta.active && info?.visibility === "visible" && meta.windowState !== "minimized";
    let shot;
    let lane;
    if (rendered && !p.fullPage) {
      const crop = p.target ? await daemon.dom(ref, "box", { target: p.target }, { frameId: Daemon.frameOf(p.target) }) : undefined;
      shot = await link.request("dom.capture", { windowId: meta.windowId, format, quality: 80, crop }, 15_000);
      lane = "dom";
    } else {
      shot = await cdp(daemon).screenshot(ref, { fullPage: p.fullPage, target: p.target, format });
      lane = "cdp";
    }
    const file = p.path ?? path.join(daemon.home, "out", `${ref.tabId}-${Date.now()}.${format === "png" ? "png" : "jpg"}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(shot.base64, "base64");
    fs.writeFileSync(file, bytes);
    return { lane, path: file, width: shot.width, height: shot.height, bytes: bytes.length, mimeType: format === "png" ? "image/png" : "image/jpeg" };
  },
};

/** @type {import("../registry.js").Tool} */
export const network_requests = {
  name: "network_requests",
  description:
    "List the tab's network requests (filter, types, since, limit) or one request's details (id). Response bodies need captureBodies: true first (shows Chrome's debugging bar until turned off). To call an API with the page's cookies, use evaluate with fetch.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", minLength: 1, description: "Substring of the URL, or /regex/." },
      types: { type: "array", items: { type: "string", enum: ["document", "xhr", "script", "stylesheet", "image", "media", "font", "websocket", "other"] }, description: "xhr covers fetch too." },
      since: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      id: { type: "integer", minimum: 1 },
      body: { type: "boolean", default: false },
      captureBodies: { type: "boolean" },
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const lane = daemon.cdp;
    if (p.captureBodies !== undefined) await cdp(daemon).captureBodies(ref, p.captureBodies);
    const capturing = Boolean(lane?.isCapturing(ref));
    const list = daemon.requests.get(tabKey(ref.instanceId, ref.tabId)) ?? [];
    const kind = (/** @type {string} */ t) => (t === "main_frame" || t === "sub_frame" ? "document" : t === "xmlhttprequest" ? "xhr" : t === "ping" || t === "csp_report" ? "other" : t);
    if (p.id !== undefined) {
      const entry = list.find((r) => r.id === p.id);
      if (!entry) throw new BctlError("INVALID_PARAMS", `no request ${p.id} in this tab`);
      const request = { id: entry.id, method: entry.method, url: entry.url, type: kind(entry.type), status: entry.status, requestHeaders: entry.requestHeaders, responseHeaders: entry.responseHeaders ?? {}, timing: { ms: entry.ms }, error: entry.error };
      if (p.body) {
        const body = lane ? await lane.responseBody(ref, entry) : null;
        if (!body) throw new BctlError("BODY_UNAVAILABLE", `no captured body for request ${p.id}`);
        Object.assign(request, body);
      }
      return { lane: capturing ? "cdp" : "dom", request, capturingBodies: capturing };
    }
    const matches = p.filter ? urlMatcher(p.filter, "filter") : () => true;
    const requests = list
      .filter((r) => (p.since === undefined || r.id > p.since) && matches(r.url) && (!p.types || p.types.includes(kind(r.type))))
      .slice(-p.limit)
      .reverse()
      .map((r) => ({ id: r.id, method: r.method, url: r.url, type: kind(r.type), status: r.status, ms: r.ms }));
    return { lane: capturing ? "cdp" : "dom", requests, capturingBodies: capturing };
  },
};

/** @type {import("../registry.js").Tool} */
export const run = {
  name: "run",
  description:
    "Run Playwright code for anything the other tools do not cover (drag, coordinates, routes, cookies, emulation, loops). page, context and a persistent state object are in scope; return a value. Shows Chrome's debugging bar while running.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", minLength: 1 }, timeout: { type: "number", minimum: 1, maximum: 600, default: 60 }, tab },
    required: ["code"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const r = await cdp(daemon).run(session, ref, p.code, p.timeout);
    return { lane: "cdp", ...finish(r.value), console: r.console };
  },
};

export { trusted };
