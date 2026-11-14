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
5. **Tests are named in the spec.** Each test has an ID (`CLICK-U01` unit, `CLICK-E01` live). The
   test file uses the same ID in its name. A test without a spec ID, or a spec ID without a test,
   fails the gate.
6. **Edge cases are explicit.** The spec lists the cases covered and the ones left out, with why.
7. **Code that drifts is a defect.** If code and spec disagree, the code is wrong until the owner
   changes the spec.

## Status

`draft` → `approved` (rule 2) → `implemented` (code and tests merged) → `verified` (live run
passed on the owner's Chrome).

## Index

| Spec | Status |
| --- | --- |
| `architecture.md` (components, two lanes, reuse policy, invariants) | approved |
| `dom-lane.md` (Playwright injected script in the extension, no debugger) | approved |
| `relay.md` (CDP lane: extension relay and Playwright) | approved |
| `sessions.md` (sessions, tabs, leases, attach lifecycle, banner policy) | approved |
| `targets.md` (refs and selectors, shared by every element tool) | approved |
| `settle.md` (when an action counts as finished) | approved |
| `errors.md` (every error code, one table) | approved |
| `interface.md` (HTTP API, MCP, CLI, extension wire protocol, call log) | approved |
| `extension-ui.md` (toolbar popup) | approved |
| `tools/status.md` | approved |
| `tools/tabs.md` | approved |
| `tools/navigate.md` | approved |
| `tools/snapshot.md` | approved |
| `tools/read.md` | approved |
| `tools/click.md` | approved |
| `tools/hover.md` | approved |
| `tools/type.md` | approved |
| `tools/fill_form.md` | approved |
| `tools/press_key.md` | approved |
| `tools/wait_for.md` | approved |
| `tools/take_screenshot.md` | approved |
| `tools/file_upload.md` | approved |
| `tools/handle_dialog.md` | approved |
| `tools/evaluate.md` | approved |
| `tools/run.md` | approved |
| `tools/scroll.md` | approved |
| `tools/network_requests.md` | approved |

## Review log

| Date | Scope | Reviewer | Result |
| --- | --- | --- | --- |
| 2026-11-13 | all specs | reviewer subagent, independent of the author | 20 findings (6 high). All addressed: `read` and `hover` tools added; popups, CSS `:hover` and `beforeunload` moved to `trusted`; `run` moved to a killable worker process; extension call timeouts with a dialog check; worker-restart identity (`browserStartedAt`), keepalive and persisted event queue; frame refs in the CDP lane; upload limit 25 MB; contradictions on `evaluate` fallback and `network_requests` lanes fixed. Three claims checked by spike first (`popup-dialog-check.mjs`): two held, one (dialogs hanging `chrome.scripting`) did not reproduce and stays as a defensive rule. |

2026-11-14: the owner approved the tool list and the architecture; all specs set to `approved`.

## Implementation state (2026-11-14)

All 18 tools, both lanes, the MCP server and the CLI are implemented. `npm test`: 11 pass;
`npm run test:live`: 44 pass (DOM lane 29, CDP lane 15); `npm run typecheck`: 0 errors;
`node tests/site/real-chrome.js` on the owner's Chrome 157: 10 pass, 2 informational (Facebook
snapshot 60% smaller than uncompacted, Marketplace click settled in 1.3 to 2.4 s, trusted scroll
loaded the feed, GitHub read). Specs stay `approved` until the gaps below are closed; then they move
to `implemented`.

Gaps against the specs:

1. The adopted Playwright cases (`CL-…`, `FI-…`, `SO-…`, `CH-…`, `DI-…`, `KB-…`, `IF-…`, `NA-…`,
   `MO-…`, `SS-…`, `WA-…`) are listed but not yet ported; the live suites cover this project's own
   test IDs.
2. `DIALOG_OPEN` detection after an extension call times out (`interface.md`) is not built; such a
   call reports `TIMEOUT`.
3. Settle numbers (500 ms, 300 ms, 3 s) are unchanged; Facebook did not need others.
4. `closeTabsOnEnd` has no parameter that sets it (`sessions.md`).
5. `docs/TOOLS.md` is not generated; `browserctl tools` lists the surface.
