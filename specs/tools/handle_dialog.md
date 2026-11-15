# `handle_dialog`

Status: verified
Depends on: `dom-lane.md`, `relay.md`, `errors.md`

## Purpose

Decide how `alert`, `confirm` and `prompt` are answered in a tab.

`confirm()` returns synchronously, so a DOM-lane dialog cannot wait for the agent: it is answered
by the tab's policy the moment it opens and reported by the action that caused it. To accept a
`confirm` that was dismissed, set the policy and repeat the action.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `accept` | boolean | yes | | | accept (OK) or dismiss (Cancel) |
| `promptText` | string | no | the prompt's default | | answer for `prompt` when accepting |
| `scope` | string | no | `"next"` | `"next"`, `"always"` | the next dialog only, or every dialog until changed |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Default policy of every owned tab: `alert` accepted, `confirm` and `prompt` dismissed (a
   destructive "Delete?" is never confirmed by accident).
2. Set the policy on the tab; the daemon re-arms it on every new document in the tab.
3. `scope: "next"` reverts to the default after one dialog.
4. The CDP lane answers dialogs in that tab by the same policy while attached.
5. `beforeunload` never asks in the agent's tabs (`dom-lane.md`); there is no open dialog to
   answer. Measured 2026-11-15: a debugger cannot answer a dialog that opened before it attached.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `policy` | `{alert, confirm, prompt, scope}` | yes | the tab's policy now |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Set how dialogs in your tab are answered: accept: true/false, promptText, scope: next | always.
By default alert is accepted and confirm/prompt are dismissed; actions report each dialog and the
answer given. To accept a dismissed confirm, call this and repeat the action.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| DLG-E01 | live | click a `confirm` button with the default policy | `answer: false` reported |
| DLG-E02 | live | `accept: true`, then the same click | `answer: true`; `scope: "next"` reverts after |
| DLG-E03 | live | `prompt` with `promptText` | page receives the text |
| DLG-E04 | live | policy survives a navigation in the tab | re-armed |
| DLG-E05 | live | DOM-lane click on a link away from a page with a `beforeunload` handler, after one `trusted` click | the link's page loads; `urlChanged` |
| DLG-E06 | live | `confirm` in a tab the agent does not own | real dialog shown, shim inert |
| DI-005..DI-008, DI-010, DI-011 | live | Playwright dialog cases, with the answer set in advance by `handle_dialog` | both lanes |
| DLG-E07 | live | playwright-mcp `dialogs.spec.ts` "alert dialog", "two alert dialogs", "confirm dialog (true)", "confirm dialog (false)", "prompt dialog", each opened by a click | each dialog in `outcome.dialogs` with its message and the answer given; the page sees the answer |

Not adopted from `dialogs.spec.ts`: "dialog closed out of band", "alert dialog w/ race", "alert
dialog during navigation", "dialog during navigate back" (they test a modal state the agent answers
later; here the answer is the tab's policy, set before).
