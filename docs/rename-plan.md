# Rename record: unified on `browserctl`

Executed 2026-08-04. The project previously ran three names in parallel — a repo
directory name, a different MCP server key, and a third internal identifier prefix.
All three are now one.

| Layer | Value |
|---|---|
| Repo directory | `browserctl` |
| MCP server key in `~/.claude.json` | `browserctl` |
| Internal identifier prefix | `bctl` |
| Package names | `browserctl-bridge`, `browserctl-mcp` |
| Extension display name | `browserctl` |
| MCP tool prefix | `browser_` — deliberately unchanged |

The old names and the full file-by-file checklist are in git history; this file keeps
only what is still useful.

## Why these choices

- **`browserctl`** says what it is, reads as a tool rather than a product, does not
  imply testing (see the positioning decision in `prior-art.md`), and does not collide
  with `bridge`, which already names a component here.
- **`bctl`** is short enough for DOM attributes and `chrome.storage` keys.
- **The `browser_` tool prefix was left alone.** It matches playwright-mcp and
  chrome-devtools-mcp convention, and renaming 64 tools would break every prompt,
  skill, and doc that references them. Project name and tool prefix do not need to
  match; `mcp__browserctl__browser_click` is unambiguous.

Timing note: the rename was free because nothing outside the project referenced the
old MCP server key and no `settings.json` permission allowlist mentioned it. That
stops being true as soon as a skill or an allowlist entry does, so a future rename
would cost more.

## The step this plan originally missed

**Moving the directory breaks the unpacked extension, and Reload cannot fix it.**
Chrome registers an unpacked extension by *absolute path*. Renaming the repo
directory invalidates that registration: the extension dies, and pressing Reload
fails because the source directory is gone. Observed here as a bridge log line
`extension disconnected` at the moment Reload was pressed, with no reconnect and a
five-minute wait that timed out.

The fix is a fresh **Load unpacked** from the new path, with two consequences:

- The extension gets a **new extension ID**.
- `chrome.storage` starts empty, so the bridge host returns to the `127.0.0.1:8765`
  default and the remembered-Connect flag is gone — the popup stays idle until
  **Connect** is pressed once. That idle-until-Connect behaviour is by design.

**This will recur on every machine that loaded the extension unpacked from the old
path.** On the Windows 11 machine, after pulling this rename, the extension
registered under the old directory will break identically and needs the same re-load
from `.../claude/browserctl/extension`.

## Lockstep identifier pairs

Four categories of identifier are split across files, so renaming one half silently
breaks behaviour rather than failing loudly. Worth knowing for any future rename:

1. **Runtime message names** between `popup.js`, `background.js`, and `content.js`.
   Miss one and the popup's Connect button stops working with no error.
2. **`chrome.storage` keys** in `cdp.js`, `background.js`, and `netlog.js`. Renaming
   these orphans existing values — including the list of tabs holding a debugger, so
   the extension forgets to detach and the "is being debugged" banner sticks until
   each tab is closed. Detach everything *before* renaming these.
3. **The tab-group default title** in `background.js`, mirrored in the tool
   description text in `mcp/index.js`. Change one and the docs drift from the code.
4. **The e2e console marker** in `tests/e2e/testpage.html`, asserted as a literal in
   `tests/e2e/run.mjs`.

Also not purely internal: the ref attribute stamped on page elements is observable in
the DOM of pages under automation, and the HAR `creator.name` written by `cdp.js` is
embedded in every exported HAR file.

## Deviations from the plan as written

- `BRIDGE_URL` was not replaced outright. `mcp/index.js` and `tests/e2e/run.mjs` now
  read `BROWSERCTL_BRIDGE_URL || BRIDGE_URL || default`, so older configs keep working.
- Versions stayed at 0.4.0. A rename is not a protocol change, and `PROTOCOL.md`
  versions the three components together.

## Verification performed

- `node --check` on all seven extension/bridge/MCP JS files; all three JSON files
  parse and carry the new names.
- All four lockstep pairs confirmed changed on both sides.
- Repo-wide grep for the old identifiers returns nothing.
- Bridge restarted from the new path, logs `browserctl-bridge@0.4.0`, extension
  reconnected.
- MCP server boots from the new path and prints the new banner; tools resolve as
  `mcp__browserctl__browser_*`.

A rollback copy of the pre-rename global config is at
`~/.claude.json.bak-20260804-125243`. It still contains the old directory path, by
design — sanitising it would defeat its purpose.
