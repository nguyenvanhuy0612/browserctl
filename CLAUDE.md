# Claude Code Instructions — browserctl

Fast, ergonomic browser automation for AI agents and developers, driving the user's real Chrome profile in the background.

## 1. Architecture Overview

Three-tier decoupled stack:
- **`extension/`** (Chrome MV3 extension): Content scripts (`content.js`), background service worker (`background.js`), netlog, and CDP bridge (`cdp.js`). Handles DOM operations, target resolution, and CDP events.
- **`bridge/`** (Local HTTP daemon, default port 8765): `server.js` and `state.js`. Routes `/command` HTTP POST requests between MCP/CLI clients and the Chrome extension via WebSocket.
- **`mcp/` & `cli.js`** (Surface layers):
  - `mcp/index.js`: Model Context Protocol server exposing 25 core tools (default) + dynamic profiles (network, cdp, cookies, storage, console, record, tabs, advanced).
  - `cli.js`: Terminal interface for humans and script runners (`bctl`).

## 2. Essential Commands

Run these from the repo root (`claude/browserctl`):

- **Release Gate / Full Verification**:
  `npm run preflight -- --e2e` (every gate, the unit suite, and the live browser suites — it prints the counts, so they are not restated here).
- **Unit Gates Only (Fast, no browser needed)**:
  `npm run preflight` (Checks reading budget, schema/doc agreement, lint, and unit tests).
- **Unit Tests**:
  `npm test` (Runs `node --test tests/unit/`).
- **Lint & Format**:
  `npm run lint` (ESLint: catches syntax errors and enforces no-comments in shipped source).
- **Auto-sync generated surface docs**:
  `npm run preflight -- --fix` (Regenerates `docs/TOOLS.md` from the tool registry).

## 3. Strict Inviolable Rules

1. **NO COMMENTS IN SHIPPED SOURCE**:
   - `cli.js`, `bridge/`, `mcp/`, and `extension/` must contain NO commentary. Only pragmas (`prettier-ignore`, `eslint-*`, `@ts-*`, shebang) are allowed.
   - Enforced by `local/shipped-source-has-no-comments` in `eslint.config.js`.
   - `scripts/` and `tests/` are exempt and should be commented normally.
2. **AGENT READING BUDGET CEILING**:
   - Total characters handed to an agent at connect (core tool descriptions + parameter describes + instructions) is strictly capped at `AGENT_TEXT_BUDGET = 18,800` characters.
   - Any addition must be funded by deletion or deliberate owner approval. Enforced by Gate 4 in `preflight.mjs`.
3. **CLEAN BREAK V2 (NO LEGACY ALIASES)**:
   - Addressing is ONE parameter: `target`. Never accept or introduce silent rewriting from `ref`, `selector`, `text`, `index`, `placeholder`.
   - Removed tools from v0.7 are unknown tools (no shims).
4. **GIT & REPO HYGIENE**:
   - DO NOT commit changes to git unless explicitly instructed by the user.
   - DO NOT push or sync changes to the public mirror (`~/Documents/browserctl`) without explicit owner directive.

## 4. Documentation & Ground Truth

- **Design Spec & Architectural History**: `docs/tool-surface-design-v2.md` (Contains the authoritative target resolution rules, tool design, and revision log).
- **Human Parameter Reference**: `docs/REFERENCE.md` (Exhaustive dictionary of all core tool parameters).
- **Surface Inventory**: `docs/TOOLS.md` (Generated catalog of all 69 tools across profiles).
- **Contributing Conventions**: `CONTRIBUTING.md` (Detailed rationale for all repo gates).
