# Changelog

## 0.6.0 — agent accuracy

An accuracy release. Every finding below came from driving browserctl with fresh-context agents on
live sites (Facebook, GitHub, YouTube, Booking, Amazon, Wikipedia, Hacker News) and then reproducing
what they hit. Full evidence, repros and verification status in
`docs/fix-plan-v2-verified-2026-09-08.md` §9-§20.

### The headline

Controls now carry the name **Chrome itself** computes for them. Measured against Chrome's
accessibility tree — `tests/e2e/label_vs_chrome.mjs`, pointable at any URL:

| site | before | after |
|---|---|---|
| github.com/login | 71% (20 anonymous controls) | **100%** (0) |
| en.wikipedia.org/Special:Preferences | 77% | **100%** (0) |
| www.booking.com | — | **100%** (0), census 113 -> 271 controls |
| news.ycombinator.com | 100% | **100%** |
| www.amazon.com/s | 89% | 92% (rest is `display:none` screen-reader text) |

### Reads

- **Names resolve the way the browser resolves them.** `aria-labelledby` on any element (GitHub labels
  its icon buttons through a hidden tooltip); a descendant image's `alt` (`<a><img alt="@user profile">`);
  a form control's `<label for>`, wrapping `<label>`, or its row's text. `value` is no longer used as a
  name — eleven `<input type="radio" value="on">` in Facebook's audience dialog were all called "on",
  which is why "Only me" could not be selected. A `<select>` is no longer named after its own options.
- **Controls that are operable but not plainly visible are censused**, and marked: `[via label]` for the
  standard 1x1 `opacity:0` checkbox behind a visible label, `[hidden until hover/focus]` for
  carousel arrows and skip links. A carousel could not be paged at all before.
- **The full ARIA widget set is matched**, not four roles. `menuitemradio`, `menuitemcheckbox`, `option`,
  `switch`, `treeitem`, `combobox`, `slider` and more were invisible; an open GitHub sort menu returned
  zero results while sitting on screen. Role and ARIA state now render inline:
  `<li>[menuitemradio][checked] "Created on"`.
- **A census leads with the page's shape**: `[Structure: 92 repeated <tr> rows (~2 controls each)]`, and
  folds say what they folded rather than only how many.
- **Notices name what was withheld** — `12 offscreen, including 2 more "Online status indicator Active
  <name>"` — and flag content no scope setting can reveal: `Possible hidden content: "See previous
  notifications" (@ref_81)`.
- **`read_page` works on real SPAs.** Its depth default was 15; a React/Comet app nests 25-45 levels, so
  it returned two headings and reported `truncated: false`. Now 60, it says when it clipped, and it no
  longer prunes React-portal subtrees or emits `<script>` bodies.
- **Open dialogs are reported whether or not they block the page** — a right-rail notifications popover
  was invisible to modal detection three probes in a row.

### Actions

- **A click on a stateful control proves the state moved.** `effect.controlState` reports
  `checked: false -> true`; when the page mutates but the control does not, it says so. Eight
  consecutive "successful" clicks on Facebook's audience radio changed nothing and reported nothing.
- **A stale ref names its replacement.** Refs remember their label, so `STALE_REF` now reads
  *"the control labelled X is now @ref_199; retry with that ref"* — no re-snapshot.
- **`new_tab(url)` waits for the page**, like `navigate` already did. Every agent was inventing its own
  follow-up wait, and a wrong guess cost a full timeout.
- **`wait_for(text=)` is case- and whitespace-insensitive**, and a timeout reports what it saw
  (`closest text on page`, `readyState`) instead of a bare "timed out".

### Tools and discoverability

- **Every tool name dispatches through `browser_action`.** `get_text`, `get_attribute`, `get_count`,
  `get_value`, `get_html`, `get_box` are tool names, not protocol actions — calling them returned
  `unknown action`, which reads as "capability missing" and sends an agent to `eval_js`. Fixed at the
  extension layer, so the CLI and the raw-HTTP endpoint get it too.
- **`get_count` answers zero** instead of `ELEMENT_NOT_FOUND`, and separates invalid CSS from no match.
- **URL attributes come back resolved**: `front (resolves to https://news.ycombinator.com/front)`.
- **Tools are grouped by intent** — `[READ]`, `[ACT]`, `[NAVIGATE]`, `[WAIT]`, `[CAPABILITY]`,
  `[SESSION]` — and the server instructions open with a what-you-want to what-to-call table. The READ
  note states plainly that `browser_snapshot` returns text, not an image; three probes had read the
  name as "screenshot".
- **`browser_a11y_snapshot` is an actionable second opinion.** Chrome's accessibility tree, with a `ref`
  on every node that the census also has, ARIA state preserved, and `censusCoverage` / `notInCensus`
  grading the census against the browser's own answer. It states its cost up front: the debugger banner,
  3x slower than a snapshot.
- **`browser_stop` warns against being called as cleanup** — a probe shut down the shared daemon to tidy up.

### Correctness of the plumbing

- **The frame merge no longer drops fields.** On any page with an iframe — i.e. every real site —
  `background.js` rebuilt the compact view from scratch, discarding landmark grouping, key-input
  hoisting, folding and every notice; then it silently dropped `nearest`, then `pageLabels`. It now
  passes the content script's result through and overrides only what it owns.
- **Per-frame errors survive.** `crossFrame` mapped any failure to `null`, so a content-script exception
  surfaced as "no frame could handle this (page not accessible)" — a permissions-shaped message for a
  crash. The real error is now returned, inline and in `diagnostics.frameErrors`.
- **`browser_a11y_snapshot` attaches on its own**; it used to fail with "call cdp_attach first".

### Observability

- **Opt-in per-call log**: `BROWSERCTL_CALL_LOG=1` writes one JSONL row per dispatched action
  (timestamp, runId, action, tabId, ok/code, durationMs). Parameter **values are never written** —
  only key names and sizes, because `fill`/`type` carry user input and `eval_js` carries code. Across
  five agent probes, not one self-reported its own call count correctly; this is how they were audited.

### Tests

36 -> **81 unit**, plus three new e2e suites, all runnable against live sites:

- `tests/e2e/run_multiframe.mjs` (19 checks) — the multi-frame blind spot that let the compact-view
  regression ship invisibly. Covers landmark grouping, folding, duplicate suppression, truncation
  hints, a non-blocking dialog, a React-portal panel and a `menuitemradio` menu.
- `tests/e2e/label_vs_chrome.mjs <url>...` — census names vs Chrome's accessibility tree.
- `tests/e2e/audit_tools.mjs <url>` — calls every read-only action and separates real failures from
  tools correctly refusing.
- `tests/e2e/coverage_check.mjs <url>` — takes `snapshot --all` as truth and checks everything in it is
  reachable by `find` and readable by `get_text`.
- `tests/unit/content_helpers.test.mjs` — the first behavioural coverage `content.js` has ever had.
  Mutation-checked: three deliberate regressions were introduced and all three were caught.

## 0.5.1

Extension and bridge version bump.
