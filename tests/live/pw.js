// @ts-check
// Playwright's page API, as far as the adopted Playwright cases use it, mapped onto browserctl
// tools: an adopted case keeps its shape and runs in the DOM lane or, with lane "cdp", with
// trusted: true. A tool error is thrown as a PwError carrying the browserctl code.

export class PwError extends Error {
  /** @param {{code: string, message: string}} error */
  constructor(error) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
  }
}

/** Lanes an adopted case runs in. */
export const LANES = /** @type {const} */ (["dom", "cdp"]);

/** @param {Function | string} fn @param {unknown[]} args */
function call(fn, args) {
  if (typeof fn === "string") return `() => (${fn})`;
  return `() => (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
}

/** Playwright timeouts are milliseconds and 0 means none; browserctl takes seconds up to 60. @param {number | undefined} ms */
const seconds = (ms) => (ms === undefined ? undefined : ms === 0 ? 60 : ms / 1000);

/**
 * @param {import("./harness.js").Harness} h
 * @param {string} session
 * @param {"dom" | "cdp"} lane
 */
export function pwPage(h, session, lane) {
  const trusted = lane === "cdp" ? { trusted: true } : {};
  /** @param {string} tool @param {object} params */
  const ok = async (tool, params) => {
    const r = await h.call(tool, params, session);
    if (!r.ok) throw new PwError(r.error);
    return r;
  };
  /** One fill_form field; a failed field is thrown like a failed tool call. @param {string} selector @param {unknown} value @param {{timeout?: number}} options */
  const setField = async (selector, value, options) => {
    const r = await ok("fill_form", { fields: [{ target: selector, value }], ...(options.timeout !== undefined && { timeout: seconds(options.timeout) }), ...trusted });
    if (r.failed) throw new PwError(r.failed.error);
    return r;
  };
  const page = {
    lane,
    session,
    /** @param {string} url */
    goto: (url) => ok("navigate", { url }),
    /** @param {string} html */
    setContent: (html) => ok("navigate", { url: h.content(html) }),
    /** Evaluates in the page; Playwright's `undefined` comes back as `null`. @param {Function | string} fn @param {unknown[]} args */
    evaluate: async (fn, ...args) => (await ok("evaluate", { function: call(fn, args), ...trusted })).value,
    /** @param {string} selector @param {Function} fn @param {unknown[]} args */
    $eval: async (selector, fn, ...args) =>
      (await ok("evaluate", { function: `(el) => (${fn.toString()})(el, ${args.map((a) => JSON.stringify(a)).join(", ")})`, target: selector, ...trusted })).value,
    /**
     * @param {string} selector
     * @param {{button?: "left" | "middle" | "right", clickCount?: number, modifiers?: string[], timeout?: number, position?: unknown}} [options]
     */
    click: (selector, options = {}) =>
      ok("click", {
        target: selector,
        ...(options.button && { button: options.button }),
        ...(options.clickCount === 2 && { doubleClick: true }),
        ...(options.modifiers && { modifiers: options.modifiers }),
        ...(options.timeout !== undefined && { timeout: seconds(options.timeout) }),
        ...trusted,
      }),
    /** @param {string} selector @param {{timeout?: number}} [options] */
    dblclick: (selector, options = {}) => page.click(selector, { ...options, clickCount: 2 }),
    /** @param {string} selector @param {{timeout?: number}} [options] */
    hover: (selector, options = {}) => ok("hover", { target: selector, ...(options.timeout !== undefined && { timeout: seconds(options.timeout) }), ...trusted }),
    /** @param {string} selector @param {string} value @param {{timeout?: number}} [options] */
    fill: (selector, value, options = {}) => ok("type", { target: selector, text: value, ...(options.timeout !== undefined && { timeout: seconds(options.timeout) }), ...trusted }),
    /** @param {string} selector @param {boolean} checked @param {{timeout?: number}} [options] */
    setChecked: (selector, checked, options = {}) => setField(selector, checked, options),
    /** @param {string} selector @param {{timeout?: number}} [options] */
    check: (selector, options = {}) => page.setChecked(selector, true, options),
    /** @param {string} selector @param {{timeout?: number}} [options] */
    uncheck: (selector, options = {}) => page.setChecked(selector, false, options),
    /** @param {string} selector @param {string | string[]} values @param {{timeout?: number}} [options] */
    selectOption: (selector, values, options = {}) => setField(selector, values, options),
    /** @param {string} selector @param {string} key */
    press: (selector, key) => ok("press_key", { key, target: selector, ...trusted }),
    keyboard: {
      /** @param {string} key */
      press: (key) => ok("press_key", { key, ...trusted }),
      /** @param {string} text */
      type: (text) => ok("type", { target: "*:focus", text, slowly: true, ...trusted }),
    },
    /** @param {string} selector @param {string[]} paths */
    setInputFiles: (selector, paths) => ok("file_upload", { target: selector, paths }),
    /** @param {string} selector @param {{state?: string, timeout?: number}} [options] */
    waitForSelector: (selector, options = {}) =>
      ok("wait_for", { target: selector, ...(options.state && { state: options.state }), timeout: seconds(options.timeout ?? 10000) }),
    /** The page's title. */
    title: async () => (await ok("evaluate", { function: "() => document.title" })).value,
    /** The page's URL. */
    url: async () => (await ok("evaluate", { function: "() => location.href" })).value,
  };
  return page;
}

/**
 * Asserts that `promise` fails with a browserctl error code.
 * @param {Promise<unknown>} promise @param {string} code
 */
export async function failsWith(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PwError && error.code === code) return /** @type {PwError} */ (error);
    throw error;
  }
  throw new Error(`expected ${code}, the call succeeded`);
}
