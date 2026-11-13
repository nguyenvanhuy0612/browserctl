# Multi-Agent Coordination

Guidelines for concurrent agent sessions and multi-browser operations.

## Tab Holds and Leases

- When an agent session acts on a tab, the bridge creates a transient lease for that session.
- During an active hold, actions from other agent sessions targeting the same tab fail with `TAB_OWNED` or `TAB_BUSY`.
- Leases expire automatically after an idle window (`LEASE_TTL_MS`), allowing other agents to acquire the tab cleanly.

## Resolving Conflicts

1. **`BROWSER_BUSY`**: Another agent is actively performing a mutating action in the browser.
   - Do not retry in a tight spin loop.
   - Wait for the indicated retry interval (`diagnostics.retryInMs`).
2. **`NEEDS_TARGET`**: Multiple browser instances (e.g. `chrome-1`, `edge-1`) or tabs exist.
   - Call `browser_tabs({ action: "list" })` to view ownership status across all tabs.
   - Explicitly bind to a free tab with `browser_tabs({ action: "select", tabId })`.
3. **`TARGET_TAKEN`**: Your previous tab was claimed by another session.
   - Open a fresh tab for your workflow using `browser_tabs({ action: "new", url })`.
