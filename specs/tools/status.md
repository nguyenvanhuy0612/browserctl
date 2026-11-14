# `status`

Status: approved
Depends on: `sessions.md`, `interface.md`

## Purpose

Show what the agent is connected to and why something does not work: browsers, extension
versions, whether `evaluate` can run without the debugging bar, which tabs have the debugger
attached, and the session's own tabs.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `allowDebugger` | boolean | no | `false` | | clear `debuggerCanceled` on every browser (after the user pressed Cancel on the bar and the agent asked them) |

## Behaviour

Reads the daemon's state; touches no page. With `allowDebugger`, clears the flag first.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `daemon` | `{version, port, startedAt}` | yes | |
| `session` | `{id, client, currentTab}` | yes | the calling session |
| `browsers` | list, below | yes | empty when none is connected |
| `browsers[].alias` | string | yes | `chrome-1` |
| `browsers[].name`, `version` | string | yes | `Chrome`, `157.0...` |
| `browsers[].extension` | `{version, protocol, outdated}` | yes | `outdated` when the protocol differs from the daemon's |
| `browsers[].userScripts` | boolean | yes | "Allow User Scripts" is on (`evaluate` without the bar) |
| `browsers[].debuggerCanceled` | boolean | yes | the user pressed Cancel; CDP-lane calls refused |
| `browsers[].attached` | `{tab, idleSecondsLeft, pins[]}[]` | yes | debugger attachments and why they stay |
| `browsers[].myTabs` | `{tab, url, title, current}[]` | yes | this session's tabs |
| `setup` | string[] | yes | missing setup steps in words (extension not connected, user scripts off) |

## Errors

`INVALID_PARAMS`. A missing browser is not an error here: `browsers` is empty and `setup` says
what to do.

## Tool description (what the agent reads)

```text
Show connected browsers, setup problems, your tabs, and where Chrome's debugging bar comes from.
Call it first when a tool reports NO_BROWSER, USER_SCRIPTS_OFF or DEBUGGER_CANCELED.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| STAT-U01 | unit | no browser | `browsers: []`, `setup` names loading the extension |
| STAT-U02 | unit | userScripts off | `userScripts: false`, `setup` names the toggle |
| STAT-U03 | unit | `allowDebugger` after a cancel | flag cleared |
| STAT-E01 | live | one CDP-lane attachment pinned by network capture | listed with pin `network` |
