# `tabs`

Status: verified
Depends on: `sessions.md`, `errors.md`

## Purpose

List tabs, open, select, close, adopt and release them. Tab ownership rules are in `sessions.md`;
this tool is their only surface.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `action` | string | yes | | `"list"`, `"new"`, `"select"`, `"close"`, `"adopt"`, `"release"` | what to do |
| `tab` | integer | for `select`, `close`, `adopt`, `release` | | a tab id from `list` | which tab |
| `url` | string | no | `about:blank` | `new` only | page to open |
| `focus` | boolean | no | `false` | `select` only | also bring the tab and its window to the front (changes what the user sees) |
| `force` | boolean | no | `false` | `adopt` only | take a tab another session holds |
| `browser` | string | no | the only connected browser | an alias from `list` (`chrome-1`) | which browser, when several are connected |
| `all` | boolean | no | `false` | `list` only | list every tab, not only this session's and the active ones |

## Behaviour

| Action | Effect |
| --- | --- |
| `list` | this session's tabs (marked `mine`, `current`), plus each window's active tab; with `all`, every tab, each with its holder |
| `new` | open an inactive tab in the last focused normal window (no tab group); it becomes current; with `url`, wait for `DOMContentLoaded` (at most 10 s) |
| `select` | make an owned tab current; with `focus`, activate it and focus its window |
| `close` | close an owned tab; if it was current, the session has no current tab |
| `adopt` | take a free tab (or, with `force`, another session's) into this session, make it current |
| `release` | give an owned or adopted tab up, leave it open, detach the debugger |

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `tabs` | `{tab, url, title, mine, current, active, holder, browser}[]` | for `list` | |
| `tab` | `{tab, url, title, browser}` | for the other actions | the tab acted on |
| `current` | integer \| null | yes | the session's current tab after the call |

## Errors

`NO_BROWSER`, `AMBIGUOUS_BROWSER`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Manage tabs. action: list | new | select | close | adopt | release. New tabs open in the
background and become your current tab. adopt takes an existing tab (e.g.
one the user opened) so you can act on it. select with focus: true shows the tab to the user.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| TABS-U01 | unit | `close` without `tab` | `INVALID_PARAMS` |
| TABS-U02 | unit | `list` for two sessions | each sees its own tabs as `mine` |
| TABS-E01 | live | `new` with `url` | inactive, not grouped, current, loaded; user's tab unchanged |
| TABS-E02 | live | `select` with `focus` | tab active, window focused |
| TABS-E03 | live | `adopt` a user tab, `release` it | owned then free, still open, never grouped |
| TABS-E04 | live | `adopt` another session's tab without and with `force` | `TAB_NOT_OWNED`, then taken |
| TABS-E05 | live | `close` the current tab | `current: null`; next `click` → `NO_TAB` |
| TABS-U03 | unit | two browsers connected, `new` without `browser` | `AMBIGUOUS_BROWSER` listing both aliases |
