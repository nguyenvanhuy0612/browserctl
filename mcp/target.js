// The session target of one MCP server process: the browser alias and tab id that every call
// naming no tab goes to, plus which browser owns each tab id seen in a listing, so that a call
// naming a tab id reaches the browser that has it. Pure state; nothing here talks to the bridge.
export function createTarget() {
  let current = null;
  // The url and title the target was last seen with, for the result that reports it
  let detail = {};
  // {browser, tabId, code} after the target failed with TARGET_CLOSED or BROWSER_DISCONNECTED;
  // cleared only by set (a select or new)
  let gone = null;
  // alias -> Set<tabId>, as of that browser's last listing
  const tabsByBrowser = new Map();

  function ownersOf(tabId) {
    const owners = [];
    for (const [alias, ids] of tabsByBrowser) if (ids.has(tabId)) owners.push(alias);
    return owners;
  }

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

    // A closed tab leaves the session with no target. A disconnected browser keeps it, so calls
    // resume on it once that browser (the same alias) is connected again.
    markGone(code) {
      if (!current) return;
      gone = { ...current, code };
      if (code === "TARGET_CLOSED") this.clear();
    },

    gone() {
      return gone ? { ...gone } : null;
    },

    // A call reached the kept target again: its browser is back
    resumed() {
      if (gone && current && gone.code === "BROWSER_DISCONNECTED") gone = null;
    },

    // Each browser present in `tabs`, and each alias in `listed`, gets its tab set replaced by
    // what this listing holds; a browser in neither keeps what it had.
    noteTabs(tabs, listed = []) {
      const fresh = new Map(listed.map((alias) => [alias, new Set()]));
      for (const t of tabs || []) {
        if (!t || t.browser == null || t.id == null) continue;
        if (!fresh.has(t.browser)) fresh.set(t.browser, new Set());
        fresh.get(t.browser).add(t.id);
      }
      for (const [alias, ids] of fresh) tabsByBrowser.set(alias, ids);
    },

    ownersOf,

    // A named tab goes to its single known owner, or asks for a lookup when there is none or
    // more than one. No named tab: the target, or an empty route the bridge resolves.
    route({ tabId } = {}) {
      if (tabId != null) {
        const owners = ownersOf(tabId);
        if (owners.length === 1) return { browser: owners[0], tabId, needsLookup: false };
        return { browser: null, tabId, needsLookup: true };
      }
      if (current) return { ...current, needsLookup: false };
      return { browser: null, tabId: null, needsLookup: false };
    },
  };
}
