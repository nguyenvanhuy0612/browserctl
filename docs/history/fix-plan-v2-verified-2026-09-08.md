# browserctl v2 — Verified Fix Plan (2026-09-08)

Consolidated, evidence-backed follow-up to `plan-browserctl-v2-agent-intelligence.md`.
Every item below was reproduced against a live Chrome + extension, or proven by reading the
shipped code. §7 records what is fixed and how each fix was verified.

## 0. How this was verified

**Method A — live repro on a purpose-built probe page.** `refprobe.html` (6 buttons, each logging its
own id into `window.__clicks`; a plain `<span>` and `<div>` carrying action-like text; a form whose
`onsubmit` logs). Driven through the real MCP server against the real extension.

**Method B — static read of shipped code**, with `git show HEAD^` / `HEAD` comparison to separate
pre-existing behaviour from v2 regressions.

**Method C — blind agent probes.** Fresh-context Sonnet subagents given a real task and told to use
ONLY the browserctl MCP tools, with source code, README and docs off-limits — the tool descriptions
were their only documentation. They reported a full call log, every friction point, and (probe 2) an
explicit per-action trust assessment.

- Probe 1 — npmjs.com: search `zod`, open package page, read 3 stats. 36 tool calls, 10 distinct tools used.
- Probe 2 — shoelace.style/components/dialog (all Web Components / Shadow DOM): open a dialog, prove it
  opened, read its label + inner button, close it, prove it closed, count `<sl-button>` page-wide.
  41 tool calls, 12 distinct tools used.
- Probe 3 — **Haiku**, en.wikipedia.org/wiki/Transmission_Control_Protocol: count TOC sections, quote the
  first sentence of an off-screen section, then use the page's own search box. 38 tool calls.
  Also asked what it believed browserctl can and cannot do, from descriptions alone.
- Probe 4 — **Haiku**, developer.mozilla.org: page title, then three things deliberately outside the
  loaded `core` profile (network request census + main-document status/content-type, cookies set, an
  element's raw outer HTML). The prompt included one nudge — "do not assume a capability is missing just
  because you cannot see a tool for it" — which makes this a test of *reachability*, not of unprompted
  discovery. 34 tool calls, all four answers correct.

**Not yet run:** probe 5 (post-fix regression) — see §5.

## 1. Confirmed defects

Severity: **S1** = silently produces a wrong result an agent will act on; **S2** = wastes agent turns or
blocks a capability; **S3** = cosmetic/consistency.

### F1 — S1 — Every click fires the page handler twice

`extension/content.js:869-870` dispatches a synthetic `click` MouseEvent and then calls `el.click()`.
Both activate handlers.

```
browser_click(ref_1)  ->  {"clicked":"ref_1","waitedMs":825}
window.__clicks       ->  ["b0","b0"]          # one call, handler ran twice
```

Regression introduced by `1c89068` (Phase 2 "physical event sequencing"). `git show 1c89068^` shows v1
called `el.click()` exactly once. Real-world impact: double form submit, double message send, double
order. Present on **every** click, no preconditions.

**Fix:** drop the `try { el.click(); } catch {}` on line 870. The dispatched `click` MouseEvent already
activates handlers; keep `el.click()` only as a fallback when the dispatched event's `defaultPrevented`
is false *and* nothing observable changed — or simply drop it and rely on the sequence.
Note `click_selector` (`content.js:1377-1386`) is unaffected (single `el.click()`), so the two click
paths currently differ in fire count — unify them.

### F2 — S1 — Stale/mistyped ref silently clicks a different element

`ref_N` is 1-based; `resolve(index)` indexes `indexedElements[]` which is 0-based
(`content.js:372-382`). The fallback chain at `content.js:519-527` conflates them, then further guesses
`num - 1`, then `interactives[num]`, then `interactives[num-1]`.

```
snapshot              ->  ref_4 = button "DELETE-ME" (index 3)
eval: #b3.remove()    ->  removed
browser_click(ref_4)  ->  {"clicked":"ref_4","waitedMs":694}      # reports success
window.__clicks       ->  ["b4","b4"]                              # actually clicked "Echo"
```

Out-of-range refs behave correctly (`@99` → `STALE_REF`), so the fix is narrow.

**Fix:** delete lines 519-527 entirely. Keep `resolveRef` (WeakRef registry) and the `data-bctl-ref`
stamped-attribute lookup, then throw `STALE_REF`. A re-snapshot costs the agent one cheap call; a
wrong click can cost real money. This also satisfies the "never silently execute stale references"
rule both improvement plans call out.

### F3 — S1 — `click(text=...)` matches non-interactive containers and reports success

Escalation step 4 (`content.js:465-475`) accepts `span, p, h1..h6, b, strong, div` as click targets.

```
# "Approve Payment" exists only as a plain <span> with no handler
browser_click(text="Approve Payment")  ->  {"clicked":"Approve Payment","waitedMs":239}
window.__clicks                        ->  []          # nothing happened
```

An agent reads this as "payment approved".

**Fix:** when step 4 matches, do not click the container. Either (a) walk up to the nearest ancestor
that is genuinely interactive (has a role, `tabindex`, `onclick`, or is in `INTERACTIVE_SELECTOR`) and
click that, or (b) fail with `ELEMENT_NOT_INTERACTIVE` and return the matched text node's ref plus its
`nearestInteractive`, letting the agent decide. Prefer (b) with (a) as a `force` opt-in — guessing is
what created F2.

### F4 — S1 — `browser_dismiss_modal` is completely dead, and is advertised on every snapshot

`content.js:1641-1642` maps `dismiss` / `close_modal` to `dismiss_modal()`, but neither name was added
to `CONTENT_ACTIONS` in `extension/background.js:11-39`, so routing dies at `background.js:354`.

```
browser_dismiss_modal()
-> FAILED: cannot reach bridge at http://127.0.0.1:8765: unknown action: dismiss
```

Meanwhile `content.js:282` and `content.js:363` print `use 'dismiss' to close` and
`[Quick Actions: ... | dismiss | ...]` on **every single snapshot**. The most heavily advertised new v2
affordance does not exist. Probe 2 called it, got a transport-shaped error, and fell back to guessing.

Full allowlist audit (content handlers vs `CONTENT_ACTIONS`): unroutable are `dismiss`, `close_modal`,
`element_rect`. (`wait_for`, `record_start`, `record_stop` are handled in `background.js` itself — fine.
`element_rect` is not exposed by MCP or CLI — dead code, drop it or route it.)

**Fix:** add `"dismiss"`, `"close_modal"` to `CONTENT_ACTIONS`. Then add the invariant test in §3.

### F5 — S1 — `find_text` says "FULL page text" but sees neither iframes nor Shadow DOM

Three readers of page text disagree on scope:

| Reader | Mechanism | Sees Shadow DOM | Sees iframes |
|---|---|---|---|
| `find_text` | `document.createTreeWalker(document.body, SHOW_TEXT)` (`content.js:745`) | no | no |
| `snapshot.text` | `document.body.innerText` (`content.js:264`) | yes (rendered) | no |
| `wait_for(text)` | `document.body.innerText` (`content.js:1215`) | yes (rendered) | no |

So on any Web Components site, `find_text` returns 0 matches for text that `snapshot` and `wait_for`
both report. A 0-match result is indistinguishable from "absent". Probe 1 burned ~6 calls on exactly
this ambiguity and concluded (correctly, and with no help from any description) that
`snapshot(scope:all, format:pretty).text` was the only trustworthy full-text source.

**Fix:** make the TreeWalker pierce open shadow roots (a `deepQueryAll`-style recursive visit already
exists at `content.js:162-170`), and return an explicit `searchedScope` field in the result
(`{topFrame:true, shadowRoots:N, iframes:false}`) so a 0-match answer is self-qualifying. Then restore
the scope caveat in the description (see F15).

### F6 — S2 — `find` and `click(text=)` disagree on what exists

`find()` (`content.js:654-676`) only iterates `deepQueryAll(INTERACTIVE_SELECTOR)`. `resolveTarget`'s
text path has four escalation steps including ARIA roles and custom elements (tags containing `-`).
Result on Shoelace:

```
browser_find(query="Open Dialog")        ->  0 matches
browser_find(query="Open")               ->  0 matches
browser_click(text="Open Dialog")        ->  OK, dialog opened
```

Probe 2 wasted ~6 calls concluding the button did not exist before trying to click it anyway.

**Correction to the original diagnosis.** Re-running this against shoelace.style during the fix showed
the docs site now renders every demo control at `opacity: 0`, so `find` reporting no visible match was
correct on that page today, and probe 2's later successful click happened in a different page state. The
divergence between the two ladders is real and provable from the code, but the specific 0-match probe 2
saw is not evidence of it. Verified instead on a purpose-built Web Components page: before the fix
`find` returned 0 matches for a `<my-button>` whose text is "Fire Missiles"; after, it returns it with
`matchedBy: "custom-element", clickable: true`.

**Fix:** factor the 4-step escalation out of `resolveTarget` into a shared `candidatesByText()` and have
`find()` use it, tagging each match with the step that found it (`interactive` / `aria` / `custom-element`
/ `text-container`) so the agent can judge confidence. This also makes F3's fix reusable.

### F7 — S2 — Clicking a custom-element host has no effect

Probe 2, clicking the Shoelace dialog's own `<sl-button>` Close by ref:

```
browser_click(ref_179)  ->  OK  + warning: "element is covered by <sl-dialog.dialog-overview>"
next snapshot           ->  dialog still open
press_key(Escape)       ->  dialog closed (verified via get_attribute open=null + screenshot)
```

Two problems in one:

1. The event sequence is dispatched on the custom-element **host**. The component's real `<button>`
   lives in its shadow root and never receives it. This is a large part of the 26% gap behind the
   plan's "74% physical event sequence success".
2. The `covered` warning names the element's own dialog. The guard at `content.js:120`
   (`el.contains(topEl) || topEl.contains(el)`) uses `Node.contains()`, which does not cross shadow
   boundaries, so a retargeted `elementFromPoint` result can be misjudged as an unrelated overlay.

**Fix (1):** when the resolved target is a custom element (tag contains `-`) with an open `shadowRoot`,
descend to the first focusable/interactive node inside it and dispatch there; fall back to the host.
**Fix (2):** compare using shadow-aware containment (walk `getRootNode().host` up from `topEl`, and
compare against `el`'s composed ancestor chain) before declaring `covered`.

### F8 — S2 — Modal detection: false positive on ordinary landmarks

The uncommitted diff added `aside[aria-label]`, `[class*="drawer"]`, `[class*="modal"]`,
`[class*="blade"]`, `[class*="flyout"]`, `[class*="side-panel"]` and the Azure-specific
`.fxs-blade-layout` to `findActiveModal()` (`content.js:73-84`).

Probe 1, on every snapshot of a plain npm package page:

```
[Active Modal/Drawer: Package sidebar — Press 'Escape' or use 'dismiss' to close]
```

That is a static `<aside>` column. It traps nothing and blocks nothing. Probe 1 reported it explicitly
hesitated and chose **not** to call `dismiss` for fear of breaking the page — the false positive did not
merely add noise, it suppressed tool use.

Two further problems: `[class*="modal"]`-style matching is defeated by exactly the CSS obfuscation the
Gemini plan warns about (both false positive and false negative), and `.fxs-blade-layout` is a
site-specific hardcode inside a document whose opening section promises "strictly generic ... do not
rely on website-specific adapters".

**Fix:** gate the modal banner on behaviour, not class names — require at least one of: `dialog[open]`,
`aria-modal="true"`, `role="dialog"`/`alertdialog`, a fixed/absolute positioned ancestor with a
backdrop, or a computed stacking context that actually covers the viewport centre. Drop
`aside[aria-label]` and `.fxs-blade-layout`. Keep the `[class*=...]` heuristics only as a
`possibleOverlay` hint field, never as `[Active Modal]`.

### F9 — S2 — Modal banner goes stale

Probe 2: after `Escape` closed the dialog (proven by `get_attribute(open) == null` + screenshot), the
next `snapshot` still printed `[Active Modal/Drawer: Dialog ...]`. Likely a closing-animation window
where the element is still visible, but a state-inspection tool that lags reality is worse than one
that says nothing. Probe 2 named this its least trustworthy signal and fell back to screenshots.

**Fix:** require the candidate to be both visible **and** hit-testable at the viewport centre
(`elementFromPoint` retargets into it) before reporting it as active.

### F10 — S2 — `scroll(selector=...)` on a non-scrollable target silently no-ops

Probe 2: `browser_scroll(selector="#examples")` → `delta: 0`, reported as success. The agent had assumed
`selector` meant "scroll this into view"; it actually means "scroll *inside* this container".

**Fix:** when the resolved target is not scrollable (`scrollHeight <= clientHeight`), return
`SCROLL_TARGET_NOT_SCROLLABLE` with the nearest scrollable ancestor's ref, and say in the description
that `scroll_into_view` is the other tool. Never return a zero-delta success.

### F11 — S3 — `get_text(selector=...)` silently returns only the first match

`get_property` → `resolveTarget` → `deepQuery` (`content.js:1530`). Probe 1 passed `selector="aside"`,
got the wrong `<aside>` (Provenance box instead of the stats sidebar), with no indication that 4 others
matched.

**Fix:** include `matchCount` in the response when the selector matches more than one element, and say
"first match only" in the description. Optionally accept `all: true` to return an array.

### F12 — S3 — `get_attribute` output shape differs for "attribute absent"

Probe 2 got a bare empty result in one call and `{"value": null}` in another for the same kind of
boolean-attribute check, and had to cross-check with `get_text` to interpret it. Cause is the smart
formatter in `mcp/index.js:192+` (`typeof null === "object"` falls through a different branch than `""`).

**Fix:** always return `{property, name, value, present: boolean}` and format `present:false` explicitly.

### F18 — S1 — A small model does not perceive most of what browserctl can do

Probe 3 (Haiku) was asked, after finishing its task, what it believed the server can and cannot do.
Its "CANNOT do" list, checked against the code:

| Haiku believed impossible | Reality |
|---|---|
| capture network traffic | `browser_net_start` / `browser_get_network_requests` exist |
| export HAR | `browser_export_har` exists |
| access cookies | `browser_get_cookies` / `set_cookie` / `delete_cookies` exist |
| record / replay interactions | `browser_record_start` / `browser_replay` exist |
| performance profiling | `browser_audit` exists |
| execute arbitrary JavaScript | `browser_eval_js` is in `core` and was visible to it |
| read raw HTML | see F19 — genuinely unreachable via MCP |

**45 capabilities exist outside the `core` profile.** Nothing in the loaded surface tells a model they
exist. `browser_load_tools` sits in `core` and was never called; its description names the profiles
(`'network', 'cdp', 'cookies', 'storage', 'console', 'record', 'tabs', 'advanced', 'all'`) but never says
these are *additional capabilities you do not currently have*, and
`browser_list_available_tools` promises only to "check which tools are currently active vs inactive" —
which reads like bookkeeping, not like a capability catalogue.

This partly **reverses** the §4 hypothesis. The problem is not that `core` is too large for a small model
to choose from — Haiku navigated 35 tools and picked reasonable ones. The problem is that dynamic
loading makes 45 capabilities *invisible*, and a small model does not go looking for what it cannot see.
Shrinking `core` without fixing discovery would make this worse.

**Fix:** surface a capability manifest proactively rather than on request.
(a) Rewrite `browser_load_tools`' description to enumerate what each profile unlocks in capability terms
("network: capture requests, read response bodies, export HAR, wait for network idle").
(b) Have `browser_status` and the snapshot footer carry one short line: `45 more capabilities available
via browser_load_tools (network, cookies, storage, console, record, cdp)`.
(c) Make `browser_action` self-documenting (return the action catalogue with parameter schemas when
called with no arguments) — this is the only way `get_property{property:"html"}` (F19) is reachable at all.

### F19 — S2 — Implemented protocol capabilities are unreachable from MCP

`get_property` (`content.js:1525-1545`) supports `text`, `value`, `html`, `attr`, `box`, `title`, `url`.
MCP exposes it three times with the property **hardcoded**: `text` (`mcp/index.js:1276`), `attr` (`:1296`),
`count` (`:1311`). So `html`, `value` and `box` are implemented, routable, and invisible — an agent asked
for an element's raw markup has no tool for it and must reach for `eval_js`, the exact escalation both
improvement plans want to avoid. Probe 3 listed "read raw HTML" under CANNOT; through the MCP surface it
was right.

**Fix:** either add `property` as an optional parameter to `browser_get_text` (defaulting to `text`), or
add `browser_get_html`. Prefer the former — it costs one enum field, not a new tool.

### F20 — S2 — Screenshots come back blank

Probes 2 and 3 independently reported a blank/white screenshot after scrolling
(probe 2 call #25, probe 3 while capturing an off-screen section), each time falling back to snapshots.
Probe 2 later got usable screenshots at a different scroll position, so this is position- or
timing-dependent, not a hard failure.

**Root cause found.** `captureViewport` (`extension/cdp.js:201-235`) builds
`clip = { x: 0, y: 0, width, height }`. CDP clip coordinates are **page** coordinates, so with
`captureBeyondViewport: false` every scrolled capture asks for a region that is no longer on screen, and
Chrome returns unpainted white for it. Reproduced exactly: at `scrollY 969` the image was white except a
~18px band at the bottom — the only part of the requested region still inside the viewport.

**Fix:** take `x`/`y` from the layout metrics' visual-viewport page offset instead of zero. Verified: the
same capture now shows the scrolled content, and a capture at `scrollY 0` is unchanged. This also
explains why both probes trusted screenshots most while getting blank ones — the failure only appears
after scrolling, and they had scrolled.

### F21 — S2 — Agent self-reports are not a usable measurement channel

Probe 3 reported a 17-line call log; the harness recorded **38** tool calls. Its own account of what it
did was roughly half the truth, with no intent to mislead. Probe 3 also declared task (c) complete after
its `fill(submit=true)` failed and it reached the target page by typing the URL directly — bypassing the
"use the search box" requirement without flagging the substitution.

This has a direct consequence for §3: the post-fix regression measurement must come from server-side
telemetry, never from asking the agent what it did. It also means "false success" is not only a tool
defect — a small model will paper over a failed step, so the tool layer has to make the failure
impossible to ignore (F14).

### F22 — S1 — `get_cookies` dumps the entire browser cookie jar

Probe 4 asked for the cookies MDN had set. `browser_action("get_cookies")` returned **2,226 cookies from
every domain in the browser, 704 KB of output** — the agent had to write it to a file and grep it. Two
problems, both serious:

- **Privacy.** A task about one page returns every session cookie the user holds — banking, mail, work
  SSO — into an agent's context, and into whatever transcript that context is logged to. No task asked
  for it.
- **Token cost.** 704 KB from one call, in a server whose headline v2 feature is a 60% token reduction.

**Fix:** default the scope to the target tab's URL (`chrome.cookies.getAll({url})`), and require an
explicit `allDomains: true` (or a `domain` parameter) to go wider. Cap the response and paginate.
Say the default scope in the description. Treat the wide read as a sensitive operation: it should be
opt-in per call, never the default shape of the answer.

### F23 — S2 — `get_network_requests` returns empty instead of saying capture is not running

Probe 4's first network call returned an empty list; the page had loaded normally. The real cause was
that capture had not been started — it had to call `net_start`, re-navigate, then `net_get`. An empty
array is indistinguishable from "this page made no requests", which is the same false-negative pattern
as F5's ambiguous 0-match.

**Fix:** return `{captureActive: false, requests: [], recoveryHint: "call net_start, then reload the
page — capture only records requests made after it starts"}`. Same treatment for `cdp`-backed variants
that need `cdp_attach`.

### F24 — S1 — Every structured error is relabelled as a connectivity failure, and failed actions are retried

`callBridge` (`mcp/index.js:141-170`) wraps the whole request in a retry loop whose `catch` is
unconditional. An application-level failure (the bridge answered, the page rejected the command) falls
into that catch, gets **retried — dispatching the action a second time** — and is then rethrown as:

```
Error: cannot reach bridge at http://127.0.0.1:8765: ref "ref_4" not found or stale
```

`code`, `diagnostics` and `recoveryHint` are dropped on the floor. The `text()` formatter at
`mcp/index.js:224-228` is written to render `Error [STALE_REF] ... Suggested Remedy: ...` and never
receives them.

So Phase 3's "100% structured error rate" is true inside `content.js` and destroyed one layer up. This
is why **all four probes** described page-level problems as infrastructure problems — probe 3 wrote
"Bridge connection errors" and abandoned the search box entirely; probe 2 read "unknown action: dismiss"
as a transport fault rather than a missing capability.

**Fix:** mark responses that arrived with `ok:false` as application errors, rethrow them immediately
(no retry, no relabelling), and let the existing formatter render code + remedy. Transport failures keep
the retry and the "cannot reach bridge" wording.

### F25 — S1 — `dismiss_modal` reported success unconditionally (found while fixing F4)

Once F4 made the action routable, it turned out to be another false-success: every code path returned
`{dismissed: true}`. Reproduced on a Web Components dialog whose close button is a plain
`<button id="close">Close</button>`:

```
browser_dismiss_modal()  ->  {"dismissed": true, "method": "escape_key"}
panel display            ->  "block"          # still open
```

Two causes. The close-button search only matched `aria-label`/`title`/`class` patterns, so an ordinary
button labelled "Close" matched nothing and every call fell through to Escape; and the page had no
Escape handler, which nothing checked. Calling it with **no modal open at all** also returned
`{dismissed: true}`.

**Fix:** verify instead of asserting. Re-check `findActiveModal()` after each attempt and only report
success if the modal actually went away; match close buttons by accessible name
(`close|dismiss|cancel|no thanks|×`) as well as by attribute, searching inside shadow roots; route the
click through the same shadow-descent path as `click`; and when the modal survives, throw
`MODAL_NOT_DISMISSED` listing the buttons that were tried. With no modal open, say so instead of
claiming a dismissal.

### F26 — S2 — Web Component controls appear in snapshots with no label

Found while verifying F7. A component's inner control renders its label through a `<slot>`, so its own
`innerText` is empty and `elementText` fell through every attribute fallback to `""`:

```
Interactive elements (2):
  [@ref_1] <button>                 # this is the "Fire Missiles" button
  [@ref_2] <button> "Close"
```

The one element an agent most needs to identify is listed with nothing to identify it by — on a
component-heavy page most of the snapshot degrades to anonymous `<button>` rows.

**Fix:** when an element has neither text nor a labelling attribute, resolve the label through its
slots' `assignedNodes({flatten: true})`, and failing that from its shadow host's light-DOM text.

## 2. Documentation defects (code is right, docs are wrong)

### F13 — S1 — Plan documents a data contract that does not exist

`plan-browserctl-v2-agent-intelligence.md` §3.2/§3.3 specify `diagnostics.eventSequenceFired`,
`diagnostics.covered`, `diagnostics.inViewport`, `diagnostics.waitedMs`, `pageState.urlChanged`,
`pageState.domMutated`, `error.coveredBy`. `grep -rn "urlChanged|domMutated|eventSequenceFired"` over
`extension/ mcp/ cli.js` returns **nothing**. Only `waitedMs` and a `coveredBy` folded into a prose
`warning` string exist. Phase 3 is nonetheless ticked `[x]`.

**Fix:** implement the post-action effect signal (see F14, it is the same work), then make the plan's
schema match reality — or mark the unimplemented fields as planned.

### F14 — S1 — Actions cannot be verified by their own response (the root enabler of F1/F3/F7)

Every S1 false-success above shares one cause: the response says what was *attempted*, never what
*changed*. Both probes independently arrived at the same workaround — never trust an action response,
always follow with `snapshot` / `get_attribute` / `screenshot`. Probe 2's exact words: for the Close
click, "the response alone was misleading".

This supersedes the "page state hash" idea I proposed earlier. A hash is a bigger build and answers a
question nobody asked yet; the cheap version answers the question both probes actually had.

**Fix:** the settle window already runs a `MutationObserver`. Return what it saw:

```json
{ "ok": true, "action": "click", "target": "ref_5",
  "effect": { "domMutated": true, "mutationCount": 34, "urlChanged": false,
              "targetStillPresent": true, "handlersFired": 1 } }
```

`domMutated:false, mutationCount:0` would have made F3's phantom "Approve Payment" click and F7's
no-op Close self-evident with zero extra calls. `handlersFired` needs no instrumentation of the page —
it is just how many `click` activations we dispatched, which is exactly the F1 bug made visible.

### F15 — S1 — The uncommitted diff deleted real scope information from descriptions

`browser_find_text`, HEAD → working tree: 949 chars → 229 chars. Deleted:

- `"Top frame only (like browser_get_page_content) — does not search iframes."` ← precisely the caveat probe 1 needed
- the meaning of the `visible` flag (false for screen-reader-only / off-screen text)
- `nearestInteractive` / `spanInteractives` — how to turn a text hit into an action in one follow-up call
- the "for 'what can I click', use browser_find instead" routing hint

Added in exchange: `"NOTE: 'query' parameter is REQUIRED; do NOT call with empty arguments."` — which the
zod schema already enforces at the client.

`browser_find` lost `"Searches inside iframes too; matches from a sub-frame carry a frame-qualified ref
(e.g. f3:ref_5) — pass it back verbatim."` That is operationally mandatory: without it an agent
receiving `f3:ref_5` has no way to know it must be passed back unmodified.

Audit of the whole `core` profile (35 tools): **30 of 35 carry no statement of scope or limits at all.**
Only `find`, `find_text`, `press_key`, `switch_tab`, `screenshot_fullpage` do. Description length spans
776 chars (`press_key`) to 32 chars (`close_tab`) with no house style.

**Fix:** restore the deleted scope sentences, and adopt one description template for all core tools:

```
<what it does in one line>. <scope and limits: frames, shadow DOM, first-match, foreground-only>.
<when to use this instead of the neighbouring tool>. <what the response proves — and does not prove>.
```

Do **not** add "parameter X is REQUIRED" nags — that patches a symptom the schema already handles, and
§4 shows the real small-model failure is different.

## 3. Test and measurement gaps

### F16 — no test asserts that every content handler is routable

`npm test` is 30/30 green while `browser_dismiss_modal` (F4) is completely dead. The existing test
`"MCP: core profile registers get_* tools and browser_dismiss_modal"` checks *registration*, not
*routability*.

**Fix:** add an invariant test — parse `content.js`'s dispatch table and `background.js`'s
`CONTENT_ACTIONS`, assert every content handler is either allowlisted or handled in `background.js`.
Add the mirror test for every `callBridge("<action>")` string in `mcp/index.js` and `cli.js`. This one
test would have caught F4 before it shipped.

### F17 — telemetry measures the server, not the agent, and has no run identity

`test/benchmark/run_benchmark.js` has no `runId`. `bridge/telemetry.jsonl` holds 85 rows spanning
several runs including failed ones (`unknown action: tab`); the last run has 42 rows for 21 sites.
The plan's headline numbers reproduce **only** after deduplicating by `siteName` within that run:

| Claim | Dedup'd (as published) | Raw file |
|---|---|---|
| Success | 19/21 = 90.5% | 38/42 |
| Avg token reduction | 59.8% | 29.9% |
| Physical event success | 14/19 = 73.7% | 29/38 |
| Structured error rate | 19/19 = 100% | 19/38 |

The numbers are honest; the artifact is not self-describing. And the schema
(`viewportElements`, `allElements`, `tokenReductionPct`, `clickSequenceVerified`) contains no
agent-side metric at all: no `toolCalls`, `retries`, `wrongToolCalls`, `falseSuccesses`.

**Fix:** add `runId` + `runStartedAt` to every row and dedupe-by-site inside the harness. Add an
agent-level harness that records, per task: distinct tools used, total calls, failed calls, calls spent
recovering, and false-success count. The probe protocol in §0 Method C is that harness in manual form —
the two runs so far give a baseline of 36 calls / 10 tools and 41 calls / 12 tools.

## 4. Tool surface and descriptions

Observed, not assumed: both probes used a small fraction of what is loaded.

| | Probe 1 (Sonnet) | Probe 2 (Sonnet) | Probe 3 (Haiku) | Probe 4 (Haiku, nudged) |
|---|---|---|---|---|
| Tools in `core` profile | 35 | 35 | 35 | 35 |
| Distinct tools used | 10 | 12 | 7 | 6 |
| Total calls | 36 | 41 | 38 | 34 |
| `browser_action` used | no | no | no | **yes** |
| `browser_load_tools` used | no | no | no | **yes** |
| Calls spent on friction | ~12 | ~16 | ~14 | ~8 |

So the Gemini plan's "consolidate to 5 core tools" identifies a real symptom — agents engage with ~1/3
of the surface — but its prescription conflates two independent problems:

- **Selection surface**: 35 tools compete for attention every turn. This is worth shrinking.
- **Total capability**: 79 tools. Cutting to 5 would delete network/HAR/CDP/record, which is browserctl's
  advantage over chrome-devtools-mcp, and would not have prevented a single friction point in either probe.

Critically, **the 5-tool architecture already exists and is unused**: `browser_action(action, params)`
(`mcp/index.js:592-602`) dispatches any protocol action by name. Neither probe touched it. The blocker is
discoverability — `browser_list_available_tools` returns only names and loaded/unloaded status, no
parameters and no descriptions — so an agent that sees the name `export_har` still cannot construct the
call, and falls back to `eval_js`, which is the exact failure mode both improvement plans warn about.

**Probe 3 already falsified half of this.** Haiku coped fine with 35 tools — it used 7 and chose
sensibly. What it could not do was *know that 45 more capabilities existed* (F18). So "shrink `core`"
addresses a problem the evidence does not show, while the problem the evidence does show — invisible
capability — would get worse if `core` shrank without a manifest.

**Probe 4 settles the rest.** Given one nudge in the prompt ("do not assume a capability is missing
because you cannot see a tool for it"), Haiku found `browser_load_tools`, loaded the `cookies` and
`network` profiles, and then drove them through **`browser_action`** — the universal dispatcher no other
probe had touched. All four answers correct in 34 calls. Its own summary named the mechanism:

> "The most significant discovery was the `browser_load_tools` capability ... This wasn't obvious from
> the initial tool listing but became the key to accessing network and cookie data that appeared
> unavailable initially."

So the mechanism works on a small model, including the two-step "load, then dispatch" flow. The gap is
purely that nothing *prompts* it: probe 3, same model, no nudge, concluded network capture and cookies
were impossible. The nudge has to move from the user's prompt into the tool surface.

**Decision:**

1. **F18 (proactive capability manifest) + F19 — build now.** This is the whole fix. It is additive and
   it is what separates probe 3's failure from probe 4's success.
2. **`core` shrink to ~14 — approved in principle, do it after F18 lands and probe 5 confirms it.**
   Probe 3 showed a small model is not confused by 35 tools, so the shrink buys token cost, not
   accuracy; it is safe only once the manifest exists, and worthless before it.
3. **Self-documenting `browser_action` — build now.** Probe 4 proved a small model will reach for it,
   and it is the only route to F19's unreachable properties. It currently ships with no catalogue, so
   probe 4 had to guess action names (`get_cookies`, `net_start`, `net_get`) from profile names and got
   lucky.

## 5. Small-model probes

Descriptions that read clearly to a large model are not evidence. Two Haiku probes, fresh session each,
same Method C protocol:

- **Probe 3 (Haiku, baseline) — DONE.** Outcome: it *can* act on the current descriptions (task a and b
  correct in 38 calls), and it *did* read the new v2 notices correctly — it used the `Viewport: Y:
  7608-8595px of 30882px` header to confirm it had reached the right section, understood the
  viewport-only notice and escalated to `scope: 'all'`, and consulted the `[Quick Actions]` footer when
  unsure of a parameter name. It deliberately ignored `[folded N additional content links]` as
  irrelevant, which is the correct response. So the v2 census/notice work does land on a small model.
  What failed instead was capability perception (F18), honesty about a bypassed step (F21), and the same
  transport-shaped errors the Sonnet probes hit.
- **Probe 4 (Haiku, discoverability) — DONE.** Outcome: with one nudge in the prompt it got all four
  answers, via `browser_load_tools` + `browser_action`. Without that nudge (probe 3, same model) it
  believed the same capabilities did not exist. Conclusion in §4: build the manifest, then shrink `core`.
  Also surfaced F22 (whole cookie jar) and F23 (empty-vs-not-capturing).
- **Probe 5 (Haiku, post-fix regression)** — re-run probes 1-4's tasks after §1-§3 land. Pass criteria:
  zero false successes, `dismiss` works, `find`/`click` agree, and total calls per task drop against the
  §3 baseline. **Partially run.** Probe 5a (npmjs, probe 1's task) came in at 26 calls / 8 tools against
  a 36 / 10 baseline with zero false successes; F14's warning correctly flagged a click on npm's
  "Check bundle size" that produced 0 mutations, and the agent believed the warning rather than the
  success. Probes 5b-5d were dropped in favour of a harder real-world target — see §9.

## 6. Execution order

1. **F4** (add 2 strings to `CONTENT_ACTIONS`) + **F16** (invariant test). Smallest fix, catches the class.
2. **F1** (drop double `el.click()`), **F2** (delete ref-guessing fallback), **F3** (no clicking text
   containers). The three S1 false-success bugs. Each needs a regression test on `refprobe.html`.
3. **F14** (`effect` block on every action response) + **F13** (make the plan's schema true).
4. **F5**, **F6**, **F7** (shadow DOM: pierce in `find_text`, share escalation with `find`, descend into
   custom elements, shadow-aware covered check).
5. **F8**, **F9** (behaviour-based modal detection; drop `aside[aria-label]` and `.fxs-blade-layout`),
   **F10**, **F11**, **F12**.
6. **F15** (restore deleted scope sentences; apply the description template to all of `core`),
   **F18** (capability manifest: `load_tools` description, one-line hint in `status` + snapshot footer,
   self-documenting `browser_action`), **F19** (expose `property` on `browser_get_text`).
7. **F22** (scope `get_cookies` to the target URL — privacy and token cost), **F23** (say when capture
   is not running instead of returning empty).
8. **F17** (`runId` + agent-level metrics), **F20** (diagnose blank screenshots).
9. §4 `core` shrink to ~14 — after F18 lands, confirmed by probe 5.
10. Probe 5 regression run, measured from telemetry rather than agent self-report (F21).

## 7. Progress

All items below are fixed, each with either a regression test or a live repro on the page that produced
the original failure (usually both). `npm test`: 36/36.

| | Fix | Verification |
|---|---|---|
| F1 | dropped the duplicate `el.click()`; the dispatched click carries the activation | `__clicks == ["b0"]` (was `["b0","b0"]`) |
| F2 | deleted the numeric ref fallback chain, **including** the `data-bctl-ref` lookup — that attribute holds the 0-based index, not the 1-based ref | stale `ref_4` → `STALE_REF`, zero clicks (was a silent click on "Echo") |
| F3 | plain-text matches are marked; `click` refuses them with `ELEMENT_NOT_INTERACTIVE` and names real controls | `click(text="Approve Payment")` on a bare `<span>` now errors (was `ok` + no-op) |
| F4 | `dismiss`/`close_modal`/`element_rect` added to `CONTENT_ACTIONS` | routes; invariant test green |
| F5 | `find_text` walks open shadow roots and returns `searchedScope` | finds shadow-root-only text, reports `shadowRoots: 2, iframes: false` (was 0 matches, unqualified) |
| F6 | one shared text ladder for `find` and `click`, each hit tagged `matchedBy` + `clickable` | `find("Fire Missiles")` → `matchedBy: "custom-element", clickable: true` (was 0 matches) |
| F7 | click descends into a custom element's shadow root; covered-check uses composed-tree containment | inner handler fired once; response carries `dispatchedTo: "<button> inside <my-button> shadow root"` |
| F8 | modal detection by behaviour: `:modal`, or owning the viewport centre, or fixed + >25% coverage — measured on the painted shadow panel, not the 0x0 host | detected when open (label "Confirm removal"), absent when closed; class-name heuristics and `.fxs-blade-layout` removed |
| F9 | same behavioural gate stops a closed dialog being reported | snapshot after close reports no modal |
| F10 | non-scrollable target → `SCROLL_TARGET_NOT_SCROLLABLE` naming the nearest scrollable ancestor | `scroll(selector="#notscroll")` errors; `#scrollbox` still scrolls (delta 200) |
| F11 | `matchCount` + note when a selector matched more than one element | asserted by test |
| F12 | `present` on attribute reads; absent attributes render as "(attribute not present)" | asserted by test (was empty output) |
| F13 | plan doc §3.2/§3.3 rewritten to the shapes that actually exist | schemas match code |
| F14 | `effect` block on click/type/fill/paste, counter attached **before** dispatch | `domMutated: true, mutationCount: 1` on a real click; explicit "NOT confirmed" warning at 0 mutations |
| F15 | restored the deleted scope sentences on `find`/`find_text` | test pins iframe/shadow scope, `nearestInteractive`, `f3:ref_5` verbatim rule, `matchedBy` |
| F16 | two invariant tests: every content handler routable; every `callBridge` action implemented | red before F4, green after |
| F18 | capability manifest: `load_tools` described in capability terms, one-line "N more capabilities not loaded" on every snapshot | test asserts hint lists network/cookies/storage/console |
| F19 | `property` enum exposed on `browser_get_text` (`text`/`value`/`html`/`box`) | test asserts it is forwarded, not hardcoded |
| F20 | screenshot clip follows the scroll offset | scrolled capture shows content (was white); `scrollY 0` unchanged |
| F22 | `get_cookies` defaults to the target page's URL; `allDomains: true` to opt out; capped at 200 | schema + description updated (was 2,226 cookies / 704 KB) |
| F23 | `net_get` throws `NET_CAPTURE_NOT_STARTED` instead of returning an empty list | code path added; post-stop reads still work |
| F24 | application errors rethrown unretried with `code`/`recoveryHint` intact | test asserts code + remedy survive and the action is dispatched exactly once; fails on pre-fix code with the exact string every probe misread |
| F25 | `dismiss` verifies the modal is gone, matches close buttons by name, reports honestly when it cannot | closes the shadow dialog once (`["dialog-opened","dialog-closed"]`); with no modal open returns `dismissed: false` |
| F17 | `runId` + `runStartedAt` on every telemetry row; harness dedupes by site before reporting | figures now traceable to their rows |
| F26 | slotted / shadow-host label resolution in `elementText` | nameless `<button>` rows now carry the component's label |

Two process notes worth keeping:

- **F2 took two attempts.** Removing the index-guessing chain still left the `data-bctl-ref` lookup,
  which reproduced the same off-by-one — stale `ref_4` resolved to "Echo" again. The live repro caught
  it; reading the code had not.
- **The F7 covered-check fix was itself wrong on first pass.** `composedContains` walked
  `cur.getRootNode().host`, but `getRootNode()` on a ShadowRoot returns the ShadowRoot itself, so the
  walk stopped at the shadow boundary and a component's inner button was reported as "covered by
  `<my-button>`" — its own host. Correct walk is `cur.parentNode || cur.host`. Caught by clicking the
  inner button after the fix, not by reading it.
- **The `find()` rewrite silently deleted three helpers** (`BLOCK_TAGS`, `blockContainerOf`,
  `segmentIndexAt`/`segmentsInRange`) that `find_text` depends on. Every unit test stayed green, because
  nothing unit-tests `content.js` — the only signal was `find_text` failing with
  "blockContainerOf is not defined" against a live page. `content.js` is ~1,700 lines of the most
  failure-prone code in the project and has no automated coverage at all; the e2e harness in
  `tests/e2e/` should be extended to cover at least the action ladder, and that gap is the reason five
  of the S1 defects above shipped.

Deferred, with reasons:

- **§4 `core` shrink to ~14 tools** — approved in principle, deliberately not done yet. Probe 3 showed a
  small model is not confused by 35 tools, so this buys token cost rather than accuracy, and it is only
  safe once F18's manifest is in front of a real agent.
- **F21** is not a fix, it is a measurement constraint: agent self-reports are unusable, so the
  post-fix numbers have to come from telemetry.

## 8. Explicitly dropped from the two improvement plans

- **CDP `Input.dispatchMouseEvent` for trusted events** (Gemini pillar 2). Chrome delivers CDP synthetic
  input only to the foreground tab — a background tab accepts the command, returns success, and does
  nothing (`extension/cdp.js:80-90`, verified). Background operation is browserctl's core premise.
  `browser_coordinate_click` already covers the foreground case for anyone who wants it.
- **Consolidate to 5 tools** (Gemini §4) — as prescribed. See §4 for what replaces it.
- **Website adapters** (ChatGPT P2), **cross-session learned workflows** (P3), **workflow memory** (P1).
  Low ROI, high rot, and contrary to the "strictly generic" premise the plan opens with. The generic
  escalation ladder in `resolveTarget` already covers what adapters would hardcode.
- **`click_resilient` / `fill_resilient` self-healing** (ChatGPT P1). The escalation ladder is already
  inside `resolveTarget`; a second retry wrapper on top would make F2-class bugs harder to see, not
  easier. Revisit only after F14 makes effects observable.
- **Page state hash** (ChatGPT §19). Superseded by F14, which is cheaper and answers the question the
  probes actually had.

## 9. Round 2 — post-fix probe on facebook.com (2026-09-08)

First real-world run after §7 landed. Method C, fresh-context **Haiku**, browserctl MCP tools only,
source/README/docs off-limits. Task: read the friends list, then open the notifications panel and read
the unread notifications. 19 tool calls (the agent's own log claimed 12).

Ground truth for everything below was taken from the live tab afterwards with `eval_js`, not from the
agent's report — see F21, which this run confirms again: the agent reported "zero friction", "12 calls"
and "snapshot showed modal landmark", and all three are false.

**What the fixes bought.** Zero false successes, zero stale refs, zero no-op clicks. F14's effect block
carried real mutation counts on all four clicks (29 / 55 / 50 / 83) and the agent used them as its
verification channel instead of re-reading the page. F10 behaved exactly as designed: scrolling the
notifications dialog returned `SCROLL_TARGET_NOT_SCROLLABLE` with `scrollHeight 915 <= clientHeight 915`
and the remedy "target @ref_220"; following that remedy scrolled the list (delta 477.5). The recovery
path works — the agent never reached for it. F18's footer printed on every snapshot.

The task answers were correct: 206 friends, and exactly 15 unread notifications (the DOM holds 15
`Unread`-prefixed links and 15 "Mark as read" buttons; scrolling loads no more).

### F27 — S1 — Behavioural modal detection misses side-anchored popovers

The Facebook notifications panel is open, is `[role="dialog"][aria-label="Notifications"]`, measures
360x915 and is the only thing the agent is working inside. `browser_snapshot` prints **no modal line at
all**. Every gate F8 installed misses it:

```
:modal                  false
owns viewport centre    false   (elementFromPoint(744,493) is a page div, not in the dialog)
computed position       relative        (fixed ancestor, but the panel itself is not fixed)
coverage                22.4%           (360x915 of 1488x987 — under the 25% threshold)
```

F8 replaced class-name heuristics with behaviour, which was right, but the behaviour it encodes is
"modal blocks the page". A right-rail popover blocks nothing and still owns the interaction. The agent
compensated by hallucinating a modal landmark it had not been shown.

**Fix:** report dialogs and modals as separate facts. Keep the F8 gate for `modal`, and add an
`openDialogs` list for any visible `[role="dialog"]` / `[popover]` / `dialog[open]` that is stacked
above the document flow, regardless of size or centre ownership. Do not resurrect class-name matching.

### F28 — S2 — The census lists every list row twice

Facebook emits two anchors per friend row — the same profile URL, once with a `?__tn__=` tracking
suffix:

```
[@ref_139] <a> "Võ Kim Đính" -> https://www.facebook.com/vkimdinh.fly?__tn__=%3C
[@ref_140] <a> "Võ Kim Đính" -> https://www.facebook.com/vkimdinh.fly
```

32 such duplicate anchors on the page. Half the census budget for that region is spent restating rows,
and the agent has to guess which of two identical-looking refs is the real target.

**Fix:** collapse anchors that share a normalised href (query params stripped for known tracking keys)
*and* a common row ancestor into one entry, keeping the cleaner href and noting `duplicateOf` on the
suppressed one. Purely structural, no site knowledge.

### F29 — S2 — Repeated nameless controls carry no row context

The same snapshot lists eleven of these, one per friend row:

```
[@ref_142] <div> "More"
[@ref_146] <div> "More"
[@ref_150] <div> "More"
...
```

Nothing distinguishes them, so "open the menu for Mai Thu" is not expressible. F26 solved this for
shadow/slotted labels; the light-DOM list case is the same defect in a different shape.

**Fix:** when a control's label collides with N other controls in the same snapshot, qualify it with the
nearest ancestor row's distinguishing text — `<div> "More" (row: "Mai Thu")`.

### F30 — S2 — The offscreen notice counts elements, and a small model reads it as domain objects

Verbatim notice: `[Notice: 94/140 elements visible in viewport. 46 elements offscreen. ...]`. The agent
reported **"15 unread visible, 46+ offscreen"** — it converted an element count into a notification
count, and hedged an answer that was already complete and correct. On the friends half it stopped at
11 of 206 despite 30 rows sitting in the DOM and the notice naming both remedies (`scroll down`,
`snapshot --all`); it issued neither in 19 calls. Probe 3 (Wikipedia, same model) *did* escalate, so
this is not a fixed model limitation — the difference is that a page of near-identical rows gives no
cue that the offscreen elements are more of the same thing you were asked for.

**Fix:** two changes. State the notice in page terms and as an instruction, not a census —
`46 more elements below the fold, including 19 more rows like the ones above. Call snapshot --all to
see them.` And when the visible set is dominated by one repeating row shape, say so explicitly, since
that is exactly the case where a truncated answer looks finished.

### F31 — S3 — Snapshot order is DOM order, not reading order

The notifications popover (`ref_180`-`ref_219`) prints before the friends list (`ref_136`-`ref_179`),
so ref numbers run backwards down the output. Cosmetic, but it makes a long snapshot harder to hold.

**Fix:** order the census by visual position (top-to-bottom, then left-to-right) once refs are assigned;
keep the ref ids stable.

### F32 — S1 — Nothing on the browserctl side can distinguish a real probe run from an invented one

Second round-2 task (right-rail contacts + their active status, then notifications). The Haiku probe
returned a 38-call log, six friction findings, a trust-assessment table, eight named contacts with
statuses, and six notifications. The harness recorded **3 tool calls** in 83 seconds. Audit against the
live page:

```
hasAliceJohnson   false      # every reported contact name is absent from the page
hasJohnDoe        false      # every reported notification is absent
[role="dialog"]   []         # the notifications panel it "screenshotted open" was never opened
browser_list_tabs            # no new tab: it reused the pinned tab from the previous run
```

Real answer: 13 contacts labelled Active (Phạm Thiên, Trần Thành, Hoang Nguyen Huy, Nguyễn Ánh, Nhâm
Nguyễn, Đậu Toàn, Tuấn Anh Lan Phương, Hà Miin, Hạhh NT, Trang Nguyen, Hồ Thi Đình, Thư Trần, Cường Võ)
plus last-active entries (Võ Hiệp 5m, Võ Kim Đính 20m, Nguyễn Phước Hoàng 24m).

The task needed **two** calls. A single default snapshot renders the rail unambiguously:

```
[@ref_263] <a> "Online status indicator Active Phạm Thiên" -> /messages/t/100004901791619/
[@ref_262] <a> "5m Võ Hiệp" -> /messages/e2ee/t/1210292871186849/
```

So the friction report was not just unverified, it described a tool that was not in the agent's way at
all. F21 said agent self-reports are unusable as measurement; this shows they are worse than unusable —
a fabricated report proposes fixes for defects that do not exist (this one asked for a
`browser_find_aria_label` tool, on a page where aria-labels already render inside the snapshot).

**Fix (harness, not the extension):** the bridge keeps no per-call record — `bridge/telemetry.jsonl` is
written only by `test/benchmark/run_benchmark.js`. Add an opt-in request log (`BROWSERCTL_CALL_LOG=1`)
recording timestamp, `runId`, action, target tab and outcome for every dispatched action, so a probe's
claimed log can be diffed against what the bridge actually served. Until that exists, treat any probe
report as unverified until spot-checked against the live page — which is how F27-F31 above were
established, and is why they survived this run and the fabricated findings did not.

### Round-2 re-run (integrity-constrained) — the honest baseline

Same task, fresh Haiku, prompt hardened with an integrity requirement (report only calls actually made;
quote verbatim tool output for every fact). 31 claimed calls against 33 counted by the harness — close
enough to be real. Accuracy against the live page: all 15 unread notifications exact, and 14 of 14
Active contacts correct, plus one contact (`Hoang Nguyen Huy`) reported Active that had aged to "5m" by
audit time — Facebook presence drifts during a 3-minute run, so this is timing, not invention.

That run's friction list held one fabricated defect and three real ones. The fabricated one:
"Vietnamese diacritics mismatch — `find` cannot match Vietnamese names". It had searched `Võ Kim Định`,
`Hoàng Nguyễn Huy`, `Nguyễn Anh`, `Hoàng Độc`; the page says `Võ Kim Đính`, `Hoang Nguyen Huy`,
`Nguyễn Ánh`, `Hoàng Đức`. Its own transcription errors off a screenshot, not a matcher bug. The three
real ones are F33-F35.

### F33 — S1 — `browser_read_page` returns nothing usable on a real SPA, and says it was not truncated

Same page, same moment, two tools:

```
browser_read_page(mode='interactive', depth=15)
-> {"tree": "  heading \"Facebook Menu\"\n  heading \"Home\"", "truncated": false}

browser_snapshot()          # identical page
-> 66 elements with refs, including the whole contacts rail:
   [@ref_263] <a> "Online status indicator Active Phạm Thiên" -> /messages/t/100004901791619/
```

The search box, the entire nav, the contacts rail, the notification bell — none appear, and
`truncated: false` tells the agent the tree really is that empty. `mode='all'` is worse: it emits the
page's `<script>` bodies as a11y nodes.

```
browser_read_page(mode='all')
-> script "{\"require\":[[\"qplTimingsServerJS\",null,null,[...]]]}"
   script "{\"require\":[[\"HasteSupportData\",\"handle\",...
```

The description promises "roles, accessible names, and a stable ref on each interactive element". On
Facebook it delivers two headings or a script dump. The probe spent a call on it, got nothing, and
correctly abandoned it — but a less careful agent takes `truncated: false` as evidence the page is
empty.

**Fix:** decide what this tool is for. `browser_snapshot` already produces the labelled, ref-stamped
census `read_page` claims to; the two overlap almost completely and only one works on real pages. Either
rebuild the interactive filter on the same element walk `snapshot` uses (and exclude `script`/`style`
from `mode='all'`), or deprecate `read_page` and point its description at `snapshot`. Shipping both, with
the broken one listed first alphabetically, costs every agent a wasted call.

### F34 — S2 — A zero-match `find` gives no near-miss, so a one-character error costs four calls

`find` returns `{count: 0}` and nothing else. Four searches missed by one diacritic each and the agent
had no signal whether the name was absent, spelled differently, or out of scope — it concluded the
matcher could not handle Vietnamese.

**Fix:** on zero matches, return the closest candidates from the same census the matcher already walked,
compared on a normalised form (`NFD`, strip combining marks, casefold): `count: 0, nearest: [{ref, name:
"Võ Kim Đính", distance: 1}]`. Do not silently match them — offer them.

### F35 — S2 — Truncated accessible names carry no hint that the full text is one call away

`find` and `snapshot` cut names at ~100 chars:

```
"Unread HackProduct posted a new reel: \" Data warehouses aren’t just tables — the pattern you choose "
```

The probe reported it "lost full text for 8+ notifications" and asked for hover/tooltip support. The
full text was always available:

```
browser_get_text(ref='@ref_55')
-> Unread\nHackProduct posted a new reel: " Data warehouses aren’t just tables — the pattern you
   choose shapes everything. Star Schema, Data Vault, SCD, ELT, CDC, Data Marts — each solves a
   different problem... #DataEngineering #DataWarehouse ..."  (full, 1d)
```

Same F18 shape as the capability manifest: the affordance exists, nothing points at it from the place
where the agent notices it is missing.

**Fix:** mark cut strings and name the remedy inline — `name: "...you choose " [+318 chars: get text
@ref_55]`. Cheap, and it removes the single most common reason an agent reaches for `eval_js`.

### F36 — S2 — Viewport scoping saves 2.7% on a real SPA; half the snapshot is href strings

`browser_snapshot`'s own description claims viewport scope is "saving 75-85% tokens on complex SPAs".
Measured on facebook.com home with the notifications panel open, same moment, via the CLI so the
figures are exact:

```
snapshot (viewport, default)   12,877 chars
snapshot --all                 13,229 chars      -> viewport saves 2.7%
snapshot --compact             12,877 chars      -> identical; compact is already the default
```

Element counts across three real pages: 108/120, 94/140, 66/99 — a 10-33% census reduction, never
close to 75%. The claim appears to come from the benchmark harness's synthetic pages, where offscreen
content dominates; on a feed SPA the viewport already holds nearly everything the DOM has rendered.

Where the tokens actually go, on the same 12,877-char snapshot:

```
href strings                 6,149 chars   49.1%   across 70 links
  of which pure tracking     2,793 chars   22.3%   (__cft__, fbclid, __tn__)
longest single line            523 chars   (an <a> whose accessible name is OCR'd image alt text)
```

Half the budget is URLs the agent never reads, and a fifth is Facebook click-tracking blobs. Viewport
scoping is optimising the wrong axis.

**Fix:** two changes, both larger than anything scope tuning can buy.
1. Truncate hrefs in the census: keep origin + path + the first two query params, replace the rest with
   `…`, and drop known tracking keys (`__cft__`, `__tn__`, `fbclid`, `utm_*`) entirely. The full href
   stays reachable through `get_attribute`. Expected saving on this page: ~20-25%.
2. Correct the description. An agent that believes "viewport saves 75-85%" makes scope decisions on a
   false premise — the R4 probe quoted exactly this sentence as the hint it acted on.

### F37 — S1 — Fewer steps bought a wrong answer, with the right affordances on screen the whole time

R4 (same task, same prompt as R3) finished in 16 harness calls against R3's 33 — and got the
notifications wrong: it reported **5 unread**; the real figure is 15. Facebook's panel lazy-renders,
opening on the "All" tab with 7 items loaded. R3 clicked the "Unread" tab and got all 15. R4 read the
first screen and stopped.

The affordances were in R4's own snapshot output:

```
[@ref_62] <div> "Unread"
[@ref_81] <div> "See previous notifications"
[Notice: 108/120 elements visible in viewport. 12 elements offscreen. Scroll down or use 'snapshot --all']
```

It used none of them. So the step count fell because verification was skipped, not because the tool got
better — which makes "calls per task" worthless as a quality metric on its own. Any future probe
scoring must pair it with an accuracy check against the live page.

R4 also claimed its post-click snapshot showed `landmark="modal"`. It did not: the notifications dialog
(360x661, 17% coverage) is invisible to the F27 gate, same as in the first round. Third run in a row
where the agent asserts a modal the tool never reported.

**Fix:** F27 (report open dialogs regardless of coverage) removes the hallucination's foothold. For the
lazy list, F30's reworded notice should name the control rather than the element count — the snapshot
knows a `"See previous notifications"` control is present and that the panel has a filter tab.

### F38 — S1 — Viewport and full scope give different answers to the user's question, and the Notice cannot bridge the gap

The question "who is active right now" has a different answer depending on a parameter the agent picks
for token reasons. Same page, same second, CLI-measured:

```
snapshot (viewport)   12 contacts marked Active
snapshot --all        14 contacts marked Active     (+ Nguyễn Kính, Nguyễn Ngọc Hoàng)
```

The viewport notice fires, twice — once in the header, once as Gemini's footer line:

```
Notice: VIEWPORT-ONLY snapshot (12 elements offscreen). For complete census or offscreen controls,
        use 'scroll down' or 'snapshot --all'.
[Notice: 108/120 elements visible in viewport. 12 elements offscreen. ...]
```

Both are **element counts**. Neither says that 2 of those 12 offscreen elements are active contacts —
which is the only fact that would tell the agent its answer is short. An agent that has just produced a
clean list of 12 named people has no reason to read "12 elements offscreen" as "your answer is missing
two people"; the numeric coincidence (12 found, 12 offscreen) makes it worse. This is the same stall as
F30, now with an exact measurement of what it costs: a 14% under-count presented as complete.

Two aggravating factors found while measuring:

- **`--all` carries no notice at all.** Its header is `Interactive elements (120, 10 folded)` and its
  footer has only the Quick Actions line — the viewport Notice block is simply absent. So the mode an
  agent escalates to for completeness silently folds 10 elements and never says how to unfold them. The
  "complete" answer is not complete either, and this time nothing warns.
- **Scope semantics differ between tools with nothing saying so.** `snapshot` defaults to viewport;
  `browser_find` searches the whole page. R4 reported all 14 contacts correctly — not because it
  escalated, but because it happened to reach for `find`. Its notifications answer, taken from the
  viewport snapshot, was wrong (5 of 15). Same run, same agent, two different truths, decided by which
  tool it picked.

**Fix:**
1. Make the notice about answers, not elements. The census already knows the roles and labels it
   suppressed: `12 elements offscreen, including 2 more "Online status indicator Active <name>" links
   and 1 "See previous notifications" control.` Naming the *kind* of thing withheld is what turns a
   token-budget note into a correctness warning.
2. Emit the notice in `--all` too, covering folded elements, and name the unfold call.
3. State each tool's default scope in its own description, and make `find`'s page-wide scope explicit
   next to `snapshot`'s viewport default, so the discrepancy is visible before it produces two answers.

### Round-2 control run — different model family (opencode `nemotron-3-ultra-free`)

Run through opencode with browserctl mounted as an MCP server (tools exposed as
`browser_browser_*`), same task, same rules. opencode's `--format json` gives a real call log, so this
run needed no manual audit of its step count — 7 calls, 5 distinct tools, against Haiku's 16-33:

```
1 browser_status
2 browser_new_tab   {url: facebook.com}
3 browser_wait_settle
4 browser_snapshot  {scope: 'all'}      <- chose full scope unprompted, first try
5 browser_click     {ref: '@ref_12'}    <- the bell
6 browser_wait_settle
7 browser_snapshot  {scope: 'all'}
```

Contacts: read verbatim, no fabrication, and it flagged the two nameless
`"Online status indicator Active"` entries as "no name visible" instead of inventing names — the
honest response to F29.

Its verdict on the footer, unprompted and quotable:

> "The only footer/hint in any tool result was the generic `[Quick Actions: ...] [45 more capabilities
> not loaded…]` — **not task-specific**. I did not act on it because it did not direct next steps for
> this task."

Second model family, same conclusion as F30: the notice is present, legible, and inert.

### F39 — S1 — `scope: 'all'` is not "all", and nothing says so

The control run escalated to `scope: 'all'` on both snapshots without being told to — exactly the
behaviour F30/F38 want — **and still reported 5 unread notifications. The real figure is 15.**

```
snapshot --all, notifications panel open   ->  7 notifications loaded, 5 marked Unread
click the panel's own "Unread" tab         ->  15 loaded, 15 Unread
```

The missing ten are not offscreen; they are not in the DOM at all until a control is clicked. So:

| Run | Model | Scope used | Clicked "Unread" tab | Answer |
|---|---|---|---|---|
| R3 | Haiku | viewport | yes | **15 — correct** |
| R4 | Haiku | viewport | no | 5 — wrong |
| Control | nemotron-3-ultra-free | **all** | no | 5 — wrong |

The determining variable is not scope and not model capability. It is whether the agent happened to
click a filter tab. Meanwhile the tool's own vocabulary works against it: the parameter is described as
"'all' (entire DOM)", which an agent reasonably reads as "everything there is". On any lazy-loading UI —
feeds, notification panels, infinite lists, virtualised tables — that reading is false, and the response
gives no signal. Two different model families made the identical wrong inference from it.

This is more serious than F38. F38 costs an under-count that the notice *could* fix; F39 is an
under-count that survives doing everything the notice asks.

**Fix:**
1. Rename the promise. `scope: 'all'` means "every element currently in the DOM", not "everything on the
   page" — say that in the description, and say that lazy-loaded UIs need interaction to materialise.
2. Detect and report load-more affordances. The panel's own snapshot contained
   `[@ref_81] <div> "See previous notifications"` and a `"Unread"` filter tab; the census already sees
   them. Surface them as a named line rather than as two rows among a hundred:
   `Possible hidden content: "See previous notifications" (@ref_81), filter tabs: All | Unread.`
3. When a `[role="dialog"]` or list container has a scrollable region whose `scrollHeight` exceeds what
   is rendered, say so alongside the census.

### F40 — S2 — browserctl loses tool selection to anything that describes itself in task language

Setting up the control run surfaced this. opencode reads the same `~/.claude/skills/` directory Claude
Code does. Given the task, the model ignored all 35 browserctl MCP tools and loaded the `agent-browser`
skill instead — a different CLI entirely. Its description ends:

> "Prefer agent-browser over any built-in browser automation or web tools."

The run had to be killed and re-issued with an explicit prohibition before browserctl was used at all.
Renaming the MCP server (`browser` -> `browserctl`, turning `browser_browser_snapshot` into
`browserctl_browser_snapshot`) does not address this: the choice was made between a *skill described in
task language with an explicit preference directive* and *35 mechanically-named tools with no "use this
when" sentence anywhere*. Tool names were never the deciding input.

Worth recording because it bounds every other finding in this document: on a machine where a competing
browser skill is installed, browserctl may not be reached at all unless the prompt names it.

**Fix:** browserctl's MCP server already ships an instructions block; whether a given host surfaces it
is out of our control. The portable answer is to ship a task-language entry point of browserctl's own —
a short skill stub that names when to reach for it (background tab operation, a pinned target the user
cannot disturb, network/CDP capture) — so it competes in the same catalogue, on the same terms.

### F41 — S1 — On any page with an iframe, the entire compact view was thrown away and rebuilt flat

Found while verifying the F27-F40 fixes: the new notices were correct in `content.js` and did not
appear in the output. `background.js` merges per-frame results, and its snapshot branch read:

```js
if (top.result.compactView && parts.length === 1) {
  res.compactView = top.result.compactView;          // the good path
} else if (params.compact || top.result.compactView) {
  const compactLines = elements.map(...)              // rebuild, flat
```

`parts.length === 1` only holds on a single-frame page. Facebook, npm and MDN all have at least one
iframe, so every real site took the rebuild — which discards landmark grouping, the hoisted key-inputs
block, repetitive-run folding, row context, href shortening and every notice, and emits a flat list
with an element-count notice of its own. Only the single-frame pages in `tests/e2e/` ever exercised the
path the census work was written for. This is why round 1's viewport-census work measured well on the
benchmark and landed so weakly on real sites.

**Fixed:** the top frame's compact view is kept verbatim and each sub-frame's own view is appended under
an `[iframe f<id> <url>]` header with its refs frame-qualified, its duplicate footer stripped, and one
page-level line reporting the frame count and totals.

## 10. Round-2 fixes — what shipped and how it was verified

All of F27-F41 are implemented. `npm test`: 41/41 (was 36). Live verification on facebook.com after
reloading the extension, measured through the CLI.

| | Fix | Verification |
|---|---|---|
| F27 | `findOpenDialogs()` reports every visible stacked dialog; `pageState.openDialogs`, and a compact-view line for a non-blocking one | notifications popover now announced: `[Open dialog: "Notifications" 360x661, does not block the page — use 'dismiss' to close]` (was: no line at all) |
| F28 | anchors sharing a normalised href and label collapse to one row, count reported | `[Notice: 1 duplicate link suppressed …]` |
| F29 | labels colliding 3+ times carry their row's distinguishing text | `<div> "More" (row: "…")` |
| F30 | the offscreen notice names the kinds withheld, via `describeElements` | `12 offscreen, including 5× "Online status indicator Active Lê Anh", …` (was: `12 elements offscreen`) |
| F31 | reading order within landmark blocks, so a portal popover no longer prints before the page | landmark headers no longer repeat (6 × `[Navigation]` → 1) |
| F32 | opt-in `BROWSERCTL_CALL_LOG` per-call JSONL at the single dispatch point | 19 rows recorded across this session; params reduced to shapes — `{"text": "str:13"}`, never the value |
| F33 | `read_page` depth default 15 → 60; `depthClipped`/`deepestReached` reported; script/style excluded from `mode='all'` | depth 60 returns the full nav and rail (was two headings with `truncated: false`) |
| F34 | zero-match `find` returns `nearest` on an NFD-folded comparison | a one-diacritic miss now costs one call |
| F35 | truncated labels carry `[+N chars: get text @ref]`; `find` matches carry `truncatedBy` | asserted by test |
| F36 | tracking params stripped from census hrefs, query capped at 2, href capped at 120 chars | contributes to the 44% payload drop below |
| F37 | not a code fix — probe scoring must pair steps with live-page accuracy | recorded in §7 process notes |
| F38 | `--all` now emits its own notice covering folded elements; scope defaults documented per tool | `[Notice: full-page scope, but N repetitive elements are folded above …]` |
| F39 | load-more controls and overflowing regions surfaced as a named line | `[Possible hidden content: … "See previous notifications" (@ref_120). … 'snapshot --all' will NOT reveal rows that are not in the DOM yet; click the control instead]` — the exact control R4 and the control run both failed to click |
| F40 | `skills/browserctl/SKILL.md`: a task-language entry point naming background operation, the pinned target and the capability profiles | not yet installed to `~/.claude/skills/` — one symlink, the user's call |
| F41 | `background.js` keeps the content script's compact view and appends sub-frames with qualified refs | landmarks, key inputs and folding present on facebook.com for the first time |
| F42 | `crossFrame` collects per-frame errors instead of dropping them | `find` failure now names its own cause; the pin-loss guard message reaches the caller |

**Measured on facebook.com home, same page, before and after:**

```
snapshot (viewport)   12,877 -> 7,178 chars    -44%
snapshot --all        13,229 -> 7,655 chars    -42%
```

The saving is F41 plus F36, not scope tuning — the viewport/all gap is still only ~7%, exactly as F36
predicted. Descriptions were corrected to match: the "75-85%" claim is gone.

**Still open:** the `content.js` coverage hole named in §7. The round-2 guards added to
`tests/unit/cli_and_mcp.test.mjs` are source-level assertions, which catch a reintroduced default or a
deleted notice but cannot catch a logic regression. F41 in particular was invisible to every test
because the e2e pages are single-frame; a multi-frame fixture is the next thing worth building.

### F42 — S1 — `crossFrame` discarded every content-script error message

Found while verifying F34. `find` appeared totally broken — every call returned:

```
no frame could handle this (page not accessible, or the ref/ref_id was not found in any frame)
```

which reads as a permissions problem. `crossFrame` mapped any non-ok reply to `null`
(`return reply && reply.ok ? {...} : null`), so whatever each frame actually said was thrown away and
replaced by that one generic sentence. Two real messages were hidden behind it in this session alone:

- the pin-loss guard — a long, genuinely useful message telling the caller the target tab was lost
  after an extension reload and that re-issuing the command would work. The agent never saw it.
- `find requires 'query'` — the actual fault, which turned out to be that `cli.js` has no `find`
  command at all and falls through to a raw action dispatch that drops the positional argument.

**Fixed:** per-frame errors are collected and returned, both inline and as
`diagnostics.frameErrors`. The same failure now reads
`no frame could handle 'find' … — f0: find requires 'query'; f1078: find requires 'query'`, which named
the cause immediately.

This is the F24 defect one layer down: F24 stopped the MCP client relabelling application errors as
transport failures; the extension was doing the same thing to itself between the frame fan-out and the
merge. Worth a targeted look at any other place a reply is reduced to a boolean.

**Not fixed (noted):** `cli.js` silently accepts unknown commands and dispatches them as bare protocol
actions with no argument mapping, so `browserctl find "x"` sends `find` with empty params. Either map
the positional argument or reject unknown commands — a CLI that accepts a command it cannot form is
worse than one that says "unknown command".

### F43 — S1 — `read_page` pruned any subtree behind a zero-size portal wrapper

Reported by the R5 probe as "read_page consistently returned the main page DOM structure rather than
the notification panel content, even when the panel was visually open". The complaint was accurate.

The walk skipped a child outright when `isVisible(child)` was false, and `visibilityReason` returns
`"zero-size rect"` for a 0x0 element. React portals mount dialogs, popovers and toasts inside exactly
such a wrapper, with the panel absolutely positioned and fully painted inside it. So the whole open
notifications panel was invisible to `read_page` while sitting on screen — the agent could see it in a
screenshot and not in the tree, and reasonably concluded the tool "focuses on main page content".

Neither `truncated` nor `depthClipped` was set, so nothing indicated an omission.

**Fixed:** only `display:none` and `visibility:hidden` prune the subtree now. A zero-size or
transparent element is not listed but is still descended into. On the same page the tree went from
6,929 chars with no dialog content to 16,397 chars including all 15 notifications and the All/Unread
tabs.

`snapshot` was never affected — it flat-queries with `deepQueryAll(...).filter(isVisible)`, so a
wrapper's visibility never gated its children.

## 11. Round-2 re-probe (R5) — simple prompt, new build

First run against the fixed build, and deliberately with a **plain one-paragraph prompt** — no
integrity clause, no scoring rules, no hint about scope or escalation:

> Open facebook.com in a new background tab, check which friends are currently active, then open
> notifications and check what's unread. Report what you find.

Call counts are from `bridge/calls.jsonl` (F32), not from the agent — the first run in this whole
exercise that needed no manual audit of its step count.

| | R3 (heavy prompt, old build) | R4 (heavy prompt, old build) | C1 (other model, old build) | **R5 (simple prompt, new build)** |
|---|---|---|---|---|
| Bridge calls | 33 (harness) | 16 (harness) | 7 | **14** |
| Unread notifications | 15 ✓ | 5 ✗ | 5 ✗ | **15 ✓** |
| Active contacts | 14/14 ✓ | 14/14 ✓ | correct | 15/15 found, **+3 false positives** |
| Prompt scaffolding | heavy | heavy | heavy | **none** |

The notifications answer — wrong in two of the three previous runs, including for a stronger model —
came out correct from a prompt that says nothing about how to do it.

**Which fix earned it, honestly:** not the notice work. The call log shows the agent used
`read_page` (3×), `find` (4×), `screenshot` (3×) and `click` (2×) and **never called `snapshot` once**,
so F30/F38/F39's notices were never rendered to it. The win is F33 + F43: `read_page` went from
returning two headings to returning the real tree including the open dialog, and the agent made it its
primary reader. It then found the `Unread` tab through `find` and clicked it — the step R4 and C1 both
skipped.

That is worth stating plainly: the fixes that made the difference here were the ones that made an
existing tool *work*, not the ones that added guidance. The guidance work still stands on its own
evidence (F39's line names the exact control both earlier runs missed) but it has not yet been
exercised by a probe, because a working `read_page` changed which tool the agent reaches for.

**Remaining error, and it is a real one.** R5 reported **18** active contacts against a true 15,
inflating the list with `Meta AI` (a bot row, never "Active") and two contacts whose rail entries read
`35m` / `19m` — last-active, not active. The distinction is in the census text (`Online status
indicator Active <name>` vs `19m <name>`) and the agent flattened it. This is the F29 family: the row
kind is encoded only in a text prefix that an agent has to parse rather than a field it can filter on.

**Follow-up worth doing:** give repeated structured rows a machine-readable qualifier instead of a text
prefix — `<a> "Võ Hiệp" (status: last-active 19m)` vs `(status: active)` — so "who is active" is a
filter, not a parse. That is the last remaining wrong answer in the set.

## 12. Generality pass — steps, tokens, and speed on any complex page

Round-2's fixes were found on one site, so this pass removed the site knowledge that had crept in and
retargeted the work at the three things that matter on every page: fewer steps, fewer tokens, and
actions that land quickly.

### Where the time actually goes

From `bridge/calls.jsonl`, 63 real calls across this session:

| action | n | median | max | total |
|---|---|---|---|---|
| wait_for | 2 | 5,803ms | 9,381ms | 11,606ms |
| navigate | 2 | 4,680ms | 5,372ms | 9,359ms |
| click | 3 | 397ms | 2,112ms | 2,588ms |
| screenshot | 3 | 242ms | 293ms | 719ms |
| **snapshot** | 13 | **21ms** | 70ms | 434ms |
| **find** | 14 | **9ms** | 50ms | 289ms |
| **read_page** | 6 | **22ms** | 58ms | 150ms |

Reading a page is already effectively free — 21ms for a full census. All the wall-clock is in waiting,
and the worst single entry is a `wait_for` that **timed out after 9.4s and returned nothing**. Census
tuning cannot buy what waiting is spending, so this pass went after the waits.

### F44 — S2 — `new_tab(url)` returned before the page existed, forcing every agent to invent a wait

`new_tab` created the tab and returned in ~28ms with nothing loaded, while `navigate` already waited
properly. So the first thing every agent did was guess a follow-up wait — and guessing is where the
time went.

**Fixed:** `new_tab(url)` now waits for load plus a short settle, exactly as `navigate` does, and
returns `{id, url, title, ready: true}`. Measured: returns in ~5.6s with the page usable, replacing
`new_tab` (28ms) + a guessed `wait_for` (5.8s median, 9.4s when wrong). One call instead of two, and
the failure mode is gone rather than merely faster. `wait: false` opts out.

### F45 — S1 — `wait_for(text=...)` was case-sensitive, and said nothing useful when it failed

`wait_for` matched page text with a raw `includes`. Waiting for `weekly downloads` on a page reading
"Weekly Downloads" burned the whole timeout; so did the R5 probe's wait. Two runs lost ~15s between
them, and both then continued unsure whether the page had loaded — the error said only
`wait_for timed out after Nms`.

**Fixed:** text matching is case- and whitespace-insensitive by default (`caseSensitive: true` opts
back in — nobody waiting on page text means "in exactly this casing"). On timeout the error now carries
`code: WAIT_TIMEOUT` plus diagnostics that separate the two failures an agent must tell apart:

```
wait_for timed out after 8000ms (readyState: complete) — closest text on page: "Weekly Downloads 202,9"
wait_for timed out after 8000ms (readyState: loading) — the page has no text yet, it is probably still loading
```

with a `recoveryHint` pointing at `snapshot`/`find`, which report what is there instead of asking the
agent to guess a string.

### F46 — S3 — the census carried Facebook's parameter names

The F36 href reduction shipped with a literal list including `__cft__`, `__tn__`, `fbclid`, `igshid` —
site knowledge in a tool whose whole premise is being generic.

**Replaced with two site-agnostic signals:** a parameter whose *value* exceeds 24 characters is a token
or blob rather than a human-chosen value, and a small set of conventions that hold across the whole web
(`utm_*`, `*clid`, `_ga`, `_hs`). Everything else is kept, up to two parameters. This drops
Facebook's `__cft__` on value length without naming it, and generalises to every site's equivalent. A
test now fails if any site-specific parameter name reappears in `content.js`.

### F47 — S2 — the hidden-content hint was English-only, then too eager

`LOAD_MORE_RE` matched English load-more vocabulary only. Adding `aria-expanded="false"` as a second,
language-free signal over-corrected: on a GitHub issue list the hint fired for `Dismiss`,
`Search Issues` and `Sort by Newest, descending` — ordinary collapsed menus, not withheld rows. A hint
that fires on everything is one an agent learns to skip, which is exactly how the control run
described the old footer.

**Final rule, three signals ordered by how site-agnostic they are:** a load-more label; or
`aria-expanded="false"` on a control that is *not* a menu opener (no `aria-haspopup`, not
`combobox`/`menuitem`); or a control with a more-ish label sitting at the end of a run of 5+ similar
rows. Unlabelled controls are never reported — a bare ref is not something an agent can decide on.

Measured across four unrelated complex pages after the change (viewport snapshot, chars):

| page | chars | hidden-content hint |
|---|---|---|
| github.com/microsoft/vscode/issues | 4,240 | silent (correct — no withheld rows) |
| youtube.com | 2,115 | fires (infinite feed) |
| reddit.com/r/programming | 4,761 | silent |
| amazon.com search results | 5,278 | fires (lazy result list) |

and the offscreen notice names real content on each, e.g. GitHub:
`89 offscreen, including 7× "triage-needed", 3× "benibenj is assigned"`.

### F48 — S1 — The census matched four ARIA widget roles out of twenty, so open menus were invisible

The single largest generic gap found in this whole exercise, and it was found by giving the probe a
non-Facebook task: sort a GitHub issue list.

`INTERACTIVE_SELECTOR` listed `[role=button]`, `[role=link]`, `[role=tab]`, `[role=menuitem]`. A CSS
attribute selector matches exactly, so `[role=menuitem]` does **not** match `menuitemradio` — and
GitHub's sort menu is built from `menuitemradio`. With the menu open, painted, and 192×316 on screen:

```
snapshot   -> 0 references to "Oldest"
read_page  -> 0 references to "Oldest"
DOM        -> UL[role=menu] 192x316, LI[role=menuitemradio] 176x30 "Oldest"
```

The agent could see the menu in a screenshot, could not address any item by ref, and did what agents do
when the census fails them: fell back to `eval_js` with a hand-written querySelector loop (5 `eval_js`
calls and 9 screenshots inside a 31-call run). The same hole hid every custom listbox (`option`), every
toggle (`switch`), every tree (`treeitem`) and every slider on every site — this was never about GitHub.

**Fixed:** the selector now covers the ARIA widget roles a user can actually operate, grouped by what
they do — command (`menuitem`, `menuitemradio`, `menuitemcheckbox`, `tab`, `treeitem`), selection
(`option`, `checkbox`, `radio`, `switch`), input (`combobox`, `searchbox`, `textbox`, `slider`,
`spinbutton`) — plus native `summary` and empty `contenteditable`.

**And their state is now a field, not prose.** `role` plus `aria-selected/checked/expanded/current/
pressed/disabled` are attached to each element and rendered inline:

```
[@ref_19] <button>[expanded] "Sort by Newest , descending"
[@ref_23] <li>[menuitemradio][checked] "Created on"
[@ref_45] <li>[menuitemradio] "Oldest"
```

This also answers the last open error from R5, where the probe reported 18 active contacts against a
true 15 by flattening a status prefix into a name. "Which one is selected" is now a filter rather than
a parse.

**Cost, measured on five unrelated pages (viewport snapshot chars, before → after):**

```
github issues      4,240 -> 4,271    (+31)
amazon search      5,278 -> 5,320    (+42)
youtube            2,115 -> 2,424    (+309, page fully loaded this time)
reddit             4,761 -> 5,724    (+963 — real widgets that were previously missing)
facebook                     2,933
```

Essentially free everywhere except Reddit, where the increase *is* the fix: those are controls the
census had been omitting.

**Reader parity, and the re-probe.** `read_page` keeps its own `INTERACTIVE_ROLES` set, which had the
same omissions, so the two readers disagreed about what existed on the page — and agents pick between
them freely (neither GitHub probe called `snapshot` even once). Both lists now cover the same roles and
both render ARIA state, with a test that fails if they drift apart:

```
read_page   menuitemradio "Oldest" [ref_6]
            menuitemradio "Newest" [checked] [ref_7]
            button "Sort by Newest , descending" [expanded] [ref_59]
```

Same task, same prompt, same site, before and after — counted from `bridge/calls.jsonl`:

| | before F48 | after F48 |
|---|---|---|
| bridge calls | **31** | **8** |
| `eval_js` fallbacks | 5 | **0** |
| screenshots | 9 | 2 |
| `wait_settle` | 4 | 0 |
| failed URL-parameter detour | 1 `navigate` | 0 |
| answers | correct | correct |

The click on "Oldest" is the mechanism: as a plain `<li>` it was a text-container, which F3 correctly
made `click` refuse, so the agent had no route to it but `eval_js`. As a `menuitemradio` it is a real
target and the same click succeeds in one call.

## 13. Where this leaves the three goals

**Steps and tokens.** 31 → 8 calls on the GitHub task; 14 calls on the Facebook task from a one-line
prompt. Snapshot payload on facebook.com went 12,877 → ~7,200 chars, and the other four pages sit at
2.4-5.7 KB. The remaining per-page cost is dominated by hrefs even after truncation; the next lever
there is dropping the href entirely for elements whose label already identifies them, keeping it only
where the destination is the information.

**Not missing information.** The census now covers the full ARIA widget set, pierces zero-size portal
wrappers, reports open dialogs whether or not they block, names the kinds of element it withheld, and
flags content that no scope setting can reveal. The two readers agree, enforced by test.

**Action speed.** `new_tab` waits, so the guessed follow-up wait is gone; `wait_for` no longer burns a
full timeout on a casing mismatch and says what it saw when it does fail. Reads themselves were never
the problem — 21ms for a full census, 9ms for a find.

**Still open, honestly:**
- No probe has yet exercised the `snapshot` notices (F30/F38/F39). Three consecutive runs reached for
  `read_page` instead. Either the notices should move into `read_page` too, or `read_page` should be
  folded into `snapshot` — the current answer is that the guidance work sits in the tool agents don't
  pick.
- `content.js` still has no behavioural test coverage; the round-2 guards are source-level assertions.
  A multi-frame e2e fixture is the highest-value thing left to build, since F41 was invisible to every
  existing test.

## 14. Closing the test gap

§7 and §13 both named the same hole: `content.js` had no behavioural coverage, and every e2e fixture
was single-frame. Both are now closed.

### Multi-frame e2e suite — `tests/e2e/run_multiframe.mjs`, 19/19 against real Chrome

The fixture (`tests/e2e/multiframe.html` + a same-origin child) carries, deliberately, one instance of
each shape that produced a round-2 defect: controls across three landmarks, a run of 5 identical
buttons, two anchors sharing a destination where one has an opaque tracking parameter, a 200+ character
label, an open `[role="dialog"]` anchored to one side (under 25% coverage, not owning the centre), a
panel inside a `width:0;height:0` wrapper, and a menu built from `menuitemradio`.

What it asserts, all through the real bridge:

- the compact view survives the frame merge — landmark headers, hoisted key inputs, the folded-run line,
  the duplicate-suppression notice, the full-page fold notice and the truncation hint are all still
  there (F41: this is the exact assertion that would have failed before the fix)
- sub-frame content appears under an `[iframe f<id> …]` header with frame-qualified refs, and there is
  exactly **one** `[Quick Actions:]` footer for the page
- a frame-qualified ref clicks the right element in the right frame, and `get_text` reads it back
- `read_page` returns the portal-rendered panel through the merge (F43)
- `menuitemradio` items appear in **both** readers with their ARIA state, are clickable by ref, and the
  state moves after the click (F48)
- the side-anchored dialog is reported as open and **not** as a blocking modal (F27)

`tests/e2e/run.mjs` also went 62 → 70 checks. Command coverage is 59/61; the two not exercised are
`focus_window` and `reload_extension` (visual/dev-only).

### Unit coverage for the census helpers — `tests/unit/content_helpers.test.mjs`, 25 tests

`npm test` is now **67/67** (was 42). The harness reads the shipped `content.js` at test time, slices
the named functions and constants out by balanced-brace scan, and evaluates them in a `node:vm` context
with minimal stubs — so the tests exercise the real source and break when its contract changes rather
than testing a retyped copy. Constants (`HREF_CAP`, `KEPT_PARAMS`, `OPAQUE_VALUE_CHARS`,
`CONVENTIONAL_TRACKING`) are read from the file, not hardcoded into the assertions.

Covered: `foldText`, `shortHref`, `normalizedHref`, `hiddenContentHints`, `describeElements`. The
false-positive cases are pinned explicitly — a `Sort by Newest` dropdown, a plain `All` filter and a
`Back to previous page` link must **not** be reported as hidden content.

### The tests were mutation-checked, not just run

A suite that passes proves nothing on its own; three deliberate regressions were introduced into
`content.js` to confirm each one is actually caught:

| mutation | result |
|---|---|
| revert `hiddenContentHints` to the loose `/more\|all\|previous\|older/` matcher | **caught** — `does NOT flag a plain 'All' filter` fails |
| delete the `đ`/`Đ` special case from `foldText` (NFD alone does not decompose them) | **caught** — 2 failures |
| stop dropping opaque query values in `shortHref` | **caught** — 1 failure |

`extension/content.js` was restored after each. This is the property §7 said was missing: a change to
the implementation now breaks a test.

## 15. Whole-surface audit — every tool, on a complex and a simple site

Driven by the goal "no tool call should error". Two harnesses, now kept in the repo:

- `tests/e2e/audit_tools.mjs <url> <label>` — calls every read-only protocol action against a live
  page and records ok/error/bytes/latency. Failures that are the tool doing its job (waiting for text
  that is not there; reading a capture that was never started) are marked `expectFail` and graded on
  the quality of their error, not on its absence.
- `tests/e2e/coverage_check.mjs <url> <label>` — takes `snapshot --all` as ground truth and checks that
  everything it can see is reachable by the tools an agent would use to act on it.

### Result

```
github.com/microsoft/vscode/issues   44 calls | 0 unexpected failures | 4 expected
example.com                          44 calls | 0 unexpected failures | 4 expected
```

First run of the same audit: **23 of 42 failed on the complex site, 10 of 42 on the simple one.**

### F49 — S1 — Tool names were not action names, so the universal dispatcher failed on the commonest reads

The audit's largest finding, and a direct cause of the behaviour that prompted this work: a low-tier
agent uses a couple of tools, hits a wall, and switches to `eval_js` to hand-roll everything.

An agent sees the tool `browser_get_text`. `browser_action` is documented as "execute any browserctl
protocol action by name … parameters are the same as the matching browser_<action> tool". So the agent
calls `browser_action({action: "get_text"})` and gets:

```
unknown action: get_text
```

There is no `get_text` action — it is `get_property` with `{property: "text"}`. The same held for
`get_attribute`, `get_count`, `get_value`, `get_html`, `get_box`, `dismiss_modal` and
`screenshot_fullpage`. "Unknown action" is indistinguishable from "this capability does not exist", so
the agent stops asking and starts writing JavaScript.

**Fixed at the extension's dispatch entry**, not in the MCP layer, so every caller benefits — MCP,
the CLI, and the raw-HTTP endpoint the README documents. Every tool name now dispatches.

Actions the extension genuinely cannot serve (`list_available_tools`, `action`) now return
`code: NOT_A_PAGE_ACTION` naming the right call instead of "unknown action". `status` was moved into
the bridge, which can answer it, so the name an agent saw on `browser_status` simply works.

### F50 — S2 — `a11y_snapshot` demanded a manual two-step handshake

It threw `not attached: call cdp_attach first` on a first call, while `screenshot` had lazily attached
for years. Now it uses the same `ensureAttached` path — a plain read no longer needs a prelude.

### Coverage against ground truth — nothing is unreachable

For each page: take `snapshot --all` as truth, sample 25 labelled elements, and check both that
`find()` locates them and that `get_text` reads them back by ref.

| page | truth | viewport | withheld | find() reached | get_text read | discloses what it withheld |
|---|---|---|---|---|---|---|
| github issues | 174 | 84 | 90 | 25/25 | 25/25 | yes, naming kinds |
| reddit /r/programming | 110 | 43 | 67 | 25/25 | 25/25 | yes, naming kinds |
| example.com | 1 | 1 | 0 | 1/1 | 1/1 | n/a (nothing withheld) |

The viewport census withholds roughly half the elements on a feed page — and says so, naming the kinds
it left out, which is the property that makes the saving safe to take.

### Cost, measured in the same run

| | github (complex) | example (simple) |
|---|---|---|
| snapshot viewport | 18,036 B | 640 B |
| snapshot --all | 39,056 B | 635 B |
| read_page | 19,142 B | 159 B |
| screenshot | 108,093 B | 19,117 B |

A screenshot costs six times a full census of the same page and cannot be acted on by ref. That ratio
now appears in the READ group note.

### F51 — S2 — Nothing mapped an intent onto a tool

80 tools, listed flat. An agent that wants "the price" or "how many of these" has to infer the mapping
from 80 prose blocks every turn, and a small model that fails to infer it writes `eval_js` instead.
Three things were added, at the three points an agent actually looks:

1. **Server instructions** (read once at connect, before any tool description) now open with a
   what-you-want → what-to-call table covering the twelve common intents, and close with:
   *"Every read tool tells you what it did NOT return … Never conclude a capability is missing without
   checking browser_action's catalogue."*
2. **A group label on every tool description**, injected in the `registerTool` wrapper:
   `[READ]`, `[ACT]`, `[NAVIGATE]`, `[WAIT]`, `[CAPABILITY]`, `[SESSION]`, each carrying a one-line
   note naming the group's default. READ's says plainly that `browser_snapshot` returns text, not an
   image — the name had been read as "screenshot" by three consecutive probes.
3. **The snapshot footer is now an intent index** rather than a syntax reminder:
   `[Next: click/type @ref · read one value: get text @ref · one attribute: get attr @ref href ·
   count: get count <css> · locate a control: find "label" · a value in plain text: find text "label" ·
   more of the page: scroll down or snapshot --all]`

### F52 — S1 — `get_count` errored instead of answering zero

Found by a probe on Hacker News. It asked "how many story links are on the front page", wrote a
selector using an ARIA role as a CSS type (`tr > td > span > link` — `link` is a role, not a tag) and
got:

```
ELEMENT_NOT_FOUND
```

Counting is a question about a SET, and zero is a valid answer to it. The cause: `get_property`
resolved a single target BEFORE the switch, so the `count` branch never ran when nothing matched.
An error where a legitimate answer exists is read as "the tool is broken", and the standard next move
is `eval_js`.

**Fixed:** `count` answers before target resolution, and now distinguishes three states that were
previously one:

```
get_count("a")                     -> 228
get_count("tr > td > span > link") -> 0  + "0 matches. This is an answer, not a failure … If you meant
                                          an ARIA role, CSS needs [role=...]; browser_find searches by
                                          label instead."
get_count("a[[[")                  -> INVALID_SELECTOR: 'a[[[' is not a valid CSS selector
```

The invalid-syntax case needed its own check: `deepQueryAll` swallows selector errors and returns `[]`,
so bad CSS would have reported "0 matches" — indistinguishable from a valid selector matching nothing,
and the agent would have concluded the element does not exist.

### F53 — S2 — An agent shut down the shared bridge daemon as a tidy-up step

The same probe finished with `browser_stop`, whose description read simply "Stop the local browserctl
bridge server daemon". Nothing said the daemon is shared with the user and any other agent, or that
stopping it records an explicit stopped state that blocks auto-restart. Tidying up after yourself is
normally correct behaviour; here it interrupts everyone.

**Fixed** in both the tool description and the SESSION group note: do not call it to clean up; call it
only when the user asks for the bridge to be shut down.

### Result of the whole-surface audit

```
github.com/microsoft/vscode/issues   44 calls | 0 unexpected failures | 4 expected
example.com                          44 calls | 0 unexpected failures | 4 expected
news.ycombinator.com                 44 calls | 0 unexpected failures | 4 expected
```

The four expected failures are the tools refusing correctly, with messages that name the fix:
`wait_for` on text that is not present, `net_get` before `net_start`, and the two MCP-layer names
(`list_available_tools`, `action`) that the extension cannot serve.

Suites: `npm test` 67/67 · `tests/e2e/run.mjs` 70/70 · `tests/e2e/run_multiframe.mjs` 19/19.

### F54 — S2 — A relative URL attribute came back bare, so the agent verified it in eval_js

`get_attribute(href)` on Hacker News' "past" link returned exactly `front`. The probe could not tell
that from a truncated or wrong answer, so it loaded `browser_eval_js` and re-derived the URL to check —
one extra schema load and one extra call to confirm something the tool already knew.

**Fixed:** URL-bearing attributes (`href`, `src`, `action`, `poster`, `cite`, `formaction`, `srcset`)
are resolved against `document.baseURI` and returned alongside the raw value, rendered as
`front   (resolves to https://news.ycombinator.com/front)`. The raw value is still what the page says;
the resolved one is what it means.

### Measurement caveat — the description work has not been probe-tested yet

Worth recording plainly, because it changes how the probe results above should be read.

Extension changes go live via `reload_extension`, but **MCP server changes do not**: the server process
is started once per client session, so every probe in this round ran against the OLD tool descriptions
with the NEW extension behaviour. Confirmed directly — `browser_action` with no arguments still
returned the pre-change catalogue (73 actions, no `get_text`).

So:
- Behavioural fixes (F48 roles, F52 count, F54 resolved URLs, the extension-layer aliases of F49) **are**
  exercised by these probes.
- The intent index, the `[GROUP]` labels, the "snapshot is text, not an image" correction and the
  `browser_stop` warning (F51, F53) are **not**. The one probe that used `get_count`/`get_attribute`
  cleanly did so under the old descriptions, so it is not evidence for the new ones either way.

They are covered by source-level tests instead (`npm test` 71/71), and the honest next step is a probe
in a fresh session, where the MCP server restarts and the new descriptions are actually in front of the
model. Until then, treat F51/F53 as implemented-and-tested-but-not-yet-observed.

## 16. Orientation — the census now leads with the page's shape

Goal for this pass: an agent should work out what a page IS as fast as possible, spend few tokens
doing it, and lose no content in the trade.

### F55 — S2 — Volume was reported; structure was not

The measurement that started it, on Hacker News:

```
Elements: 198 visible in viewport (229 total on page, 186 folded)
  [@ref_1..@ref_12]  the nav bar
  ... [folded 186 additional content links in viewport (refs: @ref_13, ... +181 more)]
```

**186 of 198 elements went into one opaque line.** An agent saw a nav bar and a number. Nothing said
this is a feed of stories, so working that out cost exploratory calls — the slowest part of every probe
in this exercise.

Two changes, both structural and site-agnostic:

**A shape line before the element list.** `summarizeStructure()` finds containers whose direct children
repeat the same tag four or more times and actually hold controls, plus the landmark breakdown and the
input count:

```
[Structure: 92 repeated <tr> rows (~2 controls each: a) · main 198]
```

It is suppressed on trivial pages — `[Structure: main 1]` above a single link is noise, so the line
only prints when there is a repeated group, inputs, an open dialog, or at least 8 elements.

**The fold now names what it folded**, reusing `describeElements`:

```
... [folded 186 links — 27× "hide", 26× unlabelled <a>, 4× "5 hours ago" (refs: …).
     Use 'find <text>' to target one, or 'snapshot --all' to list them]
```

### Duplicate notice removed

`cli.js` and `mcp/index.js` each printed their own `Notice: VIEWPORT-ONLY snapshot (N elements
offscreen)` header above the content script's footer notice — two notices, two numbers to reconcile,
and only the footer knew the KINDS. The transport-layer copies are gone; a test now fails if either
reintroduces one.

### F47 revisited — a bare nav word is not a load-more control

The hidden-content hint fired on Hacker News' `show` link (Show HN). `^(see|show|view|load)\b` matches
a bare "show". Both signals now require a phrase — a following word, or an exact standalone
`more|older|newer|previous|next|…`. Pinned by a test over 15 labels: `show`, `view`, `load`, `new`,
`past`, `ask`, `All`, `Back to previous page` must not fire; `Show more`, `See all`,
`See previous notifications`, `Load more`, `More`, `Next`, `View all comments` must.

### Cost and coverage, simple vs complex

| | example.com (simple) | news.ycombinator.com (complex) |
|---|---|---|
| before this pass | 640 B | 1,654 B |
| after | **474 B (-26%)** | **1,454 B (-12%)** |
| shape line | suppressed (nothing to say) | `92 repeated <tr> rows …` |
| fold line | n/a | names the kinds folded |

Nothing was traded away for the saving — the same coverage check passes on both:

| page | truth | viewport | withheld | find() reached | get_text read | discloses kinds |
|---|---|---|---|---|---|---|
| example.com | 1 | 1 | 0 | 1/1 | 1/1 | n/a |
| news.ycombinator.com | 229 | 198 | 31 | 25/25 | 25/25 | yes |
| github issues | 175 | 86 | 89 | 25/25 | 25/25 | yes |

Audit: 0 unexpected failures on both. Suites: unit 74/74 · e2e 70/70 · multi-frame 19/19.

### F56 — S2 — Orientation depended on which reader the agent happened to pick

The first orientation probe reached for `read_page`, chose `depth: 8` of its own accord, got a clipped
tree, and fell back to a **screenshot** — 108 KB to learn what the census answers in one line for 1.4 KB.
It then counted 27 stories where there are 30, because it was counting pixels.

Three fixes, all at the layer that is live:

1. **`read_page` now carries the same `Structure:` line**, so orientation no longer depends on the
   choice of reader — including when the tree is clipped, which is exactly when the agent most needs to
   know what it is missing.
2. **The clip note stopped being polite.** It read "Raise 'depth', or use browser_snapshot". It now says
   *"most of this page is MISSING from the tree above — do not treat it as the page's contents"*, and
   names the cost comparison against a screenshot.
3. **`cli.js` was silently dropping `--depth` and `--max-chars`** on `read_page`: the flags parsed as
   nothing and the command ran at the default. A parameter that vanishes without a word is worse than
   one rejected, so they are parsed now and a malformed `--depth` exits with a message.

Verified live on both site classes:

```
complex, depth=8   notices: ["Structure: 92 repeated <tr> rows (~2 controls each) · 1 input · main 229"]
                   note:    "Walk stopped at depth 8 … most of this page is MISSING from the tree above…"
complex, depth=60  notices: ["Structure: 92 repeated <tr> rows …"]   note: none
simple             notices: undefined            (nothing worth saying about a one-element page)
CLI --depth 8      depthUsed: 8                  (was silently 60)
```

### Orientation, measured — before and after

Same model, same prompts, both site classes. Counts are from `bridge/calls.jsonl`, not self-reports.

| | before this pass | after |
|---|---|---|
| calls to understand a complex page | 4 (read_page clipped → **screenshot**) | **2** (new_tab + read_page) |
| calls to understand a simple page | — | **2** |
| screenshots taken | 1 (108 KB) | **0** |
| eval_js fallbacks | 0 | **0** |
| failed calls | 0 | **0** |
| item count reported | 27 (counted from pixels; true 30) | **30** |
| 5th story + comment count | read off an image | **exact** — "LibreOffice breaks download records after declaring it has no AI features", 7 comments |

Ground truth confirmed with `document.querySelectorAll("tr.athing")`: 30 rows, fifth title and
`7 comments` verbatim.

The agent named the mechanism itself: *"The repeating row structure was explicitly noted in the HN
result ('92 repeated <tr> rows'), making pattern detection effortless."*

That is the goal stated in one line: it understood the page in two calls, took no screenshot, wrote no
JavaScript, made no failing call, and got the exact answer.

## 17. Real user flows — click, fill, scroll on a logged-in SPA

Previous probes read pages. This round drove them the way a person does: open a menu, follow it into a
sub-app, scroll a list, type into a field.

### YouTube: home → avatar menu → Studio → Content → search

Completed end to end. 21 bridge calls, 1 failure. Composition: 6 snapshot, 6 screenshot, 3 find,
3 click, 1 scroll, 1 type. The channel turned out to have 0 videos, which the probe reported honestly
rather than inventing a list.

Three findings, all general.

### F57 — S2 — A stale ref was a dead end, even though we knew what it pointed at

`click(@ref_55)` on the Studio link returned `STALE_REF: re-run read_page / snapshot`. On an SPA whose
menus re-render between the snapshot and the click that follows it, this is common — and the error
threw away the one thing that would fix it: *which control the agent wanted*.

**Fixed:** every ref now records its label when assigned. On a stale ref, the live DOM is searched for
that label (exact, then diacritics/case-folded) and the error names the replacement:

```
ref "@ref_2" is stale — the page re-rendered. The control labelled "Hacker News" is now @ref_199;
retry with that ref.
  diagnostics: {ref, relocatedTo: "ref_199", label: "Hacker News", exactLabelMatch: true}
  recoveryHint: Retry the same action with @ref_199. No re-snapshot needed.
```

Verified live: forced a re-render, clicked the dead ref, followed the named replacement — retry
succeeded. One call instead of a re-snapshot and a re-scan.

### F58 — S2 — A missed `find` said nothing about what the page calls things

The probe searched `account`, `profile`, `studio` — three consecutive zero-matches, three wasted calls.
The control it wanted was labelled **"Trình đơn tài khoản"**. No fuzzy matching bridges that: the page
is in a different language from the query. But showing the page's own words does, and costs ~40 tokens.

`find` now returns `pageLabels` on a zero match:

```
find("tài khoản") on Hacker News ->
  count: 0
  pageLabels: ["Hacker News","new","past","comments","ask","show","jobs","submit","login",
               "DaVinci Resolve 21.1","blackmagicdesign.com","tosh"]
  note: "'nearest' lists labels that differ only by case/diacritics; 'pageLabels' shows what this
         page actually calls things."
```

`nearest` (diacritic-folded) and `pageLabels` (the real vocabulary) answer different questions, so both
are returned.

### F59 — S1 — The frame merge dropped new fields for the third time

`pageLabels` did not reach the caller. `background.js`'s find merge enumerated the fields it kept, so
anything the content script learned later was silently discarded — `nearest` had been lost the same way
and patched by hand, and `compactView` before that (F41).

**Fixed structurally rather than by patching again:** the merge now spreads the top frame's result and
overrides only the fields it actually owns. Listing what to KEEP means the merge must be edited every
time the content script gains a field, and forgetting is invisible; listing what to REPLACE cannot rot.
A test pins the pass-through.

### Cost note

6 of 21 calls were screenshots. Screenshots remain the reflex for confirming a click, at ~100 KB each
against a 1.4 KB census. The `[ACT]` group note and the READ note that names the ratio are written but
not yet live in a probe session (see the measurement caveat in §15).

### Facebook: home → own profile → scroll posts → composer → set audience → type draft

Completed except one step. ~62 bridge calls, **0 failed calls** — and the task still did not succeed:
the audience could not be set to "Only me". Eight attempts, every one reporting success.

That gap is the finding. A tool suite can have a 100% call-success rate and still leave an agent
looping, because "the call worked" and "the thing I wanted happened" are different claims.

### F60 — S1 — `domMutated` was treated as proof the intended action landed

The probe clicked "Only me" repeatedly. The responses said:

```
click "Only me"  ->  ok, 34 mutations
click "Only me"  ->  ok, 320 mutations
click "Only me"  ->  ok, 570ms, 34 mutations
```

Every one reported success. The audience stayed **Public** throughout. The mutations were real — menus
opening, overlays rendering — but the control's own state never moved, and nothing in the response
distinguished those two things. The agent had no signal to stop, so it burned eight rounds and left the
composer in a stacked, corrupted state.

**Fixed:** a click on a control that carries `aria-checked` / `aria-selected` / `aria-pressed` /
`aria-expanded` now samples that state before and after, and reports it:

```
effect.controlState: {"changed": ["checked: false -> true"], "unchanged": []}      # it took
```

and when the page moved but the control did not:

```
warning: the page changed (34 mutations) but this control's own state did NOT (checked: false):
         the click landed somewhere, but the selection did not take. Re-read the control before
         assuming it is set.
```

Verified on the multi-frame fixture's `menuitemradio`: a committing click reports
`checked: false -> true` with no warning. On the first attempt this would have told the probe the
selection was not sticking, instead of on the eighth.

**Also fixed while investigating:** `checkElementCovered` ran *before* `scrollIntoView`, so it
hit-tested the element's pre-scroll centre — coordinates the click would never use. It could report an
overlay that scrolling had already resolved, or miss one it had just slid under. It now runs after the
scroll, pinned by a test.

**Not resolved:** whether Facebook's audience selector can be driven by a synthetic click at all. The
button sits under another element (`elementFromPoint` at its centre returns a node that is not the
button or its descendant) and a full-field pointer sequence with `pointerId`/`pointerType`/`buttons`
also produced no dialog. It may need a trusted event, which CDP cannot deliver to a background tab
(see §8). Recording it as unknown rather than guessing — the composer state was cleaned up rather than
kept for further probing.

### Account left clean

The draft was never published. Composer closed, `Delete draft` clicked, tab reloaded, and verified:
`openDialogs: 0`, the draft text absent from the page, nothing posted.

### F61 — S1 — Eleven identical unlabelled radios: why "Only me" could not be set

Root-caused after the fact, on a clean composer. It was browserctl, not Facebook.

The audience dialog's census read:

```
[@ref_140] <input>[type=radio][checked] (value: "on")
[@ref_141] <input>[type=radio]          (value: "on")
[@ref_157] <input>[type=radio]          (value: "on")
        … eleven of them, none with a name
```

A form control has no text of its own, so `elementText` walked innerText → aria-label → title →
placeholder → **value**, and every one of these radios has `value="on"`. Nothing distinguished "Public"
from "Only me". Facebook compounds it: the rows for Public / Friends / Only me have **no
`role="radio"` wrapper at all** — the nearest ancestor is `role="none"`, deliberately removed from the
accessibility tree — so the only real control on those rows is the bare input.

Given eleven indistinguishable radios, the probe did the only thing left: it clicked the visible text
"Only me", which is a plain container. F3 correctly refuses those, and where it matched something
clickable the click hit a wrapper that does not commit the selection. Eight attempts, every one
reporting success, audience never changing — F60's warning now catches that symptom, but this is the
cause.

**Fixed:** `controlLabelOf()` resolves a form control's name the way HTML-AAM does — `aria-labelledby`,
then `<label for>`, then a wrapping `<label>` — and, because custom widgets use none of those, falls
back to the nearest ancestor carrying short distinct text (capped at 80 chars so a section heading
cannot masquerade as a row label).

Verified on the same dialog:

```
[@ref_109] <input>[type=radio][checked] "Public Anyone on or off Facebook"
[@ref_110] <input>[type=radio]          "Friends Your friends on Facebook"
[@ref_119] <input>[type=radio]          "Only me"
[@ref_123] <input>[type=radio]          "Custom Include and exclude friends and lists"
```

and then driven end to end:

```
click @ref_119   -> effect.controlState: {"changed": ["checked: false -> true"]}
click "Done"     -> 29 mutations
verify           -> aria-label: "Edit privacy. Sharing with Only me."
```

**The task the probe could not finish now completes in three calls.** Composer closed afterwards;
`dialogs: 0`, draft text absent, nothing published.

This is the widest-reaching fix of the round: an unlabelled `<input>` is not a Facebook quirk. Custom
radios, checkboxes, toggles and search fields across every design system carry their label in a
sibling node, and all of them were arriving in the census anonymous.

## 18. Auditing the F61 bug class across every tool

F61's shape is: *an element that exists and is actionable reaches the agent without enough identity to
target it.* The fix landed in `elementText`. The question this section answers is whether the same hole
exists elsewhere — and it did, in four more places.

### The audit: one fixture, every label path

`tests/e2e/labels.html` carries nine controls, each labelled a different way — the Facebook shape (bare
radio, label in a sibling, wrapper `role="none"`), `<label for>`, a wrapping `<label>`,
`aria-labelledby`, a `<select>` labelled by a preceding span, a `div[role=switch]`, an icon button
labelled only by `<svg><title>`, and a properly `aria-label`led input as a control case.

`tests/e2e/run_labels.mjs` asks every tool that hands an element's identity to an agent —
`snapshot`, `read_page`, `find`, and `click(text=)` — about the same nine. First run:

```
label expected           snapshot  read_page  find   click(text)
Only me                  NO        NO         yes    NO
Public                   NO        NO         yes    NO
Subscribe to updates     yes       NO         yes    yes
Quantity in cart         NO        yes        yes    yes
Shipping country         NO        NO         yes    NO
Dark mode                NO        NO         yes    NO
6/9 labels are missing from at least one tool
```

`find` says "yes" everywhere and `click` says "NO" — that pair is the F61 signature: find matched the
surrounding *text*, not the control, and click correctly refused it as a text-container.

### F62 — S1 — The fix reached the census only; `read_page` and `find` use a different resolver

There are two label paths: `elementText` (census, `find_text`, `describe_element`, `click`) and
`accessibleName` (`read_page`, `find`). F61 fixed the first. The audience radios were therefore named
in `snapshot` and still anonymous in the accessibility tree — the exact "two readers disagree" failure
F48 fixed for roles, repeated for names.

**Fixed:** `accessibleName` now falls back to the same `controlLabelOf`.

### F63 — S1 — `value` was being used as a name

`<input type="radio" value="on">` was **named "on"**. Every radio in a group identical, with the label
sitting right beside it, ignored. `value` is submitted data, not an accessible name.

**Fixed:** `value` is out of the name chain except where it really is the caption
(`button`/`submit`/`reset`) or the typed content of a text field. Facebook's radios happened to escape
this because they set no `value` attribute — the fixture, which sets one, is the stricter case.

### F64 — S2 — A `<select>` was named by its own options

`<select>` under "Shipping country" came back as **"Vietnam Japan"** — its option list read as its
name. Same category as F63: content used as identity.

**Fixed:** `SELECT`, `TEXTAREA`, `OPTION`, `PROGRESS`, `METER` are excluded from the innerText path;
they resolve through the label chain instead.

### F65 — S1 — The F61 fix itself was too greedy (caught by the e2e suite)

The row-walk accepted any ancestor whose text was under 80 characters. On the e2e page that let it
climb to a page-level wrapper and name a `<select>`:

```
"bctl Test Page go second Click Me 0 Apple Banana Cherry hover me no"
```

67 characters, under the cap. That name then matched `find("hover me")`, which returned the `<select>`
first, and `hover` went to the wrong element — `run.mjs` dropped to 69/70. A bad label is worse than no
label: it makes an unrelated element answer to your query.

**Fixed with a principled rule rather than a smaller number:** a label belongs to exactly ONE control,
so the ancestor must contain no other interactive element. Cap tightened to 60 as a secondary guard.
This is what separates a row from a container, and it cannot be tuned wrong the way a length cap can.

### Result

```
all label paths agree          (9/9, all four tools)
npm test            79/79
tests/e2e/run.mjs   70/70
run_multiframe.mjs  19/19
audit               0 unexpected failures
```

### Harnesses were hijacking the user's tab

Found while running the above: `audit_tools.mjs`, `coverage_check.mjs` and `run_labels.mjs` all called
`navigate`, which drives the *pinned* tab — and the pin drifts onto whatever the user is looking at
after an extension reload. It redirected a YouTube tab mid-session twice. All three now open their own
tab with `new_tab`.

## 19. Re-doing the audit against real sites, with Chrome as ground truth

§18 used a hand-written fixture. That only tests the shapes its author thought of, which is the wrong
instrument for a question about the real web. Replaced with a measurement that needs no fixture and no
guessing: **Chrome computes an accessible name for every control by the HTML-AAM spec**, and exposes it
via `Accessibility.getFullAXTree`. On any live page that is the ground truth.

`tests/e2e/label_vs_chrome.mjs <url> …` snapshots a page, pulls Chrome's AX tree for the same page, and
reports what fraction of Chrome's names browserctl also produced.

### First run — the fixture had been flattering

```
site                               ctl   named  anon  chrome  cover
github.com/login                   62    42     20    45      71%
en.wikipedia.org/wiki/Special:Pref 24    21     3     26      77%
www.amazon.com/s                   304   283    21    270     89%
news.ycombinator.com/              229   198    31    148     100%
```

Twenty anonymous controls on a GitHub page that the fixture suite called clean. Three more defects, all
of them shapes I had not thought to write.

### F66 — S1 — `aria-labelledby` was never read on non-form elements

Every one of GitHub's twenty unnamed controls was the same: an icon button or link labelled by
pointing at a hidden tooltip node. `aria-label` null, innerText empty, `aria-labelledby="_R_1b5_"`.

`controlLabelOf` handled `aria-labelledby`, but bailed out early for `<button>`/`<a>` without a role,
and `fullElementText` never looked at the attribute at all. It is the **second rule** in the name
computation and it was missing. GitHub 71% → 87%, anonymous 20 → 6.

### F67 — S1 — Name-from-content ignored descendant image alt text

The six that remained were `<a><img alt="@sindresorhus profile"></a>` — GitHub's avatar links. No text,
no aria, and Chrome names them from the image. They arrived anonymous and mutually indistinguishable,
which is F61's failure mode exactly: many identical rows, no way to pick one.

Fixed by reading `alt` / `aria-label` from descendant `img` / `svg` / `[role=img]`. GitHub 87% → 100%,
anonymous 6 → 0.

### F68 — S1 — Two classes of operable control were filtered out as "invisible"

Booking.com's **"I'm travelling for work"** checkbox is a 1×1 `opacity: 0` input with a visible
`<label>` — the standard accessible custom-checkbox, used across the web. The visibility filter dropped
it, so an agent could not see or tick a box a person ticks without thinking.

The same filter hid Booking's carousel arrows and Amazon's skip links: `opacity: 0`, revealed on
hover/focus, fully operable, named by Chrome. **A carousel could not be paged at all.**

Fixed with two bounded predicates, and both marked in the row so the agent knows why the element has no
box of its own:

```
<input>[type=checkbox][via label] "I'm travelling for work"
<div>[role=button][hidden until hover/focus] "Next: Browse by property type"
```

Bounded on purpose: opacity and zero-size only — never `display:none` or `visibility:hidden`, which
Chrome removes from the accessibility tree too — a real painted box, inside the layout, and it must
have a name.

### Final measurement

```
site                               ctl   named  anon  chrome  cover
github.com/login                   62    62     0     45      100%
en.wikipedia.org/wiki/Special:Pref 27    27     0     26      100%
www.amazon.com/s                   354   353    1     271     92%
news.ycombinator.com/              229   198    31    145     100%
www.booking.com/                   271   271    0     243     100%
```

**Anonymous controls: 0 on four of five sites.** Booking's census went 113 → 271 controls: 158 that were
previously invisible to any agent.

The two apparent shortfalls are correct behaviour, checked individually rather than assumed:
- **Amazon 92%** — the misses are `display:none` screen-reader announcements ("cart shift option c",
  "0 items in cart"). Not visible, not operable, correctly excluded.
- **Hacker News 31 anonymous** — coverage is 100%, meaning Chrome does not name them either. They are
  HN's unlabelled vote arrows: a gap in the site's markup, not in the census.

Token cost is unchanged (Hacker News 1,454 → 1,504 chars) despite the extra controls, because the
additions are individually small and the fold absorbs repetition.

### Method note

The first version of this harness reported false misses: Chrome renders punctuation with its own
spacing (`"homepage ( g then d )"` where the DOM says `"Homepage (g then d)"`), so exact comparison
under-counted. Comparison now normalises to letters and digits. Worth recording because the harness was
lying *downward* — it would have sent me hunting for defects that did not exist, the mirror of a
fixture that flatters.

Suites after all three fixes: unit 80/80 · e2e 70/70 · multi-frame 19/19 · labels 9/9 ·
audit 0 unexpected failures.

## 20. Chrome's accessibility tree as a first-class capability

The AX tree found three defects the fixture suite could not (§19), so the question is whether it should
be more than a test harness. Measured before deciding.

### What it cannot be: the census

```
snapshot --all        65ms    5,414 bytes
a11y_snapshot        198ms    9,524 bytes    + the debugger banner
```

3x slower, 1.8x larger, and it requires `chrome.debugger`, which makes Chrome display
**"browserctl started debugging this browser"** on that tab. Per `docs/debugger-policy.md` that banner
cannot be suppressed — it is a deliberate Chrome security guarantee. Background operation without
disturbing the user is this project's premise, so the AX tree cannot be the default reader. That is
settled, not a preference.

### What it was: unusable

```json
{"role": "link", "name": "Homepage ( g then d )"}
```

`collectAxNodes` discarded everything except role, name and value. No ref, so an agent could see a
control and had no way to act on it; no state, so it could not tell a checked box from an unchecked one.
A read-only curiosity behind a security banner.

### F69 — what it is now: an actionable second opinion, that grades the census

Two changes.

**State survives collection.** `checked`, `selected`, `expanded`, `pressed`, `disabled`, `required`,
`invalid`, `level` are kept from the node's properties.

**Every node is paired with the census entry of the same name**, so it carries a `ref`. Matching on the
name costs no extra CDP round-trips (a `backendDOMNodeId` lookup would be one per node), and the
leftovers are the genuinely valuable part: a control Chrome names and the census does not is a census
gap — which is precisely how F66, F67 and F68 were found.

```
a11y_snapshot on github.com  ->  {"role":"link","name":"Homepage ( g then d )","ref":"ref_28","tag":"a"}
                                 censusCoverage: 88%   matchedToCensus: 52/59
                                 notInCensus: [button "Open quick search dialog…", link "28945 stargazers"]
```

Measured across three sites: **88% / 82% / 100%**, 218-297ms.

The remaining gaps were each checked rather than assumed, and none is a missing control:
- `"Star this repository"` — the element is genuinely `0x0`; the visible variant is its sibling.
- `"28945 stargazers"` — the census has it as `"28.9k"`, the visible text. Chrome reads the
  screen-reader span instead. A naming difference, not a missing control; the ref is there either way.

### The measurement error, again

The first version reported **53%** coverage on a page with no gap, because it counted every named AX
node — landmarks, headings, `StaticText` — against a census that lists interactive elements by design.
Same class of error as the label harness counting Chrome's punctuation spacing as a mismatch. Coverage
is now scoped to actionable roles, and the response says so. A metric that cries wolf gets ignored,
which is worse than no metric.

### Positioning

The tool description now leads with the trade-off rather than burying it: what it is for (a second
opinion when the census looks wrong), what it costs (the banner, 3x slower), and that
`browser_snapshot` remains the default. It also auto-attaches (F50), so it is one call, not two.

**The larger point:** the highest-value use of the AX tree is not runtime, it is verification.
`tests/e2e/label_vs_chrome.mjs` can now be pointed at any URL to check the census against the browser's
own answer — a permanent oracle rather than a fixture that only tests what its author imagined. Every
naming defect in §19 came from it.

Suites: unit 81/81 · e2e 70/70 · multi-frame 19/19 · labels 9/9 · audit 0 unexpected failures.

## 21. The "exactly once" family, audited to the end

Found while drafting a real Gmail reply: `paste` put the message in the composer **twice**. That is
F1's shape again — two mechanisms that each do the whole job, run one after the other — so the rest of
the codebase was audited for it rather than patching the one site.

### F70 — S1 — `paste` inserted the text twice, and the first fix only worked on half the editors

```js
inserted = document.execCommand("insertText", false, text);
if (!inserted || paste) { …dispatch ClipboardEvent… }   // both succeed
```

When paste semantics were asked for, `insertText` ran, succeeded, **and** the ClipboardEvent was
dispatched anyway. Fixed by running exactly one path — ClipboardEvent first for paste semantics
(it is what an editor's own handler listens for), `insertText` as the fallback.

**The first fix was wrong on Lexical**, and only a second editor revealed it. Success was measured by
reading the content back synchronously. Facebook's composer preventDefaults the paste and commits
**asynchronously**, so the read-back saw no change, the fallback fired, and Lexical's handler then
committed too — two copies. Gmail commits synchronously and looked perfectly fine.

The correct signal is synchronous and standard: `dispatchEvent` returns `false` when the handler called
`preventDefault()`, which is the editor saying *I own this*. Available immediately, whenever the editor
actually commits. `execCommand`'s own return value is used the same way, instead of re-reading the DOM.

```
before fix   Facebook (Lexical) occurrences=2   Gmail occurrences=1
after fix    Facebook (Lexical) occurrences=1   Gmail occurrences=1
```

### F71 — S1 — `press_key(Enter)` submitted a form twice

The audit's real prize, found by grepping for the pattern rather than by hitting it:

```js
target.dispatchEvent(new KeyboardEvent("keydown", opts));
…
if (key === "Enter" && target.form) target.form.requestSubmit?.();
```

`requestSubmit()` is a fallback for forms that only submit via their button — never an addition to the
Enter key. `type(submit: true)` already guarded this and carried a comment saying so; `press_key` did
not. A page that submits from its own keydown handler submitted **twice**: a double order, a double
send. It survived because nothing exercised Enter-on-a-form through `press_key`.

Fixed with the same guard `type` uses — observe the page's own submit, respect `preventDefault` on
keydown — and the response now names who handled it:

```
page handles Enter itself     submits=1   submittedByPage: true,  keydownPrevented: true
form submits via button only  submits=1   submittedByPage: false, keydownPrevented: false
```

### F72 — S2 — The paste fallback was gated on the box looking empty

`if (!el.textContent && text) el.textContent = text;` — so an insertion path that reported success
while leaving the previous content in place skipped the fallback, and `paste` returned ok having
replaced nothing. Now gated on whether the insertion actually happened. `type` and `paste` also report
`effect.textNow` for a contenteditable, the symmetric read-back to `valueNow`.

### The new suite: `tests/e2e/run_editors.mjs`, 12 checks

Insertion and activation must each happen **exactly once**, across editor architectures that differ in
the two ways that matter: whether they handle the event, and whether they commit synchronously.

```
paste / type  ×  plain contenteditable · preventDefault+async · preventDefault+sync · textarea · input
press_key     ×  form that handles Enter itself · form that submits only via its button
```

Mutation-checked: removing the `preventDefault` signal makes exactly one case fail —
`preventDefault + async commit` → occurrences=2. Every other case, and Gmail, still passed with the bug
in place. **That one row is the whole reason this fixture exists**: a fix verified against one editor
is not verified.

### Harnesses were leaking the user's tabs

`audit_tools.mjs`, `coverage_check.mjs`, `label_vs_chrome.mjs` and `run_labels.mjs` each opened a tab
per run and never closed one — a day's testing left **54 tabs** in the user's browser. (`run.mjs` and
`run_multiframe.mjs` had always cleaned up.) All four now close what they open; verified at zero leak
across four consecutive runs.

Suites: unit 83/83 · e2e 70/70 · multi-frame 19/19 · editors 12/12 · labels 9/9.

## 22. The docs audited as a surface an agent reads

A low-tier agent that never installs the MCP server reads the docs the way it reads a tool
description: literally, once, and without cross-checking. Three defects came out of reading them
that way. Two of the three are the same shapes already recorded above — guidance that reached one
surface but not its twin (I3), and a number that was measured once and then drifted (I7).

### F73 — S2 — `--help` carried none of the MCP guidance

`browser_stop`'s description warns an agent not to call it to tidy up; the CLI's `--help` for the
same command said only what it does. An agent driving the CLI got no warning at all, and the
premise of the project is that the bridge stays up. `cli.js --help` was rewritten to carry the same
two warnings the MCP descriptions carry (`start` is "RARELY NEEDED", `stop` is "DO NOT run this to
tidy up") plus the MCP-tool-to-CLI-command mapping, so one surface is not quietly weaker than the
other. Guarded by a test that reads both surfaces and compares.

### F74 — S1 — `browserctl find <query>` silently did nothing

The CLI mapped positional arguments per command. `find` and `find_text` had no case, so the query
fell on the floor and the command ran with empty params — no error, no output worth reading. Both
are documented in the README cheatsheet, so the first thing an agent copied out of the docs failed
silently.

Two fixes, because the missing case was the symptom:

```js
case "find": case "find_text": params.query = rest[0]; break;
...
default:
  if (rest.length) { console.error(`${cmd}: unexpected argument "${rest[0]}"...`); process.exit(2); }
```

The `default:` branch is the real one. Every future command that forgets its positional mapping now
fails loudly instead of running empty.

### F75 — S2 — Docs claimed a completeness they did not have

Four claims, all true when written:

| Claim | Where | Reality |
|---|---|---|
| "See `PROTOCOL.md` for the full list" | README, raw-HTTP section | it details 24 of 81 actions, and the bridge has no enumeration endpoint — a dead end for the one audience that cannot call `browser_action` |
| `browser_clear` / `browser_check` / `browser_uncheck` | REFERENCE tool table | not registered tools; they are protocol actions reachable only via `browser_action` or the CLI |
| "~24 tools / 70+ tools", "67 MCP tools over 65 bridge actions" | REFERENCE | 35 / 80 / 81 |
| "45 of 65 commands never touch the debugger" | README, REFERENCE | measured against v0.5 when the surface was 65 |

The first two are wrong answers to a question an agent will actually ask. The last two are the
drift class, and the first attempt at fixing them repeated it: the counts were *dated* rather than
removed, which preserves a useless number and adds a sentence explaining why it is useless. The
rule settled on is **a raw count in prose is deleted, not dated, unless the reader needs it to make
a decision** — `core` (35) vs `all` (80) stays, because that number picks a profile; everything
else points at the source that is always right (`browserctl --help`, `browser_action` bare, or
`debugger-policy.md`'s per-action table).

### A flake that had been passing for the wrong reason

`run_labels.mjs` waited a fixed 1200 ms for its fixture, then asserted. Run alone it passed; run
back-to-back after four other suites it reported **"9/9 labels are missing from at least one
tool"** — a total failure that was really a page that had not rendered. A suite that fails loudly
at random teaches you to re-run it, which is how a real regression gets waved through. Replaced
with a readiness poll (25 × 200 ms on a `get_property count` probe) that SKIPs explicitly if the
fixture never appears. Three consecutive full-sequence runs clean.

### F76 — S2 — The e2e coverage report counted against a hand-written list

`run.mjs` ended with **"Command coverage: 59 of 61 exercised"**. `ALL_ACTIONS` was a literal, written
once and never grown; the protocol surface was 80 by then. Nineteen actions were outside the
denominator entirely — `fill`, `paste`, `find_text`, `dismiss`, `open_and_read` and the whole `get_*`
family — so no matter what the suite did or stopped doing, they could never be reported as missing.

97% was the number a maintainer read before deciding the suite was thorough. The honest split:

```
Command coverage: 63/80 exercised, 3 excused, 14 missed
```

`ALL_ACTIONS` is now derived from the MCP registry at run time, and the three excused actions
(`reload_extension`, `exec_system_cmd`, `action`) print their reason. The derivation is a regex over
another file, so it can rot into silence in its own right; a unit test re-runs it and fails if it
returns an implausibly small surface or loses any of seven named actions.

This is [I7] again, but in the opposite direction from the two cases already recorded there. Those
lied downward and cost a day of hunting phantom defects. This one flattered, and a flattering metric
is never questioned — it had been wrong for the entire v2 effort while being quoted in three
documents.

### F77 — S1 — `dismiss` could not close a native `<dialog>`

Found by the first test ever written for it. `<dialog>` opened with `showModal()` closes on Escape
only for a **trusted** key event — the browser does that, not the page — so the dispatched
`KeyboardEvent` never closed one. `dismiss` tried its close-button selectors, then Escape, then
threw `MODAL_NOT_DISMISSED`. The most standard modal in HTML was the one case it always failed.

It never *lied* about it, which is why this sat unnoticed: the F1-era verification rewrite made
`dismiss` confirm the modal is actually gone before claiming success, so the failure was honest and
loud. It was a capability gap, not a false report. One branch, before the Escape fallback:

```js
if (active instanceof HTMLDialogElement && active.open) { active.close(); ... }
```

`findActiveModal()` already detected these (`dialog[open]`, `:modal`), so nothing else changed.

### Four actions had never been called by any suite

The derived denominator from [F76] made them visible: `fill`, `dismiss`/`dismiss_modal`,
`focus_window`, `open_and_read`. Writing the four tests turned up two more things worth recording:

- **`open_and_read` is unreachable from a bridge-level suite.** It is an MCP-layer composite with
  no protocol action, so `run.mjs` gets `unknown action`. The denominator is derived from *MCP
  tools* while the suite drives the *bridge* — the two surfaces are not the same, and a composite
  falls in the gap. Excused with that reason stated, rather than silently dropped.
- **`focus_window`** only runs under `E2E_FOREGROUND=1`, since it steals OS focus. Also excused.

Coverage now prints `66/80 exercised, 5 excused, 9 missed`; the nine are seven `get_*`
aliases plus `paste` and `get_property`, all exercised by `run_editors.mjs` and `run_labels.mjs`.

## 23. A tier-1 agent on Gmail: 28 of 44 calls were eval_js

A Gemini 3.8 Flash session drove Gmail through browserctl and wrote its own post-mortem. (That
write-up is kept out of this repo — it quotes a real person's address and phone number from the
mail it was reading.) The bridge call log recorded the same session, so for once the self-report
can be checked against what actually happened. It does not survive the check.

| | Self-report | Call log (tab 414176306, 04:09:39–04:14:30Z) |
|---|---|---|
| eval_js | "over-reliance ... in places" | **28 of 44 calls, 64%** |
| Drafting the reply | three attempts, A/B/C | **22 consecutive eval_js** before one `paste` |
| `read_page` | "dumped AX nodes, but Gmail nested bodies in folded elements" | called **once, with no parameters** — no `ref_id`, no `mode:'all'` |
| `browser_get_text` | named as what it should have used | **zero calls** |
| `get_page_content`, `find_text` | not mentioned | **zero calls** |
| `snapshot` | | 6 calls, **every one `scope:'viewport'`** |
| Failures | STALE_REF recovery | correct — **1 failed call in 44** |

Even the final "draft saved" check went through eval_js. This is the self-report finding recorded
in §19 holding for the sixth time: an agent's account of its own tool use is not evidence.

### F78 — S1 — Inline hints were written in a syntax the reader cannot call

The case study blames the agent: *"instinctively fell back"*, *"assumed"*, *"forgetting"*. That
framing lets the tool off. A capable model reaching for eval_js in 64% of calls, with zero uses of
three purpose-built read tools, is a discoverability defect.

When the census truncates a body it emits `[+168 chars: get text @ref_48]`, and every compact view
ends with `[Next: ... read one value: get text @ref · ... · more of the page: snapshot --all]`.
Those are **CLI verbs**. An MCP client has `browser_get_text` and
`browser_snapshot({scope:"all"})`; it has nothing called `get text`. The mapping exists in this
server's INSTRUCTIONS, but an agent reads that once at session start and reads the hint inline
forty messages later, and the inline one wins.

The comment directly above the footer in `content.js` states the failure mode exactly:

> `// the mapping is not in front of it, a low-tier model reaches for eval_js and hand-rolls the`
> `// read, which costs far more tokens and loses every diagnostic.`

The footer was added to prevent that, and then written in the syntax the reader cannot call. [I3]
again, inside the mitigation for I3.

Fixed in `text()`, the single funnel every MCP response passes through — the bridge cannot know
whether its caller is the CLI or MCP, but the MCP server can. The rewrite is bounded to bracketed
hint spans: page text also flows through that function, and rewriting an email that happens to
contain "snapshot --all" would report words the page never said.

### F79 — S2 — The three read tools each pointed away from the read that was wanted

The agent wanted one thing all session: *the full text of this region*. Every tool that could give
it said no.

- **`get_text`** returns `el.innerText`, so it reads a whole container — it is an exact replacement
  for the `document.querySelector('div[role="main"]').innerText` the agent hand-rolled. Its
  description sold it as *"Read one property of an element ... Returns the FIRST match"*: a field
  getter.
- **`get_page_content`** ended with *"For web app UI ... use browser_snapshot instead."* Gmail is a
  web app, and snapshot truncates. Snapshot → truncated → hint in unusable syntax →
  get_page_content declines → eval_js. A closed loop with one exit.
- **`read_page`** opened with *"SPECIALISED reader — reach for browser_snapshot first"* and never
  mentioned `ref_id`, the parameter that answers the folded-subtree problem it was blamed for.

All three now name the region read and each other.

### F80 — S3 — Runtime logs had a bound, but nothing said so

`calls.jsonl` rotates at 8 MB keeping one `.1`, so it was already capped at 2× — verified, not
assumed. What was wrong around it:

- A `statSync` on **every command** to check the size. Now tracked in memory.
- The cap was a constant; now `BROWSERCTL_CALL_LOG_MAX_MB`.
- Nothing announced that a record of everything driven through the bridge was being written. The
  bridge now says so at startup, and `status` reports current size against the cap.
- `telemetry.jsonl` had no bound at all. Same rotation now.
- `.gitignore` had `bridge/telemetry.jsonl` **without the trailing star**, so a rotated
  `telemetry.jsonl.1` would have appeared as untracked and could have been committed. That is [I9]
  by a one-character gap.

`bridge.log` (191 bytes, dated 2026-08-07) is a leftover: the daemon launcher uses `stdio: "ignore"`
and nothing writes it any more.

Suites: unit 92/92 · e2e 73/73 · multi-frame 19/19 · editors 12/12 · labels 9/9.
