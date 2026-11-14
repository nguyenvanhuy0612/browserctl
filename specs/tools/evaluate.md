# `evaluate`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `relay.md`, `errors.md`

## Purpose

Run the agent's JavaScript in the page, with the page's own globals, when no tool fits. Always
available; never refused because a tool exists for the job.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `function` | string | yes | | a JavaScript function, `() => ...`, `async (el) => ...`, or an expression | the code |
| `target` | string | no | | ref or selector | element passed as the function's first argument |
| `trusted` | boolean | no | `false` | | run through the CDP lane (shows the debugging bar) |
| `tab` | integer | no | session's current tab | owned tab | which tab |

The parameter is named `function`, as in playwright-mcp, which agents already know.

## Behaviour

1. Resolve the tab. If `target` is given, resolve it and mark the element (`targets.md`).
2. DOM lane: `chrome.userScripts.execute` in the MAIN world, in the frame of `target` (its frame
   id) or the main frame. `function` is placed into the script's source text (no `eval` or
   `new Function` at run time, which page CSP would block). The wrapper finds the marked element
   (searching open shadow roots), removes the mark, calls `function` with it if it is a function,
   and awaits a returned promise (at most 30 s).
3. CDP lane (`trusted: true`, or userScripts off and the caller passed `trusted: true` after the
   `USER_SCRIPTS_OFF` hint): Playwright `page.evaluate` or `locator.evaluate`.
4. Serialize the value: JSON values as they are; `undefined` as `null` with `type: "undefined"`;
   DOM nodes as a short HTML preview; functions, symbols and cycles as a description. Results over
   50 KB are cut and the cut is reported.
5. A thrown error or rejected promise → `EVAL_ERROR` with the page's message and the first stack
   line.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `value` | any JSON | yes | the result |
| `type` | string | yes | `typeof` of the original value, `"node"` for DOM nodes |
| `truncated` | boolean | yes | cut at 50 KB |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `EVAL_ERROR`, `USER_SCRIPTS_OFF`,
`TIMEOUT`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Run JavaScript in the page (page globals available). function: "() => document.title", or
"(el) => el.value" with target: a ref. Promises are awaited. Use it whenever no other tool fits.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| EVAL-U01 | unit | serialization: undefined, node, cycle, 60 KB string | `type`, preview, description, `truncated` |
| EVAL-E01 | live | `() => document.title` | value |
| EVAL-E02 | live | `(el) => el.value` with a ref inside an open shadow root | value; mark removed |
| EVAL-E03 | live | async function resolving after 1 s in a background tab | awaited |
| EVAL-E04 | live | throws, rejects | `EVAL_ERROR` with message |
| EVAL-E05 | live | page with `script-src 'nonce-...'` (no `unsafe-eval`) | works through userScripts |
| EVAL-E06 | live | userScripts off | `USER_SCRIPTS_OFF`; with `trusted: true` works |
| EVAL-E07 | live | reads a page global (`window.__app`) | value (MAIN world) |
| EVAL-S01 | site | Facebook and GitHub, `document.title` | value, no debugging bar |
| playwright-mcp `evaluate.spec.ts` | live | adopted cases | same values |

## Deferred option: `chrome.scripting` fallback

Not built; recorded for when "Allow User Scripts" being off becomes a problem. Owner decision
2026-11-14: leave it until needed.

Today the DOM lane runs `evaluate` only through `chrome.userScripts`; with the toggle off it
answers `USER_SCRIPTS_OFF` and never switches lanes on its own. The option is a middle step:
`chrome.userScripts`, then `chrome.scripting.executeScript` in the MAIN world with the code
evaluated there, then `USER_SCRIPTS_OFF`. Measured on the owner's Chrome (spike
`run-real-dom.mjs`): the `chrome.scripting` path works on pages without a strict CSP and is blocked
on Facebook and GitHub (`unsafe-eval` not allowed), so it would help only on pages without one.
