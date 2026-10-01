// The session target of one MCP server process: the browser alias and tab id that every call
// naming no tab goes to. Pure state; nothing here talks to the bridge.
export function createTarget() {
  let current = null;
  // The url and title the target was last seen with, for the result that reports it
  let detail = {};
  // {browser, tabId, code} after the target failed with TARGET_CLOSED, TARGET_TAKEN or
  // BROWSER_DISCONNECTED; cleared only by set (a select or new)
  let gone = null;

  return {
    get() {
      return current ? { ...current } : null;
    },

    // The target with the url and title it was set with
    described() {
      return current ? { ...current, url: detail.url, title: detail.title } : null;
    },

    set({ browser, tabId, url, title }) {
      current = { browser, tabId };
      detail = { url, title };
      gone = null;
    },

    clear() {
      current = null;
      detail = {};
    },

    // A closed or taken tab leaves the session with no target. A disconnected browser keeps it, so calls
    // resume on it once that browser (the same alias) is connected again.
    markGone(code) {
      if (!current) return;
      gone = { ...current, code };
      if (code === "TARGET_CLOSED" || code === "TARGET_TAKEN") this.clear();
    },

    gone() {
      return gone ? { ...gone } : null;
    },

    // A call reached the kept target again: its browser is back
    resumed() {
      if (gone && current && gone.code === "BROWSER_DISCONNECTED") gone = null;
    },
  };
}
