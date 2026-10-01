// Which browser has which tab id, as the bridge last saw it: tab ids are only unique within one
// browser, so a command naming a tab and no browser is routed from this.
export function createOwners() {
  // alias -> Set<tabId>
  const byBrowser = new Map();

  return {
    // A browser's full listing replaces what it owned before
    noteListing(alias, tabIds) {
      byBrowser.set(alias, new Set(tabIds));
    },
    add(alias, tabId) {
      if (!byBrowser.has(alias)) byBrowser.set(alias, new Set());
      byBrowser.get(alias).add(tabId);
    },
    remove(alias, tabId) {
      byBrowser.get(alias)?.delete(tabId);
    },
    ownersOf(tabId) {
      return [...byBrowser].filter(([, ids]) => ids.has(tabId)).map(([alias]) => alias);
    },
  };
}
