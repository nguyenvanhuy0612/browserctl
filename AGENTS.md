# AGENTS.md

browserctl is being rebuilt from scratch. Read `specs/README.md` before touching anything.

- Spec first: no code, parameter, result field or error code without an approved spec in `specs/`.
- The owner approves the high level (architecture, tool list); technical specs are approved by the
  agent after an independent review. See `specs/README.md`.
- Tests carry the spec's test IDs (`CLICK-U01`) in their names.
- Reuse Playwright as a library and adopt its test cases by ID; do not hand-write what it already
  does. Design the rest fresh. The previous implementation is archived outside this repository; do not copy its
  structure, names or style. Tool names carry no prefix (`click`, not `browser_click`).
- Throwaway experiments live in `temp/` (git-ignored). `temp/spike/` holds the relay spike that
  the architecture is based on.
- Owner only: `git commit`, `git push`, publishing, and version numbers.
