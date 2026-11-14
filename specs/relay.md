# CDP lane: relay and Playwright

Status: approved
Depends on: `architecture.md`, `sessions.md`

Used only for what the DOM lane cannot do (`architecture.md`). Shows Chrome's debugging bar
while attached.

## Shape

- The extension attaches `chrome.debugger` to a tab when the daemon asks, and relays commands
  (`{tabId, sessionId?, method, params}`), events and detaches. It decides nothing else.
- The daemon runs one CDP relay per browser. It presents a browser-level CDP endpoint to
  `playwright-core` through `connectOverCDP(transport, {noDefaults: true})` (an in-process
  transport, no extra socket).

## Relay rules (each one is a spike result)

| Rule | Why |
| --- | --- |
| Answer `Browser.getVersion`, `Target.setAutoAttach`, `Target.getTargets`, `Target.getTargetInfo`, `Target.attachToTarget`, `Target.attachToBrowserTarget`, `Target.detachFromTarget`, `Target.createTarget` (inactive tab in the session group), `Target.closeTarget`, `Target.activateTarget`, `Browser.setDownloadBehavior`, `Target.setDiscoverTargets`, `Target.getBrowserContexts` in the relay | `chrome.debugger` has no browser target |
| Answer `Browser.close` with `{}` and never forward it | the browser is the user's |
| Other browser-level commands go through any attached tab | `Storage.*` and similar work on a tab session |
| `Runtime.enable` waits for an in-flight `Page.getFrameTree` on the same session | Playwright drops contexts of frames it has not seen (BrowserMCP relay) |
| Journal state-setting commands (`*.enable`, `Emulation.set*`, `Network.set*`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`, `Target.setAutoAttach`, `Fetch.enable`); replay them after a re-attach, mapping script identifiers | idle detach must not lose Playwright's setup |
| After a re-attach, send `Runtime.executionContextsCleared` to Playwright before replaying | context ids change across attachments (uniqueId does not); hiding the change broke `evaluate` |
| Re-attach before handing work to Playwright (`wake`), not inside its first command | Playwright then sees the new contexts before it sends anything |
| `Input.*` commands are serialized per tab with a 5 s timeout | a hidden tab can leave input unanswered (BrowserMCP measurement) |
| Focus emulation (`Emulation.setFocusEmulationEnabled`) on attach when the tab is in the background, journaled | background tabs render, take input, lazy load (spike: 0 → 60 rAF/s) |
| An attach refused with "another debugger is already attached" by our own stale attachment is detached and retried; by another client it is `DEBUGGER_BUSY` | daemon restarts |
| `canceled_by_user` drops every target of that browser and is reported (`sessions.md`) | Cancel on the bar |
| The daemon never calls Playwright's `browser.close()` on this connection | it hung in the spike |

## Measured

Chrome for Testing 158 and the owner's Chrome 157: Playwright sees claimed tabs; trusted click,
fill, wheel, lazy load and screenshots work in background tabs; the bar disappears 5.35 s after the
last detach; a stopped service worker keeps its attachments; Cancel arrives as
`canceled_by_user`; reloading the extension reconnects.

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| RLY-U01 | unit | fake extension: Playwright connects, one claimed tab | page listed |
| RLY-U02 | unit | `Browser.close` from the client | answered, not forwarded |
| RLY-U03 | unit | detach then command | re-attach, journal replayed in order, script ids mapped |
| RLY-U04 | unit | `Runtime.enable` racing `Page.getFrameTree` | contexts after frame tree |
| RLY-U05 | unit | `canceled_by_user` | all targets dropped, event raised |
| RLY-E01 | live | background tab trusted click, fill, screenshot | `isTrusted: true`, user's tab unchanged |
| RLY-E02 | live | idle detach, `wake`, `evaluate` | works |
| RLY-E03 | live | service worker stopped | attachments kept, socket reconnects |
| RLY-E04 | live | stale attachment from a killed daemon | detached on reconnect |
