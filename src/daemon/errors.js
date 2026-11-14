// @ts-check
// Error codes and their default hints (specs/errors.md). A code is added to the spec before it is
// used here.

/** @type {Record<string, string>} */
export const HINTS = {
  INVALID_PARAMS: "Check the parameter names and types in the tool's schema.",
  NO_BROWSER: "No browser is connected. Load the browserctl extension (browserctl extension path) and check status.",
  AMBIGUOUS_BROWSER: "Several browsers are connected. Pick one: tabs({action: \"new\", browser: \"<alias>\"}).",
  EXTENSION_OUTDATED: "Reload the browserctl extension in chrome://extensions so it matches the daemon.",
  NO_TAB: "Open or select a tab first: tabs({action: \"new\"}).",
  TAB_NOT_OWNED: "Use a tab from tabs({action: \"list\"}) marked as yours, or adopt it.",
  TAB_CLOSED: "The tab is gone. Check tabs({action: \"list\"}).",
  PAGE_UNSCRIPTABLE: "Extensions cannot act on this page. Navigate elsewhere.",
  INVALID_TARGET: "Use a ref from snapshot (e5) or a valid Playwright selector.",
  REF_NOT_FOUND: "The element is gone or the page changed. Take a new snapshot.",
  TARGET_NOT_FOUND: "Nothing matches. Take a snapshot and use a ref.",
  AMBIGUOUS_TARGET: "Several elements match. Use one ref from snapshot.",
  TARGET_HIDDEN: "The element is not visible. Open its menu or section first.",
  TARGET_DISABLED: "The element is disabled. Fill the required fields or wait.",
  TARGET_COVERED: "Another element is on top. Close or click it first.",
  TARGET_NOT_EDITABLE: "This element does not take text. Target the input itself.",
  OPTION_NOT_FOUND: "Read the select's options with snapshot and pass an option value or label.",
  DIALOG_OPEN: "A native dialog blocks the page: handle_dialog({accept: true or false, trusted: true}).",
  NAVIGATION_FAILED: "The page did not load. Check the URL or the network.",
  FILE_NOT_FOUND: "Pass absolute paths of existing files on this machine.",
  BODY_UNAVAILABLE: "Turn on network_requests({captureBodies: true}) and repeat the action.",
  EVAL_ERROR: "Fix the code; the message has the page's error.",
  USER_SCRIPTS_OFF: "Turn on 'Allow User Scripts' for browserctl in chrome://extensions, or retry with trusted: true.",
  DEBUGGER_CANCELED: "The user stopped debugging in this browser. Retry without trusted, or ask the user and call status({allowDebugger: true}).",
  DEBUGGER_BUSY: "Another debugger (DevTools) is attached to this tab. Close it there, or retry without trusted.",
  TIMEOUT: "The call took too long. Check the page with snapshot.",
  INTERNAL_ERROR: "A fault in browserctl. Retry once; if it repeats, report it with the call log.",
};

export class BctlError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{hint?: string, [key: string]: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    if (!(code in HINTS)) {
      this.message = `${message} (unknown error code ${code})`;
      code = "INTERNAL_ERROR";
    }
    this.code = code;
    const { hint, ...rest } = extra;
    this.hint = hint ?? HINTS[code];
    this.extra = rest;
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, ...this.extra };
  }
}

// Codes the extension or the page runtime use internally, mapped to public ones.
const INTERNAL_CODES = /** @type {Record<string, string>} */ ({
  FRAME_GONE: "REF_NOT_FOUND",
  UNKNOWN_METHOD: "EXTENSION_OUTDATED",
  UNKNOWN_OP: "EXTENSION_OUTDATED",
  NOT_ATTACHED: "INTERNAL_ERROR",
  CDP_ERROR: "INTERNAL_ERROR",
  DEBUGGER_ERROR: "INTERNAL_ERROR",
  SCRIPTING_ERROR: "INTERNAL_ERROR",
  TABS_ERROR: "INTERNAL_ERROR",
  RUNTIME_ERROR: "INTERNAL_ERROR",
  EXTENSION_ERROR: "INTERNAL_ERROR",
  INPUT_TIMEOUT: "TIMEOUT",
  RUNTIME_MISSING: "INTERNAL_ERROR",
});

/** @param {unknown} error @returns {BctlError} */
export function toBctlError(error) {
  if (error instanceof BctlError) return error;
  const e = /** @type {any} */ (error);
  const raw = typeof e?.code === "string" ? e.code : "INTERNAL_ERROR";
  const code = INTERNAL_CODES[raw] ?? raw;
  const { code: _c, message: _m, ok: _o, ...extra } = typeof e === "object" && e !== null && !(e instanceof Error) ? e : {};
  return new BctlError(code in HINTS ? code : "INTERNAL_ERROR", String(e?.message ?? e), extra);
}
