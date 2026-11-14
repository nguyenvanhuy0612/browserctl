# `hover`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `settle.md`, `errors.md`

## Purpose

Move the pointer over an element to open a menu or show a tooltip.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | ref or selector | the element |
| `trusted` | boolean | no | `false` | | real pointer movement through the CDP lane |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab and target; actionability: visible, scrolled into view, hit test at the centre
   (polled up to 5 s). Disabled elements can be hovered.
2. DOM lane: `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove`, `mousemove`
   at the centre. This opens menus driven by script (`mouseenter` handlers). It does not set CSS
   `:hover`, which only real pointer movement does (spike: a `:hover` menu stayed closed).
3. CDP lane: Playwright `locator.hover()`, with focus emulation for background tabs. The pointer
   stays there until the next pointer action in the tab.
4. Settle. In the DOM lane, when nothing changed, the result's `hint` says that menus opened by
   CSS `:hover` need `trusted: true`.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `resolved` | as in `click` | yes | |
| `outcome` | as in `click` | yes | |
| `hint` | string \| null | yes | the CSS `:hover` note |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`, `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET`, `INVALID_TARGET`, `TARGET_HIDDEN`, `TARGET_COVERED`, `DEBUGGER_CANCELED`,
`DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Hover over an element to open its menu or tooltip. Menus that open only through CSS :hover need
trusted: true (real pointer; shows Chrome's debugging bar).
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| HOV-E01 | live | menu opened by a `mouseenter` handler, DOM lane, background tab | opens, no debugger |
| HOV-E02 | live | menu opened by CSS `:hover`, DOM lane | stays closed, `hint` set |
| HOV-E03 | live | the same with `trusted` | opens |
| HOV-E04 | live | tooltip on a disabled button | shown |
| HOV-S01 | site | Facebook: hover a nav icon | tooltip text appears in the next snapshot |
