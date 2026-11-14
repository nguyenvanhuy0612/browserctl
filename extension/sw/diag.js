// @ts-check
// Diagnostics without the console: anything logged as an error by an extension lands on its
// chrome://extensions Errors page, so caught problems go to a ring the daemon reads, and to the
// daemon as events when connected (specs/architecture.md, extension error handling).

/** @typedef {{at: number, where: string, message: string}} DiagEntry */

/** @type {DiagEntry[]} */
const ring = [];
const LIMIT = 200;
/** @type {((entry: DiagEntry) => void) | null} */
let forward = null;

/** @param {(entry: DiagEntry) => void} sink */
export function forwardDiagnostics(sink) {
  forward = sink;
}

/** @param {string} where @param {unknown} error */
export function note(where, error) {
  const entry = { at: Date.now(), where, message: String(/** @type {any} */ (error)?.message ?? error).slice(0, 500) };
  ring.push(entry);
  if (ring.length > LIMIT) ring.shift();
  try {
    forward?.(entry);
  } catch {
    // The sink is the socket; a failure here is already a closed connection.
  }
}

export function readDiagnostics() {
  return ring.slice();
}

/**
 * Wraps a listener so nothing it throws or rejects escapes to the extension's context.
 * @template {any[]} A
 * @param {string} where
 * @param {(...args: A) => unknown} fn
 * @returns {(...args: A) => void}
 */
export function guarded(where, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof (/** @type {any} */ (result).then) === "function") {
        /** @type {Promise<unknown>} */ (result).catch((error) => note(where, error));
      }
    } catch (error) {
      note(where, error);
    }
  };
}
