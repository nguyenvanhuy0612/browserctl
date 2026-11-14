// @ts-check
// Parameter schemas and helpers shared by the tools.
import { BctlError } from "../errors.js";

export const REF = /^(f\d+)?e\d+$/;

export const tab = { type: "integer", minimum: 0, description: "Tab id from tabs list. Default: your current tab." };
export const target = { type: "string", minLength: 1, description: "A ref from snapshot (e5) or a Playwright selector (text=Save, role=button[name=\"Save\"], #id)." };
export const trusted = { type: "boolean", default: false, description: "Real input through Chrome's debugger (shows its debugging bar)." };

/** @param {string} t */
export const by = (t) => (REF.test(t) ? "ref" : "selector");

/**
 * The CDP lane, used for `trusted: true` and the tools that need the debugger.
 * @param {import("../app.js").Daemon} daemon
 */
export function cdp(daemon) {
  const lane = /** @type {any} */ (daemon).cdp;
  if (!lane) throw new BctlError("INTERNAL_ERROR", "the CDP lane is not available in this daemon");
  return lane;
}

/** Hint for a DOM-lane action that changed nothing visible. @param {any} outcome @param {string} what */
export function noEffectHint(outcome, what) {
  if (outcome.urlChanged || outcome.domChanged || outcome.newTabs.length || outcome.dialogs.length) return null;
  return `The ${what} changed nothing on the page. If the site ignores synthetic events (or opens a popup with window.open), retry with trusted: true.`;
}
