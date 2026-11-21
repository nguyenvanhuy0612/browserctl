# `run`

Status: verified (2026-11-21: one worker per session across tabs, popups, worker replaced after a reconnect)
Depends on: `relay.md`, `sessions.md`, `errors.md`

## Purpose

Run Playwright code against the tab, for what no other tool covers: coordinates and drag,
network routing, cookies and storage state, emulation, multi-step scripts in one call.
Always the CDP lane (the debugging bar shows while it runs).

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `code` | string | yes | | the body of an async function | Playwright code |
| `timeout` | number | no | 60 | 1 to 600 seconds | |
| `tab` | integer | no | current tab | owned tab | which tab |

In scope while `code` runs: `page` (Playwright `Page` of the call's tab), `context` (its
`BrowserContext`, holding the session's tabs that `run` used and the tabs they opened), `state`
(an object kept for the session across calls and tabs), `console` (captured).
The value `code` returns is the result.

## Behaviour

1. Attach the tab (pinned for the duration), `wake` the relay.
2. Run `code` in a worker process of the session (one per session, started on first use) that
   holds its own Playwright connection to the daemon's relay through a local WebSocket endpoint.
   A call on another tab of the session adds that tab to the worker's connection; the worker and
   its `state` stay, and `page` is the call's tab. The code is a fresh async function with the
   names above. On `timeout` the worker is killed (a synchronous loop cannot be interrupted
   otherwise), `state` is lost, and the result says so; the next call starts a new worker. A call
   on a tab of another browser, or the extension reconnecting (its service worker restarted),
   also ends the worker, because its connection belongs to that browser link; the next call starts
   a new one with an empty `state`.
3. Capture `console.log` output (at most 200 lines).
4. Serialize the return value as `evaluate` does.
5. New tabs that `code` opens with `context.newPage()` join the session (inactive, not grouped).
   A tab that a page in one of the worker's tabs opens (a `target=_blank` link, `window.open`)
   joins the worker's connection with that page as its opener, so `page.waitForEvent("popup")`
   and `context.pages()` see it (measured 2026-11-21 before this rule: the popup opened and joined
   the session, but the worker's Playwright never saw it). Its load state reaches the worker by the
   relay's frame-tree rule (`relay.md`; before that rule, 4 of 14 `popup.waitForLoadState()` calls
   hung, after it 28 of 28 passed).
6. An error thrown outside the call's own promise chain, by a listener or a route handler that
   `code` registered (an uncaught exception or unhandled rejection in the worker), does not stop
   the worker: while a call runs it fails that call with `EVAL_ERROR`
   (`uncaught in a listener or route handler: <error>`); between calls it is added to the next
   call's `console` as `uncaught: <error>`. `state` is kept either way.
7. `page.close()` closes the tab and drops it from the session. `browser.close()` is not
   reachable: `browser` is not in scope and the relay refuses `Browser.close`.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"cdp"` | yes | |
| `value` | any JSON | yes | |
| `console` | string[] | yes | captured output |
| `truncated` | boolean | yes | |

## Errors

`EVAL_ERROR` (with the error and the line in `code`), `TIMEOUT`, `NO_TAB`, `TAB_NOT_OWNED`,
`TAB_CLOSED`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Run Playwright code for anything the other tools do not cover (drag, coordinates, routes,
cookies, emulation, loops). page, context and a persistent state object are in scope;
return a value. Shows Chrome's debugging bar while running.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| RUN-E01 | live | `return await page.title()` | value |
| RUN-E02 | live | `state.n = (state.n ?? 0) + 1` twice | 1 then 2 |
| RUN-E03 | live | `page.mouse.click(x, y)` on a canvas | handler fires |
| RUN-E04 | live | throws on line 3 | `EVAL_ERROR` naming line 3 |
| RUN-E05 | live | synchronous `while(true)` with `timeout: 2` | `TIMEOUT` at 2 s, daemon answers other calls meanwhile, next `run` works with empty `state` |
| RUN-E06 | live | `context.newPage()` | new tab owned, inactive, not grouped |
| RUN-E07 | live | playwright-mcp `run-code.spec.ts` "return value": role click, then return an object | the object; the page's click handler ran |
| RUN-E08 | live | "no-require": `require('fs')` | `EVAL_ERROR` with `require is not defined` |
| RUN-E09 | live | "exposes benign globals" | `setTimeout`, `URL`, `fetch`, `Buffer`, `AbortController`, `TextEncoder` are functions, `crypto` an object, `require` undefined |
| RUN-E10 | live | "delayed route with setTimeout" | `{path: "/api/slow"}` |
| RUN-E12 | live | code that clicks a `target=_blank` link and waits for `popup` | the popup's URL; `context.pages()` holds both |
| RUN-E13 | live | `state.from = page.url()` on tab A, then a `run` on tab B returning `state.from` and `page.url()` | A's URL and B's URL |
| RUN-E14 | live | `state.n = 1`, the extension's service worker stopped, then `run` returning `state.n` and `page.url()` | `null` (a new worker) and the tab's URL |
| RUN-E11 | live | "route handler exception keeps server alive"; a `requestfinished` listener that throws during a later call; one that throws between calls | `EVAL_ERROR` naming each error raised during a call, the one between calls in the next `console`; `state` kept; `tabs` answers |

Not adopted from `run-code.spec.ts`: page console messages in the result (the result's `console`
is the code's own output); `filename` cases (no file parameter); `process` being undefined (the
worker is the user's own Node process, `process` stays reachable).

## Edge cases left out

| Case | Why |
| --- | --- |
| Tabs of several browsers in one worker | a worker's connection is one browser link; a call on another browser starts a new worker |
| Keeping `state` across a worker restart (timeout, extension reconnect, daemon restart) | `state` lives in the worker process; values are often Playwright handles that die with it |
| Popups opened from tabs the worker never used | the worker follows the tabs it holds; `tabs` and the actions' `newTabs` report the others |
