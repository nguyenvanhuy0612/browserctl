# CDP lane: relay and Playwright

Status: verified (2026-11-21: lifecycle events after the frame tree)
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
| Answer `Browser.getVersion`, `Target.setAutoAttach`, `Target.getTargets`, `Target.getTargetInfo`, `Target.attachToTarget`, `Target.attachToBrowserTarget`, `Target.detachFromTarget`, `Target.createTarget` (inactive tab owned by the session), `Target.closeTarget`, `Target.activateTarget`, `Browser.setDownloadBehavior`, `Target.setDiscoverTargets`, `Target.getBrowserContexts` in the relay | `chrome.debugger` has no browser target |
| Answer `Browser.close` with `{}` and never forward it | the browser is the user's |
| Other browser-level commands go through any attached tab | `Storage.*` and similar work on a tab session |
| `Runtime.enable` and `Page.setLifecycleEventsEnabled` wait for an in-flight `Page.getFrameTree` on the same session | Chrome reports existing contexts and the current lifecycle at once, and Playwright drops contexts of frames it has not seen (BrowserMCP relay) and lifecycle events that come before its frame tree, because it starts listening for them only then; through the extension those events can overtake the frame tree's answer (measured 2026-11-21: `page.waitForLoadState()` in `run` on a loaded tab hung in 2 of 8 runs) |
| Journal state-setting commands (`*.enable`, `Emulation.set*`, `Network.set*`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`, `Target.setAutoAttach`, `Fetch.enable`); replay them after a re-attach, mapping script identifiers | idle detach must not lose Playwright's setup |
| After a re-attach, send `Runtime.executionContextsCleared` to Playwright before replaying | context ids change across attachments (uniqueId does not); hiding the change broke `evaluate` |
| Re-attach before handing work to Playwright (`wake`), not inside its first command | Playwright then sees the new contexts before it sends anything |
| A tab's `chrome.debugger` attachment is one CDP session shared by every relay on it (the daemon's and each `run` worker's). Chrome reports existing execution contexts only to the first `Runtime.enable` on a session, so the attachments keep each session's live contexts (the tab's and each child frame's, from `Runtime.executionContextCreated`, `…Destroyed`, `…sCleared`; reset on attach) and a relay replays them, as `Runtime.executionContextCreated` to that client only, after a `Runtime.enable` that another client already sent. The journal replay after a re-attach counts as such a `Runtime.enable` (so a client that connects later still gets the contexts), and a `Runtime.disable` that reaches Chrome forgets that session's contexts | measured 2026-11-15: `page.evaluate` in `run` hung, because the worker's Playwright never saw the main world (`page.title()`, which runs in Playwright's own isolated world, worked) |
| Before the first `Input.*` command on a document, wait until it has a first contentful paint or is 550 ms old (`performance.now()`); checked once per document (again after a main-frame navigation or a re-attach) | measured 2026-11-15 on Chrome for Testing 158, background tab, a page that paints nothing contentful (a blank canvas): trusted input sent at 303 or 456 ms after navigation start was dropped, at 555 and 655 ms it landed (2 runs); pages with text were not affected; a fixed wait after attaching or waiting for two animation frames did not help |
| An event of a domain goes only to the client sessions that sent a command of that domain (and did not disable it), on the tab's session and on each child frame's session alike; `Target.*` and `Inspector.*` go to the tab's primary session, and a child session's to every client that knows it. A `*.disable` is forwarded only when no session of any relay still uses the domain on that CDP session | the attachment is shared: measured 2026-11-15, the daemon's Playwright received the `Fetch.requestPaused` events of a `run` worker's `page.route` and continued the requests before the worker's handler answered |
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
| RLY-U04 | unit | `Runtime.enable` and `Page.setLifecycleEventsEnabled` racing `Page.getFrameTree` | each sent after the frame tree came back |
| RLY-E07 | live | `run` on a loaded tab: `page.waitForLoadState()` for `domcontentloaded` and `load`, 8 times, each on a new tab | each resolves |
| RLY-U05 | unit | `canceled_by_user` | all targets dropped, event raised |
| RLY-U06 | unit | two relays: the second's `Runtime.enable`; then a detach, the first's journal replay, and a third relay's `Runtime.enable` | the second and the third client each get the live contexts, once |
| RLY-U07 | unit | two relays use `Network`; one disables it, then the other; `Runtime.disable` then `Runtime.enable` | the first disable is not sent, the second is; after the re-enable each context arrives once |
| RLY-U08 | unit | `Fetch` used by one relay on the tab's session and on a child frame's session | `Fetch.requestPaused` reaches that relay's client only, on both sessions |
| RLY-E01 | live | background tab trusted click, fill, screenshot | `isTrusted: true`, user's tab unchanged |
| RLY-E02 | live | idle detach, `wake`, `evaluate` | works |
| RLY-E03 | live | service worker stopped while a tab is attached | the extension reconnects; the daemon drops the old connection's attachments and the next `trusted` call attaches again and works |
| RLY-E04 | live | stale attachment from a killed daemon | detached on reconnect |
| RLY-E05 | live | trusted click on a canvas in a background tab that was never attached | the handler fires once |
| RLY-E06 | live | `run` returning `page.evaluate(() => 1 + 1)` after a `trusted` call attached the tab | `2` |
