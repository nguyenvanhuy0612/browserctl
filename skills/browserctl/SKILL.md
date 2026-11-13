---
name: browserctl
description: Drive real Chrome browser profile via browserctl MCP and CLI for web automation, testing, and extraction.
---

# browserctl

browserctl lets an AI agent observe and interact with a live Chrome browser via DOM and accessibility snapshots.

## The Observe-Act Loop

1. **Observe**: Take a snapshot to read the page and obtain active `@e` element reference tokens:
   `browser_snapshot()` or with subtree target: `browser_snapshot({ target: "@e1" })`.
2. **Act**: Execute an action targeting an exact `@e` ref token:
   `browser_click({ target: "@e5" })` or `browser_type({ target: "@e3", text: "query", submit: true })`.
3. **Verify**: Check the `effect` object in the action response (`domChanges`, `urlChanged`, `controlState`).
   If the DOM mutated significantly, take a fresh snapshot before the next action.

## Targeting Controls

- Prefer exact `@e` tokens (`@e1`, `@e2`) from the most recent snapshot.
- Use explicit prefixes to avoid ambiguity when ref is not yet known:
  `css=#submit`, `text=Save`, `placeholder=Email`.
- On `AMBIGUOUS_TARGET`, pass a narrower target or use the exact `@e` ref token.
- On `STALE_REF`, the element was re-rendered. Call `browser_snapshot()` to refresh refs.

## Structured Extraction vs Snapshot

- Use `browser_snapshot` to understand layout, find interactive buttons/inputs, and navigate.
- Use `browser_extract` when reading tabular data, repeated card lists, or structured grids. It returns structured JSON/CSV without polluting the context window with repetitive leaf nodes.

## Safe Action Guidelines

- Check `effect.controlState` after `browser_type` or `browser_fill_form` to confirm values were committed.
- Mutating actions verify effects before returning; do not insert arbitrary fixed sleeps.
- When an action triggers a native browser dialog (`alert`, `confirm`, `prompt`), resolve it with `browser_handle_dialog`.
- Stop and invoke `browser_request_help` when encountering CAPTCHAs, two-factor auth prompts, or destructive irreversible actions without user confirmation.
