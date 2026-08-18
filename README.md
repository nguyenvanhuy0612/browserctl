# browserctl

A Chrome extension + local bridge server that lets any AI agent (Claude, GPT, or a
plain script) drive a real Chrome browser through a neutral HTTP/WebSocket API.

## How it works

```
Agent (Claude / GPT / your script)
      │  HTTP REST  +  WebSocket
      ▼
Bridge server (Node, runs on localhost)   <- relay, no build step
      │  WebSocket
      ▼
Chrome extension (Manifest V3)
   ├─ background.js  (service worker: WS client, command dispatch, target-tab pinning)
   ├─ content.js     (DOM reads + accessibility tree/refs, clicks/types/scrolls)
   └─ cdp.js         (opt-in chrome.debugger: coordinate input, background screenshots, console/network/HAR)
```

The agent never talks to Chrome directly. It POSTs a command to the bridge; the
bridge relays it to the extension over WebSocket; the extension runs it and the
result travels back the same path.

Control is **DOM-first**: the extension reads the page — interactive elements with an
**index** (`snapshot`), or the accessibility tree with stable **refs** (`read_page`) —
and the agent acts by ref/index ("click ref_5", "type into 8"). No `chrome.debugger`, so
no "is being debugged" banner. It **drops to CDP** (`chrome.debugger`) only where the DOM
can't reach: pixel-coordinate clicks on canvas/WebGL/maps, screenshotting a background
tab, console/network/HAR capture, and CSP-bypass JS eval.

The agent **pins one target tab on first use** and keeps acting on it — including DOM
interaction and screenshots while that tab sits in the **background** — so you can keep
using your other tabs without the agent following you or stealing focus. `group_tab` puts
the controlled tab in a labelled tab group so you can see which one it is. This mirrors the
official "Claude in Chrome" control model, kept **open** (no blocklist / org-lock /
per-action gating) with the agent driven externally over MCP/HTTP.

**One exception to background operation:** Chrome delivers CDP *synthetic input* only to a
foreground tab, so `coordinate_click`, `coordinate_drag`, and `press_key` **with
modifiers** cannot work on a hidden tab — they now fail with an actionable error instead of
silently doing nothing. Everything else, including every DOM action and every screenshot,
genuinely works in the background. See `docs/REFERENCE.md` for the full matrix.

## Quickstart & Installation

### 1. Install & Configure MCP (Zero-Setup via NPX)

You can run `browserctl` directly without cloning the repository.

#### For Claude Desktop / Antigravity / Cursor / Windsurf (`.mcp.json`)

Add `browserctl` to your MCP configuration:

```jsonc
{
  "mcpServers": {
    "browserctl": {
      "command": "npx",
      "args": ["-y", "browserctl-mcp"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core" // 'core' (~24 tools) or 'all' (all 70+ tools)
      }
    }
  }
}
```

#### For Claude Code CLI

```bash
claude mcp add browserctl -- npx -y browserctl-mcp
```

#### Global CLI Installation

To use the `browserctl` command from anywhere in your terminal:

```bash
npm install -g browserctl
```

---

### 2. Load the Chrome Extension

1. Open `chrome://extensions` (or `edge://extensions` on Microsoft Edge)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** -> select the `extension/` folder
4. Click the extension icon in Chrome toolbar and press **Connect** in the popup.

> **Auto-Reconnect & Keepalive**: Once connected, the extension remembers the link and automatically reconnects on browser startup. Only an explicit **Disconnect** in the popup stops reconnection.

---

### 3. Bridge Daemon & Zero-Terminal Execution

**No manual terminal needed**: When an MCP client launches or when you run any `browserctl` CLI command, the local bridge daemon is started **automatically in the background**.

You can also manage the daemon explicitly:

```bash
browserctl status                         # Check bridge health, daemon state & extension
browserctl start                          # Start bridge daemon in background
browserctl stop                           # Stop bridge daemon (records explicit stopped state)
browserctl restart                        # Restart bridge daemon
```

**State Machine (Docker/Tailscale Model)**:
- If you explicitly ran `browserctl stop`, subsequent commands will NOT auto-start the daemon unexpectedly; they prompt you to run `browserctl start` (or pass `--auto-daemon`).
- To disable auto-start globally, set `BROWSERCTL_AUTO_START=manual`.

---

## CLI Reference (`browserctl`)

```bash
# Navigation & History
browserctl open https://github.com        # Navigate target tab (alias: navigate)
browserctl back | forward | reload        # History navigation

# Inspection & Fast Property Queries (get)
browserctl snapshot --compact             # Token-efficient DOM snapshot (saves 75% tokens)
browserctl read_page                      # Read accessibility tree with refs
browserctl get title                      # Get page title
browserctl get url                        # Get page URL
browserctl get text @e1                   # Get visible text of element
browserctl get value @e1                  # Get input/textarea value
browserctl get attr @e1 href              # Get element attribute
browserctl get box @e1                    # Get bounding box (x, y, width, height)
browserctl get count "button"             # Count matching elements

# Interaction & Form Utilities
browserctl click @e1                      # Click by ref (@e1, ref_1, 0)
browserctl click --text "Sign In"         # Click by visible text
browserctl fill @e1 "my query"            # Clear input and fill text (React/Vue v-model compatible)
browserctl paste @e1 "markdown content"   # Paste multi-line text into inputs or rich-text editors (ProseMirror/Tiptap)
browserctl type @e2 "appended text"       # Type into input field
browserctl clear @e1                      # Clear input field
browserctl check @e3                      # Check checkbox / radio button
browserctl uncheck @e3                    # Uncheck checkbox
browserctl select @e4 "value"             # Select dropdown option
browserctl hover @e1                      # Hover element
browserctl focus @e1                      # Focus element
browserctl scroll down 400                # Scroll page

> **Form & Rich-Text Compatibility**: `fill`, `type`, and `paste` inject values instantly via native prototype setters (fully compatible with React/Vue `v-model`) and seamlessly handle rich-text `contenteditable` editors (ProseMirror, Tiptap, Quill, Lexical). When multiple forms coexist on a page, always target elements by their stable `@ref` from `snapshot` to avoid selector ambiguity.

# Synchronization & Timing
browserctl wait 2000                      # Sleep for 2000 ms
browserctl wait @e1                       # Wait for element to appear
browserctl wait --text "Welcome"          # Wait for text to appear
browserctl wait --network-idle            # Wait for network idle
browserctl wait --settle                  # Wait for DOM mutations to settle

# Capture, Export & JavaScript
browserctl screenshot page.png [-f]       # Capture viewport or fullpage screenshot to file
browserctl pdf document.pdf               # Print page to PDF file directly
browserctl eval -r "document.title"       # Run JS and output raw value to stdout
browserctl tab [list|new|switch|close]    # Manage browser tabs
```

### Output Formatting

By default, CLI output uses a **smart format** optimized for both humans and AI agents:
scalar queries return direct values, tab lists render as ASCII tables, and snapshots
use the compact DOM tree view.

Override with explicit flags when needed:

| Flag | Description | Use Case |
|---|---|---|
| *(none)* | Smart default (token-efficient, zero info loss) | AI agent interaction, general use |
| `-r` / `--raw` | Raw unformatted value, no trailing newline | Shell piping: `URL=$(browserctl get url -r)` |
| `--json` | Compact single-line JSON | Automated script parsing |
| `--pretty` | 2-space indented JSON | Human inspection, debugging |

```bash
browserctl get title               # -> Example Domain
browserctl get title -r            # -> Example Domain  (no newline, perfect for piping)
browserctl get title --json        # -> {"property":"title","value":"Example Domain"}
browserctl get title --pretty      # -> { "property": "title", "value": "Example Domain" }
browserctl tabs                    # -> clean ASCII table
browserctl tabs --json             # -> {"tabs":[...]}
```

## Using it via Model Context Protocol (MCP)

The `mcp/` server exposes browser automation tools for MCP clients (Antigravity, Claude Code, Cursor, Windsurf).

### Token Optimization & Profiles
By default, `browserctl` runs with `BROWSERCTL_MCP_PROFILE="core"` which exposes ~24 core tools plus `browser_action` (a universal dispatcher tool), saving ~10,000 system prompt tokens. To register all 70+ granular tools, set `BROWSERCTL_MCP_PROFILE="all"`.

### MCP Core Tools

| Tool | Description |
|---|---|
| `browser_click` | Click element by ref/index/selector/text (supports `waitFor` selector) |
| `browser_fill` | Fill input or rich-text editor (ProseMirror/Tiptap/Vue/React) |
| `browser_paste` | Paste large text/Markdown via Clipboard events without AST corruption |
| `browser_type` | Focus element and set text (React/Vue `v-model` compatible) |
| `browser_snapshot` | Fast token-efficient DOM snapshot with stable refs |
| `browser_read_page` | Accessibility tree inspection |
| `browser_screenshot` | Viewport or full-page screenshot (lossless PNG or vision-optimized JPEG) |
| `browser_eval_js` | Evaluate JavaScript in page context |
| `browser_start` | Start bridge daemon in background if stopped |
| `browser_stop` | Stop bridge daemon (records explicit stopped state) |
| `browser_status` | Check bridge health, daemon state, extension connection |

### Output Format Parameter

Tools that return structured data (`browser_snapshot`, `browser_eval_js`, `browser_status`)
accept an optional `format` parameter (`"smart"` default, `"json"`, `"pretty"`, `"raw"`).

```jsonc
{
  "mcpServers": {
    "browserctl": {
      "command": "npx",
      "args": ["-y", "browserctl-mcp"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core"
      }
    }
  }
}
```

The bridge daemon auto-starts when the MCP server boots. The extension must be
installed and connected in Chrome. Typical agent use:
"snapshot the page, then click the login button" -> Agent calls `browser_snapshot`,
reads the indexed elements, then `browser_click`.

## Using it from any other agent (raw HTTP)

Send commands as JSON over HTTP. See `PROTOCOL.md` for the full list.

```bash
# Take a snapshot of the current page (interactive elements + text)
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"snapshot"}'

# Navigate
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'

# Click the element that snapshot labeled index 3
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"click","params":{"index":3}}'
```

A typical agent loop: `snapshot` -> reason about the returned element list ->
issue `click` / `type` / `scroll` / `navigate` -> `snapshot` again.

## Status

Working, **v0.5**, 65 MCP tools over 64 bridge actions. Control parity with the official
"Claude in Chrome" surface (open): DOM-index + accessibility-tree (`read_page`) reads with
stable refs, ref/coordinate interaction, background-tab control, screenshots (incl.
background tabs), console/network/HAR capture, record/replay, and tab grouping. Reads and
interaction pierce open shadow DOM and cover iframes (including cross-origin) via
all_frames injection with frame-qualified refs.

Tests: 18/18 unit, 62/62 e2e, 58 of 60 commands exercised.

Docs:

- **`docs/REFERENCE.md`** — the operator's guide: install, control model, every tool
  grouped with its params, recipes, failure modes, the foreground-input matrix. Start here.
- `PROTOCOL.md` — wire-level command spec and per-version changelog.
- `docs/prior-art.md` — how this compares to similar projects, and the positioning
  decision (general-purpose browser control, explicitly not test automation).
- `docs/backlog-capability-gaps.md` — the five tracked gaps, with verified CDP surfaces.
- `docs/debugger-policy.md` — which commands need `chrome.debugger` (45 of 65 never do),
  what a per-site denial would cost, and the single chokepoint to enforce it at.

## Testing

End-to-end tests drive the live stack (bridge -> extension -> Chrome) by POSTing
real commands against a controlled page the runner serves over http:

```bash
# bridge must be running and the extension connected
node tests/e2e/run.mjs                    # 62 checks; never steals focus
E2E_FOREGROUND=1 node tests/e2e/run.mjs   # + the 2 synthetic-input tests (steals focus)

# bridge relay only, no Chrome needed (~0.5s, safe alongside a live bridge)
node --test tests/unit/bridge.test.mjs
```

It creates a dedicated tab, exercises nearly all commands (all but `focus_window` and
`reload_extension`, which steal focus / drop the connection), asserts behaviour
including the framework-safe value setter, ref-addressed element screenshots,
shadow-DOM reads, and history navigation, then closes the tab and prints a
pass/fail + coverage report. After editing extension code, reload it
(`chrome://extensions` -> reload, or the `reload_extension` command) before
re-running so the test hits the new code.

## Security

**This is a single-user, internal tool.** It runs on my own machine, driven by my
own agent, and is not meant to be shared, exposed, or run on a multi-user host. The
security model is deliberately "trusted local machine": there is **no auth and no
access control**, by design. The hardening items below are known and **intentionally
not implemented** — none of them affect the MCP/HTTP functionality, so for a
single-user setup they buy nothing. If this project is ever shared or moved off a
trusted machine, revisit them first.

Known, accepted risks (single-user only):

- **Any web page you visit can reach the bridge.** The bridge binds `127.0.0.1`, but
  a page you browse can `fetch("http://127.0.0.1:8765/command", ...)` as a no-preflight
  "simple" request (or open `ws://127.0.0.1:8765/extension`) and issue commands to your
  browser. Localhost binding does not stop same-machine web content; only an `Origin`
  allowlist + shared token would, and neither is implemented.
- **The extension↔bridge link is unauthenticated cleartext ws**, and the bridge host is
  user-configurable on the options page. Whatever answers on that socket gets full browser
  control. Keep the extension host set to `127.0.0.1` so Chrome talks to the local bridge.
- **Listening on `0.0.0.0` by default** allows HTTP requests (e.g. from an MCP client on another LAN machine) to reach the bridge. If running on an untrusted network, override via `HOST=127.0.0.1 npm start` or firewall port 8765 accordingly.
- **`get_cookies` reads cookies for the whole browser profile** (all sites), not just the
  target tab. There is no redaction on network/HAR/cookie output — headers (incl.
  `Cookie` / `Authorization`) come back verbatim, which is the point for a local debug tool.

**Prompt injection still applies.** A web page can embed hidden text that tries to
hijack whatever agent is driving the browser (the same risk the official Claude in
Chrome documents). No login removes that risk. When pointing an agent at untrusted
pages, keep a human in the loop for anything destructive or sensitive.
