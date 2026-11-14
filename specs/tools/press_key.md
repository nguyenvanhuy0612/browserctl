# `press_key`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `settle.md`, `errors.md`

## Purpose

Press a key or a chord (`Enter`, `Escape`, `Tab`, `Control+A`, `ArrowDown`) on an element or on
whatever has focus.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `key` | string | yes | | a Playwright key name or chord (`Shift+Tab`, `Meta+A`); single characters allowed | the key |
| `target` | string | no | the focused element, else `body` | ref or selector | focus this first |
| `trusted` | boolean | no | `false` | | CDP lane, real keyboard input |
| `tab` | integer | no | current tab | owned tab | which tab |

Key names and their `code`/`keyCode` come from Playwright's US keyboard layout, extracted from the
pinned `playwright-core` at build time. An unknown key → `INVALID_PARAMS` listing close names.

## Behaviour

1. Resolve the tab; focus `target` if given (actionability as in `click`).
2. DOM lane: `keydown` (and `keypress` for printable keys) and `keyup` with `key`, `code`,
   `keyCode`, modifiers, `repeat: false`. If no handler called `preventDefault`, perform the
   browser's default action ourselves for these keys, since synthetic events have none:

   | Key | Default action performed |
   | --- | --- |
   | printable character | insert it at the caret (as `type` with `slowly`) |
   | `Enter` in an input of a form | `form.requestSubmit()` |
   | `Enter` / `Space` on a button, link, `role=button` | `click` |
   | `Tab` / `Shift+Tab` | move focus to the next / previous focusable element |
   | `Backspace` / `Delete` in a text field | delete the selection or one character |
   | `Control+A` / `Meta+A` in a text field | select all |
   | `Escape` | none (handlers only) |
   | arrows, `PageUp`/`PageDown`, `Home`/`End` outside text fields | scroll the page or the focused scroller |

   Other default actions (caret movement by arrows inside text, IME, browser shortcuts) are not
   emulated; the hint for a key with no visible effect names `trusted: true`.
3. CDP lane: Playwright `keyboard.press`.
4. Settle; return.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `focused` | `{ref, role, name}` \| null | yes | element that had focus when the key was sent |
| `defaultAction` | string \| null | yes | the emulated default action, or `"prevented"` by the page, or null |
| `outcome` | as in `click` | yes | |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`, `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET`, `INVALID_TARGET`, `TARGET_HIDDEN`, `TARGET_DISABLED`, `DEBUGGER_CANCELED`,
`DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Press a key or chord (Enter, Escape, Tab, ArrowDown, Control+A) on target or on the focused
element. Enter submits forms, Tab moves focus. trusted: true for keys a site handles only from
real keyboards.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| KEY-U01 | unit | `Shift+Tab`, `Control+Shift+K`, `+`, `Shift++`, unknown `Foo` | parsed chords; `INVALID_PARAMS` |
| KEY-E01 | live | Enter in a form input | submitted; `defaultAction: "submit"` |
| KEY-E02 | live | Tab through three inputs | focus moves in order |
| KEY-E03 | live | Escape closes a modal listening to `keydown` | modal gone |
| KEY-E04 | live | handler calls `preventDefault` on Enter | no submit; `defaultAction: "prevented"` |
| KEY-E05 | live | ArrowDown in a listbox with a keydown handler | selection moves |
| KB-002, KB-003, KB-009, KB-010, KB-013..KB-017, KB-025, KB-027, KB-030, KB-038, KB-041 | live | Playwright keyboard cases | DOM lane where emulated, CDP lane all |
| playwright-mcp `cli-keyboard.spec.ts` press cases | live | adopted | same results |
