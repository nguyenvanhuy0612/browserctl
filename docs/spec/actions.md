# Spec: actions

An action is `click`, `type`, `fill`, `paste`, `press_key`, `hover`, `scroll`, `select_option`,
`dismiss`. Two rules govern all of them, and both were learnt by shipping their violation.

## Rule 1 — exactly once

**Where two mechanisms can each do the whole job, exactly one runs.**

This is the most repeated defect in the codebase. Four instances, all the same shape: dispatch the
real event, then call the programmatic equivalent as well.

| Site | What ran twice | Consequence |
|---|---|---|
| `click` | a dispatched `click` event **and** `el.click()` | every page handler fired twice — double submit, double send, double order [F1] |
| `type(submit)` | Enter keydown **and** `requestSubmit()` | double form submit |
| `paste` | `execCommand("insertText")` **and** a `ClipboardEvent` | an email body landed in the composer twice [F70] |
| `press_key(Enter)` | Enter keydown **and** `requestSubmit()` | double submit on any form that handles Enter itself [F71] |

### How "the first one worked" is decided

Not by reading the DOM back. That check is synchronous and editors are not.

The first fix for [F70] measured success by comparing content before and after. Facebook's Lexical
composer `preventDefault`s the paste and commits **asynchronously**: the read-back saw nothing, the
fallback fired, and Lexical then committed too — two copies. Gmail commits synchronously and looked
perfectly fine.

The signal is synchronous, standard, and available whenever the editor actually commits:

- **`dispatchEvent()` returns `false`** when a handler called `preventDefault()`. That is the editor
  saying *I own this event*.
- **`execCommand()` returns `true`** when the browser accepted and performed the edit.
- **For a form submit**, listen for the page's own `submit` before dispatching, and honour
  `preventDefault` on keydown.

A fallback fires only when the primary path says it did not act.

> A fix verified against one editor is not verified. `tests/e2e/run_editors.mjs` varies the two things
> that change the outcome — whether the editor handles the event, and whether it commits synchronously
> — because removing the `preventDefault` signal fails **exactly one** of its twelve cases, and Gmail
> passes with the bug in place.

## Rule 2 — say whether it landed

Every action returns an `effect` block. Reporting "ok" for an action that did nothing is the failure
class this whole document exists to prevent.

```jsonc
"effect": {
  "measured": true,
  "domMutated": true,
  "mutationCount": 34,
  "urlChanged": false,
  "targetStillPresent": true,
  "controlState": { "changed": ["checked: false -> true"], "unchanged": [] },
  "valueNow": "…",     // form fields
  "textNow": "…"       // contenteditable
}
```

The mutation counter is attached **before** dispatch, or it cannot see the mutation it is measuring.

### `domMutated` is not proof

It proves the page reacted. It does not prove the intended thing happened.

A real audience selector produced 34, then 320, then 34 mutations across eight clicks while the
selection never committed — and every one of those clicks reported success. The mutations were real:
menus opening, overlays rendering. Nothing in the response distinguished that from the selection
taking [F60].

**For a control carrying `aria-checked` / `aria-selected` / `aria-pressed` / `aria-expanded`**, the
state is sampled before and after and reported as `controlState`. A page that mutates while the
control does not move carries an explicit warning.

### When it clearly did nothing

Zero mutations and no URL change produce:

> `the page did not change at all (0 mutations, same URL): treat this click as NOT confirmed and
> verify before continuing`

This warning has done its job in practice — a probe on npm believed it over its own assumption and
did not report a no-op click as success.

## Actionability

Checked before acting, on the element as it will be at dispatch time:

- **`disabled` is a hard error.** Browsers suppress input to a disabled control, so acting and
  reporting success would be a lie.
- **Any other non-visible reason** still acts, with a `warning`. A zero-size input behind a styled
  label is real, and refusing would remove working capability.
- **The covered check runs AFTER `scrollIntoView`.** It hit-tests the element's centre, and the scroll
  moves it — measuring first tested coordinates the click would never use [F60].

So a `warning` means "it ran, but the element did not look actionable — verify". An error means "it
could not have worked".

## Refs

A ref is WeakRef-backed and survives re-snapshots. When it goes stale, the error **names its
replacement**: refs record the label they were assigned to, and the live DOM is searched for that label
(exact, then diacritics/case-folded).

```
ref "@ref_2" is stale — the page re-rendered. The control labelled "Hacker News" is now @ref_199;
retry with that ref.
```

"Re-run snapshot" threw away the one thing that would fix it: which control the agent wanted. SPA menus
re-render between the snapshot and the click that follows [F57].

What resolution must **never** do is guess. `data-bctl-ref` holds the 0-based snapshot index, not the
1-based ref number, so a stale `ref_4` once resolved to the element *after* the intended one and the
action reported success against the wrong target [F2]. A re-snapshot costs one cheap call; a wrong
click cannot be taken back.
