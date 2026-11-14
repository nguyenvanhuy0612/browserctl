# `handle_dialog`

Status: approved
Depends on: `dom-lane.md`, `relay.md`, `errors.md`

## Purpose

Decide how `alert`, `confirm` and `prompt` are answered in a tab, and answer a native dialog that
is already blocking the page.

`confirm()` returns synchronously, so a DOM-lane dialog cannot wait for the agent: it is answered
by the tab's policy the moment it opens and reported by the action that caused it. To accept a
`confirm` that was dismissed, set the policy and repeat the action.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `accept` | boolean | yes | | | accept (OK) or dismiss (Cancel) |
| `promptText` | string | no | the prompt's default | | answer for `prompt` when accepting |
| `scope` | string | no | `"next"` | `"next"`, `"always"` | the next dialog only, or every dialog until changed |
| `trusted` | boolean | no | `false` | | also answer a native dialog that is open now (CDP lane) |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Default policy of every owned tab: `alert` accepted, `confirm` and `prompt` dismissed (a
   destructive "Delete?" is never confirmed by accident).
2. Set the policy on the tab; the daemon re-arms it on every new document in the tab.
3. `scope: "next"` reverts to the default after one dialog.
4. With `trusted`: attach, and if a native dialog is open (`beforeunload`, or one opened before the
   shim loaded), answer it with `Page.handleJavaScriptDialog`. The CDP lane answers later dialogs
   in that tab by the same policy while attached.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `policy` | `{alert, confirm, prompt, scope}` | yes | the tab's policy now |
| `answered` | `{type, message, accepted}` \| null | yes | the open dialog answered by this call (`trusted` only) |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Set how dialogs in your tab are answered: accept: true/false, promptText, scope: next | always.
By default alert is accepted and confirm/prompt are dismissed; actions report each dialog and the
answer given. To accept a dismissed confirm, call this and repeat the action. trusted: true also
answers a dialog that is blocking the page now (DIALOG_OPEN).
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| DLG-E01 | live | click a `confirm` button with the default policy | `answer: false` reported |
| DLG-E02 | live | `accept: true`, then the same click | `answer: true`; `scope: "next"` reverts after |
| DLG-E03 | live | `prompt` with `promptText` | page receives the text |
| DLG-E04 | live | policy survives a navigation in the tab | re-armed |
| DLG-E05 | live | `beforeunload` blocking `navigate` (after one `trusted` click) | `DIALOG_OPEN`; `trusted` answers it |
| DLG-E06 | live | `confirm` in a tab the agent does not own | real dialog shown, shim inert |
| DI-005..DI-008, DI-010, DI-011 | live | Playwright dialog cases | both lanes |
| playwright-mcp `dialogs.spec.ts` | live | adopted where the answer is given in advance | same results |
