# `fill_form`

Status: approved
Depends on: `tools/type.md`, `dom-lane.md`, `targets.md`, `errors.md`

## Purpose

Set several form controls in one call: text fields, checkboxes, radios, switches, selects and
sliders. This is also the only way to choose `<select>` options and to check boxes; there are no
separate `select_option` and `check` tools.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `fields` | object[] | yes | | 1 to 50 entries | controls to set, in order |
| `fields[].target` | string | yes | | ref or selector | the control |
| `fields[].value` | string \| boolean \| string[] | yes | | string for text, select (value or label), range; boolean for checkbox, radio, switch; string[] for a multiple select | what to set |
| `trusted` | boolean | no | `false` | | CDP lane for every field |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Validate every entry's shape first; a bad entry fails the call before anything is set.
2. For each field in order, resolve and wait for actionability (5 s), then by the element:
   - text input, textarea, contenteditable, date/color/range: as `type` (no submit);
   - checkbox, radio, `role=checkbox|radio|switch`: click if the state differs, then verify the
     state (Playwright `check`/`uncheck` semantics; unchecking a radio → `INVALID_PARAMS`);
   - `<select>`: Playwright `selectOptions` by value, then by label; `string[]` only on
     `multiple`.
   A value whose type does not fit the element → `INVALID_PARAMS` naming the field.
3. Stop at the first failing field. Settle once at the end.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `fields` | `{target, ref, kind, value}[]` | yes | each field set, with the value read back |
| `failed` | `{index, error}` \| null | yes | the field that failed; the ones before it stay set |
| `outcome` | as in `click` | yes | |

When a field fails, the call returns `ok: true` with `failed` set, so the agent sees which fields
were already filled. The error inside `failed` uses the codes below.

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `INVALID_PARAMS`, and per field:
`REF_NOT_FOUND`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `TARGET_HIDDEN`,
`TARGET_DISABLED`, `TARGET_NOT_EDITABLE`, `OPTION_NOT_FOUND`.

## Tool description (what the agent reads)

```text
Set several form controls at once: fields: [{target, value}]. value is a string for text fields
and selects (option value or label), true/false for checkboxes, radios and switches, a list for
multi-selects. Stops at the first field that fails and says which.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| FORM-U01 | unit | boolean for a text field, list for a single select | `INVALID_PARAMS` naming the field, nothing set |
| FORM-E01 | live | login form: text, password, checkbox | all set, values read back |
| FORM-E02 | live | third field missing | `failed.index == 2`, first two set |
| FORM-E03 | live | custom `role=switch` | toggled |
| SO-001..SO-005, SO-007, SO-010..SO-014, SO-021..SO-023, SO-025..SO-034 | live | Playwright select cases | both lanes |
| FORM-E04 | live | select value that matches no option (Playwright SO-016 returns `[]`) | `OPTION_NOT_FOUND` after 5 s |
| CH-001..CH-013, CH-016, CH-017 | live | Playwright check cases | both lanes |
| playwright-mcp `form.spec.ts` | live | adopted cases | same results |

Not adopted: SO-016..SO-019 (Playwright return values; our result reads the selection back), SO-006, SO-008, SO-009, SO-020, SO-024 (handles and attribute objects are not part
of `value`); CH-014, CH-015 (trial runs).
