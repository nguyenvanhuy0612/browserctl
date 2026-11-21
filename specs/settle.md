# Settle: when an action is finished

Status: verified (2026-11-21: the quiet window ignores attribute changes)
Depends on: `dom-lane.md`, `sessions.md`

An action returns after the page has reacted, so the agent's next read sees the result (spike:
a click returned before Facebook rendered Marketplace).

## Signals

| Signal | Source | Works in background tabs |
| --- | --- | --- |
| navigation started / committed / DOMContentLoaded / history state updated, per frame | `chrome.webNavigation` events in the extension | yes |
| DOM mutation counts: every change, and content changes (nodes added or removed, text changed) | a `MutationObserver` in the DOM-lane runtime (microtasks, not rendering) | yes |
| new tabs | `chrome.tabs.onCreated` with `openerTabId` | yes |
| dialogs | the dialog shim log (DOM lane), `Page.javascriptDialogOpening` (CDP lane) | yes |

Page timers are throttled to one per second in background tabs, so all waiting is done by the
daemon polling the runtime, never by `setTimeout` inside the page.

## Algorithm

1. Before the action: read the URL, title and mutation count.
2. After the action, for up to 500 ms: watch for a main-frame navigation start.
3. If a navigation started: wait for commit, then `DOMContentLoaded`, at most 10 s
   (running out is not an error: `settled: false`). The runtime is re-injected on demand.
4. Then poll the content count every 100 ms until it is unchanged for 300 ms, at most 3 s from
   the action. Attribute changes do not count: a style animation, a progress bar or a video's
   time attribute changes them many times a second in a rendered tab, which would hold every
   action to the 3 s limit; a reaction that only toggles attributes happens in the action's own
   handler or with content around it.
5. Report `urlChanged`, `url`, `title`, `newTabs`, `dialogs`, `domChanged` (any mutation, attributes
   included), `settled`.

The numbers (500 ms, 300 ms, 3 s, 10 s) are measured against Facebook and the fixture pages during
implementation and updated here with the measurement.

## Measured

2026-11-15, Chrome for Testing 158, background tabs, DOM-lane click (`tests/fixtures/reactions.html`):

| Page reaction after the click | Waited for | Click returned in |
| --- | --- | --- |
| microtask, `setTimeout(0)`, `setTimeout(100)` (tab hidden 1 s), a `fetch` then render, a spinner then the content one timer later | 3 of 3 each | 845 to 925 ms |
| `setTimeout(100)` in a tab hidden 12 s | 1 of 2 | 850 ms |
| `setTimeout(700)` | 0 of 3 | 850 ms |
| `requestAnimationFrame` | never runs (background tabs do not render, `dom-lane.md`) | 850 ms |
| a `setTimeout(50)` ticker mutating forever | runs once a second, so the quiet window ends between ticks: `settled: true` | 1.2 s |
| a ticker driven by 50 ms network requests (adding nodes) | `settled: false` at the 3 s limit | 3 s |

Chrome runs a hidden tab's timers on one wake-up per second, so a reaction scheduled 100 ms or more
after the action may land after the 300 ms quiet window. The numbers stay: a 1 s window would add up
to 700 ms to every action of every agent, and an agent that expects a later reaction names it with
`wait` on the action (`actions.md`), which also covers the `requestAnimationFrame` case through
`trusted: true`. The click's floor is the 500 ms navigation watch plus the 300 ms quiet window.

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SET-E01 | live | click that changes nothing | returns within 1.2 s, `domChanged: false` |
| SET-E02 | live | DOM change from a 0 ms timer after the click, and a spinner then content one timer later (a 100 ms timer is not used: in a tab hidden for a while it may wait for the next 1 s wake-up, see Measured) | `domChanged: true`, the content is there when the click returns |
| SET-E03 | live | ticker adding nodes forever, driven by network callbacks (timers would be throttled) | returns at 3 s, `settled: false` |
| SET-E08 | live | an attribute changing forever, driven by network callbacks, and a click that changes nothing else | returns within 1.5 s, `settled: true`, `domChanged: true` |
| SET-E04 | live | link to a slow page (2 s server delay) | waits for commit, `urlChanged` |
| SET-E05 | live | SPA `pushState` navigation | `urlChanged`, no full navigation wait |
| SET-E06 | live | background tab | same results as foreground (no in-page timers) |
| SET-E07 | live | DOM change 2.5 s after the click (700 ms raced the click's own 850 ms floor: a hidden tab runs the timer on its next 1 s wake-up, anywhere from 0.7 to 1.7 s after the click, so the test failed in a full run on 2026-11-16) | not waited for without `wait`; on a fresh page, with `wait: {text}` the click returns after it |
| Playwright CL-067, CL-068, CL-069, CL-076 | live | navigation during the click, frame detached | no protocol error, no hang |
| SET-S01 | site | Facebook Marketplace click | snapshot after the result shows Marketplace content |
