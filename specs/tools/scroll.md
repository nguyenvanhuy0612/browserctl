# `scroll`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `dom-lane.md`, `relay.md`, `targets.md`, `settle.md`, `errors.md`

## Purpose

Scroll the page or a scrollable container, bring an element into view, or load more content in
an infinite list.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `direction` | string | no | `"down"` | `"up"`, `"down"`, `"left"`, `"right"` | |
| `amount` | number | no | 0.8 of the container's height (or width) | pixels, 1 to 100000 | how far |
| `to` | string | no | | `"top"`, `"bottom"` | instead of `direction`/`amount` |
| `target` | string | no | the page | ref or selector | a scrollable container to scroll, or any other element to bring into view |
| `trusted` | boolean | no | `false` | | real mouse-wheel input through the CDP lane (sites that listen to wheel events; lazy loading in background tabs) |
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to be actionable (`actions.md`) |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab and target. A target that is not scrollable and given without `direction`,
   `amount` or `to` is scrolled into view (centre) and nothing else.
2. A target that is not scrollable but given with a direction scrolls its nearest scrollable
   ancestor.
3. DOM lane: `scrollBy` / `scrollTo` with `behavior: "instant"`.
4. CDP lane: Playwright `mouse.wheel` at the centre of the part of the container inside the
   viewport (the page's centre without `target`), with focus emulation for background tabs;
   then the page height is watched for up to 1.5 s, since loaders answer late (Facebook).
5. Settle (`settle.md`, which also catches content added by loaders), then measure.
6. In a background tab in the DOM lane, when the scroll reached the end and nothing was added,
   the result's `hint` says lazy loading needs `trusted: true` (background tabs do not render, so
   IntersectionObserver loaders do not run: spike).

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `before`, `after` | `{x, y}` | yes | scroll offsets |
| `atEnd` | boolean | yes | cannot scroll further in that direction |
| `contentGrew` | boolean | yes | scroll height grew during settle (more items loaded) |
| `hint` | string \| null | yes | the background lazy-load note above |
| `waited` | object \| null | yes | the `wait` result, null without `wait` (`actions.md`) |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`, `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET`, `INVALID_TARGET`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Scroll the page or a container (target), by direction and amount, or to: top | bottom; or bring
target into view. Reports whether the end was reached and whether more content loaded.
trusted: true uses real wheel input, needed for lazy loading in background tabs.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SCR-E01 | live | page down, to bottom, to top | offsets, `atEnd` |
| SCR-E02 | live | scrollable div by ref | div scrolls, page does not |
| SCR-E03 | live | infinite list, foreground, DOM lane | `contentGrew: true` |
| SCR-E04 | live | infinite list, background, DOM lane | `contentGrew: false`, `hint` set |
| SCR-E05 | live | infinite list, background, `trusted` | `contentGrew: true` |
| SCR-E06 | live | element below the fold, no direction | scrolled into view |
| MO-017..MO-020, MO-022, MO-023 | live | Playwright wheel cases as `scroll` with `trusted` (the wheel point is the target's visible centre, not a mouse position the test chose) | CDP lane |
| SCR-S02 | site | Facebook feed, background, DOM lane, 3000 px | informational: offsets, `contentGrew`, `hint` |
| SCR-S01 | site | Facebook feed, background, `trusted` | `contentGrew` and the page more than 1000 px taller (Facebook keeps only a window of posts in the DOM and numbers none, so counting posts is no measure) |

Not adopted: MO-021 (a modifier held during the wheel: `scroll` has no modifiers).
