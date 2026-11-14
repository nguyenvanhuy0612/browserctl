// @ts-check
// click, hover, type, fill_form, press_key, scroll, file_upload, handle_dialog
// (specs/tools/*.md). DOM lane by default; `trusted` goes to the CDP lane.
import fs from "node:fs";
import path from "node:path";
import { Daemon } from "../app.js";
import { BctlError, toBctlError } from "../errors.js";
import { charsOf, parseChord } from "../keys.js";
import { by, cdp, noEffectHint, tab, target, trusted } from "./common.js";

/** @typedef {import("../sessions.js").TabRef} TabRef */

/** @type {import("../registry.js").Tool} */
export const click = {
  name: "click",
  description:
    "Click an element. target: a ref from snapshot (e5) or a Playwright selector (text=Save, role=button[name=\"Save\"], #id). Works in background tabs. trusted: true sends real mouse input for sites that ignore synthetic clicks (shows Chrome's debugging bar). Returns the element hit and what changed (url, new tabs, dialogs, DOM).",
  inputSchema: {
    type: "object",
    properties: {
      target,
      button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
      doubleClick: { type: "boolean", default: false },
      modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] }, uniqueItems: true, default: [] },
      trusted,
      tab,
    },
    required: ["target"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    if (p.trusted) {
      const { result, outcome } = await daemon.act(ref, () => cdp(daemon).click(ref, p));
      return { lane: "cdp", resolved: { by: by(p.target), ...result.resolved }, outcome, hint: null };
    }
    const { result, outcome } = await daemon.act(ref, () =>
      daemon.retrying(() => daemon.dom(ref, "click", { target: p.target, button: p.button, doubleClick: p.doubleClick, modifiers: p.modifiers }, { frameId })),
    );
    return { lane: "dom", resolved: { by: by(p.target), ...result.resolved }, outcome, hint: noEffectHint(outcome, "click") };
  },
};

/** @type {import("../registry.js").Tool} */
export const hover = {
  name: "hover",
  description:
    "Hover over an element to open its menu or tooltip. Menus that open only through CSS :hover need trusted: true (real pointer; shows Chrome's debugging bar).",
  inputSchema: { type: "object", properties: { target, trusted, tab }, required: ["target"] },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    if (p.trusted) {
      const { result, outcome } = await daemon.act(ref, () => cdp(daemon).hover(ref, p));
      return { lane: "cdp", resolved: { by: by(p.target), ...result.resolved }, outcome, hint: null };
    }
    const { result, outcome } = await daemon.act(ref, () =>
      daemon.retrying(() => daemon.dom(ref, "hover", { target: p.target }, { frameId: Daemon.frameOf(p.target) })),
    );
    const hint = noEffectHint(outcome, "hover") ? "Nothing opened. Menus shown by CSS :hover need trusted: true." : null;
    return { lane: "dom", resolved: { by: by(p.target), ...result.resolved }, outcome, hint };
  },
};

/**
 * Presses one key through the lane chosen by `trusted`.
 * @param {Daemon} daemon
 * @param {TabRef} ref
 * @param {{key: string, target?: string, trusted?: boolean}} p
 */
async function pressKey(daemon, ref, p) {
  const { modifiers, key } = parseChord(p.key);
  if (p.trusted) return cdp(daemon).press(ref, { key: p.key, target: p.target });
  return daemon.retrying(() => daemon.dom(ref, "press", { target: p.target, key, modifiers }, { frameId: Daemon.frameOf(p.target) }));
}

/** @type {import("../registry.js").Tool} */
export const type = {
  name: "type",
  description:
    "Replace the text of an input, textarea or rich-text field. target: a ref or selector. submit: true presses Enter after. slowly: true types key by key for autocomplete fields. Returns the field's value afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      target,
      text: { type: "string" },
      submit: { type: "boolean", default: false },
      slowly: { type: "boolean", default: false },
      trusted,
      tab,
    },
    required: ["target", "text"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    const { result, outcome } = await daemon.act(ref, async () => {
      let r;
      if (p.trusted) r = await cdp(daemon).type(ref, p);
      else if (p.slowly) {
        await daemon.retrying(() => daemon.dom(ref, "fill", { target: p.target, value: "" }, { frameId }));
        r = await daemon.dom(ref, "typeChars", { target: p.target, chars: charsOf(p.text) }, { frameId });
      } else r = await daemon.retrying(() => daemon.dom(ref, "fill", { target: p.target, value: p.text }, { frameId }));
      if (p.submit) await pressKey(daemon, ref, { key: "Enter", target: p.target, trusted: p.trusted });
      return r;
    });
    return { lane: p.trusted ? "cdp" : "dom", resolved: { by: by(p.target), ...result.resolved }, value: result.value, outcome };
  },
};

/** @type {import("../registry.js").Tool} */
export const fill_form = {
  name: "fill_form",
  description:
    "Set several form controls at once: fields: [{target, value}]. value is a string for text fields and selects (option value or label), true/false for checkboxes, radios and switches, a list for multi-selects. Stops at the first field that fails and says which.",
  inputSchema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            target,
            value: { anyOf: [{ type: "string" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] },
          },
          required: ["target", "value"],
          additionalProperties: false,
        },
      },
      trusted,
      tab,
    },
    required: ["fields"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    /** @type {any[]} */
    const done = [];
    /** @type {{index: number, error: object} | null} */
    let failed = null;
    const { outcome } = await daemon.act(ref, async () => {
      for (const [index, field] of p.fields.entries()) {
        const frameId = Daemon.frameOf(field.target);
        try {
          const { kind, multiple } = await daemon.retrying(() => daemon.dom(ref, "kind", { target: field.target }, { frameId }));
          const value = field.value;
          let r;
          if (kind === "checkable") {
            if (typeof value !== "boolean") throw new BctlError("INVALID_PARAMS", `field ${index}: ${field.target} is a checkbox, radio or switch; value must be true or false`);
            r = p.trusted ? await cdp(daemon).check(ref, field.target, value) : await daemon.retrying(() => daemon.dom(ref, "check", { target: field.target, checked: value }, { frameId }));
          } else if (kind === "select") {
            if (typeof value === "boolean" || (Array.isArray(value) && !multiple)) {
              throw new BctlError("INVALID_PARAMS", `field ${index}: ${field.target} is a ${multiple ? "multiple " : ""}select; value must be ${multiple ? "a string or a list" : "a string"}`);
            }
            const values = Array.isArray(value) ? value : [value];
            r = p.trusted ? await cdp(daemon).select(ref, field.target, values) : await daemon.retrying(() => daemon.dom(ref, "select", { target: field.target, values }, { frameId }));
          } else {
            if (typeof value !== "string") throw new BctlError("INVALID_PARAMS", `field ${index}: ${field.target} takes text; value must be a string`);
            r = p.trusted ? await cdp(daemon).type(ref, { target: field.target, text: value }) : await daemon.retrying(() => daemon.dom(ref, "fill", { target: field.target, value }, { frameId }));
          }
          done.push({ target: field.target, ref: r.resolved?.ref ?? null, kind, value: r.value });
        } catch (error) {
          failed = { index, error: toBctlError(error).toJSON() };
          break;
        }
      }
    });
    return { lane: p.trusted ? "cdp" : "dom", fields: done, failed, outcome };
  },
};

/** @type {import("../registry.js").Tool} */
export const press_key = {
  name: "press_key",
  description:
    "Press a key or chord (Enter, Escape, Tab, ArrowDown, Control+A) on target or on the focused element. Enter submits forms, Tab moves focus. trusted: true for keys a site handles only from real keyboards.",
  inputSchema: { type: "object", properties: { key: { type: "string", minLength: 1 }, target, trusted, tab }, required: ["key"] },
  async handler(p, { daemon, session }) {
    parseChord(p.key);
    const ref = await daemon.tab(session, p.tab);
    const { result, outcome } = await daemon.act(ref, () => pressKey(daemon, ref, p));
    return { lane: p.trusted ? "cdp" : "dom", focused: result.focused ?? null, defaultAction: result.defaultAction ?? null, outcome };
  },
};

/** @type {import("../registry.js").Tool} */
export const scroll = {
  name: "scroll",
  description:
    "Scroll the page or a container (target), by direction and amount, or to: top | bottom; or bring target into view. Reports whether the end was reached and whether more content loaded. trusted: true uses real wheel input, needed for lazy loading in background tabs.",
  inputSchema: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "number", minimum: 1, maximum: 100000 },
      to: { type: "string", enum: ["top", "bottom"] },
      target: { ...target, description: "A scrollable container, or an element to bring into view." },
      trusted,
      tab,
    },
  },
  async handler(p, { daemon, session }) {
    if (p.to && (p.direction || p.amount !== undefined)) throw new BctlError("INVALID_PARAMS", "to cannot be combined with direction or amount");
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    if (p.trusted) {
      const { result, outcome } = await daemon.act(ref, () => cdp(daemon).wheel(ref, p));
      return { lane: "cdp", ...result, outcome, hint: null };
    }
    const { result, outcome } = await daemon.act(ref, () => daemon.dom(ref, "scroll", { target: p.target, direction: p.direction, amount: p.amount, to: p.to }, { frameId }));
    if (result.intoView) return { lane: "dom", before: null, after: null, atEnd: false, contentGrew: false, intoView: result.intoView, outcome, hint: null };
    const metrics = await daemon.dom(ref, "scrollMetrics", { target: p.target }, { frameId });
    const contentGrew = metrics.scrollHeight > result.scrollHeight;
    const info = await daemon.dom(ref, "info");
    const hint =
      info.visibility === "hidden" && result.atEnd && !contentGrew
        ? "Background tabs do not render, so content that loads on scroll does not load here. Retry with trusted: true."
        : null;
    return { lane: "dom", before: result.before, after: result.after, atEnd: result.atEnd && !contentGrew, contentGrew, outcome, hint };
  },
};

const MIME = /** @type {Record<string, string>} */ ({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
  ".zip": "application/zip", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
});
const DOM_LANE_UPLOAD_LIMIT = 25 * 1024 * 1024;

/** @type {import("../registry.js").Tool} */
export const file_upload = {
  name: "file_upload",
  description: "Attach local files (absolute paths) to a file input or to the upload button that opens a file chooser. paths: [] clears it. Returns the files as the page sees them.",
  inputSchema: {
    type: "object",
    properties: { target, paths: { type: "array", items: { type: "string", minLength: 1 } }, tab },
    required: ["target", "paths"],
  },
  async handler(p, { daemon, session }) {
    const files = [];
    let total = 0;
    for (const file of p.paths) {
      if (!path.isAbsolute(file)) throw new BctlError("FILE_NOT_FOUND", `${file} is not an absolute path`);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        throw new BctlError("FILE_NOT_FOUND", `${file} does not exist`);
      }
      if (!stat.isFile()) throw new BctlError("FILE_NOT_FOUND", `${file} is not a file`);
      total += stat.size;
      files.push({ file, stat });
    }
    const ref = await daemon.tab(session, p.tab);
    const frameId = Daemon.frameOf(p.target);
    const probe = await daemon.retrying(() => daemon.dom(ref, "findFileInput", { target: p.target }, { frameId }));
    if (!probe.found || total > DOM_LANE_UPLOAD_LIMIT) {
      const { result, outcome } = await daemon.act(ref, () => cdp(daemon).upload(ref, p.target, p.paths));
      return { lane: "cdp", files: result.files, outcome };
    }
    const payloads = files.map(({ file, stat }) => ({
      name: path.basename(file),
      mimeType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      buffer: fs.readFileSync(file).toString("base64"),
      lastModifiedMs: stat.mtimeMs,
    }));
    const { result, outcome } = await daemon.act(ref, () => daemon.dom(ref, "setFiles", { target: p.target, files: payloads }, { frameId, timeoutMs: 60_000 }));
    return { lane: "dom", files: result.files, outcome };
  },
};

/** @type {import("../registry.js").Tool} */
export const handle_dialog = {
  name: "handle_dialog",
  description:
    "Set how dialogs in your tab are answered: accept: true/false, promptText, scope: next | always. By default alert is accepted and confirm/prompt are dismissed; actions report each dialog and the answer given. To accept a dismissed confirm, call this and repeat the action. trusted: true also answers a dialog that is blocking the page now (DIALOG_OPEN).",
  inputSchema: {
    type: "object",
    properties: {
      accept: { type: "boolean" },
      promptText: { type: "string" },
      scope: { type: "string", enum: ["next", "always"], default: "next" },
      trusted,
      tab,
    },
    required: ["accept"],
  },
  async handler(p, { daemon, session }) {
    const ref = await daemon.tab(session, p.tab);
    const owner = daemon.sessions.ownerOf(ref.instanceId, ref.tabId);
    const answer = p.accept ? "accept" : "dismiss";
    const policy = { alert: "accept", confirm: answer, prompt: answer, ...(p.promptText !== undefined && { promptText: p.promptText }), scope: p.scope };
    if (owner) {
      owner.dialogPolicy = policy;
      daemon.sessions.persist();
    }
    await daemon.armDialogs(ref, policy).catch(() => {});
    const answered = p.trusted ? await cdp(daemon).answerDialog(ref, p.accept, p.promptText) : null;
    return { policy, answered };
  },
};
