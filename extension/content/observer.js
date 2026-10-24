// DOM Mutation Observer & Cache Invalidator for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

let activeObserver = null;
let debounceTimer = null;

/**
 * Initializes a MutationObserver on document.body or documentElement
 * to detect DOM tree mutations and trigger invalidation callbacks.
 *
 * @param {function} callback - Function called when mutations occur.
 * @param {object} [options]
 * @param {number} [options.debounceMs=50] - Debounce delay in ms.
 * @returns {MutationObserver|null} Active observer instance.
 */
export function initMutationObserver(callback, { debounceMs = 50 } = {}) {
  if (typeof MutationObserver === "undefined") return null;
  if (typeof document === "undefined") return null;

  const target = document.body || document.documentElement;
  if (!target) return null;

  if (activeObserver) {
    try {
      activeObserver.disconnect();
    } catch {}
    activeObserver = null;
  }

  activeObserver = new MutationObserver((mutations) => {
    if (debounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (typeof callback === "function") callback(mutations);
      }, debounceMs);
    } else {
      if (typeof callback === "function") callback(mutations);
    }
  });

  activeObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  return activeObserver;
}

/**
 * Disconnects the active mutation observer if running.
 */
export function disconnectObserver() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (activeObserver) {
    try {
      activeObserver.disconnect();
    } catch {}
    activeObserver = null;
  }
}
