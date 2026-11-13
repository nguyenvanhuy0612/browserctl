# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## 1. What browserctl is and what it is not

browserctl is a browser automation tool that AI agents invoke to operate web pages. It drives the user's real Chrome profile in the background via a local bridge daemon and a Chrome MV3 extension.

- It is a tool, not an agent: it never embeds an LLM. The reasoning and observe-act loop live in the calling agent.
- It operates on the live DOM and accessibility tree, not pixels or screenshots.
- It operates through a local HTTP/WebSocket bridge (`bridge/`) and exposes an MCP server (`mcp/`) and CLI (`cli.js`).

## 2. Where things live

A three-tier stack:

- `extension/` — Chrome MV3 extension. DOM traversal, VOM snapshots, element resolution, CDP interactions. Change here for page operations, target resolution, and browser-side state.
- `bridge/` — Local HTTP daemon on port 8765, routing commands between clients and the extension over WebSocket. Change here for transport, multi-browser aliasing, holds/leases, and session tracking.
- `mcp/` and `cli.js` — The client surfaces (MCP server, `browserctl` CLI). Change here for tool schemas, descriptions, and user/agent command interfaces.

## 3. Commands

Run from the repository root:

- `npm run preflight -- --e2e` — Full release gate: unit gates plus live browser suites.
- `npm run preflight` — Gates and unit tests only, no browser required.
- `npm run preflight -- --fix` — Regenerate `docs/TOOLS.md` from the tool registry.
- `npm test` — Unit tests.
- `npm run lint` — ESLint including local custom rules.

Each command prints its own counts. Do not restate counts anywhere in documentation; a number copied into prose rots on the next commit.

## 4. Invariants

1. **A comment describes the code, not its history.** Comments describe what code does and what constrains it. They never carry revision history, what was tried first, or session notes. History belongs in `CHANGELOG.md`. Enforced by `local/comments-describe-the-code` in `eslint.config.js`.
2. **The agent reading budget is capped.** All text handed to an agent at connect (core tool descriptions, parameter schemas, instructions) is capped at `AGENT_TEXT_BUDGET` (20,200 chars) in `scripts/preflight.mjs`. Additions must be funded by deletions.
3. **Clean break v2: no legacy aliases.** Element addressing is one parameter: `target`. Never accept or silently rewrite removed legacy aliases (`ref`, `selector`, `text`, `index`, `placeholder`). Tools removed in v0.7 are unknown tools, not shims.

## 5. Autonomy boundaries

- **Proceed without asking:** Read files, explore the codebase, run checks in section 3, and edit code within the assigned scope.
- **Propose and wait:** Schema changes, adding/removing dependencies, raising `AGENT_TEXT_BUDGET`, changing public tool surfaces, or modifying documented result envelopes.
- **Owner only, never on your own judgment:** `git commit`, `git push`, npm publishing, and picking release version numbers.

## 6. Where the truth lives

When sources disagree, resolve in this order:

1. **The code and its tests.** What ships is what the code and tests prove. A doc that contradicts passing tests is a defect.
2. `docs/REFERENCE.md` — Authoritative parameter definitions, return schemas, and error codes.
3. `docs/TOOLS.md` — Generated catalogue of the tool surface. Never hand-edit; regenerate with `npm run preflight -- --fix`.
4. `CONCEPTS.md` — Shared vocabulary and architectural concepts.
5. `CONTRIBUTING.md` — Rationale for preflight gates and development workflow.
6. `CHANGELOG.md` — Chronological history of published versions and unreleased changes.
7. `docs/internal/` — Exists only on the owner's machine (git-ignored); never cite or link it from tracked files.

## 7. Definition of done

Definition of done for a change to tool descriptions, instructions, result fields, or docs:
- **Run as a stranger:** The operator is an agent that has the packed package and the shipped docs, and nothing else: no repo, no plan. Reaching for a parameter or ordering the docs do not mention ends the run as a finding.
- **Run every example** in README.md and `docs/REFERENCE.md` verbatim.
- **Measure with the bridge call log:** Agents misreport their own call counts.
- **A run with no findings is a failed run.**
- **Each finding gets one disposition:** fixed with a named test that you invert-verified (break the fix, see the test fail, restore); owned elsewhere (a row in the backlog); or accepted, with a reason. "Recorded" is not a disposition.
- **All unit tests and preflight gates pass** (`npm run preflight`).
- **Live e2e tests pass** when touching bridge/extension runtime (`npm run preflight -- --e2e`).
- **New error codes or result fields** are documented in `docs/REFERENCE.md` and guarded by preflight.
