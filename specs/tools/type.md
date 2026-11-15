# `type`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `dom-lane.md`, `targets.md`, `settle.md`, `errors.md`

## Purpose

Put text into an input, textarea or contenteditable element, replacing what is there, and
optionally submit.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | ref or selector | the field |
| `text` | string | yes | | may be empty (clears the field) | the text |
| `submit` | boolean | no | `false` | | press Enter afterwards (`press_key` rules) |
| `slowly` | boolean | no | `false` | | one character at a time with key events, for fields that react per keystroke (autocomplete) |
| `trusted` | boolean | no | `false` | | CDP lane with real keyboard input |
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to be actionable (`actions.md`) |
| `scroll` | string | no | `"auto"` | `"auto"`, `"center"`, `"none"` | scrolling before the action (`actions.md`) |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab and target; actionability as in `tools/click.md` plus editable (not readonly),
   polled up to 5 s.
2. DOM lane, default: Playwright `fill` (`dom-lane.md`): date/color/range inputs by value; text
   inputs and textareas through the prototype setter and `beforeinput`/`input`/`change`;
   contenteditable through `execCommand("insertText")`.
3. DOM lane, `slowly`: clear as above when the field is not already empty, then per character
   `keydown`, `keypress`, `textInput` (Chrome's legacy text event, which React's `onBeforeInput`
   listens to), `beforeinput`, value update, `input`, `keyup`, the order Chrome uses for real
   typing (Playwright KB-007).
4. CDP lane: Playwright `locator.fill`, or, for `slowly`, `locator.fill("")` when the field is not
   empty and then `locator.pressSequentially`.
5. `submit`: `press_key` Enter on the field, after step 6.
6. Read the value back. A contenteditable field typed through `execCommand` (DOM lane) is read a
   second time, in the next call to the page and before `submit`: editors such as Facebook's
   Lexical cancel the native insertion and render the text a microtask later (measured
   2026-11-14: `"\n"` right after the input events, the full text one call later). The runtime
   keeps the element it typed into for that read, so the target is not resolved again; if the
   editor has replaced the element meanwhile, the first read is kept. Inputs, textareas and the
   CDP lane (Playwright reads after its own wait) are read once. In the CDP lane, a field that is
   gone by then (typing made the page navigate) reads as `null` after at most 1 s.
7. `submit` (step 5) runs after the read-back, so `value` is what was typed, not the field after
   the form handled Enter. Settle; return.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `resolved` | as in `click` | yes | |
| `value` | string \| null | yes | the field's value (or text for contenteditable) after typing; null when the field left the page |
| `outcome` | as in `click` | yes | |
| `waited` | object \| null | yes | the `wait` result, null without `wait` (`actions.md`) |
| `hint` | string \| null | yes | set when `wait` timed out (`actions.md`) |

A `value` that differs from `text` is not an error (masks, formatters); the agent sees both.

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`, `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET`, `INVALID_TARGET`, `TARGET_HIDDEN`, `TARGET_DISABLED`, `TARGET_NOT_EDITABLE`
(not a text field, readonly after 5 s, `input[type=number]` given letters), `DEBUGGER_CANCELED`,
`DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Replace the text of an input, textarea or rich-text field. target: a ref or selector. submit:
true presses Enter after. slowly: true types key by key for autocomplete fields. Returns the
field's value afterwards.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| TYPE-U01 | unit | characters for `slowly`: `aB é` | each keeps its text; letters get their key code; `é`, outside the layout, is typed as text |
| TYPE-E01 | live | React-style tracked input | page's input handler sees the value |
| TYPE-E02 | live | `slowly` on an autocomplete that listens to `keydown` | suggestions appear |
| TYPE-E03 | live | `submit` in a form without a submit button | form submitted |
| TYPE-E04 | live | masked phone field | `value` shows the mask |
| TYPE-E05 | live | editor that cancels `beforeinput` and renders its model a microtask later (Lexical-like); then an input whose form clears it on Enter, with `submit` | `value` equals the text in both cases |
| TYPE-S01 | site | Facebook search box | value set, no Enter, no bar |
| FI-001, FI-002, FI-004..FI-007, FI-010..FI-017, FI-020..FI-024, FI-026..FI-034, FI-036 | live | Playwright fill cases | both lanes |
| FI-009 | live | `input` event composed across shadow DOM | both lanes |
| KB-001, KB-007 | live | typing into a textarea; event order | `slowly` and CDP lane |
| TYPE-E06 | live | playwright-mcp `type.spec.ts`: `submit` (the page's key handler sees Enter with the value), `slowly` (one `keydown` per character), no `submit` | the value; the handler's log |

Not adopted: FI-003, FI-018, FI-019 (API misuse that our parameter validation refuses earlier);
FI-025 (focus in another frame: adopted once frame tests exist).
