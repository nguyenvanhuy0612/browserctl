# Specs

The spec is the source of truth. Code implements an approved spec; it never leads it.

## Rules

1. **Spec first.** No function, tool, parameter, result field or error code exists in code before
   it exists in an approved spec. A change starts as a spec change.
2. **Who approves.** The owner approves the high level: `architecture.md`, the tool list, and
   anything that changes what an agent can do. Technical specs (parameters, behaviour, errors,
   tests) are approved by the agent after an independent review (a second agent or a reviewer
   subagent reads the spec against the code it depends on), and the owner is told.
3. **One spec per unit.** A tool, a daemon module or the extension relay each get one file. The
   template is `_template.md`; every section is filled or marked `none`.
4. **Exact surface.** A spec lists every parameter (name, type, default, allowed values), every
   result field, every error code with its `hint`, and the behaviour step by step.
5. **Tests are named in the spec.** Each test has an ID (`CLICK-U01` unit, `CLICK-E01` live,
   `CLICK-S01` site check on the owner's Chrome). The test file uses the same ID in its name. A test
   without a spec ID, or a spec ID without a test, fails the gate (`node scripts/spec-ids.js`). Kind
   `manual` marks a check only a person can do (pressing Cancel on Chrome's bar); the gate lists
   those instead of failing on them.
6. **Edge cases are explicit.** The spec lists the cases covered and the ones left out, with why.
7. **Code that drifts is a defect.** If code and spec disagree, the code is wrong until the owner
   changes the spec.

## Status

`draft` → `approved` (rule 2) → `implemented` (code and tests merged) → `verified` (live run
passed on the owner's Chrome).

## Index

| Spec | Status |
| --- | --- |
| `architecture.md` (components, two lanes, reuse policy, invariants) | verified |
| `dom-lane.md` (Playwright injected script in the extension, no debugger) | verified |
| `relay.md` (CDP lane: extension relay and Playwright) | verified |
| `sessions.md` (sessions, tabs, leases, attach lifecycle, banner policy) | implemented (manual check open) |
| `targets.md` (refs and selectors, shared by every element tool) | verified |
| `actions.md` (common action parameters: `timeout`, `scroll`, `wait`) | verified |
| `settle.md` (when an action counts as finished) | verified |
| `errors.md` (every error code, one table) | verified |
| `interface.md` (HTTP API, MCP, CLI, extension wire protocol, call log) | verified |
| `extension-ui.md` (toolbar popup) | implemented (manual check open) |
| `tools/status.md` | verified |
| `tools/tabs.md` | verified |
| `tools/navigate.md` | verified |
| `tools/snapshot.md` | verified |
| `tools/read.md` | verified |
| `tools/get.md` | verified |
| `tools/click.md` | verified |
| `tools/hover.md` | verified |
| `tools/type.md` | verified |
| `tools/fill_form.md` | verified |
| `tools/press_key.md` | verified |
| `tools/wait_for.md` | verified |
| `tools/take_screenshot.md` | verified |
| `tools/file_upload.md` | verified |
| `tools/handle_dialog.md` | verified |
| `tools/evaluate.md` | verified |
| `tools/run.md` | verified |
| `tools/scroll.md` | verified |
| `tools/network_requests.md` | verified |

## Review log

| Date | Scope | Reviewer | Result |
| --- | --- | --- | --- |
| 2026-11-15 | `architecture.md`: `beforeunload` removed from the reasons to use `trusted` (the shim handles it in the agent's tabs, `dom-lane.md`); package `browserctl-mcp`, version 1.0.0 | owner | Approved by the owner; statuses set to `verified` after the site run (11 pass), `implemented` for `extension-ui.md` and `sessions.md` until UI-S01 and SES-S01 are checked by hand. |
| 2026-11-15 | First-release work: every spec ID given a test (gate `scripts/spec-ids.js`), the adopted Playwright and playwright-mcp cases ported or listed as not adopted with the reason, the five open gaps closed (`DIALOG_OPEN` replaced after measuring that no debugger can answer a dialog opened before it attached; settle numbers measured and kept; `closeTabsOnEnd` through `X-Browserctl-Close-Tabs`; `docs/TOOLS.md` generated), release gates (`scripts/preflight.js`) | author, each change spec first and test seen failing first; then an independent reviewer agent (read-only) over every uncommitted change and `snapshot.md` revision 2 | Porting and measuring found real defects, each fixed after its spec: `page.evaluate` hung in `run` (contexts not replayed to a second client), the first trusted input after a fresh load was dropped (paint holding), a `run` worker's `Fetch` events went to the daemon's Playwright, listener errors killed the run worker, `evaluate` code saw the wrapper's variables (`result`), DOM-lane clicks missed wrapped links, `display: contents` and text inside controls, a covered element was never re-scrolled, `fill_form` refused ARIA checkables and followed links inside labels, the CDP lane kept a swapped element, `textInput` was missing, chords sent no modifier key events, screenshots raced Chrome's capture quota, a stale CDP state survived a worker restart, `beforeunload` froze background tabs, and page-opened tabs were owned by the wrong session and took the user's view (Chrome's `openerTabId` is the active tab). The reviewer's 3 high findings (relay replay after a re-attach, two tests that could not fail) and 9 medium ones (child-session routing, `Runtime.disable` duplicates, two `beforeunload` handler forms, key aliases in the CDP lane, spec drift) are fixed with tests (RLY-U06..U08, KEY-U02, KEY-E07, NAV-E04 extended and shown failing by a mutation of the shim); the low ones are fixed or the spec reworded. |
| 2026-11-13 | all specs | reviewer subagent, independent of the author | 20 findings (6 high). All addressed: `read` and `hover` tools added; popups, CSS `:hover` and `beforeunload` moved to `trusted`; `run` moved to a killable worker process; extension call timeouts with a dialog check; worker-restart identity (`browserStartedAt`), keepalive and persisted event queue; frame refs in the CDP lane; upload limit 25 MB; contradictions on `evaluate` fallback and `network_requests` lanes fixed. Three claims checked by spike first (`popup-dialog-check.mjs`): two held, one (dialogs hanging `chrome.scripting`) did not reproduce and stays as a defensive rule. |
| 2026-11-15 | SHOT-E01 (`take_screenshot.md` test row): wait until the selected tab reports `visible` (up to 5 s) instead of a fixed 500 ms; skip with a reason when it never does | author | Measured: activating the harness window took 0.5 to 1.5 s, so the fixed wait was flaky; later the screen was locked (`CGSSessionScreenIsLocked`), every window was hidden and the product correctly used the CDP lane, which no test change can turn into a DOM-lane capture. A harness flag (`--disable-backgrounding-occluded-windows`) was tried and removed: it did not help. |
| 2026-11-15 | Test gaps and spec-only changes closed: SNAP-E02, SNAP-E05, TGT-E02, TGT-E03, TGT-E05, TGT-E06, TYPE-E04, FORM-E04, FORM-E05 written; SNAP-E07 (native progress) and GET-E03 (contenteditable cut) extended; GET-E06 and ACT-E03 made deterministic (the element now appears 3 s after the click: the click's own settle took about 1 s and raced the old 1 s delay) | author; mutation checks | Behaviour specified after the code (F3, F7, F8, F9 and the reviewer's spec gaps) and the new gap tests could not fail first, so each test was shown to guard its rule by a mutation: the rule was broken in the code, the test failed, the file was restored (20 mutations, all caught; the first TYPE-E04 mutation hit a branch the test does not use and was moved to the setter path). TGT-E03 needed both of its `isConnected` checks removed; SNAP-E05 was checked by removing the shadow-root walk in the generated Playwright script, then rebuilding. TGT-E02 holds because each document gets a fresh runtime; no mutation of that was made. API-E02 now kills its MCP child in a `finally`, after a failing assertion hung the runner. |
| 2026-11-14 | Independent review (a separate read-only reviewer agent) of every uncommitted change: snapshot rev 2, targets rev 2, `actions.md`, `get`, `type`/`fill_form` read-back, tab groups removal | independent reviewer agent; findings resolved by the author | 14 findings. Bugs, each with a test seen failing first: outline collapsed regions holding a `[modal]` line or an iframe (SNAP-U20); fold lines broke the prose budget across nesting (SNAP-U20); CDP lane `timeout: 0` meant "no limit" in Playwright and hung (ACT-E05); `file_upload` CDP calls ignored `timeout` (ACT-E05); empty `wait` strings accepted (ACT-U01); `>>` chains without spaces and quoted `>>` mis-split (TGT-U03); the cut line pushed the snapshot past `maxChars` (SNAP-U03). Spec gaps closed in the spec: exact `name=`/`testid=`, ARIA checkable values and contenteditable cut in `get`, native progress/meter values, fold order. Test gaps: GET-E06 could not fail (rewritten), FORM-E03 duplicate renumbered FORM-E05, TABS-E03 added. Cleanups: one `REF`, `factText` copies aligned. Earlier gaps the reviewer listed (SNAP-E02, SNAP-E05, TGT-E02, TGT-E03, TGT-E05, TGT-E06, TYPE-E04, FORM-E04, FORM-E05) predate this session and stay open. |
| 2026-11-14 | Review of the session's reactive changes (owner asked after a fix was made mid-test without a spec): `type.md` and `fill_form.md` step 6 (second read of contenteditable fields on the same element, before `submit`), `dom-lane.md` (`readBack`, `get`), `snapshot.md` (readiness: minimum cost and the failure path; modal naming of a role-less backdrop; exact role lists for label echoes and prose; `near` limits; light-DOM headings for `ctx`), `get.md` (DOM objects as `toString()`), `actions.md` (timeout named in the message; `fill_form` waits only when every field was set), `interface.md` (instructions content) | author review of every function changed in the session against its spec; no independent reviewer | Nine findings, each fixed spec first, then a test seen failing (TYPE-E05, FORM-E03, GET-E02, ACT-E03, SNAP-U18), then the code; SNAP-E08's backdrop case and the role lists were code without spec, so only the spec changed. The mid-test `type` fix was reverted: it read after `submit` and resolved the target again. F4 (light-DOM headings for `ctx`) has SNAP-E11, but it also passes on the old code: Chrome orders the shadow headings, which are disconnected from the document for `compareDocumentPosition`, in a way that happened to give the right answer, so the defect was a risk, not a reproduced failure; the change is kept because it makes the result deterministic and matches the spec. |
| 2026-11-14 | `actions.md` (new: `timeout`, `scroll`, `wait` on the action tools), `tools/get.md` (new tool, owner's request), `targets.md` revision 2 (locator forms `name=`, `label=`, `placeholder=`, `testid=`, `alt=`, `title=` rewritten by the daemon; XPath allowed), `TARGET_OUTSIDE_VIEWPORT`, parameter rows in click, hover, type, fill_form, press_key, scroll, file_upload, navigate | author self-review; no independent reviewer | Owner direction 2026-11-14: actions take a ref or any locator and parameters such as wait and timeout, each with a default. Decision D5 of the snapshot plan changed: XPath is allowed, since Playwright resolves it at no cost. `wait` that times out does not fail the action (a retry would act twice). |
| 2026-11-14 | `tools/snapshot.md` revision 2: readiness (step 2), facts on lines (`[empty]`, `[type]`, `[value]`, `[near]`, `[ctx]`, `[modal]`, `[hidden]`, `[no-pointer-events]`, table and list counts), modal layer, label echoes, prose folding (`maxText`), outline collapse to fit `maxChars`, YAML-safe marker lines; result fields `ready`, `readiness`, `modal`, `textFolded`, `collapsed` | author self-review against real pages (demoqa, YouTube search and watch, Wikipedia, HuggingChat, OpenStreetMap, Hacker News, MDN) through the live harness; no independent reviewer | Every rule changed after a real page contradicted it: hanging ad requests (demoqa), attribute churn and 1 s timer bursts in background tabs (YouTube), `readyState` stuck at `interactive` (MDN), the whole page being one table (HN), heading anchors sharing names with the table of contents (MDN). Refs are untouched: facts are brackets after the ref; collapsed nodes keep their line and ref. An independent review is still due. |
| 2026-11-14 | tab groups removed (`sessions.md`, `tools/tabs.md`, `interface.md`, `relay.md`): owner's decision | owner decision; author applied it | New tabs are inactive and ungrouped; `tabs.group`/`tabs.ungroup` and the `tabGroups` permission are gone (the extension needs a Reload). |
| 2026-11-14 | `tools/snapshot.md` compaction rule 3 (noise removal, SNAP-U05 to U09) and SNAP-E06 (iframe in a shadow root, `targets.md`) | author self-review, no independent reviewer | Driven by measured defects on Facebook, OpenStreetMap, MDN and HN (`temp/snapshot-review/snapshot-plan.md`, findings 2, 3, 4, 8, 14, 19). Unit tests red-green; SNAP-E06 verified failing without the runtime fix. An independent review is still due for the whole snapshot revision (S1 to S3). |

2026-11-14: the owner approved the tool list and the architecture; all specs set to `approved`.

## Implementation state (2026-11-15)

All 19 tools, both lanes, the MCP server and the CLI are implemented, and every test ID in these
specs has a test (`node scripts/spec-ids.js`: no untested ID, no test without one; UI-S01 and
SES-S01 are manual checks). The adopted Playwright and playwright-mcp cases are ported
(`tests/live/pw-*.test.js`, `tests/live/mcp-cases.test.js`), each spec naming the cases it does
not adopt and why. Release gates: `npm run preflight` (`scripts/preflight.js`). Results of the last
full run are in the review log above.

Last runs (2026-11-15, version 1.0.0, package `browserctl-mcp`): `npm run preflight -- --live
--release`: every gate passed (unit 60 pass; live 354 pass, 0 fail, 4 skipped when the Chrome for
Testing window has no OS focus or the screen is locked: SHOT-E01, SHOT-E03, SCR-E03, AR-077).
`node tests/site/real-chrome.js` on the owner's Chrome after the extension reload: 11 pass, 2
informational (SNAP-S01 Facebook 66% smaller than `full`, Marketplace click settled in 1.1 s,
trusted scroll grew the feed 9,385 px).

Open:

1. Manual checks UI-S01 (popup) and SES-S01 (Cancel on the bar).
