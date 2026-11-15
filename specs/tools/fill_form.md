# `fill_form`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `tools/type.md`, `dom-lane.md`, `targets.md`, `errors.md`

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
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to be actionable (`actions.md`) |
| `scroll` | string | no | `"auto"` | `"auto"`, `"center"`, `"none"` | scrolling before the action (`actions.md`) |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Validate every entry's shape first; a bad entry fails the call before anything is set.
2. For each field in order, resolve and wait for actionability (`timeout`, 5 s by default), then by the element:
   - text input, textarea, contenteditable, date/color/range: as `type` (no submit), including the
     second read of a contenteditable field (`type.md`, step 6);
   - checkbox, radio, and the roles that carry `aria-checked` (`checkbox`, `radio`, `switch`,
     `menuitemcheckbox`, `menuitemradio`, `option`, `treeitem`, as Playwright): click if the state
     differs, then verify the state (Playwright `check`/`uncheck` semantics). Unchecking a checked
     native radio button → `INVALID_PARAMS` (only another radio unchecks it); an ARIA radio is
     clicked and its handler decides. A label target (or text inside a label) whose control is
     visible clicks the control, so a link inside the label is not followed; a hidden control (a
     styled custom checkbox) is set through its label. The field's kind and the radio check come
     from the DOM lane in both lanes, so `trusted` changes only how the click is sent;
   - `<select>`: Playwright `selectOptions` by value, then by label; `string[]` only on
     `multiple`.
   A value whose type does not fit the element → `INVALID_PARAMS` naming the field.
3. Stop at the first failing field. Settle once at the end. `wait` (`actions.md`) runs only when
   every field was set; after a failed field `waited` is null.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `fields` | `{target, ref, kind, value}[]` | yes | each field set, with the value read back |
| `failed` | `{index, error}` \| null | yes | the field that failed; the ones before it stay set |
| `outcome` | as in `click` | yes | |
| `waited` | object \| null | yes | the `wait` result, null without `wait` (`actions.md`) |
| `hint` | string \| null | yes | set when `wait` timed out (`actions.md`) |

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
| FORM-E03 | live | the Lexical-like editor of TYPE-E05 as a field | its `value` equals the text |
| FORM-E02 | live | third field missing | `failed.index == 2`, first two set |
| FORM-E05 | live | custom `role=switch` | toggled |
| SO-001..SO-005, SO-011, SO-012, SO-014, SO-022, SO-025, SO-026, SO-028..SO-034 | live | Playwright select cases | both lanes |
| SO-010, SO-023 | live | a list for a select without `multiple` (Playwright selects the first value, or none) | `INVALID_PARAMS` in `failed`: a list needs `multiple` (step 2) |
| FORM-E04 | live | select value that matches no option (Playwright SO-016 returns `[]`), `timeout: 0.5` | `OPTION_NOT_FOUND` in `failed` after the timeout |
| CH-001..CH-013, CH-016, CH-017 | live | Playwright check cases | both lanes |
| FORM-E06 | live | playwright-mcp `form.spec.ts` "textbox": text, email, range, a select by value and a checkbox, each inside its label | every field set and read back |

Not adopted: SO-016..SO-019 (Playwright return values; our result reads the selection back), SO-006, SO-008, SO-009, SO-020, SO-024 (handles and attribute objects are not part
of `value`); SO-007, SO-013, SO-027 (select by index: `value` is an option's value or label); SO-021
(`null` to deselect: `value` is never null; `[]` deselects a multiple select, SO-022); CH-014, CH-015 (trial runs).
