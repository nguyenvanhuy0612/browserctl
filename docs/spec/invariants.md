# Spec: invariants

Rules that span files, so no single edit obviously violates them. Each has a test, because each has
already been broken once by someone editing one half.

## I1 — Every content handler is routable

`content.js`'s dispatch table and `background.js`'s `CONTENT_ACTIONS` are edited in different files.
A handler added to one and forgotten in the other produces a tool that registers fine, passes every
registration test, and fails at runtime with a transport-shaped "unknown action".

`browser_dismiss_modal` shipped this way: completely dead, while **every snapshot advertised it** [F4].
The suite was 30/30 green throughout.

*Guarded by:* "every content.js handler is routable" in `cli_and_mcp.test.mjs`.

## I2 — Every tool name dispatches

The MCP tool surface and the protocol action surface are not the same list, and an agent only ever sees
the first. `browser_get_text` is a tool; `get_text` is `get_property` with `{property:"text"}`. Reaching
for the name you just saw returned `unknown action` [F49].

Aliases live at the **extension's dispatch entry**, not in the MCP layer, so the CLI and the documented
raw-HTTP endpoint get them too. The MCP layer keeps a mirror table only so `browser_action`'s catalogue
can advertise them — and a test fails if the two drift.

*Guarded by:* "every tool name dispatches through browser_action", "the two alias tables cannot drift
apart".

## I3 — The two readers agree

`snapshot` uses `elementText` + `INTERACTIVE_SELECTOR`; `read_page` uses `accessibleName` +
`INTERACTIVE_ROLES`. Agents pick between them freely — three consecutive probes chose `read_page`
without being asked. A role or a name resolved by one and not the other means the two tools disagree
about whether a control exists [F48, F62].

*Guarded by:* "the two readers agree on what counts as interactive", `tests/e2e/run_labels.mjs`.

## I4 — Exactly one mechanism acts

See `actions.md`. Four instances, and the pattern recurs because both mechanisms genuinely work in
isolation.

*Guarded by:* `tests/e2e/run_editors.mjs` (12 checks), "activation happens exactly once", "exactly one
insertion path runs on paste".

## I5 — A merge passes through, it does not enumerate

`background.js` merges per-frame results. Listing the fields to **keep** means editing the merge every
time the content script gains one, and forgetting is invisible: `compactView` was rebuilt from
scratch [F41], then `nearest` was lost, then `pageLabels` [F59]. Spread the top frame's result and
override only what the merge owns.

*Guarded by:* "the find merge must pass the top frame's result through".

## I6 — A claim in a description must be measured

`browser_snapshot` claimed viewport scope saved "75-85% tokens on complex SPAs". Measured: **2.7%** on a
real page. A probe quoted that sentence as the hint it acted on, so it was making scope decisions on a
false premise [F36]. `docs/plan-…-v2.md` likewise ticked "[x] telemetry recording in bridge" for
telemetry that lives in the benchmark script.

*Guarded by:* a test asserting the 75-85% claim does not return; and by re-running the measurement
harnesses, which is cheaper than arguing.

## I7 — A metric must count what it claims

Two harnesses lied, in opposite directions, and both would have wasted a day:

- `label_vs_chrome` compared names verbatim, so Chrome's punctuation spacing (`"homepage ( g then d )"`
  vs `"Homepage (g then d)"`) read as a miss. It lied **downward** — sending me hunting defects that
  did not exist.
- `a11y_snapshot`'s coverage counted every named AX node, including landmarks and `StaticText` the
  census omits by design, and reported **53%** on a page with no gap.

A third lied **upward**, which is the dangerous direction. `run.mjs` reported *"59 of 61 commands
exercised"* against a hand-written `ALL_ACTIONS` list. The protocol surface had grown to 80; nineteen
actions — `fill`, `paste`, `find_text` and the whole `get_*` family [F76] — were not in the denominator at
all, so they could never be reported as missing. The honest figure was 63 exercised, 3 excused, 14
missed. The list is now derived from the MCP registry, and the excused ones carry their reason in the
output.

A metric that cries wolf gets ignored; a metric that flatters is never questioned at all. So:

- **Derive the denominator, never hand-maintain it.** A hand-kept list stops counting silently, and
  nothing about the number looks wrong when it does.
- **Scope it to what the thing under test is for**, and say in the response what was counted, what
  was deliberately excluded, and why.

## I8 — A harness cleans up after itself

Four harnesses opened a tab per run and never closed one; a day's testing left **54 tabs** in the
user's browser. Three of them also called `navigate`, which drives the *pinned* tab — and the pin
drifts onto whatever the user is looking at after an extension reload. That redirected a YouTube tab
mid-session twice.

**A harness opens its own tab with `new_tab` and closes it, including on the error path.**

## I9 — Runtime data never ships

`package.json`'s `files` listed whole directories, so anything the runtime wrote into `bridge/` was
published: 964 KB of `calls.jsonl` — a log of every action driven through the bridge — plus
`telemetry.jsonl` and `bridge.log`.

**An allowlist of directories is not an allowlist.** Name the source files. The call log itself records
parameter *keys and sizes only*, never values, because `fill`/`type`/`paste` carry user input and
`eval_js` carries code.

*Guarded by:* "the bridge can record a per-call log, and never records parameter values"; and by
`npm pack --dry-run` before any publish.

## I10 — A number in prose must be one the reader needs

Counts rot. `"~24 tools"`, `"67 MCP tools over 65 bridge actions"`, `"45 of 65 commands"`,
`"72 findings"`, `"83/83 unit"` — every one was true when written and wrong when read [F75].

The first attempt at fixing them made it worse: the counts were **dated** rather than removed, which
keeps a useless number and adds a sentence explaining why it is useless.

- **Delete the number, do not date it.** Point at the source that is always right instead:
  `browserctl --help`, `browser_action` called bare, `debugger-policy.md`'s per-action table, or the
  suite's own printed output.
- **Keep it only where the reader needs it to decide something.** `core` (35) vs `all` (80) stays,
  because that number picks a profile.
- **A snapshot document may carry as-measured numbers.** `docs/history/` and `CHANGELOG.md` are
  dated by definition and say so in their headers. A live document may not.

The same reasoning applies one level down, to the numbers a *metric* reports — see [I7], where a
hand-kept denominator flattered the coverage report for the whole v2 effort.

*Guarded by:* "Docs do not claim a completeness they lack" (F75), which fails if the retired counts
return.
