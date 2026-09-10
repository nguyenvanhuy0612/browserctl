# browserctl — complete reference

Version 0.6.3. The extension, bridge, and MCP server are versioned together.

This is the **operator's guide**: how to install it, what each tool is for, recipes, and the failure
modes worth recognising. Three neighbours, so you land in the right one:

- `PROTOCOL.md` — the wire format. Message shapes between client, bridge and extension.
- **`spec/`** — the contract and the reasoning. What an element is called and why, what a census must
  admit to omitting, what "the action worked" means, the error taxonomy, the cross-file invariants.
  When this guide says *what*, the spec says *why, and what breaks otherwise*.
- `history/` — the investigation logs those rules were extracted from.

> [!WARNING]
> **Safety & Isolation Disclaimer:**
> `browserctl` gives AI agents direct DOM and network control. Never run on a primary browser profile with personal credentials. Use dedicated testing profiles or open-source Chromium builds.

> Releasing a version? Run `npm run preflight -- --e2e` and read
> [RELEASING.md](RELEASING.md) — it lists every gate and what a failure means.

## What it is

**browserctl** (v0.6.3, 80 tools) gives an AI agent DOM-level control of a *real*, already-logged-in Chrome
or Edge, through a neutral HTTP/WebSocket API and an MCP server. It drives one pinned tab
**in the background**, without stealing focus and without a debugger banner on the common
path, so you can keep working in your own tab while the agent works in its own.

It is a general-purpose browser control surface — deliberately **not** a test-automation
framework. See `prior-art.md` § Positioning decision for what that rules out and why.

### CLI Helper (`browserctl`)

`browserctl` is executable globally and can be invoked directly from anywhere in the terminal:

```bash
# Global flags (--tab <id>, -c, --json, --pretty) can appear anywhere in the command
browserctl --tab 123 snapshot --compact   # Viewport-scoped DOM with Quick Actions affordance footer
browserctl snapshot --all                 # Full DOM extraction including offscreen elements
browserctl tabs                           # List open tabs (alias for tab list)
browserctl switch 123                     # Switch target tab (alias for tab switch)

# Inspection & Fast Property Queries (get / describe)
browserctl get text @ref_1                # Get visible text by ref (alias: get_text)
browserctl get text ytd-active-account-header-renderer # Direct text query by custom element tag
browserctl get count <selector>           # Count matching elements (alias: get_count)
browserctl get value @ref_1               # Get input/textarea value
browserctl get attr @ref_1 href           # Get element attribute (alias: attribute)
browserctl get title | get url            # Fast metadata retrieval
browserctl describe <target>              # Inspect element tag, attributes, rect, visibility

# Interaction & Form Utilities
browserctl click @ref_1                   # Physical click dispatch (pointer + mouse + click)
browserctl fill @ref_1 "my query"         # Native input value setter + input event
browserctl paste @ref_1 "markdown"        # Paste text into fields or rich-text editors
browserctl press Enter                    # Dispatch keyboard event (Enter, Tab, Escape)
browserctl dismiss [target]               # Dismiss active modal, drawer, or flyout (Escape or close button)
browserctl scroll down [px] [target]      # Scroll page or container (smart nested container detection)
browserctl select @ref_1 "value"          # Select dropdown option

# Capture & Export
browserctl screenshot [file.png] [-f]     # Viewport or fullpage (-f) screenshot
browserctl pdf [file.pdf]                 # Print page to PDF
browserctl wait --settle                  # Wait for network idle and DOM mutation debounce
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
      "args": ["-y", "browserctl-mcp"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core" // 'core' (35 tools) or 'all' (all 80)
      }
    }
  }
}
```

Or with Claude CLI:
```bash
claude mcp add browserctl -- npx -y browserctl-mcp
```

#### Option B: Global Install via NPM

```bash
npm install -g browserctl-mcp
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

1. Use the DOM equivalent — `browser_click` by ref, selector or text instead of a pixel
   click; `browser_fill` (any `method`) instead of keystrokes.
2. `browser_press_key { allowSynthetic: true }` — fires the page's own shortcut handler
   with the modifier flags set. Does **not** drive native editing (no real `Cmd+A`).
3. Foreground it: `browser_switch_tab { id, focus: true }`. This steals the user's focus —
   ask first.

`press_key` always reports `via: "cdp"` (real OS event) or `via: "dom"` (synthetic) so you
never have to guess which semantics you got.

## Reading a list of rows

A page of results, cards, table rows or messages is one call, not one call per field:

```
browser_get_property({
  selector: "li.result",            // the ROW
  all: true,
  fields: {
    title: "h3",                    // a CSS selector, read as text
    url:   { selector: "a", attr: "href" },   // …or {selector, property, attr}
    price: ".price",
  },
})
```

Each row comes back with its own `ref` and the named values; URL attributes are resolved to
absolute. Field selectors resolve **inside** each row — if a value lives in a sibling of the
row (a separate `<tr>`, the next `<div>`), it is a second read, and the response says which
fields matched nothing rather than handing back silent nulls.

The census tells you what the rows are: `[Structure: 18 repeated <li> rows (~1 control each: a)]`.

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

A **stale ref is not a dead end** (0.6.0). Refs remember the label they were assigned to, so if the page
re-rendered and the same label is still present, the error names its replacement:
`ref "@ref_2" is stale — the control labelled "Hacker News" is now @ref_199; retry with that ref.`
No re-snapshot needed. This matters on SPAs, where a menu can re-render between the snapshot and the
click that follows it.

**Names come from the browser's own resolution** (0.6.0): `aria-label`, `aria-labelledby`, a descendant
image's `alt`, `title`/`placeholder`, a form control's `<label for>` / wrapping `<label>` / row text,
then slotted shadow content. A control's `value` is never its name — that had every
`<input type="radio" value="on">` in a group called "on". Verified at 100% of Chrome's own named
controls on github.com, booking.com and news.ycombinator.com; check any site yourself with
`node tests/e2e/label_vs_chrome.mjs <url>`.

Some controls are listed even though they are not plainly visible, each marked so you know why:
`[via label]` is the standard 1x1 `opacity:0` checkbox operated through a visible `<label>`;
`[hidden until hover/focus]` is a carousel arrow or skip link. Both are genuinely operable and both are
in Chrome's accessibility tree.

## Tools

The names below are MCP tool names. Three kinds of row do not map one-to-one onto a protocol
action, so read them before assuming a name is callable as-is:

- **Composites have no action of their own.** `browser_open_url` is `new_tab`/`navigate` → wait
  → `read_pdf` probe → optional read, in one call.
- **One name per capability.** The reader is `get_property` at every layer — MCP tool, CLI and
  raw HTTP. The old convenience action names (`get_text`, `get_value`, `get_html`, `get_box`,
  `get_attribute`, `get_count`) still resolve at the extension's dispatch entry, so an old script
  keeps working, but there is no MCP tool by those names any more.
- **Rows marked ¹ are protocol actions with no MCP tool.** Reach them with
  `browser_action({action: "check", params: {…}})`, or from the CLI as `browserctl check <target>`.
  There is no `browser_check` tool to call.
- **Eight tool names were removed in 0.6.4/0.7.0; their job is a parameter now.**
  `browser_type` / `browser_paste` / `browser_select_option` → `browser_fill` with `method` or
  `option`. `browser_screenshot_fullpage` → `browser_screenshot({fullPage: true})`.
  `browser_wait_settle` → `browser_wait_for({for: "settle"})`. `browser_get_text` /
  `browser_get_attribute` / `browser_get_count` → **`browser_get_property`** with
  `property: "text" | "attr" | "count"`. No aliases were kept: one name per capability, at every
  layer. The underlying protocol actions all still run — `browser_action({action: "paste", …})`
  reaches them, and they are listed in its catalogue.
- **0.8.0 removed four more.** `browser_navigate` and `browser_new_tab` → **`browser_open_url`**
  with `target: "current" | "new" | <tabId>` (and `read:` folds in the old
  `browser_open_and_read`). `browser_find_text` → `browser_find({query, in: "text"})`.
  `browser_dismiss_modal` → click the dialog's own close control, or
  `browser_action({action: "dismiss"})`. `browser_reload` moved INTO core.
- **Rows marked ³ left `core` in 0.6.4** — zero calls across 43 measured agent sessions, or
  (for `browser_exec_system_cmd`) no business being one keystroke away from a page-reading
  agent. Load them with `browser_load_tools({profile: "advanced" | "system"})`.

For the authoritative list of everything callable, run `browserctl --help` or call
`browser_action` with no arguments. Every tab-scoped tool also accepts `tabId` (and `tab_id`).

**Tool profiles.** `core` (default) loads 23 tools; `all` loads everything. Everything else is one
`browser_load_tools` call away: `network`, `cdp`, `cookies`, `storage`, `console`, `record`,
`tabs`, `advanced`, `system`.

### Read the page

| Tool | Purpose | Params |
|---|---|---|
| `browser_snapshot` | Primary tool to inspect UI, controls, notifications & badges | `maxText`, `scope`, `compact`, `format` |
| `browser_get_property` | **The element read.** One element, a whole region, every match, or a whole row-shaped list — text, value, HTML, box, attribute or count, without eval_js | `selector`, `ref`, `index`, `placeholder`, `property` (`text`\|`value`\|`html`\|`box`\|`attr`\|`count`), `attr`, `all`, `max`, `fields` |
| `browser_read_page` | Read page (accessibility tree) | `mode`, `depth`, `ref_id`, `maxChars` |
| `browser_find` | Find controls by label/text or CSS selector, or search the page's prose with `in: "text"` | `query`, `selector`, `in` (`controls`\|`text`), `regex`, `contextChars`, `max` |
| `browser_get_page_content` | Get readable article/documentation text (prose only) | `maxChars` |
| `browser_describe_element` | Describe element tag, attributes, box, and visibility | `selector`, `ref`, `index`, `placeholder` |
| `browser_a11y_snapshot` | Accessibility snapshot | — |
| `browser_read_pdf` | Read a PDF tab | — |

### Interact (DOM — works on a background tab)

| Tool | Purpose | Params |
|---|---|---|
| `browser_click` | Click element by ref/selector/text | `ref`, `selector`, `text`, `index`, `waitFor`, `settleMs`, `autoSettle` |
| `browser_fill` | **The one text-entry verb.** Any editable target (input, textarea, contenteditable, rich-text) or a `<select>` | `ref`, `selector`, `placeholder`, `index`, `text`, `option`, `method` (`set`\|`type`\|`paste`), `waitFor`, `submit`, `settleMs`, `autoSettle` |
| `clear` ¹ | Clear input/textarea element | `ref`, `selector` |
| `check` ¹ | Check checkbox or radio button | `ref`, `selector`, `text` |
| `uncheck` ¹ | Uncheck checkbox | `ref`, `selector`, `text` |
| `browser_hover` ³ | Hover element | `ref`, `selector`, `text` |
| `browser_press_key` | Press a key | `key`, `ref`, `modifiers`, `allowSynthetic` |
| `browser_scroll` | Scroll page or container (smart nested container detection) | `direction`, `amount`, `ref`, `selector`, `index` |
| `browser_insert_text` | Insert text (CDP) | `text` |

### Daemon & Dynamic Tool Management

| Tool | Purpose | Params |
|---|---|---|
| `browser_status` | Bridge & extension connectivity, daemon state | `format` |
| `browser_start` | Start bridge daemon in background if stopped | — |
| `browser_stop` | Stop bridge daemon (records explicit stopped state) | — |
| `browser_load_tools` | Dynamically load tool categories (`network`, `cdp`, `cookies`, `storage`, etc.) into prompt | `profile`, `tools` |
| `browser_unload_tools` ³ | Unload extra tools and reset back to the `core` profile | `profile`, `tools` |
| `browser_list_available_tools` | List all tool profiles and currently active/inactive status | `format` |

### Interact (pixel — FOREGROUND tab only)

| Tool | Purpose | Params |
|---|---|---|
| `browser_coordinate_click` | Click at coordinates | `x`, `y`, `button`, `clickCount` |
| `browser_coordinate_drag` | Drag between coordinates | `fromX`, `fromY`, `toX`, `toY` |

### Navigate & wait

| Tool | Purpose | Params |
|---|---|---|
| `browser_go_back` | Go back | — |
| `browser_go_forward` | Go forward | — |
| `browser_reload` | Reload the target tab | `bypassCache` |
| `browser_wait_for` | Wait for a condition, or for the page itself to stop moving | `for` (`settle`), `selector`, `text`, `gone`, `timeoutMs` |
| `browser_wait_network_idle` | Wait for network quiet period (supports tolerance for persistent sockets) | `idleMs`, `timeoutMs`, `maxInFlight` |

### Screenshots & PDF

| Tool | Purpose | Params |
|---|---|---|
| `browser_screenshot` | Screenshot the viewport, or the whole page with `fullPage` | `fullPage`, `format`, `quality` |
| `browser_element_screenshot` | Screenshot one element | `index`, `ref`, `format` |
| `browser_print_pdf` | Print page to PDF | — |

### Tabs & windows

| Tool | Purpose | Params |
|---|---|---|
| `browser_status` | Bridge/extension readiness, no browser command needed | — |
| `browser_list_tabs` | List tabs | — |
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
| `browser_exec_system_cmd` ³ | Execute system shell command on bridge host (`system` profile) | `command`, `cwd`, `env`, `timeoutMs` |
| `browser_cdp_send` | Send a raw CDP command (power tool) | `method`, `params` |
| `browser_eval_js` | Evaluate JavaScript in page context (auto-bypasses CSP and Trusted Types via CDP) | `expression`, `format` |
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

**Did it actually take?** (0.6.0) Every action returns an `effect` block: `domMutated`, `mutationCount`,
`urlChanged`, `targetStillPresent`. For a control carrying `aria-checked`/`selected`/`pressed`/
`expanded`, it also reports `controlState` — whether the control's *own* state moved:

```
effect.controlState: { "changed": ["checked: false -> true"], "unchanged": [] }
```

This distinction is the point. A real audience selector produced 34, then 320, then 34 mutations across
eight clicks while the selection never committed, and every one of those clicks reported success.
`domMutated` proves the page reacted; only `controlState` proves the thing you aimed at changed. When
the page mutates and the control does not, the response says so explicitly.

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
browser_open_url  { url, target: "new" }
browser_wait_for  { for: "settle" }                 # readyState complete + no animations
browser_read_page { mode: "interactive" }
browser_click     { ref: "ref_12" }
```

**Fill a form without keystrokes.** `browser_fill` sets the value through the
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

What matters in practice is that most commands never touch the debugger, and only two acquire a
session on their own (`browser_cdp_attach`, which is explicit intent, and
`browser_spoof_visibility`) plus the background-tab branch of `browser_screenshot`.
`docs/debugger-policy.md` holds the per-action table, and a script to re-derive it when the
command surface changes. A screenshot of an *active* tab uses `chrome.tabs.captureVisibleTab` and
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
# unit: no Chrome needed. 81 tests, ~2s, safe to run with a live bridge.
npm test

# e2e: drives the real stack. Bridge must be running and the extension connected.
node tests/e2e/run.mjs                      # 70 checks; never steals focus
E2E_FOREGROUND=1 node tests/e2e/run.mjs     # + the 2 synthetic-input tests (steals focus)
node tests/e2e/run_multiframe.mjs           # 19 checks on a page with a real iframe
node tests/e2e/run_labels.mjs               # 9 label-resolution shapes, all four readers agree
node tests/e2e/run_editors.mjs              # 12 checks: text goes in EXACTLY once, and a form
                                            # submits exactly once, across editor architectures

# against ANY live site — these need no fixture and are the ones worth running after
# touching the census, the dispatch table, or a tool description:
node tests/e2e/label_vs_chrome.mjs https://github.com/login   # census names vs Chrome's own
node tests/e2e/audit_tools.mjs https://example.com out        # every read-only action
node tests/e2e/coverage_check.mjs https://news.ycombinator.com hn  # nothing unreachable
```

The e2e runner serves its own page (plus a second origin for a genuinely cross-origin
iframe), creates its own tabs, and closes what it opened. It ends with a coverage line —
`exercised / excused / missed` against the protocol surface, which it derives from the MCP
registry rather than a hand-kept list. `reload_extension`, `exec_system_cmd` and `action` are
excused there, with the reason printed. A "missed" action may still be covered by
`run_editors.mjs` or `run_labels.mjs`; the line only speaks for this suite.

**`run_multiframe.mjs` exists because every other fixture was single-frame**, and that blind spot let a
severe regression ship invisibly: on any page with an iframe — i.e. every real site — the frame merge
rebuilt the compact view from scratch and discarded landmark grouping, folding and every notice. All 81
unit tests stayed green throughout.

**`run_editors.mjs` guards the "exactly once" family.** Insertion and activation are each done by two
mechanisms that both work — a ClipboardEvent and `execCommand`, an Enter key and `requestSubmit()` —
and running both is the single most repeated defect in this codebase (F1, F70, F71). The fixture varies
the two things that actually change the outcome: whether the editor handles the event, and whether it
commits synchronously. Facebook's Lexical composer is the only case that catches a fix verified against
Gmail alone.

**`label_vs_chrome.mjs` is the oracle worth knowing about.** Chrome computes an accessible name for
every control to spec and exposes it through the accessibility tree, so on any live page that is ground
truth for what the census *should* have found — no fixture, no guessing what shapes to test. Three
naming defects came from it that a hand-written fixture had passed clean. The bar is: zero anonymous
controls, and coverage at 100% of Chrome's named controls.

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
