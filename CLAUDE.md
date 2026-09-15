# Claude Code Instructions — browserctl

Fast, ergonomic browser automation for AI agents and developers, driving the user's real
Chrome profile in the background.

## 1. Where things live

A three-tier stack. Start reading at the tier that owns the change.

- `extension/` — Chrome MV3 extension. DOM work, target resolution, CDP. Change here for
  anything about what the page does or how an element is found.
- `bridge/` — local HTTP daemon on port 8765, routing `/command` between clients and the
  extension over WebSocket. Change here for transport, state, and logging.
- `mcp/index.js` and `cli.js` — the two surfaces (MCP server, `bctl` terminal command).
  Change here for tool schemas, descriptions, and anything an agent or human reads.

## 2. Commands

From this directory.

- `npm run preflight -- --e2e` — release gate: every gate plus the live browser suites.
- `npm run preflight` — gates and unit tests only, no browser needed.
- `npm run preflight -- --fix` — regenerate `docs/TOOLS.md` from the tool registry.
- `npm test` — unit tests.
- `npm run lint` — ESLint, including the repo's own rules.

Each command prints its own counts. Do not restate those counts anywhere in the docs; a
number copied into prose is stale by the next commit.

## 3. Invariants

1. **No comments in shipped source.** `cli.js`, `bridge/`, `mcp/`, `extension/` carry no
   commentary — only pragmas (`prettier-ignore`, `eslint-*`, `@ts-*`, shebang). `scripts/`
   and `tests/` are exempt and should be commented normally.
   Enforced by `local/shipped-source-has-no-comments` in `eslint.config.js`.
2. **The agent reading budget is capped.** Everything handed to an agent at connect — core
   tool descriptions, parameter descriptions, instructions — is capped at
   `AGENT_TEXT_BUDGET` in `scripts/preflight.mjs`. Any addition must be funded by a
   deletion. Enforced by the reading-budget gate.
3. **Clean break v2: no legacy aliases.** Addressing is one parameter, `target`. Never
   accept or silently rewrite `ref`, `selector`, `text`, `index`, `placeholder`. Tools
   removed in v0.7 are unknown tools, not shims.

## 4. Autonomy boundaries

**Proceed without asking:** read anything, explore, run the commands in section 2, and edit
code within the scope of the task you were given.

**Propose and wait:** changes to the design spec (`docs/internal/tool-surface.md`), adding
or removing an npm dependency, raising `AGENT_TEXT_BUDGET`, renaming or removing anything
already public (a tool, a parameter, a result field).

**Owner only, never on your own judgement:** `git commit`, `git push`, publishing, syncing
to the public mirror, and choosing a release number. Approving a plan is not approving the
version number inside it.

## 5. Ground truth

- `docs/internal/` — working documents, not part of the published package. `tool-surface.md` is
  the spec: authoritative target-resolution rules and tool design, stated as what is true now.
  `history.md` holds decisions, reviews, superseded designs and the revision log — read it for
  how something came to be, never quote it as current behaviour.
- `docs/REFERENCE.md` — human-facing dictionary of core tool parameters.
- `docs/TOOLS.md` — generated catalogue of the tool surface. Never hand-edit; regenerate.
- `CONTRIBUTING.md` — the rationale for each gate.
- `CHANGELOG.md` — what changed and when.
