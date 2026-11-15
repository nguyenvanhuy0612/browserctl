# `wait_for`

Status: verified
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

`TIMEOUT` (with what was last seen: whether the text was present, or the element's state with its
role and name), `NO_TAB`,
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
| WA-027 | live | unknown option `waitFor` | `INVALID_PARAMS` naming `state` among the valid parameters |
| WA-029..WA-032, WA-034..WA-037, WA-039..WA-041 | live | Playwright wait-for-selector cases (an element's own subtree as a `>>` chain; a timeout as `TIMEOUT`, whose message names the state and the element last seen) | same outcomes |
| WA-038 | live | `click` on `text=Reset` matching a hidden and a visible button | `AMBIGUOUS_TARGET` listing both (Playwright proceeds with the first and fails on it) |
| WAIT-E04 | live | playwright-mcp `wait.spec.ts` "text": text that a click changes 1 s later | matched; the snapshot shows the new text |
| WAIT-E05 | live | "textGone": the same page, the old text | waited until it was gone |
| WAIT-E06 | live | "time": 1 s; 70 s | `waitedMs` about 1000; `INVALID_PARAMS` (at most 60) |

Not adopted: WA-028 (`waitFor` tolerated as an alias: no aliases); WA-033 (a wait goes on across a
navigation, WAIT-E02); WA-042, WA-043 (selectors wait in the main frame only, `targets.md`);
playwright-mcp `wait.spec.ts` combinations of `time` with `text` or `textGone` with `text` (one
condition per call).
