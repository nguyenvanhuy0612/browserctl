# Contributing to browserctl

Conventions that are enforced by a gate, and the reasoning behind each one. This file is not
published to npm — see "What ships" below.

## Comments: none in published source

**Rule.** `cli.js`, `bridge/`, `mcp/` and `extension/` carry no commentary. Pragmas are the only
exception: `prettier-ignore`, `eslint-*`, `@ts-*`, `global`/`globals`, and the shebang.

`scripts/` and `tests/` are exempt and are commented normally — around 12–18% of their lines.

**Enforced by** `npm run lint`, via the local ESLint rule
`local/shipped-source-has-no-comments` in `eslint.config.js`.

**Why.** A comment is the only artefact in the repo that stays silent when the code beneath it
changes. The reasons behind shipped behaviour live in three places that do not go silent:

1. **A test that fails without it.** Test names carry the finding they came from — for example
   `"Counting answers zero and separates invalid syntax (F52)"`. If the behaviour drifts, the
   suite goes red; a comment would simply become wrong.
2. **`CHANGELOG.md`.** The user-facing "why", including the approaches that were tried and
   failed — 0.7.1 records that a click's first movement check used a 1px tolerance and therefore
   read a 400px-over-10s slide as stationary.
3. **The tool's own `description()`.** What an agent needs at call time belongs in the schema it
   reads, not in a comment no agent will ever see.

`scripts/` and `tests/` are exempt for the opposite reason: a gate whose purpose is not written
down is a gate someone deletes to get a green run. That has already happened once — five
documentation gates were removed rather than migrated during the v2 rename, and the stale tool
references they existed to catch survived into the working tree.

## Text an agent reads: say it once, and pay for what you add

**Rule.** Tool `description`s, parameter `describe()`s and the `INSTRUCTIONS` block are loaded
into every agent's context at connect, on every session, whether or not the tool is ever called.
They are not documentation that sits quietly in a file. Before adding a sentence there, find out
whether it is already stated somewhere else, and delete as much as you add.

**Enforced by** the `the agent's reading budget is respected` gate in `scripts/preflight.mjs`,
which fails on three things:

1. **Budget.** What a default session is handed has a ceiling (`AGENT_TEXT_BUDGET`): the 24 core
   tools' descriptions, their parameter `describe()`s, and the instructions block. Today it sits
   at 18.2k of 19k characters — about 4.5k tokens every session pays before it does anything.
   There is no comfortable headroom on purpose: a real addition has to be funded by a real
   deletion, or by raising the ceiling deliberately and saying why in the commit.

   Measure the **registry**, never the source file. The largest duplication this repo ever had
   was invisible in the source: the group note was one constant, and 24 identical copies on the
   wire.
2. **No sentence in two tools.** A sentence of 45 characters or more appearing in two different
   tools' text fails. If a fact genuinely has to travel with two sibling tools, put it in
   `REPEAT_ALLOWED` **with the reason** — an exception that has to be written down is an
   exception somebody thinks about.
3. **No reworded copy.** Two sentences from different tools that share 60% of their four-word
   shingles fail too. Paraphrasing a duplicate is still a duplicate, and it is worse: the two
   copies now drift apart instead of staying wrong together.

**The one allowed exception, and what it costs.** Target resolution is stated three times: in the
server instructions (the agent, which cannot open a file), in `docs/REFERENCE.md` (the reader, who
never sees the instructions) and in `docs/tool-surface-design-v2.md` (the spec). Three audiences,
none able to follow a cross-reference. The price of the exception is a gate —
`every copy of the target-resolution rules agrees` — which pins the six resolution modes and the four
prefixes in all three. It caught a real drift the first time it ran: the instructions still
described the pre-fix CSS behaviour and never named `text-exact` or `text-substring` at all.
Duplication you cannot remove has to be duplication you can check.

**Where a fact belongs.** Every piece of knowledge in this repo has exactly one home. Adding a
second copy "so it is easier to find" is how an agent ends up reading the same thing four times
and a maintainer ends up fixing three of them.

| The fact | Its one home |
| :--- | :--- |
| How to sequence calls — the loop | `INSTRUCTIONS`, once |
| What a family of tools is for | `GROUP_NOTE`, generated from `TOOL_GROUPS` |
| What one tool does, and what it refuses | that tool's `description` |
| What one parameter means | that parameter's `describe()` |
| Why the code is the way it is | a test that fails without it, or `CHANGELOG.md` — never a comment |
| How a human installs and runs it | `docs/INSTALL.md` |
| The full parameter dictionary | `docs/REFERENCE.md` |
| The tool surface as it actually is | `docs/TOOLS.md`, generated |
| Design intent and its review history | `docs/tool-surface-design-v2.md`, internal |

**Why the budget and not just taste.** Description text competes with the page the agent is
actually reading. Tokens spent restating what another tool already said are tokens not spent on
the task, on every session, forever. And a fact stated in four places is not four times as clear:
it is one true copy and three that will be out of date by the next rename.

## Before you add a parameter to a core tool

Ask whether the **capability** is core, not whether the parameter is small. `browser_action`
dispatches any protocol action without a schema entry, so a rare or unfinished capability never
needs one — and a parameter on a core tool is read by every session forever, whether or not
anyone uses it.

This is not hypothetical: an unfinished dialog feature put two parameters on five core tools and
a paragraph in the instructions before anyone noticed, because each step looked small next to the
change it belonged to. Look at the whole surface after a change, not only the diff. A number
under budget is not the same as a change that earned its place.

## What ships

`package.json`'s `files` lists every published path **by name**. Do not add a bare directory.

A `"docs/"` entry once published `docs/tool-surface-design-v2.md` — 56 kB of implementation
review, counter-review and owner directives — to every npm consumer. Working documents are not
product.

**Enforced by** the `npm tarball is clean` gate in `scripts/preflight.mjs`, which fails on any
packed file whose name contains `design`, `review`, `plan`, `backlog`, `history`, `proposal` or
`notes`.

Published docs are `docs/INSTALL.md`, `docs/REFERENCE.md` and `docs/TOOLS.md` only.

## Before pushing

```sh
npm run lint          # includes the no-comments rule
npm run format:check  # prettier, source only
npm run preflight     # 13 gates, runs the unit suite
npm run preflight -- --e2e   # before cutting a release: needs the bridge and extension up
```

`npm run preflight` is the release gate, not `npm test`. If a gate is wrong, fix the gate —
deleting it is not a fix.

## Docs that must move together

- A new or renamed **tool** → `docs/TOOLS.md` (`node scripts/preflight.mjs --fix` regenerates it),
  `docs/REFERENCE.md`, `README.md`'s core-tool list, `CHANGELOG.md`.
- A new **parameter** → `docs/REFERENCE.md` and the `describe()` on its schema. A parameter
  documented in neither is invisible to both humans and agents, which is what the
  `every core tool parameter is documented` gate exists to catch.
- A change to the **tool surface** → `docs/tool-surface-design-v2.md`, which is the design of
  record and stays internal.
