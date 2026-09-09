# Spec: what each suite exists to catch

Every suite here was added because something shipped that the existing ones could not see. The entry
for each names that thing, so a suite is never deleted for being quiet.

## The suites

| Suite | Needs Chrome | Catches |
|---|---|---|
| `npm test` (83) | no | contracts, descriptions, cross-file invariants, the pure census helpers |
| `tests/e2e/run.mjs` (70) | yes | the real stack against a served page; 59 of 61 commands |
| `tests/e2e/run_multiframe.mjs` (19) | yes | **anything that only breaks when the page has an iframe** |
| `tests/e2e/run_editors.mjs` (12) | yes | insertion and activation happening **exactly once** |
| `tests/e2e/run_labels.mjs` (9) | yes | the four readers disagreeing about an element's name |
| `tests/e2e/label_vs_chrome.mjs <url>` | yes | the census disagreeing with **Chrome** on any live page |
| `tests/e2e/audit_tools.mjs <url>` | yes | any read-only action failing, on a site you care about |
| `tests/e2e/coverage_check.mjs <url>` | yes | something in `snapshot --all` being unreachable by `find`/`get_text` |

## Why each of the last five exists

**`run_multiframe.mjs`** — every fixture was single-frame, and that blind spot let the compact view be
rebuilt from scratch on *every real site* while all 81 unit tests stayed green [F41]. Its fixture
carries one instance of each shape that produced a round-2 defect: three landmarks, a run of five
identical buttons, two anchors sharing a destination, a 200+ character label, a side-anchored
non-blocking dialog, a panel inside a `width:0;height:0` wrapper, and a `menuitemradio` menu.

**`run_editors.mjs`** — the double-insertion bug was invisible on every simple fixture *and on Gmail*.
Only Lexical, which `preventDefault`s and then commits asynchronously, doubled the text [F70]. The
fixture varies exactly the two things that change the outcome: whether the editor handles the event,
and whether it commits synchronously.

**`run_labels.mjs`** — nine controls, each labelled a different way, asked of all four readers. Added
when the [F61] fix landed in the census only and left `read_page` and `find` anonymous [F62].

**`label_vs_chrome.mjs`** — the oracle. Chrome computes an accessible name for every control to spec,
so on any live page that is ground truth for what the census *should* have found. **Three naming
defects came from it that the hand-written fixture had passed clean** [F66, F67, F68]. A fixture only
tests the shapes its author imagined; this needs no fixture at all.

**`audit_tools.mjs`** — calls every read-only action against a live site. Its first run found **23 of
42 failing** on a complex page, at a time when everything else was green. It separates real failures
from tools correctly refusing (`wait_for` on absent text, `net_get` before `net_start`), grading the
latter on the quality of the error.

## Two rules for writing tests here

**A suite that passes proves nothing until you have seen it fail.** Every claim of coverage in this
project has been mutation-checked: a deliberate regression is introduced and the suite must catch it.

```
revert hiddenContentHints to the loose matcher   -> caught (1 failure)
delete foldText's đ/Đ special case               -> caught (2 failures)
stop dropping opaque query values in shortHref   -> caught (1 failure)
remove the preventDefault signal from paste      -> caught (1 of 12 — the Lexical case only)
```

That last line is the argument for the whole approach: eleven of twelve cases, and Gmail, passed with
the bug in place.

**Source-level assertions are a floor, not coverage.** Most of the unit suite greps `content.js` for a
default or a phrase. That catches a reintroduced constant or a deleted notice; it cannot catch a logic
regression. Real behavioural coverage lives in `content_helpers.test.mjs` (the pure helpers, sliced from
the shipped file at test time so they break when the implementation changes) and in the e2e suites.

## Measuring an agent, not the server

Agent self-reports are unusable as measurement. Across every probe run in this project, **not one
reported its own call count correctly** — 26/33, 12/19, 38/3, 31/33, 6/16, 8/6 — and one fabricated an
entire 38-call session, including six friction findings and eight contact names that do not exist on
the page [F32].

Set `BROWSERCTL_CALL_LOG=1` and read `bridge/calls.jsonl`. Score a run as **steps × accuracy against
the live page**, never steps alone: the fastest run in the set finished in half the calls of the next
and got the answer wrong, because it skipped the verification [F37].
