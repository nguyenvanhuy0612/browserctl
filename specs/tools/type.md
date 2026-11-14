# `type`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `settle.md`, `errors.md`

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
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab and target; actionability as in `tools/click.md` plus editable (not readonly),
   polled up to 5 s.
2. DOM lane, default: Playwright `fill` (`dom-lane.md`): date/color/range inputs by value; text
   inputs and textareas through the prototype setter and `beforeinput`/`input`/`change`;
   contenteditable through `execCommand("insertText")`.
3. DOM lane, `slowly`: clear as above, then per character `keydown`, `keypress`, `beforeinput`,
   value update, `input`, `keyup`.
4. CDP lane: Playwright `locator.fill`, or `locator.pressSequentially` for `slowly`.
5. `submit`: `press_key` Enter on the field.
6. Read the value back; settle; return.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `resolved` | as in `click` | yes | |
| `value` | string | yes | the field's value (or text for contenteditable) after typing |
| `outcome` | as in `click` | yes | |

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
| TYPE-E01 | live | React-style tracked input | page's input handler sees the value |
| TYPE-E02 | live | `slowly` on an autocomplete that listens to `keydown` | suggestions appear |
| TYPE-E03 | live | `submit` in a form without a submit button | form submitted |
| TYPE-E04 | live | masked phone field | `value` shows the mask |
| TYPE-S01 | site | Facebook search box | value set, no Enter, no bar |
| FI-001, FI-002, FI-004..FI-007, FI-010..FI-017, FI-020..FI-024, FI-026..FI-034, FI-036 | live | Playwright fill cases | both lanes |
| FI-009 | live | `input` event composed across shadow DOM | both lanes |
| KB-001, KB-007 | live | typing into a textarea; event order | `slowly` and CDP lane |
| playwright-mcp `type.spec.ts` | live | adopted cases | same results |

Not adopted: FI-003, FI-018, FI-019 (API misuse that our parameter validation refuses earlier);
FI-025 (focus in another frame: adopted once frame tests exist).
