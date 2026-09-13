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

## Two ways in, same capability

Everything browserctl can do is reachable **either** as MCP tools **or** as shell commands. Same bridge,
same extension, same actions — pick whichever your agent can actually run.

| | Use when | First command |
|---|---|---|
| **MCP** | your client speaks MCP (Claude Code/Desktop, Cursor, Windsurf, Antigravity) | configure it below, then call `browser_snapshot` |
| **CLI** | your agent can run shell commands but has no MCP — or you are at a terminal | `browserctl status` |

### No MCP? Start here.

If you can run a shell command, you have the whole tool. No MCP client, no config file, no daemon to
start — the CLI launches the bridge itself on first use.

```bash
# from a clone (no install at all):
node cli.js status
node cli.js snapshot -c

# or without cloning:
npx -y -p browserctl-mcp browserctl status
npx -y -p browserctl-mcp browserctl snapshot -c

# or install once, then just `browserctl` / `bctl`:
npm i -g browserctl-mcp
browserctl status
```

You still need the Chrome extension loaded (step 2 below) — that is what the bridge talks to.

Every MCP tool has a CLI equivalent with the same name minus the `browser_` prefix:
`browser_snapshot` → `browserctl snapshot`, `browser_get_property` → `browserctl get text @ref_1`,
`browser_click` → `browserctl click @ref_1`. The full list is in
[CLI Reference](#cli-reference--ai-agent-guide-browserctl) below; `browserctl --help` prints it too.

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
        "BROWSERCTL_MCP_PROFILE": "core" // 'core' (24 tools) or 'all' (all 68)
      }
    }
  }
}
```

#### For Claude Code CLI

```bash
claude mcp add browserctl -- npx -y browserctl-mcp
```

#### From a clone (local path)

```jsonc
{
  "mcpServers": {
    "browserctl": {
      "command": "node",
      "args": ["/absolute/path/to/browserctl/mcp/index.js"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core"
      }
    }
  }
}
```

#### Global CLI Installation

To use the `browserctl` command from anywhere in your terminal:

```bash
npm install -g browserctl-mcp
```

Tools appear as `mcp__browserctl__browser_*`. In `core` mode, `browser_action` reaches any
protocol action (CDP, cookies, storage, HAR export, recordings) without loading its profile.

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

## The first five minutes

Every task here is the same loop: **orient -> read -> act -> verify**. Four real calls, with the
answers they actually return (CLI on the left of each pair, the MCP tool that does the same thing
named beside it).

**1. Orient** — open a URL and pin the tab (`browser_open_url`):

```console
$ browserctl open https://example.com --json
{"url":"https://example.com/"}
```

**2. Read** — the census: what is on the page and what you can act on (`browser_snapshot`):

```console
$ browserctl snapshot -c --json
{"url":"https://example.com/","title":"Example Domain","scope":"viewport",
 "viewport":{"width":1488,"height":987,"scrollY":0,"scrollHeight":987,"scrollPercent":0},
 "totalElementsCount":1,"offscreenCount":0,"window":{"offset":0,"shown":1,"inScope":1},
 "pageState":{"isBusy":false,"hasActiveModal":false,"activeModalTag":null,"openDialogs":[]},
 "elements":[{"index":0,"ref":"ref_1","tag":"a","text":"Learn more","landmark":"main",
              "inViewport":true,"href":"https://iana.org/domains/example"}],
 "text":"Example Domain This domain is for use in documentation examples ... Learn more",
 "census":"  [@ref_1] <a> \"Learn more\" -> https://iana.org/domains/example",
 "foldedCount":0,"duplicateCount":0}
```

`elements[].ref` is what you act on. `offscreenCount`, `foldedCount` and `duplicateCount` say what
the census left out; `window` says where you are in a paged read (`browser_snapshot({cursor})`
returns the next page). Nothing in the response is advice — it is all page fact.

**3. Act** — click that ref (`browser_click`):

```console
$ browserctl click @ref_1 --json
{"navigated":true,"from":"https://example.com/","to":"https://www.iana.org/help/example-domains",
 "effect":{"measured":false,"urlChanged":true},
 "note":"'click' navigated the page, so the content script running it was replaced and its own
         reply was lost. The action DID run — it was deliberately not retried, because a retry
         could repeat it (e.g. submit twice). Read the new page to see the result; refs from
         before the navigation are gone."}
```

**4. Verify** — every action answers with `effect`: DOM mutations, whether the URL moved, and for
a stateful control whether its own state moved. An action that reports success while `effect`
shows nothing changed has not happened. Then read again — the refs from step 2 died with the old
document.

Two things follow from step 3 that are worth knowing before you hit them: **refs go stale** on
navigation or a re-render (re-read, do not guess), and `browser_eval_js` is the last resort, not
the first — a tool that already answers the question costs fewer tokens and says why when it
fails.

## CLI Reference & AI Agent Guide (`browserctl`)

Three invocations, all identical in behaviour — use whichever is available:

```bash
browserctl snapshot -c                          # installed globally (aliases: bctl)
node cli.js snapshot -c                         # from a clone, nothing installed
npx -y -p browserctl-mcp browserctl snapshot -c # neither
```

The bridge daemon starts itself on the first command; there is nothing to run beforehand and no
terminal to leave open. Global flags (`--tab <id>`, `-c|--compact`, `--json`, `--pretty`) may appear at
any position.

**For an agent:** prefer `-c` (compact) for reads and `--json` when you need to parse the result.
A snapshot answers with the same fields either way — what was left offscreen, what was folded, the
page's structure, any content that only loads on interaction — so nothing is lost by driving the CLI
instead of MCP. The CLI renders those fields as lines under the element listing; `--json` returns
them as fields.

### Quick Cheatsheet

| Task | Command | Description |
| :--- | :--- | :--- |
| **Inspect UI** | `browserctl snapshot -c` | Compact viewport interactive DOM with Key Inputs section & smart feed folding |
| **Full DOM** | `browserctl snapshot --all` | Capture entire page DOM (including offscreen elements) |
| **Click** | `browserctl click @ref_X` | Mouse click on ref, text, ARIA role, or custom element (`*-*`) |
| **Type / Fill** | `browserctl fill @ref_X "text"` | Fast native fill on input/textarea (emits candidate refs if not editable) |
| **Keystroke** | `browserctl press Enter` | Dispatch key press (e.g. `Enter`, `Tab`, `Escape`) |
| **Upload** | `browserctl upload ./report.pdf "Choose file"` | Attach a local file to a file input (walks from a styled label to the hidden input; needs the debugger) |
| **Scroll** | `browserctl scroll down [px] [target]` | Scroll page or container (smart nested container detection) |
| **Dismiss** | `browserctl dismiss [target]` | Close active modal, drawer, or flyout (Escape or close button) |
| **Read Text** | `browserctl get text @ref_X` | Extract visible text or value of target ref |
| **Count Items** | `browserctl get count <selector>` | Fast CSS selector census (e.g. `'button'`, `'a[href]'`) |
| **Tabs** | `browserctl tab list` | List all open tabs (aliases: `tabs`, `tab switch <id>`, `switch <id>`) |
| **Wait** | `browserctl wait [--settle|--auto]` | Wait for DOM mutations and animations to settle (ideal for SPAs) |
| **Network Idle** | `browserctl wait --network-idle [--tolerance 1]` | Wait for network quiet period (supports tolerance for persistent sockets) |
| **Eval JS** | `browserctl eval <expr> [-r]` | Evaluate JavaScript (auto-bypasses CSP and Trusted Types via CDP) |

### Command Catalog by Functional Group

Every tool with its exact parameters, generated from the server's own registry:
[docs/TOOLS.md](docs/TOOLS.md). For prose, protocol schemas, and examples, refer to
[docs/REFERENCE.md](docs/REFERENCE.md) and [PROTOCOL.md](PROTOCOL.md):

- **Navigation & Tab Control** ([REFERENCE.md](docs/REFERENCE.md)):
  `open <url>`, `reload`, `back`, `forward`, `tab list` (alias: `tabs`), `tab switch <id>` (alias: `switch`), `tab new [url]`, `tab close [id]`.
- **Page Inspection & Property Extraction** ([REFERENCE.md](docs/REFERENCE.md)):
  `snapshot [-c|--compact] [--all]` (DOM tree with `@ref_N` markers, a Key Inputs & Search Fields block, and smart feed folding), `read_page`, `get text <target>` (alias: `get_text`), `get value <target>`, `get attr <target> <name>`, `get count <selector>` (alias: `get_count`), `find <query>`, `get title`, `get url`, `get html`, `get box`.
- **Physical User Interaction** ([REFERENCE.md](docs/REFERENCE.md)):
  `click <target>` (standard, custom elements `*-*`, and ARIA roles), `dblclick <target>`, `fill <target> "text"` (with candidate input recovery hints), `type <target> "text"`, `paste <target> "text"`, `clear <target>`, `press <key>`, `dismiss [target]`, `check <target>`, `uncheck <target>`, `select <target> <val>`, `hover <target>`, `focus <target>`, `scroll <down|up> [px] [target]`, `scrollintoview <target>`, `upload <file> [target]`.
- **Synchronization & Waiting**:
  `wait [--settle|--auto]` (default: waits for DOM mutations and CSS/JS animations to settle), `wait --network-idle [--tolerance N]`, `wait <target>`, `wait --text "..."`, `wait <ms>`.
- **Capture, Export & JavaScript**:
  `screenshot [file.png] [-f]`, `pdf [file.pdf]`, `eval <js_expr> [-r]` (automatic CDP Runtime fallback on CSP / Trusted Types errors).
- **CDP & Network Diagnostics** ([PROTOCOL.md](PROTOCOL.md)):
  `cdp_attach`, `cdp_detach`, `cdp_send`, `get_console_logs`, `get_network_requests`, `export_har`.

### Output Formatting

By default, **CLI** output uses a smart format for a human reader: scalar queries return the
bare value, tab lists render as ASCII tables, and a snapshot prints the compact element
listing followed by what it withheld. The **MCP server** answers in compact JSON instead —
`format: "smart"` there gives the same human view.

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

## Releasing

`npm run preflight -- --e2e` runs every pre-release gate: versions, unit tests, the generated
tool surface, doc coverage for every tool and parameter, dead pointers to removed tools, e2e
action coverage, the agent-facing intent index, the npm tarball, and the live end-to-end
suite. See [docs/RELEASING.md](docs/RELEASING.md) — the gates and what each failure means —
before cutting a version.

## Using it via Model Context Protocol (MCP)

The `mcp/` server exposes browser automation tools for MCP clients (Antigravity, Claude Code, Cursor, Windsurf).

### Dynamic Tool Discovery & Profile Management
AI agents can dynamically load and unload specialized tool categories into the active session without restarting the server:

* `browser_load_tools`: Load a category (`"network"`, `"cdp"`, `"cookies"`, `"storage"`, `"console"`, `"record"`, `"tabs"`, `"advanced"`, `"system"`, `"all"`) or specific tools directly into the prompt.
* `browser_list_available_tools`: Check which tool categories are currently active vs available for loading.

Start-up profile: `BROWSERCTL_MCP_PROFILE=core` (default, 24 tools) or `all`.

### The tools

The complete surface — every tool, its exact parameters, and what it returns — is generated
from the running server into **[docs/TOOLS.md](docs/TOOLS.md)**. A release gate fails if that
file and the registry disagree, which is why it is the only list in this repository worth
trusting; a table typed by hand goes stale the first time a parameter is added.

The 24 tools in the default `core` profile, by the step of the loop they belong to:

| Step | Tools |
|---|---|
| **Open** | `browser_open_url`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_reload` |
| **Read** | `browser_snapshot`, `browser_get_property`, `browser_get_page_content`, `browser_find`, `browser_read_page`, `browser_screenshot` |
| **Act** | `browser_click`, `browser_fill`, `browser_upload`, `browser_press_key`, `browser_scroll` |
| **Wait** | `browser_wait_for` |
| **Reach further** | `browser_load_tools`, `browser_list_available_tools`, `browser_action`, `browser_eval_js` |
| **Daemon** | `browser_start`, `browser_stop`, `browser_status` |

### What a tool returns

Compact JSON, always — the same object the bridge produced, with nothing added to it. Every tool
accepts `format` to change that: `pretty` (indented JSON), `smart` (the human-readable rendering
the CLI uses) or `raw` (the bare value). Every tab-scoped tool also accepts `tabId` (spelled
`tab_id` too) to act on a tab other than the pinned one.

An unknown parameter is refused, with the legal set and a did-you-mean, rather than silently
ignored — a silently dropped `format` once cost an agent a whole session of `eval_js`.

The bridge daemon auto-starts when the MCP server boots. The extension must be installed and
connected in Chrome. A typical exchange: `browser_snapshot` -> read the refs -> `browser_click`
-> check the `effect` block -> read again.

## Using it from any other agent (raw HTTP)

Send commands as JSON over HTTP.

**Finding the action you need.** `PROTOCOL.md` gives the wire shape and documents the core actions in
detail, but it is not the index — it details the core actions only. Two complete sources:

- `browserctl --help` lists every command, and each maps to an action of the same name
  (`get text` → `get_property`, `tab list` → `tab`).
- From an MCP client, `browser_action` with no arguments returns the full catalogue.

The bridge itself has no enumeration endpoint: `{"action":"action"}` and
`{"action":"list_available_tools"}` are refused, because those are client-layer names, not page
actions. If you are on raw HTTP with no shell and no MCP client, the two lists above are the reference.

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

Working, **v0.7.1**, 68 MCP tools over 86 protocol actions. Control parity with the official
"Claude in Chrome" surface (open): DOM-index + accessibility-tree (`read_page`) reads with
stable refs, ref/coordinate interaction, background-tab control, screenshots (incl.
background tabs), console/network/HAR capture, record/replay, and tab grouping. Reads and
interaction pierce open shadow DOM and cover iframes (including cross-origin) via
all_frames injection with frame-qualified refs.

Every census row carries the name Chrome itself computes for that control — measured at 100% of
Chrome's named controls on github.com, booking.com and news.ycombinator.com. An action reports
whether the control's own state actually moved, not just that the DOM churned. A read says what it
left out, and names the kind of thing it was. A tool answers in compact JSON and adds nothing of
its own to the result; what the server has to say lives in the tool descriptions and the server
instructions, where it costs once per session.

Tests: all suites green — unit, e2e, multi-frame e2e, editor insertion, label parity, and a
whole-surface audit that calls every read-only command against a live site. `npm test` and the
harnesses under `tests/e2e/` print the current counts; `docs/spec/testing.md` says what each
suite exists to catch.

Docs:

- **`CHANGELOG.md`** — what changed in this release and why, with the measurements.
- `skills/browserctl/SKILL.md` — an optional Claude Code skill stub describing browserctl in
  task language ("drive a real tab in the background", "a logged-in session"). Symlink it into
  `~/.claude/skills/` if you want browserctl reached by intent rather than by tool name; on a
  machine with a competing browser skill installed, that is the difference between being used
  and being ignored.
- **`docs/REFERENCE.md`** — the operator's guide: install, control model, which tool to reach
  for and what its answer means, recipes, failure modes, the foreground-input matrix. Start here.
- **`docs/TOOLS.md`** — every tool and its exact parameters, generated from the running server.
- `PROTOCOL.md` — the wire format, and the core actions in detail. It is not the action index;
  `browserctl --help` and `browser_action` (called bare) are the complete lists.
- `docs/prior-art.md` — how this compares to similar projects, and the positioning
  decision (general-purpose browser control, explicitly not test automation).
- `docs/backlog-capability-gaps.md` — the five tracked gaps, with verified CDP surfaces.
- `docs/debugger-policy.md` — which commands need `chrome.debugger`, per action, with a script
  to re-derive the table when the command surface changes,
  what a per-site denial would cost, and the single chokepoint to enforce it at.
- **`docs/spec/`** — the contract: what an element is *called* and why, what a census contains
  and admits to omitting, what "the action worked" means, the error taxonomy, the cross-file
  invariants, and what each test suite exists to catch. Start at `docs/spec/README.md`.
- `docs/history/` — the investigation logs the specs were extracted from: findings from driving
  browserctl with fresh-context agents on live sites, each with its repro and how it was
  verified. Read it when a rule looks arbitrary; the evidence is there.
- `docs/backlog-chrome-devtools-parity.md` — deferred work to fold the useful parts of the
  `chrome-devtools` MCP into browserctl.
  The v2 work started from two third-party plans; what was adopted from them is §4 of the
  fix-plan and what was rejected is §8, both in `docs/history/`.

## Testing

```bash
npm test                       # unit: no Chrome needed, ~3s, safe alongside a live bridge
npm run preflight -- --e2e     # every release gate, including the live suites
```

The end-to-end suites drive the real stack (bridge -> extension -> Chrome) against pages the
runner serves itself, and there are more of them than `run.mjs`: a multi-frame regression suite,
a label-parity suite, an "exactly once" editor suite, and three that run against any live site
you name. Each one, what it catches and when to run it:
[docs/REFERENCE.md](docs/REFERENCE.md#tests), with the contract they enforce in
`docs/spec/testing.md`.

## Security

**This is a single-user, internal tool.** It runs on my own machine, driven by my
own agent, and is not meant to be shared, exposed, or run on a multi-user host. The
security model is deliberately "trusted local machine": there is **no auth and no
access control**, by design. The hardening items below are known and **intentionally
not implemented** — none of them affect the MCP/HTTP functionality, so for a
single-user setup they buy nothing. If this project is ever shared or moved off a
trusted machine, revisit them first.

Known, accepted risks (single-user only):

- **The bridge listens on `0.0.0.0:8765` by default**, so anything that can route to this
  machine can drive the browser. Set `HOST=127.0.0.1` (or firewall the port) on any network you
  do not control.
- **Any web page you visit can reach the bridge**, even bound to localhost: page JS can
  `fetch("http://127.0.0.1:8765/command", ...)` as a no-preflight "simple" request (or open
  `ws://127.0.0.1:8765/extension`) and issue commands to your browser. Localhost binding does not
  stop same-machine web content; only an `Origin` allowlist + a shared token would, and neither
  is implemented.
- **The extension↔bridge link is unauthenticated cleartext ws**, and the bridge host is
  user-configurable on the options page. Whatever answers on that socket gets full browser
  control. Keep the extension host set to `127.0.0.1` so Chrome talks to the local bridge.
- **`browser_upload` reads a local file and hands it to a web page.** The path comes from
  whoever is driving, and Chrome opens it with the bridge user's permissions — so an agent
  that can be talked into an upload can send any file this account can read to any site it is
  on. Same trust level as `exec_system_cmd`, and the same answer: this is a single-user tool on
  a trusted machine.
- **`get_cookies` reads cookies for the whole browser profile** (all sites), not just the
  target tab. There is no redaction on network/HAR/cookie output — headers (incl.
  `Cookie` / `Authorization`) come back verbatim, which is the point for a local debug tool.

**Prompt injection still applies.** A web page can embed hidden text that tries to
hijack whatever agent is driving the browser (the same risk the official Claude in
Chrome documents). No login removes that risk. When pointing an agent at untrusted
pages, keep a human in the loop for anything destructive or sensitive.
