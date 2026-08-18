# browserctl — complete reference

Version 0.5.1. The extension, bridge, and MCP server are versioned
together; `PROTOCOL.md` is the wire-level spec and this document is the operator's guide.

> [!WARNING]
> **Safety & Isolation Disclaimer:**
> `browserctl` gives AI agents direct DOM and network control. Never run on a primary browser profile with personal credentials. Use dedicated testing profiles or open-source Chromium builds.

## What it is

**browserctl** (v0.5.1, 70+ tools) gives an AI agent DOM-level control of a *real*, already-logged-in Chrome
or Edge, through a neutral HTTP/WebSocket API and an MCP server. It drives one pinned tab
**in the background**, without stealing focus and without a debugger banner on the common
path, so you can keep working in your own tab while the agent works in its own.

It is a general-purpose browser control surface — deliberately **not** a test-automation
framework. See `prior-art.md` § Positioning decision for what that rules out and why.

### CLI Helper (`browserctl`)

`browserctl` is executable globally and can be invoked directly from anywhere in the terminal:

```bash
# Daemon & connectivity
browserctl status                         # Check bridge and extension connection
browserctl start                          # Start bridge daemon in background
browserctl stop                           # Stop bridge daemon (records stopped state)

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

# Interaction & Form Utilities
browserctl click @e1                      # Click by ref (@e1, ref_1, 0)
browserctl fill @e1 "my query"            # Clear input and fill text (React/Vue v-model compatible)
browserctl paste @e1 "markdown content"   # Paste multi-line text into inputs or rich-text editors (ProseMirror/Tiptap)
browserctl type @e2 "appended text"       # Type into input field
browserctl clear @e1                      # Clear input field
browserctl check @e3                      # Check checkbox / radio button
browserctl uncheck @e3                    # Uncheck checkbox
browserctl select @e4 "value"             # Select dropdown option

# Capture, Export & JavaScript
browserctl screenshot page.png [-f]       # Capture viewport or fullpage screenshot to file
browserctl pdf document.pdf               # Print page to PDF file directly
browserctl eval -r "document.title"       # Run JS and output raw value to stdout
browserctl tab [list|new|switch|close]    # Manage browser tabs
```

## Architecture

```
Agent (Claude Code / Antigravity / any MCP client / CLI / HTTP client)
      |  MCP stdio            |  HTTP POST /command
      v                       v
mcp/index.js  ------------>  bridge/server.js        (Node, 0.0.0.0:8765, configurable via HOST/PORT)
 (Auto-daemon spawn)          relay + correlation + heartbeat + daemon state machine
                                      |  WebSocket /extension
                                      v
                              extension/ (Manifest V3)
                                background.js  service worker, dispatch, tab pinning
                                content.js     DOM reads/writes, a11y tree, refs, insertText
                                cdp.js         chrome.debugger: console/network/HAR/input/pdf
                                netlog.js      chrome.webRequest light capture (no banner)
```

Four dispatch layers, and every action belongs to exactly one:

| Layer | Where | Banner? | Works on a background tab? |
|---|---|---|---|
| `CONTENT_ACTIONS` | content script | no | yes |
| `NET_ACTIONS` | `chrome.webRequest` | no | yes |
| `CDP_ACTIONS` | `chrome.debugger` | yes | yes, **except synthetic input** |
| everything else | `chrome.tabs` / `chrome.windows` in the worker | no | yes |

## Install & Setup

### 1. Load the Chrome Extension

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the extension icon → **Connect**

Step 3 is required on a fresh load: a newly installed extension stays idle by design and
makes no connection attempt. After the first successful Connect it remembers and
auto-reconnects with capped exponential backoff (max 30s), and never permanently gives up
on a transient outage — only an explicit **Disconnect** stops it.

### 2. Using with MCP Clients (Claude Code, Antigravity, Cursor, Windsurf)

**Zero-Manual-Server**: The bridge daemon is started automatically in the background when the MCP server launches. No separate `npm start` terminal required!

#### Option A: Run via `npx` (from NPM Registry)

Add to your `claude_desktop_config.json`, `.mcp.json`, or Antigravity MCP settings:

```jsonc
{
  "mcpServers": {
    "browserctl": {
      "command": "npx",
      "args": ["-y", "-p", "@nguyenvanhuy0612/browserctl", "browserctl-mcp"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core" // 'core' (~24 tools) or 'all' (all 70+ tools)
      }
    }
  }
}
```

Or with Claude CLI:
```bash
claude mcp add browserctl -- npx -y -p @nguyenvanhuy0612/browserctl browserctl-mcp
```

#### Option B: Global Install via NPM

```bash
npm install -g @nguyenvanhuy0612/browserctl
```

#### Option C: Local Path

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

Tools appear as `mcp__browserctl__browser_*`. In `core` mode, `browser_action` is always available to dynamically invoke any protocol action (CDP, cookies, storage, HAR export, recordings, etc.).

## The control model

This is the part an agent must get right; the MCP server sends it as server instructions
on connect.

- **One pinned target.** The first command pins the currently focused tab and it *stays*
  pinned even after the user switches tabs. Every subsequent command acts on that tab, so
  a read can never silently land on whatever the user is now looking at.
- **`navigate` / `new_tab` / `switch_tab` re-pin.** Closing the target unpins it.
  `current_tab` tells you what is pinned.
- **Per-command override.** Any tab-scoped action accepts `tabId` to run *that one
  command* against *that tab* without touching the pin — this is how several agents drive
  different tabs concurrently without racing.
- **Background-first.** Do not foreground a tab to act on it. Reads, DOM interaction,
  navigation and screenshots all work on a hidden tab.
- **`group_tab` once**, early, so the user can see which tab you drive. It does not
  activate the tab.

> **When the pin is lost, a content read is refused once.** The pin is persisted to
> `chrome.storage.session`, so it survives a service-worker recycle and a bridge restart —
> but it is genuinely gone if the target tab was closed, the browser session ended, or the
> extension was reloaded. In that state, pin-on-first-touch would adopt whatever tab the
> user is looking at *and return its content*; that is how a read once landed on a personal
> chat tab. A content-returning command now refuses once, names the tab it would have read,
> and pins it — re-issue to proceed, or retarget first. Navigation, tab management, and any
> command with an explicit `tabId` are never guarded.

## The one real limitation: synthetic input needs a foreground tab

Verified 2026-08-04 on Chrome/macOS. Chrome delivers CDP synthetic input only to the tab
that is active in a focused window. On a background tab, `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent` are accepted and **report success while doing nothing**.

| Command | Background tab | Foreground tab |
|---|---|---|
| `browser_coordinate_click` | **errors** (was a silent no-op) | works |
| `browser_coordinate_drag` | **errors** | works |
| `browser_press_key` **with** `modifiers` | **errors** | works, incl. Mac editor commands |
| `browser_press_key` with `allowSynthetic:true` | works (`via:"dom"`) | works |
| `browser_insert_text` | works | works |
| every screenshot tool | works | works |
| every DOM action, console/network/HAR, `eval_js`, cookies, storage | works | works |

Remedies, in order of preference:

1. Use the DOM equivalent — `browser_click` / `browser_click_selector` by ref or selector
   instead of a pixel click; `browser_type` / `browser_fill_selector` instead of keystrokes.
2. `browser_press_key { allowSynthetic: true }` — fires the page's own shortcut handler
   with the modifier flags set. Does **not** drive native editing (no real `Cmd+A`).
3. Foreground it: `browser_switch_tab { id, focus: true }`. This steals the user's focus —
   ask first.

`press_key` always reports `via: "cdp"` (real OS event) or `via: "dom"` (synthetic) so you
never have to guess which semantics you got.

## Element identity: refs vs indices vs selectors

- **`ref`** (`ref_5`, or `f3:ref_5` inside an iframe) — WeakRef-backed, survives
  re-snapshots, does not mutate the page. **Prefer this.** Comes from `read_page`,
  `find`, `snapshot`.
- **`index`** — positional, per-snapshot; also stamped on the element as
  `data-bctl-ref` so it survives minor DOM churn. Top frame only.
- **CSS selector** — `click_selector` / `fill_selector`, no snapshot needed; what
  `record`/`replay` emit.

Reads pierce **open shadow DOM** and cover **iframes including cross-origin** (all_frames
injection, frame-qualified refs). Pass a frame-qualified ref back verbatim.

## Tools

67 MCP tools over 65 bridge actions — `browser_open_and_read` is a composite
(`new_tab`/`navigate` → wait → `read_pdf` probe → read) with no bridge action of its own.
Every tab-scoped tool also accepts `tabId`.

### Read the page

| Tool | Purpose | Params |
|---|---|---|
| `browser_snapshot` | Snapshot page | `maxText` |
| `browser_read_page` | Read page (accessibility tree) | `mode`, `depth`, `ref_id`, `maxChars` |
| `browser_find` | Find elements by text | `query`, `max` |
| `browser_find_text` | Find text on the page | `query`, `regex`, `max`, `contextChars` |
| `browser_get_page_content` | Get readable page content | — |
| `browser_describe_element` | Describe one element | `index`, `ref` |
| `browser_a11y_snapshot` | Accessibility snapshot | — |
| `browser_read_pdf` | Read a PDF tab | — |
| `browser_open_and_read` | Open (or reuse) a tab and read it in one call | `url`, `wait`, `timeoutMs`, `read`, `maxChars` |

### Interact (DOM — works on a background tab)

| Tool | Purpose | Params |
|---|---|---|
| `browser_click` | Click element by ref/selector/text | `ref`, `selector`, `text`, `waitFor`, `settleMs` |
| `browser_fill` | Fill input or rich-text editor (clears & sets instantly) | `ref`, `selector`, `text`, `waitFor`, `submit` |
| `browser_paste` | Paste large text/Markdown via Clipboard events | `ref`, `selector`, `text`, `waitFor`, `submit` |
| `browser_type` | Focus element and set text (React/Vue `v-model` compatible) | `ref`, `selector`, `text`, `waitFor`, `submit` |
| `browser_clear` | Clear input/textarea element | `ref`, `selector` |
| `browser_check` | Check checkbox or radio button | `ref`, `selector`, `text` |
| `browser_uncheck` | Uncheck checkbox | `ref`, `selector`, `text` |
| `browser_click_selector` | Click by CSS selector | `selector` |
| `browser_fill_selector` | Fill by CSS selector | `selector`, `value` |
| `browser_hover` | Hover element | `ref`, `selector`, `text` |
| `browser_select_option` | Select dropdown option | `ref`, `selector`, `value`, `label` |
| `browser_press_key` | Press a key | `key`, `ref`, `modifiers`, `allowSynthetic` |
| `browser_scroll` | Scroll page | `direction`, `amount` |
| `browser_insert_text` | Insert text (CDP) | `text` |

### Daemon & Dynamic Tool Management

| Tool | Purpose | Params |
|---|---|---|
| `browser_status` | Bridge & extension connectivity, daemon state | `format` |
| `browser_start` | Start bridge daemon in background if stopped | — |
| `browser_stop` | Stop bridge daemon (records explicit stopped state) | — |
| `browser_load_tools` | Dynamically load tool categories (`network`, `cdp`, `cookies`, `storage`, etc.) into prompt | `profile`, `tools` |
| `browser_unload_tools` | Unload extra tools and reset prompt back to lightweight `core` profile | `profile`, `tools` |
| `browser_list_available_tools` | List all tool profiles and currently active/inactive status | `format` |

### Interact (pixel — FOREGROUND tab only)

| Tool | Purpose | Params |
|---|---|---|
| `browser_coordinate_click` | Click at coordinates | `x`, `y`, `button`, `clickCount` |
| `browser_coordinate_drag` | Drag between coordinates | `fromX`, `fromY`, `toX`, `toY` |

### Navigate & wait

| Tool | Purpose | Params |
|---|---|---|
| `browser_navigate` | Navigate | — |
| `browser_go_back` | Go back | — |
| `browser_go_forward` | Go forward | — |
| `browser_reload` | Reload | — |
| `browser_wait_for` | Wait for condition | `selector`, `text`, `gone`, `timeoutMs` |
| `browser_wait_settle` | Wait for page to settle | — |
| `browser_wait_network_idle` | Wait for network idle | — |

### Screenshots & PDF

| Tool | Purpose | Params |
|---|---|---|
| `browser_screenshot` | Screenshot | `format`, `quality` |
| `browser_screenshot_fullpage` | Full-page screenshot | `format`, `quality` |
| `browser_element_screenshot` | Screenshot one element | `index`, `ref`, `format` |
| `browser_print_pdf` | Print page to PDF | — |

### Tabs & windows

| Tool | Purpose | Params |
|---|---|---|
| `browser_status` | Bridge/extension readiness, no browser command needed | — |
| `browser_list_tabs` | List tabs | — |
| `browser_new_tab` | New tab | — |
| `browser_switch_tab` | Switch tab | `id`, `focus` |
| `browser_close_tab` | Close tab | — |
| `browser_current_tab` | Current target tab | — |
| `browser_group_tab` | Group a tab (visual marker) | `id`, `title`, `color` |
| `browser_ungroup_tab` | Ungroup a tab | — |
| `browser_list_windows` | List windows | — |
| `browser_focus_window` | Focus window | — |
| `browser_spoof_visibility` | Spoof page visibility (unblock background lazy-load) | — |

### Console, network & HAR

| Tool | Purpose | Params |
|---|---|---|
| `browser_cdp_attach` | Attach debugger | — |
| `browser_cdp_detach` | Detach debugger | — |
| `browser_get_console_logs` | Get console logs | `limit`, `clear` |
| `browser_get_network_requests` | Get network requests | `urlContains` |
| `browser_get_response_body` | Get response body | — |
| `browser_export_har` | Export HAR | — |
| `browser_net_start` | Start network capture (light) | — |
| `browser_net_stop` | Stop network capture (light) | — |
| `browser_net_get` | Get captured network (light) | `urlContains`, `limit` |
| `browser_net_clear` | Clear network capture (light) | — |

### State: cookies & storage

| Tool | Purpose | Params |
|---|---|---|
| `browser_get_cookies` | Get cookies | — |
| `browser_set_cookie` | Set cookie | `name`, `url`, `secure` |
| `browser_delete_cookies` | Delete cookies | — |
| `browser_storage_get` | Read web storage | — |
| `browser_storage_set` | Write web storage | — |
| `browser_storage_remove` | Remove web storage key | — |
| `browser_storage_clear` | Clear web storage | — |

### Scripting, record/replay, ops

| Tool | Purpose | Params |
|---|---|---|
| `browser_exec_system_cmd` | Execute system shell command on bridge host | `command`, `cwd`, `env`, `timeoutMs` |
| `browser_cdp_send` | Send a raw CDP command (power tool) | `method`, `params` |
| `browser_eval_js` | Evaluate JavaScript | — |
| `browser_audit` | Audit page | — |
| `browser_record_start` | Start recording | — |
| `browser_record_stop` | Stop recording | — |
| `browser_record_get` | Get recorded steps | — |
| `browser_replay` | Replay steps | `startUrl`, `steps` |
| `browser_reload_extension` | Reload the extension | — |
## Actionability: why an action reports a warning

`click` / `type` / `hover` / `select_option` / `click_selector` / `fill_selector` check the
target before acting.

- **`disabled` is a hard error.** Browsers suppress input to a disabled control, so acting
  and reporting success would be a lie. The handler genuinely does not fire.
- **Any other non-visible reason** (`display:none`, `visibility:hidden`, `opacity:0`,
  `zero-size rect`) still acts, and the result carries a `warning`. These paths use
  `el.click()` and the native value setter, which *do* fire handlers on a hidden element —
  refusing would remove working capability (a 0-size input behind a styled label is real).

So: a `warning` means "it ran, but the element did not look actionable — verify the
effect". An error means "it could not have worked".

## The escape hatch: `browser_cdp_send`

Requires `browser_cdp_attach`. Sends any method in Chrome's `chrome.debugger` allowlist and
returns the result verbatim. This is how to reach a capability before it has a dedicated
tool, and how to answer a CDP question without editing the extension:

```
browser_cdp_attach
browser_cdp_send { method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } }
browser_cdp_send { method: "Emulation.setDeviceMetricsOverride",
                   params: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true } }
browser_cdp_send { method: "DOM.setFileInputFiles",
                   params: { files: ["/abs/path/file.pdf"], objectId: "..." } }
```

Every one of the five tracked backlog gaps is reachable through it today. `DOMStorage` and
`IndexedDB` are not in the allowlist and return Chrome's own `wasn't found` error.

Two footguns: enabling an interception domain without handling its events (e.g.
`Fetch.enable`) pauses page traffic until you disable it, and
`Emulation.setDeviceMetricsOverride` changes the screenshot scale `coordinate_click` remaps
against.

## Readiness: `browser_status`

Every other tool needs the extension, so they can only report its absence by failing.
`browser_status` checks the bridge's own `/status` and returns
`{ bridgeReachable, extensionConnected, ready, hint }`. Call it after restarting the bridge
or reloading the extension, or when a command says `extension not connected`.


## Recipes

**Read a page cheaply.** `read_page` (indented a11y text + refs) costs far less than a
screenshot and is usually enough to reason and act. Use `snapshot { maxText: 0 }` when you
want the element list without any page text.

```
browser_group_tab                                  # show the user which tab you drive
browser_navigate  { url }
browser_wait_settle                                # readyState complete + no animations
browser_read_page { mode: "interactive" }
browser_click     { ref: "ref_12" }
```

**Fill a form without keystrokes.** `type` and `fill_selector` set the value through the
prototype's native setter, so React/Vue value-tracking sees a real edit instead of
reverting it. This is more reliable than synthesising keys, and it works in the background.

**Read a page you have to open first.** `open_and_read` collapses open → wait → read into
one call and detects a PDF before attempting a DOM read (Chrome's PDF viewer has no
readable DOM, so every content action fast-fails on such a tab).

**Capture network traffic.** Two modes:

| | `net_*` (`chrome.webRequest`) | `cdp_attach` + `get_network_requests` |
|---|---|---|
| Debugger banner | no | yes |
| Response bodies | no | yes (`get_response_body`, `export_har { bodies: true }`) |
| Headers/status/timing | yes | yes |

Start with the light mode; escalate only when you need bodies.

**Scroll a background tab that lazy-loads nothing.** Many sites pause infinite scroll
while `document.hidden` is true. `spoof_visibility` patches `document.hidden` /
`visibilityState` and fires `visibilitychange` **without activating the tab**. It is
explicit and opt-in, because visibility state also gates video autoplay, polling and
analytics. Known limit: it patches JS-visible state only, not Chrome's renderer-level
throttling — a site whose lazy-load rides `requestAnimationFrame` or
`IntersectionObserver` may still not budge, and this action will never foreground the tab
on its own to work around that.

**Debug why a click did nothing.** `describe_element { ref }` returns
`visibilityReason`: one of `visible`, `zero-size rect`, `visibility:hidden`,
`display:none`, `opacity:0`, `disabled`.

## Failure modes worth recognising

| Symptom | Cause | Fix |
|---|---|---|
| `extension not connected` (503) | Chrome closed, or a fresh Load unpacked never Connected | Open the popup → **Connect** |
| A command needs the foreground | CDP synthetic input on a hidden tab | Use the DOM equivalent, `allowSynthetic`, or foreground it |
| `tab is showing a PDF (no readable DOM)` | Content action on Chrome's PDF viewer | `read_pdf` |
| `ref "..." not found or stale` | Element GC'd or the page re-rendered | Re-run `read_page` / `snapshot` |
| `modifiers require cdp_attach` | Modified key press with no debugger | `cdp_attach`, or `allowSynthetic:true` |
| Restricted-page error on screenshot | `chrome://` or the Web Store rejects the debugger | Structurally out of reach |
| Reads land on an unexpected tab | Pin was lost (bridge restart) | `current_tab`, then re-target |
| Coordinates off by 2x | A screenshot other than the last CDP one set the scale | Take a CDP screenshot immediately before the coordinate action |

## The debugger banner

Attaching `chrome.debugger` makes Chrome show `"browserctl" started debugging this browser`.
It **cannot be suppressed** — that is a Chrome security guarantee, not a gap here.

What matters in practice is that most of the tool never attaches: **45 of 65 commands never
touch the debugger**, and only two acquire a session on their own (`browser_cdp_attach`, which
is explicit intent, and `browser_spoof_visibility`) plus the background-tab branch of
`browser_screenshot`. A screenshot of an *active* tab uses `chrome.tabs.captureVisibleTab` and
raises nothing.

The banner therefore appears when you opt into CDP — but note it then **stays** until
`browser_cdp_detach` or the tab closes; there is no idle auto-detach yet. If you see it
unexpectedly, the usual cause is a background-tab screenshot earlier in the task.

Full dependency map, the cost of forbidding the debugger per site, and where to enforce such a
policy: `debugger-policy.md`.

## Security posture

Single-user, trusted-machine tool. **No auth, no access control, by design.** Accepted
risks, unchanged:

- **Any page you visit can reach the bridge.** It binds `127.0.0.1`, but page JS can
  `fetch("http://127.0.0.1:8765/command")` as a no-preflight simple request and drive your
  browser. Only an `Origin` allowlist plus a shared token would stop that; neither is
  implemented.
- **The extension↔bridge link is unauthenticated cleartext ws**, and the host is
  user-configurable. Whatever answers on that socket gets full browser control.
- **`get_cookies` reads the whole browser profile**, not just the target tab, and network
  /HAR output returns `Cookie` / `Authorization` headers verbatim — the point of a local
  debug tool, a liability anywhere else.
- **Prompt injection applies.** A page can embed hidden text aimed at whatever agent is
  driving. No login removes that. Keep a human in the loop for anything destructive.

Revisit all of the above before this leaves a trusted machine.

## Tests

```bash
# unit: bridge relay only, no Chrome needed. ~0.5s, safe to run with a live bridge.
node --test tests/unit/bridge.test.mjs

# e2e: drives the real stack. Bridge must be running and the extension connected.
node tests/e2e/run.mjs                      # 62 checks; never steals focus
E2E_FOREGROUND=1 node tests/e2e/run.mjs     # + the 2 synthetic-input tests (steals focus)
```

The e2e runner serves its own page (plus a second origin for a genuinely cross-origin
iframe), creates its own tabs, exercises 58 of 60 commands, and closes what it opened.
`reload_extension` is never exercised — it drops the connection mid-run by design.

After editing extension code, reload the extension (`chrome://extensions` → reload, or the
`reload_extension` command) before re-running, or you will test the old code.

**Two test-design rules learned the hard way here:**

1. **Do not let a test depend on the tab's foreground state implicitly.** The original
   `coordinate_click` test asserted against the main tab; any earlier test that
   foregrounded it silently changed the outcome. The guards now assert against a dedicated
   background tab addressed by explicit `tabId`.
2. **Do not let a test depend on scroll position implicitly.** The same test computed
   `getBoundingClientRect()` after an earlier test had scrolled the page, so it clicked at
   a negative coordinate. Scroll the target into view first.

## Known gaps

Tracked in `backlog-capability-gaps.md`, ordered by value/cost: dialog handling
(`Page.handleJavaScriptDialog` — currently an unexpected `confirm()` hangs every DOM
command), file upload (`DOM.setFileInputFiles` + `Page.setInterceptFileChooserDialog`),
emulate/throttle, network mocking (`Fetch` domain — the big one), `storage_state`
export/import.

Structurally out of reach: `chrome://` pages, the Web Store, other extensions' popups, and
OS-level dialogs (certificate prompts, the native file picker). HTTP basic-auth is
reachable — via `Fetch.continueWithAuth`, once network interception lands.
