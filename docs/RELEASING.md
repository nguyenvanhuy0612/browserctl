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
| **versions agree** | `package.json` and `extension/manifest.json` disagree, or `SERVER_VERSION` is restated instead of read | Bump both. The manifest version is the only thing in `chrome://extensions` that reveals a stale loaded extension — that cost a probe run three of its checks once. |
| **the changelog leads with this version** | the newest `## x.y.z` in CHANGELOG.md is not `package.json`'s version | Collapse or bump. See *Version numbers are read from outside* below. |
| **unit tests** | any of `npm test` fails | Fix it. These pin behaviour that was wrong once already. |
| **generated surface doc is current** | `docs/TOOLS.md` no longer matches the registry | `node scripts/preflight.mjs --fix`. A tool or parameter shipped without appearing in the one document that claims to list them all. |
| **every core tool appears in the docs** | a `core` tool is in neither README nor REFERENCE | Document it. A tool nobody documented is a tool nobody finds. |
| **every core tool parameter is documented** | a parameter has no `describe()`, or its name appears in no doc | Two audiences: the agent reads `describe()`, a human reads `docs/REFERENCE.md`. **This is the gate for the most common blind spot — a feature that ships as a new PARAMETER on an existing tool.** Every doc still describes the tool correctly, and nothing says the new capability exists. |
| **no live pointer to a removed tool** | a string an agent can read names a `browser_*` that is not registered | Repoint it. Comments and migration notes are allowed to name history; hints, descriptions and error messages are not. `wait_network_idle`'s timeout hint pointed at `browser_wait_settle` for two releases after it was deleted. |
| **e2e covers every protocol action** | an action is neither exercised by a suite nor listed in `NOT_EXERCISED` with a reason | Write the check, or write the excuse. `browser_dismiss_modal` once shipped completely dead while every snapshot advertised it. |
| **the intent index is not stale** | a core tool is missing from the `WHAT YOU WANT -> WHAT TO CALL` block in the server INSTRUCTIONS | Add its line. That block is read once at connect, before any tool description; a core tool absent from it is reachable only by luck. |
| **npm tarball is clean** | the package would ship `calls.jsonl`, `improvements/`, or telemetry | Fix `files` in `package.json`. |
| **end-to-end (live browser)** | the live stack fails, or the bridge/extension is not connected | The gate retries once — the live stack has genuine transients, especially in the first seconds after `reload_extension`. A second failure is real; the gate prints the suite's own FAILURES block. |

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
