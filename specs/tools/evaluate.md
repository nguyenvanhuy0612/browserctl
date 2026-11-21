# `evaluate`

Status: verified (2026-11-21: `timeout`, `action`)
Depends on: `dom-lane.md`, `targets.md`, `relay.md`, `errors.md`

## Purpose

Run the agent's JavaScript in the page, with the page's own globals, when no tool fits. Always
available; never refused because a tool exists for the job.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `function` | string | yes | | a JavaScript function, `() => ...`, `async (el) => ...`, or an expression | the code |
| `target` | string | no | | ref or selector | element passed as the function's first argument |
| `timeout` | number | no | `30` | 1 to 300 seconds | how long the code may run, promise included |
| `action` | boolean | no | `false` | | the code changes the page: run it as an action (below) |
| `trusted` | boolean | no | `false` | | run through the CDP lane (shows the debugging bar) |
| `tab` | integer | no | session's current tab | owned tab | which tab |

The parameter is named `function`, as in playwright-mcp, which agents already know.

## Behaviour

1. Resolve the tab. If `target` is given, resolve it and mark the element (`targets.md`).
2. DOM lane: `chrome.userScripts.execute` in the MAIN world, in the frame of `target` (its frame
   id) or the main frame. `function` is placed into the script's source text (no `eval` or
   `new Function` at run time, which page CSP would block). `function` is compiled outside the
   wrapper's own scope, so it sees the page's globals even when they share a name with the
   wrapper's variables (`result`, `value`, `element`); names starting with `__bctl` are
   reserved. The wrapper finds the marked element
   (searching open shadow roots), removes the mark, calls `function` with it if it is a function,
   and awaits a returned promise.
3. CDP lane (`trusted: true`, or userScripts off and the caller passed `trusted: true` after the
   `USER_SCRIPTS_OFF` hint): Playwright `page.evaluate` or `locator.evaluate`.
4. Serialize the value: JSON values as they are; `undefined` as `null` with `type: "undefined"`;
   DOM nodes as a short HTML preview; functions, symbols and cycles as a description. Results over
   1 MB are cut and the cut is reported.
5. A thrown error or rejected promise → `EVAL_ERROR` with the page's message and the first stack
   line. Code still running after `timeout` → `TIMEOUT` naming `evaluate` and the limit, with the
   hint to raise `timeout` (not the hint of a page that stopped answering: the page answers other
   calls meanwhile).
6. `action: true`: the code runs as an action does (`sessions.md`: after the action in flight on
   the tab), and the result carries `outcome` after the page settled (`settle.md`), as `click`'s
   does. Without it nothing waits, so reading values stays fast.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `value` | any JSON | yes | the result |
| `type` | string | yes | `typeof` of the original value, `"node"` for DOM nodes |
| `truncated` | boolean | yes | cut at 1 MB |
| `outcome` | object | with `action: true` | what changed, as in `click` |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `EVAL_ERROR`, `USER_SCRIPTS_OFF`,
`TIMEOUT`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Run JavaScript in the page (page globals available). function: "() => document.title", or
"(el) => el.value" with target: a ref. Promises are awaited (timeout). action: true when the code
changes the page: outcome after it reacts, like click. Use it whenever no other tool fits.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| EVAL-U01 | unit | serialization: undefined, node, cycle, a 60 KB string (whole), a string over 1 MB (cut) | `type`, preview, description, `truncated` |
| EVAL-E01 | live | `() => document.title` | value |
| EVAL-E02 | live | `(el) => el.value` with a ref inside an open shadow root | value; mark removed |
| EVAL-E03 | live | async function resolving after 1 s in a background tab | awaited |
| EVAL-E04 | live | throws, rejects | `EVAL_ERROR` with message |
| EVAL-E05 | live | page with `script-src 'nonce-...'` (no `unsafe-eval`) | works through userScripts |
| EVAL-E06 | live | userScripts off | `USER_SCRIPTS_OFF`; with `trusted: true` works |
| EVAL-E07 | live | reads a page global (`window.__app`) | value (MAIN world) |
| EVAL-E08 | live | `trusted: true`: `() => document.title`, and `(el) => el.id` with a selector | same values through Playwright |
| EVAL-E09 | live | page globals named `result`, `value`, `element`, `mark` | each read back as the page set it |
| EVAL-S01 | site | Facebook and GitHub, `document.title` | value, no debugging bar |
| EVAL-E11 | live | `action: true` with code that clicks a button whose handler adds text after a 0 ms timer | `outcome.domChanged: true`, the text is there when the call returns |
| EVAL-E12 | live | a promise that never settles, `timeout: 1`, in both lanes | `TIMEOUT` naming `evaluate` after about 1 s; the next call on the tab works |
| EVAL-E10 | live | playwright-mcp `evaluate.spec.ts`: `document.title`, an element's style by locator, an object, a cyclic object, the expression `(1+1)`, a thrown error | the values (the cycle as `"[circular]"`); `EVAL_ERROR` with the message |

Not adopted from `evaluate.spec.ts`: the sandboxed page (served with a CSP `sandbox` header the
fixture server does not send) and the count of evaluations (no per-call page instrumentation).

## Edge cases left out

| Case | Why |
| --- | --- |
| Stopping code that is still running after `timeout` | the page's script cannot be interrupted from outside; the call returns and the code finishes on its own (a synchronous loop blocks the page, so the next call reports the page not answering) |
| `outcome` without `action` | settle costs at least 800 ms; most evaluate calls read values |

## Deferred option: `chrome.scripting` fallback

Not built; recorded for when "Allow User Scripts" being off becomes a problem. Owner decision
2026-11-14: leave it until needed.

Today the DOM lane runs `evaluate` only through `chrome.userScripts`; with the toggle off it
answers `USER_SCRIPTS_OFF` and never switches lanes on its own. The option is a middle step:
`chrome.userScripts`, then `chrome.scripting.executeScript` in the MAIN world with the code
evaluated there, then `USER_SCRIPTS_OFF`. Measured on the owner's Chrome (spike
`run-real-dom.mjs`): the `chrome.scripting` path works on pages without a strict CSP and is blocked
on Facebook and GitHub (`unsafe-eval` not allowed), so it would help only on pages without one.
