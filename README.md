# browserctl

A Chrome/Edge extension + local bridge server + MCP server that lets any AI agent (Claude, Antigravity, Cursor, or scripts) drive a real Chromium browser through a neutral HTTP/WebSocket API.

> [!WARNING]
> **Safety & Isolation Disclaimer:**
> `browserctl` grants AI agents full programmatic control over browser DOM, forms, cookies, and network requests.
> - **DO NOT USE ON YOUR PRIMARY PERSONAL BROWSER PROFILE** (e.g. personal profiles containing saved banking credentials, password managers, or private data).
> - **STRONGLY RECOMMENDED**: Run `browserctl` in a dedicated, isolated browser profile, an open-source **Chromium test build** (e.g. Ungoogled Chromium / raw Chromium), or an isolated sandbox/testing browser instance.

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
        "BROWSERCTL_MCP_PROFILE": "core" // 'core' (35 tools) or 'all' (all 80)
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
npm install -g browserctl-mcp
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

## CLI Reference & AI Agent Guide (`browserctl`)

`browserctl` is executable globally and can be invoked directly from anywhere in the terminal or by AI agents via `node cli.js`. Global flags (such as `--tab <id>`, `-c|--compact`, `--json`, `--pretty`) can appear at any position in the command line.

### Quick Cheatsheet

| Task | Command | Description |
| :--- | :--- | :--- |
| **Inspect UI** | `browserctl snapshot -c` | Compact viewport interactive DOM with Key Inputs section & smart feed folding |
| **Full DOM** | `browserctl snapshot --all` | Capture entire page DOM (including offscreen elements) |
| **Click** | `browserctl click @ref_X` | Mouse click on ref, text, ARIA role, or custom element (`*-*`) |
| **Type / Fill** | `browserctl fill @ref_X "text"` | Fast native fill on input/textarea (emits candidate refs if not editable) |
| **Keystroke** | `browserctl press Enter` | Dispatch key press (e.g. `Enter`, `Tab`, `Escape`) |
| **Scroll** | `browserctl scroll down [px] [target]` | Scroll page or container (smart nested container detection) |
| **Dismiss** | `browserctl dismiss [target]` | Close active modal, drawer, or flyout (Escape or close button) |
| **Read Text** | `browserctl get text @ref_X` | Extract visible text or value of target ref |
| **Count Items** | `browserctl get count <selector>` | Fast CSS selector census (e.g. `'button'`, `'a[href]'`) |
| **Tabs** | `browserctl tab list` | List all open tabs (aliases: `tabs`, `tab switch <id>`, `switch <id>`) |
| **Wait** | `browserctl wait [--settle|--auto]` | Wait for DOM mutations and animations to settle (ideal for SPAs) |
| **Network Idle** | `browserctl wait --network-idle [--tolerance 1]` | Wait for network quiet period (supports tolerance for persistent sockets) |
| **Eval JS** | `browserctl eval <expr> [-r]` | Evaluate JavaScript (auto-bypasses CSP and Trusted Types via CDP) |

### Command Catalog by Functional Group

For deep parameters, protocol schemas, and examples, refer to [docs/REFERENCE.md](docs/REFERENCE.md) and [PROTOCOL.md](PROTOCOL.md):

- **Navigation & Tab Control** ([REFERENCE.md](docs/REFERENCE.md)):
  `open <url>`, `reload`, `back`, `forward`, `tab list` (alias: `tabs`), `tab switch <id>` (alias: `switch`), `tab new [url]`, `tab close [id]`.
- **Page Inspection & Property Extraction** ([REFERENCE.md](docs/REFERENCE.md)):
  `snapshot [-c|--compact] [--all]` (DOM tree with `@ref_N` markers, Key Inputs & Search Fields block, active drawer alert, smart feed folding, and Quick Actions footer), `read_page`, `get text <target>` (alias: `get_text`), `get value <target>`, `get attr <target> <name>`, `get count <selector>` (alias: `get_count`), `find <query>`, `get title`, `get url`, `get html`, `get box`.
- **Physical User Interaction** ([REFERENCE.md](docs/REFERENCE.md)):
  `click <target>` (standard, custom elements `*-*`, and ARIA roles), `dblclick <target>`, `fill <target> "text"` (with candidate input recovery hints), `type <target> "text"`, `paste <target> "text"`, `clear <target>`, `press <key>`, `dismiss [target]`, `check <target>`, `uncheck <target>`, `select <target> <val>`, `hover <target>`, `focus <target>`, `scroll <down|up> [px] [target]`, `scrollintoview <target>`.
- **Synchronization & Waiting**:
  `wait [--settle|--auto]` (default: waits for DOM mutations and CSS/JS animations to settle), `wait --network-idle [--tolerance N]`, `wait <target>`, `wait --text "..."`, `wait <ms>`.
- **Capture, Export & JavaScript**:
  `screenshot [file.png] [-f]`, `pdf [file.pdf]`, `eval <js_expr> [-r]` (automatic CDP Runtime fallback on CSP / Trusted Types errors).
- **CDP & Network Diagnostics** ([PROTOCOL.md](PROTOCOL.md)):
  `cdp_attach`, `cdp_detach`, `cdp_send`, `get_console_logs`, `get_network_requests`, `export_har`.

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

### Dynamic Tool Discovery & Profile Management
AI agents can dynamically load and unload specialized tool categories into the active session without restarting the server:

* `browser_load_tools`: Load a category (`"network"`, `"cdp"`, `"cookies"`, `"storage"`, `"console"`, `"record"`, `"tabs"`, `"advanced"`, `"all"`) or specific tools directly into the prompt.
* `browser_unload_tools`: Unload extra tools and reset back to the lightweight `"core"` profile to free system prompt tokens.
* `browser_list_available_tools`: Check which tool categories are currently active vs available for loading.

### MCP Core Tools

| Tool | Description |
|---|---|
| `browser_click` | Click element by ref/index/selector/text across standard tags, ARIA roles, and custom Web Components |
| `browser_fill` | Fill input or rich-text editor (with recovery hints suggesting candidate inputs on mismatch) |
| `browser_paste` | Paste large text/Markdown via Clipboard events without AST corruption |
| `browser_type` | Focus element and set text (React/Vue `v-model` compatible) |
| `browser_snapshot` | Primary inspection tool (preserves Key Inputs block at top, folds dense feeds, saves 75-85% tokens) |
| `browser_get_text` | Extract visible innerText from element by selector, ref, or index (no eval_js needed) |
| `browser_get_attribute` | Read specific DOM attribute (href, aria-label, src, etc.) from target element |
| `browser_get_count` | Fast element census count matching CSS selector across page and open Shadow DOM |
| `browser_describe_element` | Inspect element tag, attributes, bounding box, and actionability visibility |
| `browser_dismiss_modal` | Dismiss active modal, side drawer, or flyout (clicks close or sends Escape) |
| `browser_wait_settle` | Wait for DOM mutations & animations to settle (ideal for SPAs with active WebSockets) |
| `browser_read_page` | Accessibility tree inspection |
| `browser_get_page_content` | Extract article or documentation text (prose only, not for app UI or headers) |
| `browser_screenshot` | Viewport or full-page screenshot (lossless PNG or vision-optimized JPEG) |
| `browser_eval_js` | Evaluate JavaScript in page context (auto-bypasses CSP & Trusted Types via CDP) |
| `browser_load_tools` | Dynamically load tool categories (`cdp`, `network`, `cookies`, etc.) into prompt |
| `browser_unload_tools` | Unload extra tools and reset active prompt back to core profile |
| `browser_list_available_tools` | List all tool categories and active status |
| `browser_start` | Start bridge daemon in background if stopped |
| `browser_stop` | Stop bridge daemon (records explicit stopped state) |
| `browser_status` | Check bridge health, daemon state, extension connection |

### Output Format Parameter

Tools that return structured data (`browser_snapshot`, `browser_eval_js`, `browser_status`, `browser_list_available_tools`)
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

Working, **v0.6.1**, 80 MCP tools over 81 bridge actions. Control parity with the official
"Claude in Chrome" surface (open): DOM-index + accessibility-tree (`read_page`) reads with
stable refs, ref/coordinate interaction, background-tab control, screenshots (incl.
background tabs), console/network/HAR capture, record/replay, and tab grouping. Reads and
interaction pierce open shadow DOM and cover iframes (including cross-origin) via
all_frames injection with frame-qualified refs.

**0.6.0 is an agent-accuracy release.** Every census row now carries the name Chrome itself
computes for that control — measured at 100% of Chrome's named controls on github.com,
booking.com and news.ycombinator.com, against 71-89% before. Actions report whether the
control's own state actually moved, not just that the DOM churned. Reads say what they left
out, and name the kind of thing it was.

Tests: 83/83 unit, 70/70 e2e, 19/19 multi-frame e2e, 12/12 editor insertion, 9/9 label
parity, 59 of 61 commands exercised, 0 unexpected failures on a whole-surface audit
against live sites.

Docs:

- **`CHANGELOG.md`** — what changed in this release and why, with the measurements.
- `skills/browserctl/SKILL.md` — an optional Claude Code skill stub describing browserctl in
  task language ("drive a real tab in the background", "a logged-in session"). Symlink it into
  `~/.claude/skills/` if you want browserctl reached by intent rather than by tool name; on a
  machine with a competing browser skill installed, that is the difference between being used
  and being ignored.
- **`docs/REFERENCE.md`** — the operator's guide: install, control model, every tool
  grouped with its params, recipes, failure modes, the foreground-input matrix. Start here.
- `PROTOCOL.md` — wire-level command spec and per-version changelog.
- `docs/prior-art.md` — how this compares to similar projects, and the positioning
  decision (general-purpose browser control, explicitly not test automation).
- `docs/backlog-capability-gaps.md` — the five tracked gaps, with verified CDP surfaces.
- `docs/debugger-policy.md` — which commands need `chrome.debugger` (45 of 65 never do),
  what a per-site denial would cost, and the single chokepoint to enforce it at.
- `docs/fix-plan-v2-verified-2026-09-08.md` — the evidence base for 0.6.0: 69 findings from
  driving browserctl with fresh-context agents on live sites, each with its repro and how it
  was verified. Read §19-§20 first if you want the method rather than the list.

## Testing

End-to-end tests drive the live stack (bridge -> extension -> Chrome) by POSTing
real commands against a controlled page the runner serves over http:

```bash
# bridge must be running and the extension connected
node tests/e2e/run.mjs                    # 70 checks; never steals focus
E2E_FOREGROUND=1 node tests/e2e/run.mjs   # + the 2 synthetic-input tests (steals focus)

# multi-frame regression suite: landmark grouping, key-input hoisting, repetitive-run
# folding, duplicate-link suppression, long-label truncation hints, an open-but-not-
# blocking dialog, a React-portal (zero-size wrapper) panel, and a menuitemradio menu —
# all against a page with a same-origin iframe, so the compact-view MERGE path (not just
# the single-frame content script) is exercised. SKIPs cleanly (exit 0) if the bridge or
# extension isn't available.
node tests/e2e/run_multiframe.mjs

# insertion and activation must each happen EXACTLY ONCE. Varies the two things that
# change the outcome: whether the editor handles the event, and whether it commits
# synchronously. Facebook's Lexical composer is the case that catches a fix verified
# against Gmail alone.
node tests/e2e/run_editors.mjs

# bridge relay only, no Chrome needed (~0.5s, safe alongside a live bridge)
node --test tests/unit/bridge.test.mjs

# whole-surface audit against ANY live site: calls every read-only action and reports
# unexpected failures separately from the ones that are the tool doing its job (waiting
# for absent text, reading a capture that was never started).
node tests/e2e/audit_tools.mjs https://github.com/microsoft/vscode/issues complex
node tests/e2e/audit_tools.mjs https://example.com simple

# ground-truth coverage: takes `snapshot --all` as truth, then checks every sampled
# element is reachable by find() and readable by get_text, and that the viewport census
# discloses what it withheld.
node tests/e2e/coverage_check.mjs https://news.ycombinator.com hn
```

Run the audit against a site you care about after touching the census, the dispatch table
or a tool description. The bar is **zero unexpected failures** — the first run of it found
23 of 42 calls failing on a complex page.

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
