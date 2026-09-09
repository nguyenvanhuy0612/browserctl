# Spec: how an element gets its name

The name is the only handle an agent has on a control it can see. Eight separate defects came from
this one function, so the resolution order below is normative and each step names the failure it
prevents.

Ground truth for every rule here is **Chrome's own accessibility tree**. Where the browser and this
implementation disagree, the browser is right. `tests/e2e/label_vs_chrome.mjs <url>` measures the
disagreement on any live page; the bar is 100% of Chrome's named controls.

## Resolution order

Applied in this order, first non-empty wins. Implemented in `fullElementText()` and mirrored in
`accessibleName()`.

| # | Source | Prevents |
|---|---|---|
| 1 | `innerText` / `textContent` — **unless** the tag is in `TEXT_IS_CONTENT` | — |
| 2 | `aria-label` | — |
| 3 | `aria-labelledby`, joining every referenced node's text | GitHub labels icon buttons through a hidden tooltip node; twenty controls on one page came back nameless [F66] |
| 4 | `alt` / `aria-label` of a descendant `img`, `svg`, or `[role=img]` | GitHub avatar links are `<a><img alt="@user profile">`: no text, no aria. All identical, so none could be picked [F67] |
| 5 | `title`, own `alt`, `placeholder` | — |
| 6 | `controlLabelOf()` — a form control's own label (below) | Eleven `<input type="radio">` in one dialog, all nameless [F61] |
| 7 | `value`, **only** for `input[type=button\|submit\|reset]` | `<input type="radio" value="on">` was NAMED "on". Every radio in a group identical, the label beside it ignored [F63] |
| 8 | slotted / shadow-host text | A Web Component's control renders its label through a `<slot>`, so its own `innerText` is empty [F26] |

### `TEXT_IS_CONTENT` — tags whose text is data, not a name

`SELECT`, `TEXTAREA`, `OPTION`, `PROGRESS`, `METER`.

A `<select>`'s text is its option list, so a country picker was named **"Vietnam Japan"** instead of
"Shipping country" [F64]. Same reasoning as keeping `value` out of the chain: content is not identity.

### `controlLabelOf()` — a form control's label

Applies to `INPUT`, `SELECT`, `TEXTAREA`, and anything carrying a `role`. In HTML-AAM order:

1. `aria-labelledby`
2. `<label for=…>`
3. a wrapping `<label>`
4. **the nearest ancestor carrying short, distinct text** — because custom widgets use none of the above

Rule 4 is bounded by two conditions, and both are load-bearing:

- **The ancestor must contain no other interactive element.** A label belongs to exactly one control;
  an ancestor holding two is a container, not a row.
- **Its text must be ≤ 60 characters.**

Without the first condition the walk climbed to a page-level wrapper and named a `<select>`
`"bctl Test Page go second Click Me 0 Apple Banana Cherry hover me no"` — 67 characters, under an
80-char cap that was the only guard at the time. That name then matched `find("hover me")`, which
returned the `<select>`, and `hover` went to the wrong element [F65].

> **A wrong name is worse than no name.** A nameless control is visibly unusable; a wrongly-named one
> makes an unrelated element answer to your query.

## Both readers must agree

`snapshot`, `find_text`, `describe_element` and `click` resolve through `elementText`;
`read_page` and `find` resolve through `accessibleName`. These are different functions and they have
drifted before: the [F61] fix landed in the census only, leaving the same radios named in `snapshot`
and anonymous in the accessibility tree, with `find` matching the surrounding *text* rather than the
control [F62].

**Any change to one must be made to the other.** `tests/e2e/run_labels.mjs` asks all four tools about
the same nine controls and fails if they disagree.

## Truncation

Names are capped at 200 characters. A cut name carries `textTruncatedBy: N` and renders as
`[+N chars: get text @ref]`, because the full value is one call away and an agent that cannot see that
reaches for `eval_js` instead [F35].
