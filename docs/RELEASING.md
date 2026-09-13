# Releasing

Run this before every version, however small:

```
npm start                      # bridge up, extension loaded in Chrome
npm run preflight -- --e2e     # ten gates; nothing ships until all are green
```

`npm run preflight` alone skips only the live-browser gate. Use it while working; use
`--e2e` before you tag.

---

## Why a script and not a checklist

A checklist is written against the surface that existed the day it was written. Then a
feature ships that it cannot see — and the checklist still passes, because it never knew
to look. That is not hypothetical: a hand-written table of every tool and its parameters
claimed a parameter on a tool that did not have it, and nobody noticed until a reader tried
to use it. That table is now `docs/TOOLS.md`, generated, with a gate that fails when it
drifts.

So every gate **derives** what it checks from the code — the tool registry, the parameter
schemas, the protocol action list. A new tool or a new parameter is checked from the moment
it exists, without anyone remembering to add a line here.

Where a gate *cannot* derive the answer, it fails loudly and tells you where to write the
missing sentence. That is the design: the script cannot write your docs, but it can refuse
to let you forget them.

---

## The gates, and what a failure means

| Gate | Fails when | What to do |
|---|---|---|
| **versions agree** | `package.json`, `extension/manifest.json`, `SERVER_VERSION`, or any version/tool-count stated in PROTOCOL.md, README.md, REFERENCE.md, TOOLS.md or the skill disagree | Bump both, and fix the prose. PROTOCOL.md claimed 0.6.3 while the package was 0.7.1 and REFERENCE.md claimed 80 tools when there were 67 — a number written into prose rots, so state it once or derive it. The manifest version is also the only thing in `chrome://extensions` that reveals a stale loaded extension. |
| **the changelog leads with this version** | the newest `## x.y.z` in CHANGELOG.md is not `package.json`'s version | Collapse or bump. See *Version numbers are read from outside* below. |
| **unit tests** | any of `npm test` fails | Fix it. These pin behaviour that was wrong once already. |
| **generated surface doc is current** | `docs/TOOLS.md` no longer matches the registry | `node scripts/preflight.mjs --fix`. A tool or parameter shipped without appearing in the one document that claims to list them all. |
| **every core tool appears in the docs** | a `core` tool is in neither README nor REFERENCE | Document it. A tool nobody documented is a tool nobody finds. |
| **every core tool parameter is documented** | a parameter has no `describe()`, or its name appears in no doc | Two audiences: the agent reads `describe()`, a human reads `docs/REFERENCE.md`. **This is the gate for the most common blind spot — a feature that ships as a new PARAMETER on an existing tool.** Every doc still describes the tool correctly, and nothing says the new capability exists. |
| **no live pointer to a removed tool** | a string an agent can read names a `browser_*` that is not registered | Repoint it. Comments and migration notes are allowed to name history; hints, descriptions and error messages are not. `wait_network_idle`'s timeout hint pointed at `browser_wait_settle` for two releases after it was deleted. |
| **e2e covers every protocol action** | an action is neither exercised by a suite nor listed in `NOT_EXERCISED` with a reason | Write the check, or write the excuse. `browser_dismiss_modal` once shipped completely dead while every snapshot advertised it. |
| **the loop is stated, and group notes are generated** | the instructions do not state the loop (open → read → act → check the effect), or a group note hard-codes its member list | Say the loop; generate the lists from `TOOL_GROUPS`. A group note is prefixed onto every description in its group, so a stale one is wrong on every tool at once — the READ note listed two merged-away tools for two releases. |
| **the intent index is not stale** | an entry point (open_url, snapshot, get_page_content, get_property, find, click, fill, eval_js, action, load_tools) is missing from the server INSTRUCTIONS | Add it. The instructions carry the tools an agent needs to START; everything else lives in its own description, the way playwright-mcp does it. |
| **child test scripts parse on their own** | a fixture in `tests/unit/children/` has a syntax error | Fix it — and prefer `runChild("x.mjs")` over an inline template literal: an embedded script carries two escaping layers, and a lost backslash becomes a real newline inside a string, failing in a child whose stderr the runner truncates. |
| **npm tarball is clean** | the package would ship `calls.jsonl`, `improvements/`, or telemetry | Fix `files` in `package.json`. |
| **end-to-end (live browser)** | any of the four live suites fails (main, multi-frame, label parity, editors), or the bridge/extension is not connected | The gate retries each suite once — the live stack has genuine transients, especially in the first seconds after `reload_extension`. A second failure is real; the gate prints that suite's own FAILURES block. It ran only `run.mjs` until 0.7.1, and three assertions in the multi-frame suite were failing unnoticed for two releases. |

---

## Version numbers are read from outside

A version number is not a log of how much work happened. It is what a stranger sees on npm
and in the tags, and from there **the only visible facts are which versions exist and which
are missing**.

Bumping while you work is fine — it is often the honest thing to do mid-change. But before
publishing, collapse those bumps into the one version you will actually ship, and give it one
CHANGELOG entry. Five internal versions that were never published are not five releases; they
are one release with a confusing number.

The specific failure to avoid: the registry sits at `0.6.2`, the working tree has iterated to
`0.9.1`, and publishing that way tells everyone who looks that `0.6.3` through `0.9.0` exist
somewhere and they cannot have them. Nothing about the internal history justifies that to a
reader — so renumber. Versions that were never published cost nothing to renumber, and cost
your users' trust to skip.

Rules of thumb:

- **Never publish a gap.** The next published version is the previous published version plus
  one step. Check with `npm view <pkg> version`, not with what the repo did.
- **One published version, one CHANGELOG entry.** The `the changelog leads with this version`
  gate enforces the pairing; collapsing the entries is yours to do.
- **Breaking changes still move the number honestly.** Collapsing does not mean hiding: the
  entry must carry the full migration table for everything that broke, whichever internal
  version broke it.

---

## When you add a feature, this is what has to change with it

The gates catch most of it. This table is what they catch, made explicit, so you can do it
in one pass instead of five rounds of red.

| You added | Then also |
|---|---|
| **A new tool** | `TOOL_CATEGORIES` (which profile), a line in the intent index, a row in `docs/REFERENCE.md`, a row in README's core table if it is core, an e2e check or an `NOT_EXERCISED` excuse, a unit test for whatever made it worth adding |
| **A new parameter on an existing tool** | a real `describe()` on the field — the agent reads that and nothing else; the tool's own description if the parameter changes *when to reach for the tool*; the parameter list in `docs/REFERENCE.md`; a test that the parameter reaches the protocol action it claims to |
| **A new protocol action** | the dispatch in `background.js`, an e2e check, and — if it has no MCP tool — the `extra` list in `browser_action`'s catalogue, or it becomes invisible while still working |
| **A removed or renamed tool** | grep is not enough; the "no live pointer" gate finds the strings, but you still owe the CHANGELOG a migration line, and `NOT_EXERCISED`/`ACTION_ALIASES` may name the old identifier |
| **New output in a response** (a field, a notice line) | check the cross-frame merge in `background.js` passes it through — that merge has dropped new fields twice by listing what it keeps instead of what it overrides — and check the MCP formatter in `text()` renders it |
| **A new hint or notice string** | write it in a syntax an MCP client can call, or add a rule to `CLI_TO_MCP` that rewrites it. A hint naming a CLI verb reaches the one reader who cannot use it. |

---

## Documentation describes what exists

Not how it came to exist. A description or a doc is read by someone deciding what to do next,
and every sentence about a solution that was tried and replaced is a sentence they have to
read and discard. Three places have accumulated exactly that and must not again:

- **Tool descriptions** — what the tool does now, and which neighbour to reach for instead.
  Not which failure mode caused which clause to be added.
- **PROTOCOL.md / REFERENCE.md** — the shape as it is. Not "added in 0.6.0".
- **Version and counts in prose** — a gate now checks them, because they had already rotted.

The history is not lost and is not unimportant: it belongs in code comments (which is where
this repo keeps its reasons), in the CHANGELOG, and in `docs/history/`. Those are read by
someone asking *why*, which is a different question from *what do I call*.

---

## Keeping this document honest

This file describes gates that live in `scripts/preflight.mjs`. If you change a gate, change
the row. If you add a gate, add a row — and prefer adding a gate over adding a paragraph
here, because a paragraph is a thing to remember and a gate is a thing that runs.

The failure mode this document is most likely to have is the same one it exists to prevent:
being accurate about the release of the day it was written. When a release surprises you,
the fix is usually a new derived gate, not a new instruction.

## Cutting the release

1. `npm run preflight -- --e2e` — all green.
2. CHANGELOG entry: what changed, and for a breaking change, the migration line.
3. Commit, tag.
4. `npm publish` and the public-repo sync are deliberately manual and outside this script.
