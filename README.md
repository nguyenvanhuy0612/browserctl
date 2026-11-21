# browserctl

[![npm](https://img.shields.io/npm/v/browserctl-mcp)](https://www.npmjs.com/package/browserctl-mcp)
[![node](https://img.shields.io/node/v/browserctl-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/browserctl-mcp)](LICENSE)

Browser control for AI agents, in the Chrome you already use.

browserctl lets an agent work in your own browser, with your logins, in background tabs of its own.
It drives pages through a browser extension and Playwright's page engine, so most work happens
without Chrome's "started debugging this browser" bar; the debugger is attached only for the few
tasks that need real input, and detached again when they are done.

It ships as an MCP server, a CLI and a local HTTP API, all backed by one daemon.

## Why browserctl

- **Your sessions, not a fresh profile.** Sites you are signed in to stay signed in. No cookies to
  export, no separate browser to log into.
- **Out of your way.** The agent opens its own tabs in the background; your active tab and window
  never change unless the agent is asked to show you something.
- **Quiet by default.** Snapshots, clicks, typing, forms, scrolling and JavaScript run without the
  debugging bar. Real input (`trusted: true`) and Playwright scripts (`run`) use the debugger on
  demand.
- **Built for agents.** Compact accessibility snapshots with stable element refs, Playwright
  locators everywhere, one-call act-then-wait, and every result says what changed: URL, new tabs,
  dialogs, DOM.
- **Tested against Playwright's own cases.** Playwright's click, check, fill, select, keyboard,
  upload, dialog, navigation, wheel, screenshot and selector tests are ported and run through
  browserctl, in each lane they apply to.

## Requirements

- Node.js 22 or later
- Chrome 135 or later, or another Chromium browser (Edge, Brave)
- macOS, Linux or Windows

## Quick start

**1. Install**

```bash
npm install -g browserctl-mcp
```

**2. Load the extension**

```bash
browserctl extension path     # copies the extension to ~/.browserctl/extension and prints the folder
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the folder printed above (`~/.browserctl/extension`, or
   `%USERPROFILE%\.browserctl\extension` on Windows).
3. Open the extension's **Details** and turn on **Allow User Scripts**. This lets `evaluate` run
   on any page, including pages with a strict Content Security Policy, without the debugging bar.

**3. Connect your agent**

Claude Code:

```bash
claude mcp add browserctl -s user -- browserctl-mcp
```

Any other MCP client (Claude Desktop, Cursor, and others):

```json
{
  "mcpServers": {
    "browserctl": { "command": "browserctl-mcp" }
  }
}
```

After upgrading browserctl, run `browserctl extension path` again and click **Reload** on the
extension in `chrome://extensions`.

The MCP server starts the daemon on `127.0.0.1:8765` when it is not running. Ask the agent to call
`status` to confirm the browser is connected; it lists anything left to set up.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connected browsers, setup problems, your tabs, and where the debugging bar comes from |
| `tabs` | List, open, select, close, adopt and release tabs |
| `navigate` | Open a URL, or go back, forward, reload; waits for the page to load |
| `snapshot` | Compact accessibility snapshot with element refs (`e5`) to act on |
| `read` | The page as readable text: headings, paragraphs, full tables, form values |
| `get` | One value from an element: text, value, attribute, property, state or box |
| `click` | Click an element; reports navigation, new tabs, dialogs and DOM changes |
| `hover` | Hover to open menus and tooltips |
| `type` | Replace the text of an input, textarea or rich-text editor |
| `fill_form` | Set several fields at once: text, checkboxes, radios, switches, selects |
| `press_key` | Press a key or chord, on an element or the focused one |
| `scroll` | Scroll the page or a container, or bring an element into view |
| `wait_for` | Wait for text, an element state, a URL or a time |
| `take_screenshot` | Viewport, full page or one element, saved to a file |
| `file_upload` | Attach files to a file input or a custom upload button |
| `handle_dialog` | Choose how `alert`, `confirm` and `prompt` are answered |
| `evaluate` | Run JavaScript in the page |
| `run` | Run Playwright code against the tab (drag, coordinates, routes, cookies, emulation) |
| `network_requests` | The tab's requests, with response bodies on demand |

Every parameter is documented in [docs/TOOLS.md](docs/TOOLS.md).

**Targets.** Element tools take a ref from `snapshot` (`e5`, or `f1e3` inside a frame) or any
Playwright locator: CSS, `text=`, `role=button[name="Save"]`, XPath, plus the shorthands `label=`,
`placeholder=`, `testid=`, `alt=`, `title=` and `name=`. Chain with `>>`, pick with `>> nth=0`.

**Common action options.** `timeout` (seconds to wait for the element), `scroll` (`auto`, `center`
or `none`) and `wait`, which waits for a condition after the action so act-then-wait is one call.

**Tabs and sessions.** Each MCP server process is one session with one current tab, which tools use
when `tab` is left out. Subagents of one client share that session, so each should open its own tab
(`tabs` with `action: "new"`) and pass `tab` on every call; every result names the tab it acted on.

## How it works

```
Agent (MCP) ─┐
CLI         ─┼─ HTTP ─> daemon (Node.js) ── WebSocket ──> extension (MV3) ──> your tabs
Scripts     ─┘          sessions, tab ownership,          DOM lane: Playwright's page engine
                        Playwright for the CDP lane       CDP lane: chrome.debugger relay
```

- **DOM lane (default).** Playwright's injected page script runs inside the extension, in an
  isolated world. It resolves locators, checks that elements are visible, enabled and not covered,
  and dispatches the same event sequence a user would produce. No debugger, no bar.
- **CDP lane (on demand).** With `trusted: true`, for `run`, for background screenshots and for
  response bodies, the extension attaches `chrome.debugger` and the daemon drives the tab with
  `playwright-core`. Input is real (`isTrusted`), and the debugger detaches after 30 idle seconds.
- **Sessions.** Each agent gets its own session and its own tabs; another session's tab is refused
  unless explicitly adopted. Several agents can share one browser.

The full design, with the measurements behind each decision, is in [specs/](specs/) (start with
[specs/architecture.md](specs/architecture.md)). Upgrading from 0.9.x: [CHANGELOG.md](CHANGELOG.md)
maps the old tool names to the new ones.

## CLI

Every tool is also a command, with flags generated from its parameters.

```bash
browserctl tools                                   # every tool and its parameters
browserctl navigate --url example.com
browserctl snapshot
browserctl click --target e5
browserctl evaluate --function "() => document.title"
browserctl daemon status                           # also: daemon start, daemon stop
```

Output is the JSON result; `--pretty` indents it, `--session <name>` picks the session.

## HTTP API

Scripts in any language can call the daemon directly. Each request names its session in a header.
The HTTP API does not start the daemon: run `browserctl daemon start` first, unless an MCP server
already started it. A session ends after 5 minutes without a request (`BROWSERCTL_SESSION_IDLE`)
and frees its tabs.

```python
import json, urllib.request

def call(tool, **params):
    request = urllib.request.Request(
        f"http://127.0.0.1:8765/v1/tools/{tool}",
        data=json.dumps(params).encode(),
        headers={"content-type": "application/json", "x-browserctl-session": "my-script"},
    )
    return json.load(urllib.request.urlopen(request))

call("navigate", url="https://example.com")
print(call("read", main=True)["text"])
```

Every answer is `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", "hint"}}`; the
hint, when present, names the next call to make.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `BROWSERCTL_PORT` | `8765` | Daemon port. When changed, set the same port in the extension's popup. |
| `BROWSERCTL_HOME` | `~/.browserctl` | Sessions, browser aliases, the call log, screenshots, and the extension copy to load. |
| `BROWSERCTL_DETACH_IDLE` | `30` | Seconds without a CDP-lane call before the debugger detaches. |
| `BROWSERCTL_SESSION_IDLE` | `300` | Seconds without a request or heartbeat before a session ends and frees its tabs. |
| `BROWSERCTL_AUTO_START` | | `manual`: clients never start the daemon themselves. |
| `BROWSERCTL_CLOSE_TABS` | | `1`: tabs the session opened are closed when it ends (for example when the MCP server exits). |

## Privacy and security

- The agent acts with your signed-in sessions. Grant it the same trust you would give someone using
  your browser.
- The daemon listens on `127.0.0.1` only and sends nothing anywhere else.
- Every call is logged with its parameters to `~/.browserctl/calls.jsonl` (rotated at 20 MB), so you
  can see what the agent did. Typed text and evaluated code appear there in full.
- Tabs you opened yourself are never touched unless the agent adopts them.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `NO_BROWSER` | The extension is not connected: check that it is loaded and enabled, then call `status`. |
| `USER_SCRIPTS_OFF` | Turn on **Allow User Scripts** in the extension's details, or pass `trusted: true`. |
| `EXTENSION_OUTDATED` | Run `browserctl extension path`, then click **Reload** on the extension in `chrome://extensions`. |
| `DEBUGGER_CANCELED` | Someone pressed Cancel on the debugging bar. Calls without `trusted` still work; `status({allowDebugger: true})` re-enables the debugger. |

## Development

```bash
git clone https://github.com/nguyenvanhuy0612/browserctl
cd browserctl
npm install
npm run build          # extracts Playwright's page script and key table into extension/generated/
```

Load the checkout's `extension/` folder unpacked (so a rebuild and **Reload** pick up your
changes), and register the MCP server from the checkout:

```bash
# macOS / Linux
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)/src/mcp/main.js"
```

```powershell
# Windows (PowerShell)
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)\src\mcp\main.js"
```

Tests and release gates:

```bash
npm test               # unit tests, no browser
npm run test:live      # live tests in Chrome for Testing (run `npx playwright-core install chromium` once)
npm run typecheck
npm run preflight      # every release gate; add -- --live for the live suites
```

The project is spec-first: every behaviour is specified in `specs/`, and every test carries the ID
of the spec row it proves (`CLICK-E01`, or Playwright's own `CL-001`).

## License

[MIT](LICENSE)
