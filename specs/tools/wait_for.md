# `wait_for`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `errors.md`

## Purpose

Wait until text appears or disappears, an element reaches a state, or a fixed time passes.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `text` | string | one of `text`, `textGone`, `target`, `url`, `time` | | | visible text to appear (substring, case-sensitive) |
| `url` | string | one of the five | | substring, or `/regex/` | the tab's URL to match |
| `textGone` | string | one of the five | | | visible text to disappear |
| `target` | string | one of the five | | ref or selector | element to reach `state` |
| `state` | string | no | `"visible"` | `"visible"`, `"hidden"`, `"attached"`, `"detached"`; with `target` only | |
| `time` | number | one of the five | | 0.1 to 60 seconds | just wait |
| `timeout` | number | no | 10 | 0.1 to 60 seconds | give up after |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

The daemon polls the DOM-lane runtime every 200 ms (page timers are throttled in background tabs),
across navigations: the runtime is re-injected after each document load. Text is matched against
the visible text of every frame the runtime is in, cross-origin ones included. `url` is checked
against the tab's URL from `chrome.tabs`. `time` sleeps in the daemon.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `waitedMs` | integer | yes | |
| `matched` | `{ref, role, name}` \| null | yes | the element that matched `text` or `target` |

## Errors

`TIMEOUT` (with what was last seen: the closest text match or the element's state), `NO_TAB`,
`TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `INVALID_TARGET`, `AMBIGUOUS_TARGET`,
`INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Wait for text to appear (text) or disappear (textGone), for target to become visible / hidden /
attached / detached, or for time seconds. timeout defaults to 10 s.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| WAIT-E01 | live | text appears after 2 s in a background tab | waits about 2 s, not throttled to timer granularity |
| WAIT-E02 | live | wait across a navigation | matched on the new page |
| WAIT-E03 | live | never appears | `TIMEOUT` with last seen state |
| WA-027..WA-043 | live | Playwright wait-for-selector cases that use visible/hidden/attached/detached | same outcomes |
| playwright-mcp `wait.spec.ts` | live | adopted | same results |
