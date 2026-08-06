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

## Setup

### 1. Bridge server

```bash
cd bridge
npm install
npm start          # listens on http://localhost:8765
```

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions` on Microsoft Edge)
2. Enable **Developer mode** (top right)
3. **Load unpacked** -> select the `extension/` folder
4. Click the extension icon and press **Connect** in the popup.

A freshly installed extension stays idle and makes no connection attempt (so a
not-yet-started bridge produces no console error). The first time you press
**Connect** and it succeeds, the extension remembers it and auto-reconnects on
later browser starts. After that it keeps trying with capped exponential backoff
(up to 30s between tries) and **never permanently gives up** on a transient
outage — restart the bridge and the extension re-links on its own, no manual
Connect needed. A `chrome.alarms` keepalive resumes reconnect even after the
MV3 service worker is recycled. Only an explicit **Disconnect** stops the loop.
When both are running, the popup reads **Connected**.

While connected, the bridge sends an application-level heartbeat ping every ~20s.
Receiving it resets the MV3 service-worker idle timer, so the socket stays
genuinely open instead of dropping on an idle gap; the extension's pong lets the
bridge drop a dead link promptly. The keepalive alarm is then only a fallback.

Works on any Chromium browser (Chrome, Edge). The host/port the extension dials
is configurable on the extension's **options page** (popup -> "Open settings",
or the Extensions page -> Details -> Extension options) and stored in
`chrome.storage`; the service worker reconnects automatically on change.

## Using it from Claude Code (MCP)

The `mcp/` server exposes the browser as native tools (`browser_snapshot`,
`browser_navigate`, `browser_click`, ...) for any MCP client. This is the
recommended path for Claude Code / Claude Desktop.

On connect, the server sends a set of **operating instructions** (surfaced to the
model by the MCP client) that make every agent follow the same control model:
pin one target tab, group it, and act on it **in the background** — never switch
or foreground the user's current tab unless a step genuinely can't run in the
background or the user asks. So while you keep working in your own tab (say
GitLab), the agent drives its tab (say LinkedIn) without disturbing you.

```bash
cd mcp
npm install
# Register with Claude Code (run from anywhere; use the absolute path to mcp/index.js on this machine):
# Windows:
claude mcp add browserctl -- node "C:/path/to/browserctl/mcp/index.js"
# macOS:
claude mcp add browserctl -- node "/path/to/browserctl/mcp/index.js"
```

Or add it to a project's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "browserctl": {
      "command": "node",
      "args": ["/absolute/path/to/browserctl/mcp/index.js"],
      "env": { "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765" }
    }
  }
}
```

The bridge server (`bridge/ npm start`) and the extension must be running; the MCP
server is a thin stdio wrapper that POSTs to the bridge. Typical Claude Code use:
"snapshot the page, then click the login button" -> Claude calls `browser_snapshot`,
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
  control. Keep the host at the `127.0.0.1` default.
- **`get_cookies` reads cookies for the whole browser profile** (all sites), not just the
  target tab. There is no redaction on network/HAR/cookie output — headers (incl.
  `Cookie` / `Authorization`) come back verbatim, which is the point for a local debug tool.

**Prompt injection still applies.** A web page can embed hidden text that tries to
hijack whatever agent is driving the browser (the same risk the official Claude in
Chrome documents). No login removes that risk. When pointing an agent at untrusted
pages, keep a human in the loop for anything destructive or sensitive.
