# `get`

Status: verified (2026-11-14, new tool asked for by the owner; see the review log in
`specs/README.md`)
Depends on: `targets.md`, `actions.md`, `dom-lane.md`, `errors.md`

## Purpose

Read one fact about an element, or about every element a selector matches: its text, value, an
attribute, a property, its HTML, its state or its box. The snapshot shows the structure; `get` is
the precise follow-up, so an agent does not need `evaluate` for it (0.9.x baseline: 41% of MCP
calls were `evaluate`, most of them reading one value).

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | ref or locator (`targets.md`) | the element |
| `what` | string | no | `"text"` | `"text"`, `"value"`, `"attribute"`, `"property"`, `"html"`, `"state"`, `"box"` | what to read |
| `name` | string | for `attribute` and `property` | | attribute name (`href`), or a property path (`dataset.id`, `validity.valid`) | which one |
| `all` | boolean | no | `false` | | a selector matching several elements returns each of them (at most 100) instead of `AMBIGUOUS_TARGET` |
| `maxChars` | integer | no | 5000 | 100 to 200000 | cut `text`, `html` and the text `value` of a contenteditable element |
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to exist (`actions.md`); visibility is not required |
| `tab` | integer | no | session's current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab and the target (`targets.md`), polling until it exists or `timeout` ends.
2. Read in the DOM lane (no debugger, works in background tabs):

   | `what` | Value |
   | --- | --- |
   | `text` | `innerText` (rendered text; `textContent` when the element is not rendered), cut to `maxChars` |
   | `value` | inputs and textareas: `value`; selects: the selected options' values (a list for `multiple`); checkboxes and radios: `checked`; elements with role `checkbox`, `radio` or `switch`: `aria-checked` as a boolean; contenteditable: its text, cut to `maxChars`; others: `null` |
   | `attribute` | `getAttribute(name)`, `null` when absent |
   | `property` | the property at the dotted path: primitives as they are; plain objects and arrays as JSON; any other object (a DOM object such as `validity`, `classList`, an element) as its `toString()`; functions and missing steps `null` |
   | `html` | `outerHTML`, cut to `maxChars` |
   | `state` | `{visible, enabled, editable, checked, focused, inViewport}` (`checked` is null for non-checkable elements) |
   | `box` | `{x, y, width, height}` in CSS pixels relative to the viewport, plus `inViewport` |

3. Return without settling: `get` changes nothing.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `resolved` | `{by, ref, role, name}` | without `all` | the element |
| `value` | any | without `all` | what was read |
| `cut` | integer | without `all` | characters removed by `maxChars` (0 when none) |
| `count` | integer | with `all` | how many elements matched |
| `items` | `{resolved, value, cut}[]` | with `all` | the first 100 |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`, `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET` (without `all`), `INVALID_TARGET`, `INVALID_PARAMS` (`name` missing for
`attribute` or `property`, or given for another `what`).

## Tool description (what the agent reads)

```text
Read one thing about an element: what: text (default) | value | attribute | property | html |
state | box; name: the attribute or property (href, dataset.id). target: a ref or a locator.
all: true returns every match of a selector. Use it instead of evaluate to read a value.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| GET-U01 | unit | `what: "attribute"` without `name`; `name` with `what: "text"` | `INVALID_PARAMS` |
| GET-E01 | live | locators fixture: text, value of text input, select (single and multiple), checkbox, `role=switch` with `aria-checked="true"` | values |
| GET-E02 | live | attribute `href`, property `dataset.id`, property `validity.valid`, property `validity`, missing attribute | values, `"[object ValidityState]"`, `null` |
| GET-E03 | live | `html` with `maxChars: 100`; `text` of a hidden element; `value` of a long contenteditable with `maxChars: 100` | cut reported; `textContent`; value cut to 100 |
| GET-E04 | live | `state` of a disabled and of an offscreen button; `box` | flags and numbers |
| GET-E05 | live | `all: true` on `css=li` (12 items); without `all` | `count: 12`, items; `AMBIGUOUS_TARGET` |
| GET-E06 | live | on a fresh page, element added 3 s after a click: `timeout: 0` right after the click, then `timeout: 6` | `TARGET_NOT_FOUND`, then found (the element did not exist when the wait began) |
| GET-E07 | live | frame ref | read inside the frame |
