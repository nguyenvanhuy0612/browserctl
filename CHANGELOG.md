# Changelog

## 0.7.0 — one name per capability, a census that answers, gates that derive

Breaking. `core` is **23 tools**, down from 35. Every capability the removed names carried
is a parameter on a tool that remains, no aliases were kept, and every underlying protocol
action still runs — `browser_action({action, params})` reaches them and its catalogue lists
them.

| Removed | Call instead |
|---|---|
| `browser_get_text`, `browser_get_attribute`, `browser_get_count` | **`browser_get_property`** with `property: "text" \| "value" \| "html" \| "box" \| "attr" \| "count"` |
| `browser_type`, `browser_paste`, `browser_select_option` | `browser_fill` with `method: "type" \| "paste"` or `option` |
| `browser_navigate`, `browser_new_tab`, `browser_open_and_read` | **`browser_open_url`** with `target: "current" \| "new" \| <tabId>`, `wait`, `read` |
| `browser_find_text` | `browser_find({query, in: "text"})` |
| `browser_screenshot_fullpage` | `browser_screenshot({fullPage: true})` |
| `browser_wait_settle` | `browser_wait_for({for: "settle"})` |
| `browser_dismiss_modal` | click the dialog's own close control, or `browser_action({action: "dismiss"})` |
| `browser_click_selector`, `browser_fill_selector` | `browser_click({selector})` / `browser_fill({selector})` |

The measurements behind it: 43 real agent sessions across two clients used a median of 5.5
to 7 distinct tools out of the 35 that were loaded, and 43 of 80 registered tools were never
called once. Every failure observed in that window was parameter-level — four out of four —
and not one was a wrong-tool choice.

### The element read is one tool now

`browser_get_property` reads one element, a whole region, every match, or a whole row-shaped
list:

```
browser_get_property({selector: 'div[role="main"]'})                       // a region's text
browser_get_property({selector: 'a', property: 'attr', attr: 'href', all: true})
browser_get_property({selector: 'li.result', all: true, fields: {
  title: 'h3', url: {selector: 'a', attr: 'href'}, price: '.price' }})     // a row at a time
```

Three MCP names on one protocol action is what produced the bug that started this: `all` was
added to one of the three faces and the other two silently stayed narrower, so the tool whose
NAME matched "read every href" was the one that could not do it. `fields` closes the last
read an agent had a good reason to write in JavaScript — a probe used `eval_js` exactly once
on the previous build, for exactly this, and said why.

Field selectors resolve INSIDE each row. A value that sits in a sibling of the row is a
separate read, and the response names the fields that matched nothing instead of returning
silent nulls.

### The census answers instead of just reporting

- **Paged, not truncated.** `browser_snapshot` lists `limit` elements (default 200) and
  returns `next`; pass it back as `cursor`. Indices and refs stay valid across pages.
- **Regions and dialogs carry refs.** `[Structure: … aside 19 (@ref_32)]` and
  `[Open dialog: "Notifications" 360x722 (@ref_35) — read it with 'get text @ref_35']`.
  Reading a right rail used to mean guessing `[role=complementary]`.
- **The counts reconcile.** In-scope, whole-page and offscreen now add up; paging states its
  own numbers separately.
- **`browser_find` takes a CSS `selector`** and returns the same refs — the cheap way to get
  a ref for something that just appeared, without re-reading the page.

### Parameters are checked, not guessed

- `tab_id` is declared on every tab-scoped tool and normalised to `tabId`. It used to be
  accepted by three tools and silently stripped by the other 76.
- Unknown parameters are refused with the legal set, a did-you-mean, and a redirect for the
  measured wrong-tool tells. `read_page {format:"markdown"}` used to return an accessibility
  tree and report success, so an agent concluded the reader was broken and hand-rolled the
  read in `eval_js` for the rest of the session.

### Fixes

- **A click that navigates is no longer reported as a stale ref.** Submitting a form worked,
  changed the URL, and returned `STALE_REF`: the content script running the action died with
  the old document and the retry ran against the new one. It reports the navigation now, and
  deliberately does not retry — a retry is a double submit.
- **`browser_open_url` cannot hijack the tab the user is looking at.** With nothing pinned,
  `target: "current"` opens a new tab and says so.
- The cross-frame snapshot merge passes the top frame's result through instead of listing the
  fields it keeps — it had silently dropped every field added to the census after it was
  written, twice.
- Hints name calls that exist: the inline footer, the dialog notices, `wait_network_idle`'s
  timeout hint and the CLI help all pointed at tools that had been deleted.

### Releasing

`npm run preflight -- --e2e` runs ten gates: versions, unit tests, the generated tool table,
documentation coverage for every tool and every parameter, dead pointers to removed tools,
end-to-end action coverage, the agent-facing intent index, the npm tarball, and the live
suite. They **derive** what they check from the tool registry and the parameter schemas, so a
new tool or parameter is checked from the moment it exists. See
[docs/RELEASING.md](docs/RELEASING.md); the full tool surface is generated into
[docs/TOOLS.md](docs/TOOLS.md).

Unit 121/121. End-to-end 85/85 against a live browser.

## 0.6.3 — the hint an agent cannot call

A tier-1 agent drove Gmail through browserctl and spent **28 of its 44 calls on `eval_js`**,
hand-rolling reads that `browser_get_text` answers exactly. It never called `get_text`,
`get_page_content` or `find_text` once, and never widened a snapshot past the viewport. The agent
wrote its own post-mortem blaming itself. The bridge call log for the same session says the tool
surface was at fault.

- **Inline hints were written in CLI syntax.** When the census truncates a body it prints
  `[+168 chars: get text @ref_48]`, and every compact view ends with
  `[Next: ... read one value: get text @ref · ... · more of the page: snapshot --all]`. An MCP
  client has `browser_get_text` and `browser_snapshot({scope:"all"})` — nothing called `get text`.
  The mapping lives in the server's instructions, read once at session start, while the hint
  arrives inline forty messages later; the inline one wins.

  The comment directly above that footer in `content.js` predicted this exactly — *"a low-tier
  model reaches for eval_js and hand-rolls the read"* — so the mitigation for the problem was
  written in the syntax that causes it. Hints are now rewritten to real tool calls in `text()`,
  the single funnel every MCP response passes through, bounded to bracketed hint spans so a page
  whose own text contains `snapshot --all` is never altered. [F78]

- **All three read tools pointed away from the read that was wanted.** `get_text` returns
  `el.innerText` and reads a whole container, but was described as *"Read one property of an
  element"* — a field getter. `get_page_content` ended with *"For web app UI ... use
  browser_snapshot instead"*, and snapshot truncates, closing a loop whose only exit was
  `eval_js`. `read_page` opened by discouraging itself and never mentioned `ref_id`, the parameter
  that answers the folded-subtree case it gets blamed for. All three now name the region read and
  each other. [F79]

### Runtime logs

`calls.jsonl` already rotated at 8 MB keeping one `.1`, so it was capped at 2× — verified rather
than assumed. What was wrong around it: a `statSync` on **every command** to check the size (now
tracked in memory), a cap that could only be changed by editing source (now
`BROWSERCTL_CALL_LOG_MAX_MB`), and nothing anywhere saying that a record of everything driven
through the bridge was being written. The bridge now announces it at startup and `status` reports
current size against the cap.

`telemetry.jsonl` had no bound at all and now rotates the same way. `.gitignore` listed
`bridge/telemetry.jsonl` **without the trailing star**, so a rotated `.1` would have shown up as
untracked and could have been committed — invariant I9 by a one-character gap. [F80]

The notice added above was then found to be invisible: the daemon is spawned with
`stdio: "ignore"`, so a startup line reaches nobody in the mode everyone runs. `browserctl status`
is the surface a person looks at, and it could not print the log because the CLI calls
`GET /status`, which returned `{ extensionConnected }` alone while `action: "status"` returned six
fields — two endpoints answering one question from two hand-kept lists. One `statusPayload()` now
serves both. [F81]

Suites: unit 93 · e2e 73 · multi-frame 19 · editors 12 · labels 9.

## 0.6.2 — the docs, and what auditing them turned up

No new capability. Two user-facing bugs, one silent metric, and a documentation pass that made the
project's own numbers checkable.

- **`dismiss` could not close a native `<dialog>`.** A dialog opened with `showModal()` closes on
  Escape only for a **trusted** key event — the browser handles that, not the page — so the
  dispatched `KeyboardEvent` never closed one. `dismiss` tried its close-button selectors, then
  Escape, then threw `MODAL_NOT_DISMISSED`. The most standard modal in HTML was the one case it
  always failed. It never reported false success, which is why it went unnoticed for so long: the
  0.6.0 verification rewrite already made `dismiss` confirm the modal is gone before claiming
  anything. It now calls `close()` on the element before falling back to Escape. [F77]

- **`browserctl find <query>` silently did nothing.** The CLI maps positional arguments per command
  and `find` / `find_text` had no case, so the query fell on the floor and the command ran with
  empty params. The missing case is fixed, but the real fix is the new `default:` branch: any
  command that forgets its positional mapping now exits with an error instead of running empty.
  [F74]

- **`--help` carried none of the guidance the MCP descriptions carry.** An agent driving the CLI
  got no warning that `browser_stop` is not for tidying up, which is the one thing that breaks the
  premise of the project. Both surfaces now say the same things. [F73]

### The coverage report had been flattering for the whole v2 effort

`run.mjs` ended with **"Command coverage: 59 of 61 exercised"**. `ALL_ACTIONS` was a hand-written
literal; the protocol surface was 80 by then. Nineteen actions — `fill`, `paste`, `find_text` and
the whole `get_*` family — were outside the denominator entirely, so nothing they did or stopped
doing could ever be reported. The list is now derived from the MCP registry at run time, excused
actions print their reason, and a unit test fails if the derivation returns an implausible surface.

This is the invariant on metrics (I7) for the third time, and the first time in the dangerous
direction. The two cases already recorded there lied *downward* and cost a day hunting defects that
did not exist. This one flattered, and a flattering metric is never questioned. [F76]

Making the denominator honest exposed four actions no suite had ever called: `fill`, `dismiss` /
`dismiss_modal`, `focus_window`, `open_and_read`. Tests were written for them, which is how the
`dismiss` bug above was found. `open_and_read` turns out to be unreachable from a bridge-level
suite at all — it is an MCP-layer composite with no protocol action — and `focus_window` steals OS
focus; both are now excused with the reason printed rather than silently missing.

### Documentation

Docs claimed a completeness they did not have, and the numbers in them had drifted [F75]. The
README pointed raw-HTTP callers at `PROTOCOL.md` "for the full list" — it details 24 of 81 actions,
and the bridge has no enumeration endpoint, so that was a dead end for the one audience that cannot
call `browser_action`. `REFERENCE.md` listed `browser_clear` / `browser_check` / `browser_uncheck`
as tools; they are protocol actions with no dedicated tool, and calling them fails.

The rule settled on: **a raw count in prose is deleted, not dated, unless the reader needs it to
make a decision.** `core` (35) vs `all` (80) stays, because that number picks a profile. Everything
else now points at the source that is always right — `browserctl --help`, `browser_action` called
bare, or `debugger-policy.md`'s per-action table.

Also: every doc now carries an H1, a purpose line, and a date where it is a snapshot; the design
doc moved into `docs/history/` where the project's own taxonomy puts it; and a finding cited by a
test is now required to have an entry in the history log, which F73-F77 did not.

Two spec defects of the same shape, one found by a reader: a table column headed `Site` that
contained actions, and consequence cells that stated a general failure for three rows and a
one-site anecdote for the fourth (`paste` "an email body landed in the composer twice" — the bug is
in any editor that handles the paste itself, not in email).

### Tests

`run_labels.mjs` waited a fixed 1200 ms for its fixture and reported "9/9 labels are missing" when
run back-to-back after other suites — a total failure that was really a page that had not rendered.
A suite that fails at random teaches you to re-run it, which is how a real regression gets waved
through. Replaced with a readiness poll that SKIPs explicitly if the fixture never appears.

Suites: unit 89 · e2e 73 (66/80 commands exercised, 5 excused) · multi-frame 19 · editors 12 ·
labels 9.

## 0.6.1 — exactly once

Three defects of one shape, found by drafting a real email: **two mechanisms that each do the whole
job, run one after the other.** Same shape as 0.6.0's double click (F1).

- **`paste` inserted the text twice.** `execCommand("insertText")` ran, succeeded, and the
  ClipboardEvent was dispatched anyway. Now exactly one path runs — the ClipboardEvent first for paste
  semantics, `insertText` as the fallback.

  The first fix was wrong on half the editors, and only a second editor revealed it. Success was
  measured by reading the content back synchronously; Facebook's Lexical composer preventDefaults the
  paste and commits **asynchronously**, so the read-back saw nothing, the fallback fired, and Lexical
  then committed too. Gmail commits synchronously and looked fine. The signal is now `preventDefault`
  — `dispatchEvent` returns false when the editor claims the event — which is synchronous and standard
  regardless of when the editor commits.

- **`press_key(Enter)` submitted a form twice.** It dispatched keydown and then called
  `requestSubmit()` unconditionally. That call is a fallback for forms that only submit via their
  button, never an addition to the Enter key — `type(submit: true)` already guarded this, `press_key`
  did not. A page that submits from its own keydown handler submitted twice: a double order, a double
  send. The response now reports `submittedByPage` and `keydownPrevented`.

- **The paste fallback was gated on the box looking empty.** An insertion path that reported success
  while leaving the previous content in place skipped the fallback, and `paste` returned ok having
  replaced nothing. Now gated on whether the insertion actually happened. `type` and `paste` also
  report `effect.textNow` for a contenteditable — the symmetric read-back to `valueNow`.

Also: `browser_get_count`'s description now states that a count of 0 is an answer rather than a
failure, that malformed CSS is a separate `INVALID_SELECTOR` error, and that ARIA roles seen in a
snapshot are not CSS tags.

### New suite — `tests/e2e/run_editors.mjs`, 12 checks

Insertion and activation must each happen exactly once, across editor architectures that differ in the
two ways that change the outcome: whether the editor handles the event, and whether it commits
synchronously.

```
paste / type  ×  plain contenteditable · preventDefault+async · preventDefault+sync · textarea · input
press_key     ×  form that handles Enter itself · form that submits only via its button
```

Mutation-checked: removing the `preventDefault` signal makes exactly one case fail —
`preventDefault + async commit`. Every other case, and Gmail, still passed with the bug in place.

### Test harnesses no longer leak tabs

`audit_tools.mjs`, `coverage_check.mjs`, `label_vs_chrome.mjs` and `run_labels.mjs` each opened a tab
per run and never closed one; a day's testing left 54 tabs in the browser. All four now close what
they open.

Suites: 83/83 unit · 70/70 e2e · 19/19 multi-frame · 12/12 editors · 9/9 labels.

## 0.6.0 — agent accuracy

An accuracy release. Every finding below came from driving browserctl with fresh-context agents on
live sites (Facebook, GitHub, YouTube, Booking, Amazon, Wikipedia, Hacker News) and then reproducing
what they hit. Full evidence, repros and verification status in
`docs/history/fix-plan-v2-verified-2026-09-08.md` §9-§20.

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
