# Common action parameters

Status: verified (2026-11-14, owner direction: actions take a ref or any locator, plus parameters
such as wait and timeout, each with a default; see the review log in `specs/README.md`)
Depends on: `targets.md`, `settle.md`, `tools/wait_for.md`, `errors.md`

The action tools share three parameters, so an agent learns them once. Each has a default; leaving
them out gives the behaviour the tools had before.

| Name | Type | Default | Allowed values | Tools | Meaning |
| --- | --- | --- | --- | --- | --- |
| `timeout` | number (seconds) | 5 | 0 to 60 | `click`, `hover`, `type`, `fill_form`, `press_key` (with `target`), `scroll` (with `target`), `file_upload`, `get` | how long to wait for the target to exist and be actionable (visible, enabled, not covered, editable). 0 tries once |
| `scroll` | string | `"auto"` | `"auto"`, `"center"`, `"none"` | `click`, `hover`, `type`, `fill_form` | `auto`: scroll the target into view only when its centre is outside the viewport; `center`: always scroll it to the middle first; `none`: never scroll, and fail with `TARGET_OUTSIDE_VIEWPORT` when it is outside |
| `wait` | object | none | one condition of `wait_for` (`text`, `textGone`, `target` + `state`, `url`, `time`) plus its `timeout` (seconds, default 10), with `wait_for`'s constraints (non-empty strings) | `click`, `hover`, `type`, `fill_form`, `press_key`, `scroll`, `file_upload`, `navigate` | after the action has settled (`settle.md`), wait for the condition, so act-then-wait is one call |

## `wait`

- Same conditions, matching rules and polling as `wait_for` (`tools/wait_for.md`); exactly one
  condition, else `INVALID_PARAMS` before anything runs.
- The action runs first. A wait that times out does not undo it and does not turn the result into
  an error (a retry would act twice): the result carries
  `waited: {ok: false, waitedMs, lastSeen}` and a `hint` saying the action ran but the condition
  was not met. A wait that holds gives `waited: {ok: true, waitedMs, matched}`.
- Without `wait`, the result has `waited: null`. `fill_form` runs it only when every field was
  set.

## `timeout`

- Seconds, as in `wait_for`. It bounds the actionability polling of the DOM lane (every 100 ms in
  the daemon, `click.md`) and every Playwright call of the CDP lane (for `file_upload` also the
  click and the wait for the file chooser). `0` means one try in both lanes: the CDP lane passes
  1 ms to Playwright, where 0 would mean no limit.
- The error at the end is the last actionability error (`TARGET_NOT_FOUND`, `TARGET_HIDDEN`,
  `TARGET_DISABLED`, `TARGET_COVERED`, `TARGET_NOT_EDITABLE`), as before; when the daemon polled
  at least twice, its message ends with `(gave up after N s; raise timeout to wait longer)`.

## `scroll`

- DOM lane: applied in the runtime's actionability check, before the hit test.
- CDP lane: `center` scrolls the element to the middle before the Playwright call; `none` checks
  the element's box against the viewport first and fails with `TARGET_OUTSIDE_VIEWPORT`; `auto`
  is Playwright's own behaviour.
- `TARGET_OUTSIDE_VIEWPORT` is not retried: the page will not scroll by itself.

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| ACT-U01 | unit | `wait` with two conditions, with none, with an unknown key, with `text: ""`; `timeout: 61`; `scroll: "top"` | `INVALID_PARAMS` before any page call |
| ACT-E01 | live | click a button that shows text 1 s later, with `wait: {text}` | `waited.ok`, `waitedMs` about 1000 |
| ACT-E02 | live | same, with `wait: {text: "never", timeout: 0.5}` | result ok, the click happened, `waited.ok: false`, hint |
| ACT-E03 | live | element added 3 s after a click (the click's own settle can take about 1 s, so 1 s left no margin): `timeout: 0.3` then `timeout: 5` | `TARGET_NOT_FOUND` in under 1.5 s (polling plus round trips), message names 0.3 s; then the click lands |
| ACT-E04 | live | button below the fold: `scroll: "none"`, then `"center"` | `TARGET_OUTSIDE_VIEWPORT`; then clicked and centred |
| ACT-E05 | live | `trusted: true` with `wait` and `scroll: "none"` on the same page; `timeout: 0` on a covered button; `file_upload` with `timeout: 0.5` on a button that opens no chooser | same outcomes in the CDP lane; both fail in under 3 s |
| ACT-E07 | live | `fill_form` whose second field does not exist, with `timeout: 0.3` and `wait` | `failed.index: 1`, `waited: null`, returns without waiting |
| ACT-E06 | live | `navigate` to a page that renders after a slow request, with `wait: {text: "Loaded content"}` | `waited.ok` |
