# Settle: when an action is finished

Status: approved
Depends on: `dom-lane.md`, `sessions.md`

An action returns after the page has reacted, so the agent's next read sees the result (spike:
a click returned before Facebook rendered Marketplace).

## Signals

| Signal | Source | Works in background tabs |
| --- | --- | --- |
| navigation started / committed / DOMContentLoaded / history state updated, per frame | `chrome.webNavigation` events in the extension | yes |
| DOM mutation count | a `MutationObserver` in the DOM-lane runtime (microtasks, not rendering) | yes |
| new tabs | `chrome.tabs.onCreated` with `openerTabId` | yes |
| dialogs | the dialog shim log (DOM lane), `Page.javascriptDialogOpening` (CDP lane) | yes |

Page timers are throttled to one per second in background tabs, so all waiting is done by the
daemon polling the runtime, never by `setTimeout` inside the page.

## Algorithm

1. Before the action: read the URL, title and mutation count.
2. After the action, for up to 500 ms: watch for a main-frame navigation start.
3. If a navigation started: wait for commit, then `DOMContentLoaded`, at most 10 s
   (running out is not an error: `settled: false`). The runtime is re-injected on demand.
4. Then poll the mutation count every 100 ms until it is unchanged for 300 ms, at most 3 s from
   the action.
5. Report `urlChanged`, `url`, `title`, `newTabs`, `dialogs`, `domChanged`, `settled`.

The numbers (500 ms, 300 ms, 3 s, 10 s) are measured against Facebook and the fixture pages during
implementation and updated here with the measurement.

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SET-E01 | live | click that changes nothing | returns in about 300 ms, `domChanged: false` |
| SET-E02 | live | DOM change 1 s after the click | `domChanged: true`, waited for it |
| SET-E03 | live | ticker mutating forever | returns at 3 s, `settled: false` |
| SET-E04 | live | link to a slow page (2 s server delay) | waits for commit, `urlChanged` |
| SET-E05 | live | SPA `pushState` navigation | `urlChanged`, no full navigation wait |
| SET-E06 | live | background tab | same results as foreground (no in-page timers) |
| Playwright CL-067, CL-068, CL-069, CL-076 | live | navigation during the click, frame detached | no protocol error, no hang |
| SET-S01 | site | Facebook Marketplace click | snapshot after the result shows Marketplace content |
