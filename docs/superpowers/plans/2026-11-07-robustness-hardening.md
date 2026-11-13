# Robustness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make failures in the bridge and the extension visible and bounded: the bridge parses request bodies correctly and reports a survived uncaught exception as degraded, the extension stops swallowing errors silently, and every test the repo has runs in the release gate.

**Architecture:** Four independent changes. (1) The preflight unit-test gate also runs the colocated `*.spec.js`. (2) `readBody` in `bridge/server.js` counts bytes and decodes once. (3) A new pure module `bridge/crash.js` records uncaught exceptions and `bridge/server.js` reports them as `degraded` in `/status`. (4) A `swallow`/`noteSwallowed` pair in `extension/util.js` replaces silent catches in the service-worker files, and ESLint then forbids new empty catches there.

**Tech Stack:** Node >= 18 ESM, `node:test`, `ws`, ESLint flat config, Chrome MV3 service worker.

**Spec:** None separate. The requirements are the four review items agreed on 2026-11-07: swallowed errors, `uncaughtException`, `readBody`, test coverage. Security findings (`HOST=0.0.0.0`, unauthenticated `/command`, `exec_system_cmd`) are intentionally out of scope: the bridge is for internal use.

## Global Constraints

- No security work: do not touch `HOST`, `Origin`/`Host` checks, auth, or `exec_system_cmd` gating.
- No change to any public surface: no tool, parameter, or result field is added, renamed, or removed (CLAUDE.md section 4). `statusPayload()` keeps its fields.
- No new npm dependency. `AGENT_TEXT_BUDGET` untouched; no tool or parameter description edits.
- Comments describe the code, not history (`local/comments-describe-the-code` lint rule).
- Do not write counts, versions, or dates into docs or comments.
- Do not run `git commit` or `git push`, and do not choose a version number or edit `CHANGELOG.md`. The owner commits and releases. Final handoff includes proposed CHANGELOG wording only.
- A new file needs a stated reason; only `bridge/crash.js` and its spec are added (Task 3), and it must be listed in `package.json` `files`.
- Production code is frozen once a task's verification starts. A failing test is triaged (test defect, regression, or spec drift) before any production change.
- Files committed to the repo contain no absolute user paths.

## Decision on `uncaughtException`

Decided by the owner: the bridge keeps running and `/status` reports `degraded`. `unhandledRejection` stays log-and-continue. `degraded` is a new public result field, approved by the owner.

## Review Focus

Inputs and conditions the tasks' main tests would not otherwise hit, most likely first. Each has a test in the task named in brackets.

1. A JSON body whose multibyte character is split across two TCP chunks: expected to parse intact, today it is corrupted. [Task 2]
2. A body that is under the cap in characters but over it in bytes (3-byte characters): expected to be refused with the existing "too large" 400. [Task 2]
3. A command in flight when an uncaught exception hits: expected to complete normally. [Task 3]
4. A second uncaught exception: expected to increment `count` and keep the latest message. [Task 3]
5. A rejection value that is not an `Error` (`undefined`, a string, `null`) passed to `swallow`: expected to log and not throw inside a `.catch`. [Task 4]

---

### Task 1: Release gate runs the colocated specs

**Files:**
- Modify: `scripts/preflight.mjs` (the `unit tests` gate, around line 339)
- Modify: `CONTRIBUTING.md` only if it describes the `unit tests` gate (grep for it first)

**Interfaces:**
- Produces: the gate's detail string `"<pass>/<pass>"` now counts `npm test` plus `npm run test:colocated`. Later tasks add specs under `bridge/` and rely on this gate to run them.

- [ ] **Step 1: Prove the gap.** Run `npm run test:colocated` and note the pass count (`ℹ pass N`). Run `npm run preflight` and confirm its unit-test count equals `npm test` alone and excludes N.
- [ ] **Step 2: Change the gate** to execute `npm run test:all` and sum every `^ℹ pass (\d+)$` and `^ℹ fail (\d+)$` match with `matchAll` (the output now holds two runs). Keep throwing on a non-zero fail total. The detail string stays `"<pass>/<pass>"`.
- [ ] **Step 3: Verify.** `npm run preflight` prints a unit-tests detail equal to the sum from step 1. Temporarily make one colocated spec fail: the gate must fail. Revert the temporary edit.
- [ ] **Step 4:** If `CONTRIBUTING.md` describes this gate, update it to say the colocated specs are included.

### Task 2: `readBody` counts bytes and decodes once

**Files:**
- Modify: `bridge/server.js` (`readBody`, its two call sites at the `/heartbeat|/release` and `/command` routes, `export` line)
- Test: `tests/unit/bridge.test.mjs`

**Interfaces:**
- Produces: `export async function readBody(req, { maxBytes = MAX_HTTP_BODY_BYTES } = {}): Promise<object>`; `MAX_HTTP_BODY_BYTES` is a module constant of 5_000_000 (no env var). On overflow it rejects with an `Error` whose message contains `request body too large` and whose `code` is `"BODY_TOO_LARGE"`. Other rejections keep their current messages (`invalid JSON body`).

- [ ] **Step 1: Write failing tests** in `tests/unit/bridge.test.mjs`, importing `readBody` from `../../bridge/server.js` and using `Readable.from` as the request:
  - `readBody: a multibyte character split across two chunks is decoded intact`: body `JSON.stringify({ a: "€" })` as a Buffer split inside the 3-byte character; assert result `deepEqual { a: "€" }`.
  - `readBody: the cap counts bytes, not characters`: `maxBytes: 100`, body `{"a":"€€…"}` with 40 `€` (about 130 bytes, 50 characters); assert rejection with `code === "BODY_TOO_LARGE"`.
  - `readBody: stops reading the stream once over the cap`: an async generator yielding 1000 chunks of 1024 bytes with `maxBytes: 4096`; assert rejection and that fewer than 1000 chunks were pulled.
  - `POST /command oversized body: the response closes the connection`: raw `http.request` with a 5_100_000-byte body; assert status 400, message matches `/too large/`, and `res.headers.connection === "close"`. Keep the existing oversized-body test unchanged.
- [ ] **Step 2: Run** `node --test tests/unit/bridge.test.mjs`. Expected: the four new tests FAIL (`readBody` is not exported; byte test and split test fail on current logic).
- [ ] **Step 3: Implement.** Collect `Buffer` chunks, track a byte total, `Buffer.concat(...).toString("utf8")` once at `end`. On overflow: drop the collected chunks, stop collecting, `req.pause()`, reject with the coded error. Factor the two identical `.catch` blocks into one `sendBodyError(res, err)` that replies 400 as today and adds `connection: close` when `err.code === "BODY_TOO_LARGE"`. Export `readBody` next to `computeTimeoutMs`.
- [ ] **Step 4: Run** `node --test tests/unit/bridge.test.mjs`. Expected: all PASS, including the original oversized-body and invalid-JSON tests.

### Task 3: Record uncaught exceptions and report `degraded`

**Files:**
- Create: `bridge/crash.js` (reason: importing `bridge/server.js` starts a listener, so the logic cannot be unit-tested from there; the module is pure), `bridge/crash.spec.js`, `tests/unit/bridge_crash.test.mjs`, `tests/unit/children/crash-preload.mjs`
- Modify: `bridge/server.js` (`statusPayload`, the `uncaughtException` handler), `mcp/index.js` (`browser_status`), `cli.js` (`status`), `package.json` `files`, `docs/REFERENCE.md`, `tests/unit/browsers_mcp.test.mjs` and `tests/unit/children/browsers-mcp.mjs` (case `uc-degraded-status`)

**Interfaces:**
- Produces: `createFaultLog({ now }): { record(err): void, snapshot(): null | { count, lastAt, lastError } }`; `/status` carries `degraded: snapshot()`; `browser_status` carries `degraded` and a `hint` that names it only when set.

- [ ] Specs and integration tests written first and watched failing; implementation follows the signatures above; `npm run preflight` passes.

### Task 4: `swallow` helper

**Files:**
- Modify: `extension/util.js`
- Create: `tests/unit/extension_util.test.mjs` (reason: no test imports `extension/util.js` today; the helper is pure ESM and importable under Node)

**Interfaces:**
- Produces in `extension/util.js`:
  - `export function swallow(tag: string): (err?: unknown) => void`, for `promise.catch(swallow("cdp.persistAttached"))`;
  - `export function noteSwallowed(tag: string, err?: unknown): void`, for `catch (err) { noteSwallowed("cdp.attach.detach", err); }`.
  - Both emit `console.debug("[browserctl] swallowed", tag, message)` where `message` is `err.message` for an `Error`, else `String(err)`. Neither ever throws. `console.debug` is hidden at the service worker console's default level, so a swallowed error costs nothing until someone looks. Tags are static strings of the form `<file>.<operation>`.

- [ ] **Step 1: Write failing tests** with `console.debug` stubbed: `swallow` returns a function; calling it logs once with the tag and the message; `noteSwallowed` logs the same; both survive `undefined`, `null`, a string, and an object with a throwing `toString`, without throwing.
- [ ] **Step 2: Run** `node --test tests/unit/extension_util.test.mjs`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** both functions in `extension/util.js`.
- [ ] **Step 4: Run** the test again. Expected: PASS.

### Task 5: Replace silent catches in `cdp.js`

**Files:**
- Modify: `extension/cdp.js` (about 43 sites; `util.js` is already imported there)

**Interfaces:**
- Consumes: `swallow`, `noteSwallowed` from Task 4.

- [ ] **Step 1: List the sites.** `grep -nE "catch \{\}|catch \(e\) \{\}|\.catch\(\(\) => \{\}\)" extension/cdp.js`. Exclude every hit that sits inside a template string evaluated in the page (for example the `spoof_visibility` snippets around lines 1313 to 1343): those run in the page world where `noteSwallowed` does not exist.
- [ ] **Step 2: Convert.** `.catch(() => {})` becomes `.catch(swallow("cdp.<operation>"))`. `catch {}` and `catch (e) {}` become `catch (err) { noteSwallowed("cdp.<operation>", err); }`. Use a distinct tag per site, named for what failed (`cdp.detachBeforeReattach`, `cdp.persistAttached`).
- [ ] **Step 3: Check the vm-sliced tests.** `tests/unit/source-slice.mjs` evaluates functions cut out of the extension source in `node:vm`. If a sliced function now references `swallow` or `noteSwallowed`, add a stub to that test's sandbox rather than changing the production code.
- [ ] **Step 4: Verify.** `npm test` and `npm run lint` both pass; the grep from step 1 returns only template-string hits.

### Task 6: Replace silent catches in `background.js`, `netlog.js`, `driver/`, then lock it in

**Files:**
- Modify: `extension/background.js` (about 38 sites; add `swallow, noteSwallowed` to an import from `./util.js`), `extension/netlog.js` (1), `extension/driver/network.js` (4), `extension/driver/session.js` (3), `extension/driver/emulate.js` (1), `extension/driver/frame.js` (1)
- Modify: `eslint.config.js` (the `extension/**/*.js` block, around line 121)

**Interfaces:**
- Consumes: `swallow`, `noteSwallowed` from Task 4.

- [ ] **Step 1 and 2:** same procedure as Task 5, with tag prefixes `background.`, `netlog.`, `driver.network.`, `driver.session.`, `driver.emulate.`, `driver.frame.`. Exclude hits inside page-evaluated template strings.
- [ ] **Step 3: Lock in.** In the `extension/**/*.js` lint block set `no-empty` to `["error", { allowEmptyCatch: false }]`. Add a following override that restores `allowEmptyCatch: true` for `extension/content.js` and `extension/content/**`: the content script is not a module, cannot import `util.js`, and its 42 sites are out of scope here. A catch that holds only a comment satisfies `no-empty`; that stays an acceptable, deliberate choice.
- [ ] **Step 4: Verify.** `npm run lint` is clean (it fails first if any site was missed), then `npm run preflight` passes. The owner runs `npm run preflight -- --e2e` before any release, since this task touches live-browser code paths and the unit tests cannot cover them.

---

## Self-review notes

- Coverage: swallowed errors (Tasks 4 to 6), `uncaughtException` (Task 3), `readBody` (Task 2), test coverage (Task 1). Security is excluded by decision.
- Out of scope, listed so it is a choice and not an omission: the silent catches in `content.js`, `popup.js`, `options.js`; surfacing swallowed-error counts through `/status`; `unhandledRejection` policy.
- Proposed CHANGELOG wording for the owner, version number theirs: "`/status` and `browser_status` report `degraded` after the bridge survives an uncaught exception; request bodies are limited and decoded by bytes; the extension logs swallowed errors at debug level; the release gate runs every spec and lints the whole extension."
