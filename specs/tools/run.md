# `run`

Status: approved
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

In scope while `code` runs: `page` (Playwright `Page` of the tab), `context` (its
`BrowserContext`), `state` (an object kept for the session across calls), `console` (captured).
The value `code` returns is the result.

## Behaviour

1. Attach the tab (pinned for the duration), `wake` the relay.
2. Run `code` in a worker process of the session (one per session, started on first use) that
   holds its own Playwright connection to the daemon's relay through a local WebSocket endpoint.
   The code is a fresh async function with the names above. On `timeout` the worker is killed
   (a synchronous loop cannot be interrupted otherwise), `state` is lost, and the result says so;
   the next call starts a new worker.
3. Capture `console.log` output (at most 200 lines).
4. Serialize the return value as `evaluate` does.
5. New tabs that `code` opens with `context.newPage()` join the session (inactive, grouped).
6. `page.close()` closes the tab and drops it from the session. `browser.close()` is not
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
| RUN-E06 | live | `context.newPage()` | new tab owned, inactive, grouped |
| playwright-mcp `run-code.spec.ts` | live | adopted | same results |
