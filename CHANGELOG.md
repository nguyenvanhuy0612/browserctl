# Changelog

## 0.8.4

A fix release. Most of it closes gaps where a tool reported success for something that did not
happen, or where the one-parameter `target` addressing of 0.8.0 had not reached every path.

### Changed
- **`browser_element_screenshot` and `browser_describe_element` take `target`.** They were the
  last tools still declaring `ref` / `index` / `selector` / `placeholder`; those are now refused
  with the one-parameter form, as on every other tool.
- **`browser_action` runs a tool's name exactly as that tool.** `browser_action({action:
  "read_page", params})` goes through `browser_read_page` itself: the same parameter check, the
  same schema, the same mapping onto protocol actions. A removed spelling such as `ref` is refused
  there too, and `browser_action`'s own `tabId` and `format` carry over.
- **Calls that used to report success for nothing now fail.** `replay` stops at the first step
  that fails and names it; `go_back` / `go_forward` fail when the tab does not move;
  `record_start` fails on a page it cannot hook; `fill_form` refuses an option a `<select>` does
  not have; `browser_type` on a `<select>` points to `browser_select_option`.
- **`browser_spoof_visibility` takes `restore: true`** to put the page's own `hidden` /
  `visibilityState` back and turn focus emulation off. Its result now says the spoof lasts until
  the page navigates.

### Fixed
- **An action is sent once.** On a debugger-attached tab the dialog watcher gave up after 3 s and
  sent the action again, so a slow click or type ran two or three times. The MCP client no longer
  resends after a timeout or a dropped connection either — only a refused connection proves the
  command never arrived.
- **Frame-qualified refs work through `target`.** A ref such as `@f3:ref_5` from a snapshot was
  sent to the top frame and not found; `browser_file_upload` dropped `target` altogether and fell
  back to the page's only file input.
- **`method: "type"` types.** The method never reached the extension, so it behaved as `set`. It
  now sends key and input events per character on free-text fields, and uses `set` on fields that
  sanitize a partial value (number, date).
- **Target resolution:** a `<label>` and the control it names, or an `<li>` around its link, are
  one match rather than an ambiguity; an app-shell custom element no longer matches every text
  query; `E5` is a label, not a ref; `placeholder=` prefers an exact match and is not confused by
  a labelled region around the input; labels and `aria-labelledby` inside a shadow root name
  their control; a control once matched as plain text is no longer refused on every later call.
- **Recording:** a checkbox or radio replays to the state it was left in, not to its value
  attribute; recording continues after the page navigates; steps from another tab are ignored.
- **`element_screenshot`** clips the right area on pages with smooth scrolling and for elements
  inside same-origin frames, and says so when the element has no size.
- **Submitting with `type` / `paste`** no longer submits twice when the page handles Enter itself.
- **CDP:** dialog events arrive on every attached tab; the network buffer keeps the newest 2000
  requests instead of the first 2000; two actions on one tab no longer cancel each other's dialog
  watch.
- **Long-lived pages** no longer accumulate every ref ever issued.
- **`browser_stop` stops the daemon.** It recorded a stopped state and reported success while the
  bridge kept running. `browser_start` on a running bridge clears that state.
- **`browserctl stop` on Windows** killed every process in `netstat` output for the port, Chrome
  included; it now kills the listener only.
- **Custom `BROWSERCTL_BRIDGE_URL`:** the daemon is started on, and stopped at, the URL's port.
- **Smaller fixes:** `wait_for({for: "settle"})` is no longer cut off at 30 s; full-page capture
  through `screenshot_fullpage` and the CLI's `-f`; the CLI reads `--cursor`, `find … --max N` and
  `upload '#input' file`; `hover` returns its `resolved` block; storage refuses an unknown area.

### Internal
- The call log records each response's size in `bytes`.
- `run_extended.mjs`, the live suite for the loadable profiles, runs in the release gate.
- Unit tests no longer write the real `~/.browserctl/daemon.json`.

## 0.8.3

### Fixed
- **Closing a tab that is already closed succeeds.** `chrome.tabs.remove` throws on a tab that is
  gone, so a caller that closed a tab and then cleaned up got a failure for reaching the state it
  asked for. It now reports `alreadyClosed: true`; a failure with the tab still open is still a
  failure and still throws. The pinned-tab release moved with it — closing the pinned tab used to
  leave the pin on a tab that no longer existed, so every later untargeted command went nowhere.
- **The call log's size cap is honoured.** The size was read once at start-up and then only added
  to, so anything that truncated or replaced the file from outside left the count wrong for the
  life of the daemon — rotating early and overwriting the kept `.1`. The size is now read from
  disk, and the count is no longer reset when the rotation itself fails, which previously let the
  file grow past the cap with nothing to stop it.

### Added
- **A caller can name itself in the call log.** `POST /command` accepts an optional
  `client: {session, source}`, recorded on each logged call. One bridge and one extension serve
  every client on the machine, so their commands share a log; without this, a single agent
  session cannot be told apart from a test run, and `runId` identifies the daemon process rather
  than the caller. The MCP server, the CLI, the e2e suite and the benchmark harness each tag
  their own traffic. Both fields are optional, clamped, and absent from a call that does not send
  them.

## 0.8.2

A patch release with one behavioural fix. Everything else changed below the published surface.

### Fixed
- **The server no longer hands an agent call syntax it will then refuse.** When a result carried
  an inline CLI-style hint, the MCP layer rewrote it into MCP form — and six of those rewrites
  still named the `ref` and `selector` parameters that 0.8.0 removed from `browser_get_property`.
  An agent that followed the hint verbatim got its call rejected by the very server that had just
  suggested it. The rewrites now name `target`, like everything else since the clean break.

### Internal
- A gate now reads every tool call written out in shipped source or docs and checks its keys
  against that tool's own schema, so a parameter that is renamed cannot leave working examples
  behind. The gate that already watched for removed *tools* never looked at parameters, which is
  how the fix above stayed invisible through two releases.
- The gates that scan "everywhere the surface is described" shared three copies of one file list,
  and two of those copies named files that no longer exist — so each reported a wider scan than it
  performed. One list now, with a gate asserting every path in it is still there.
- The internal design document is split in two: a spec that states what is true now, and an
  append-only history of how it got that way. Neither ships. A count that had been wrong in four
  places for eleven revisions came out of the spec entirely — `preflight` prints it.
- Everything private now lives under one directory that the public sync excludes by location,
  replacing five patterns that matched by filename.

## 0.8.1

**0.8.0 was published on 13 Sep and withdrawn the same day; npm never allows a withdrawn version
number to be reused, so this release carries the next one.** If you installed 0.8.0 in that
window, everything below applies to you as well — it is the same break from 0.7.x, not a second
one.

**BREAKING — this release is a clean break and does not support 0.7.x.** Every tool was renamed or
consolidated, element addressing collapsed into one `target` parameter, and the compatibility
shims that existed during development have been removed. A 0.7 call fails; it does not quietly
keep working. Failures are actionable: a removed parameter is refused with the form that replaces
it, and `browser_action` called bare lists every action the bridge will dispatch. Pin 0.7.1 if you
are not ready to move.

### Consolidated & Renamed Tools
- **browser_navigate**: Collapses browser_open_url and browser_reload into a single tool (url or reload: true).
- **browser_tabs**: Consolidates browser_list_tabs, browser_switch_tab, browser_close_tab, and new-tab creation into a single management interface (action: "list" | "new" | "select" | "close").
- **browser_type**: Renamed from browser_fill, supporting text input with set, type, and paste methods.
- **browser_evaluate**: Renamed from browser_eval_js.
- **browser_take_screenshot**: Renamed from browser_screenshot.
- **browser_file_upload**: Renamed from browser_upload.
- **browser_get_content**: Renamed from browser_get_page_content.

### New Capabilities
- **Unified target Resolution Engine**: Single parameter for element addressing across all interaction tools (browser_click, browser_type, browser_get_property, browser_select_option, browser_press_key, browser_scroll, browser_file_upload). Supports refs (@ref_1), explicit prefixes (css=, text=, placeholder=, index=), CSS selector syntax matching, exact visible text on interactive controls, placeholders/aria-labels, and type selector fallbacks. Reports unambiguous resolution metadata and raises AMBIGUOUS_TARGET on multiple candidate matches.
- **browser_fill_form**: Batch form filling tool executing sequential field writes in one round-trip with stop-on-first-failure diagnostics.
- **browser_extract**: Structured multi-row extraction tool from repeating DOM containers without writing JavaScript expressions.

### Fixed
- **`browser_take_screenshot({format: "png"})` works.** The shared `format` parameter added to every tab-scoped tool was overwriting the screenshot tool's own image-format enum, so the only accepted values were `json`/`pretty`/`smart`/`raw` — a PNG could not be requested at all, while the tool description advertised it. A tool that declares its own `format` now keeps it.
- **`browser_hover` accepts `ref` and `index` again.** Its `target` was required, so the documented aliases were rejected by schema validation before the alias mapping ever ran.
- **`browserctl browser_eval_js` is understood by the CLI again**, like every other renamed name.
- **`browser_fill_form` refuses an empty field list at the schema** instead of a round trip later.
- **`browser_extract` no longer requires `fields`.** Omitting it returns each row's text with its ref, which the protocol always supported — the tool schema was stricter than the capability.
- **`target` is required on `browser_click`, `browser_type`, `browser_select_option` and `browser_hover`**, so a call missing it fails at the schema rather than a round trip later.
- **`browser_go_back` / `browser_go_forward` work again.** They went through `chrome.tabs.goBack`, which refused every tab with "Cannot find a next page in history" even where the page's own `history.back()` moved fine. They now drive the page's history directly, which also works on a tab that is not in the foreground — the state this tool exists to drive.

### Changed
- **A page with several regions of one kind can now be told apart.** `structure` lists each region separately with its own ref and the name it declares (`nav "Shortcuts" 15 (@ref_80)`), and the census starts a new header when the region changes, not just when the landmark type does (`[Navigation — Facebook]`, `[Navigation — Shortcuts]`). Asked for "the left-hand navigation" on facebook.com, an agent previously saw 24 items under one `[Navigation]` heading spanning three different regions. A page with one region of each kind is unchanged, to the byte.
- **A compact snapshot no longer carries the same rendered census twice.** `compactView` was an alias of `census` on every single-frame page, and the multi-frame merge rebuilt it even when there was nothing to merge. It is now emitted only when sub-frames were actually folded in, and readers fall back to `census`. On facebook.com a snapshot dropped from 38.2 kB to 31.8 kB — about 1,600 tokens per call.
- **browser_tabs / list_tabs report `groupId`.** A tab in a Chrome tab group now says which group it is in. Cleanup could not verify what it could not see, and Chrome syncs saved tab groups between machines — a group left behind by a failed run reappears on the other machine.

### Native Dialog Support — EXPERIMENTAL, and kept out of the core surface
- A call that raises `alert()`/`confirm()`/`prompt()` while a debugger is attached now returns `DIALOG_BLOCKED` naming the type and message, instead of hanging on a page that will never reply. Nothing is ever answered on your behalf, and this guard adds no parameter to any tool.
- Answering lives in the `cdp` profile: `browser_handle_dialog` for one already open, and `onDialog` on the triggering call through `browser_action`. **Unfinished** — no end-to-end coverage, and `beforeunload` and a `blockedBy` field on readers are not built. Do not build on it yet.
- **`browser_hover` takes `target`** like every other interaction tool, instead of `ref`/`index`.

### Changed
- **A session is handed 47% less text before it starts.** The group note (`[READ] …`, `[ACT] …`) was pasted onto every tool description, so 24 tools carried 24 identical copies; it is now stated once in the server instructions and each tool carries only its `[GROUP]` tag. The `tabId`/`tab_id`/`format` parameter descriptions, repeated on 20 tools, moved the same way. What a default session loads dropped from 34,286 to 18,217 characters — roughly 8,600 tokens to 4,600, every session, before any work is done.

### Fixed
- **`browserctl extension-path` prints the folder to load in chrome://extensions.** Installing via npx or `npm -g` puts the extension inside the package, and the install guide told everyone to pick "the `extension/` directory inside this repository" — a directory those users do not have.

### Deprecated & Migration Guidance
- Legacy tool names (browser_open_url, browser_fill, browser_eval_js, etc.) mapped to helpful deprecation error hints directing callers to v2 equivalents.

## 0.7.1 — a result is data, not a rendered page

Breaking in one way that matters to anyone parsing output, despite the patch number: **a tool
answers in compact JSON by default**, where it used to answer in the human-readable "smart" rendering, and the census no
longer carries `[Notice: …]` / `[Next: …]` lines — what they said is in fields now. Pass
`format: "smart"` for the old view. The CLI is unchanged: it asks for `smart` itself.

- **Compact JSON is what a tool returns.** `format` defaults to `json` with no pretty-printing;
  `pretty`, `smart` (the human-readable rendering) and `raw` are still there when you ask for
  them. The CLI asks for `smart`, so a terminal session looks the same as before.

- **Nothing is injected into a result any more.** The `[Notice: …]` / `[More: …]` lines, the
  `[Next: …]` hints and the trailing suggestions block are gone. An agent could not tell which
  of those lines were browserctl talking and which were the page — and neither could a page,
  which is what made forging one worth trying. Guidance now lives where it costs once per
  session instead of once per call: the server instructions and the tool descriptions.

- **`browser_upload` — attach a local file to a file input.** The one thing on this surface a
  page's own JavaScript genuinely cannot do: a `File` can only come from the browser process, so
  `eval_js` was never a fallback for it. It runs through `DOM.setFileInputFiles`, which fires
  `change`/`input` the way a human's picker does, and costs a debugger attach (Chrome's banner
  on that tab).

  Three things it handles because the naive version fails on them: the input is `display:none`
  behind a styled label on nearly every real upload UI, so naming the *visible* control walks to
  the input behind it and the response says which step answered; Chrome opens the paths itself,
  so a relative or missing path is refused at the bridge, where there is a filesystem to check
  against (measured first: a bad path attached nothing and still reported success); and an input
  without `multiple` silently keeps the first file, so the response says how many were dropped
  and why. Also fixed on the way: `chrome.debugger.attach` failing with "another debugger is
  already attached" now detaches our own leftover session and retries once, and says what to do
  when the holder is somebody else (DevTools open on that tab).

- **A click no longer reads its coordinates off a moving box.** Playwright refuses to click
  until the target has stopped moving; we dispatched at wherever it was, so a control sliding in
  with a modal was clicked at last frame's position. `click` now waits for the box to stop
  (capped at 300ms) and reports `effect.stabilized` when it had to wait, with a warning when it
  never settled. The detection differs by regime, which is the part worth knowing: a tab that is
  not visible receives **no animation frames**, yet its animation timeline keeps advancing
  (measured on a background tab: a slide read 298 -> 310 -> 323 px across three calls) — so a
  visible tab is checked by sampling the box across frames and a hidden one by reading the
  running animations. A fade or a colour change is not a moving target. The first cut of this
  used a 1px tolerance, which read a 400px-over-10s slide (0.66px per frame) as stationary.

- **What the notices carried became fields.** `browser_snapshot` answers with
  `offscreenCount`, `foldedCount`, `duplicateCount`, `structure`, `hiddenContent` and
  `openDialogs[].ref` — the same facts, addressable, and no longer competing with page text for
  the reader's attention. The rendered census stays available as `census` for a human reading
  the CLI.

- **`browser_open_url({read})` returns a structured object, and its census is paged.** A probe
  asked it to open Hacker News with `read: "snapshot"` and got **63,000 characters**, past its
  harness's inline budget, so the result was spilled to a file and the agent gave up on reading
  the page and wrote `querySelectorAll` instead. The composite was bypassing the paging of the
  census it composes. Same page now: **1,167 characters**, paged. [F98]

- **`browser_snapshot` says what it does NOT carry.** The same probe concluded "no browserctl
  tool maps DOM properties to pixel geometry" and hand-rolled `getBoundingClientRect` four
  times. The census description now names the call that does:
  `browser_get_property({selector, all: true, fields: {box: {property: "box"}, cls: {attr: "class"}}})`.

- **An `all: true` read renders one line per row.** It was falling through to a raw JSON
  dump — twelve lines a row, with `property`/`name`/`present` repeated on every one — so a
  fifty-row survey cost six hundred lines to say fifty things. That is the token cost that
  sends an agent back to `eval_js`. A box now renders as coordinates, a null field as `-`, an
  absent attribute as `(not present)`, and a URL as its resolved absolute form. [F97]

- **A field whose property answers outside `value` is no longer a silent null.**
  `property: "box"` answers in x/y/width/height, and the fields reader read only `.value`, so
  every box came back `null` — a wrong answer wearing a right answer's shape, on exactly the
  call ("every button, its label, where it is") that the feature exists for. [F96]

- **`note` is an array when there is more than one thing to say.** Two unrelated facts ("this
  field matched nothing in the row" and "there are more rows than listed") were glued into one
  string with a space.

- **Each tool group now says it is a ladder.** The note prefixed onto every tool in a group
  lists its siblings and says so outright: if one does not answer, the answer is almost
  always another one in the list — work along it before reaching for `eval_js`. The member
  lists are generated from the group definition; hand-written, the READ note named two tools
  that had been merged away two releases earlier, and was therefore wrong on all seven READ
  tools at once.

- **The loop is stated where it is read.** `orient -> read -> act -> verify`, once in the
  server instructions and again as the prefix on every tool description, so the shape is
  present at the moment of choosing a call rather than only at connect.

- **Two intents that had no line in the index now have one:** surveying a page (every
  control's name, box and classes in one call) and `browser_describe_element` for "why is
  THIS element not working", which lives in the `advanced` profile and was invisible.

- The intent-index checks sliced to a fixed character count, so the index growing pushed
  `browser_load_tools` out of the window and the check quietly stopped covering its tail.
  Both slice to the index's real end now.

- **The docs describe what exists, not how it got here.** Tool descriptions are a functional
  sentence plus a pointer to the neighbour that answers the next question — half the characters
  they were, with no mention of surfaces that were removed. The hand-written tool catalogue in
  `docs/REFERENCE.md` became a pointer to `docs/TOOLS.md`, which is generated from the running
  registry and gated; what stays in REFERENCE is the part a generated table cannot carry, plus
  the parameters that behave the same way on several tools.

- **The release gate runs every live suite, not one of four.** `run_multiframe.mjs`,
  `run_labels.mjs` and `run_editors.mjs` were left to be run by hand, and three assertions in
  the multi-frame suite went on asserting the census prose that this release removed — failing,
  unnoticed, for two releases. A suite the release does not run is a suite that rots.

- **`eval_js` answered differently depending on whether a debugger happened to be attached.**
  An async expression returned `{}` through the `chrome.scripting` path (no await) and the
  resolved value through `Runtime.evaluate` (which sets `awaitPromise`) — one expression, two
  answers, no error either way. Both paths now await, and both report the same shape: a value
  that has no JSON form (a DOM node, a `Map`, a `Set`) comes back with its class name and a
  line saying `{}` is not the same as nothing.

Unit 143/143; the four live suites (main 93/93, multi-frame 19/19, editors 12/12, label
parity) are all green and all four are now run by the release gate; thirteen gates green.

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
