// @ts-check
// Parameter schemas and helpers shared by the tools.
import { BctlError } from "../errors.js";
import { REF } from "../targets.js";

export { REF };

export const tab = { type: "integer", minimum: 0, description: "Tab id from tabs list. Default: your current tab." };
export const target = { type: "string", minLength: 1, description: "A ref (e5) or a locator (#id, label=Email, role=button[name=\"Save\"], ...)." };

// Common action parameters (specs/actions.md).
export const timeout = { type: "number", minimum: 0, maximum: 60, default: 5, description: "Seconds to wait for the target." };
export const scrollMode = {
  type: "string",
  enum: ["auto", "center", "none"],
  default: "auto",
};
export const waitCondition = {
  type: "object",
  description: "Then wait for one wait_for condition.",
  properties: {
    text: { type: "string", minLength: 1 },
    textGone: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    state: { enum: ["visible", "hidden", "attached", "detached"], default: "visible" },
    url: { type: "string", minLength: 1 },
    time: { type: "number", minimum: 0.1, maximum: 60 },
    timeout: { type: "number", minimum: 0.1, maximum: 60, default: 10 },
  },
  additionalProperties: false,
};

/** @param {any} wait */
export function checkWait(wait) {
  if (!wait) return;
  const conditions = ["text", "textGone", "target", "url", "time"].filter((k) => wait[k] !== undefined);
  if (conditions.length !== 1) throw new BctlError("INVALID_PARAMS", "wait: pass exactly one of text, textGone, target, url, time");
}
export const trusted = { type: "boolean", default: false, description: "Real input through Chrome's debugger (shows its debugging bar)." };

/** @param {string} t */
export const by = (t) => (REF.test(t) ? "ref" : "selector");

/**
 * A URL test from a parameter: `/regex/flags`, or else a substring. An invalid regex is the
 * caller's mistake (`network_requests` filter, `wait_for` url).
 * @param {string} pattern @param {string} name the parameter, for the error
 * @returns {(url: string) => boolean}
 */
export function urlMatcher(pattern, name) {
  if (!/^\/.*\/[a-z]*$/.test(pattern)) return (url) => url.includes(pattern);
  try {
    const regex = new RegExp(pattern.slice(1, pattern.lastIndexOf("/")), pattern.slice(pattern.lastIndexOf("/") + 1));
    return (url) => regex.test(url);
  } catch (error) {
    throw new BctlError("INVALID_PARAMS", `${name}: ${/** @type {Error} */ (error).message}`, { hint: `Pass a substring, or a valid /regex/.` });
  }
}

/**
 * The CDP lane, used for `trusted: true` and the tools that need the debugger.
 * @param {import("../app.js").Daemon} daemon
 */
export function cdp(daemon) {
  if (!daemon.cdp) throw new BctlError("INTERNAL_ERROR", "the CDP lane is not available in this daemon");
  return daemon.cdp;
}

/** Hint for a DOM-lane action that changed nothing visible. @param {any} outcome @param {string} what */
export function noEffectHint(outcome, what) {
  if (outcome.urlChanged || outcome.domChanged || outcome.newTabs.length || outcome.dialogs.length) return null;
  return `The ${what} changed nothing on the page. If the site ignores synthetic events (or opens a popup with window.open), retry with trusted: true.`;
}
