# Command protocol

Agents send commands to the bridge:

```
POST http://localhost:8765/command
content-type: application/json

{ "action": "<name>", "params": { ... } }
```

The response is always JSON:

```jsonc
{ "ok": true,  "result": { ... } }   // success
{ "ok": false, "error": "message" }  // failure
```

All actions operate on the **active tab** unless noted.

## Page inspection

### `snapshot`
Returns the page's interactive elements (each with a stable `index` for this page
load), plus page metadata and visible text. This is the agent's main "what's on
screen" call.

Params: none (optional `{ "maxText": 4000 }` to cap returned text length).

Result:
```jsonc
{
  "url": "https://example.com/",
  "title": "Example",
  "elements": [
    { "index": 0, "tag": "a",      "text": "Home",        "href": "/" },
    { "index": 1, "tag": "input",  "type": "search",      "placeholder": "Search", "value": "" },
    { "index": 2, "tag": "button", "text": "Submit" }
  ],
  "text": "Visible page text, truncated..."
}
```

Indices are valid until the page navigates or is re-rendered. Re-`snapshot` after
any action that changes the page.

## Actions

### `navigate`
`params: { url }` - load `url` in the active tab. Returns `{ url }` once loaded.

### `click`
`params: { index }` - click the element with that snapshot index.

### `type`
`params: { index, text, submit? }` - focus the element, set its value to `text`
(firing input/change events). If `submit: true`, presses Enter afterward.

### `scroll`
`params: { direction: "up"|"down", amount? }` - scroll by `amount` px
(default 600). `direction: "down"` is the default.

### `screenshot`
Captures the visible viewport of the active tab via `chrome.tabs.captureVisibleTab`.
Result: `{ dataUrl: "data:image/png;base64,..." }`.

## Tabs

### `list_tabs`
Result: `{ tabs: [ { id, url, title, active } ] }`.

### `new_tab`
`params: { url? }` - open a new tab (optionally at `url`). Result: `{ id }`.

### `switch_tab`
`params: { id }` - make that tab active.

### `close_tab`
`params: { id }` - close that tab.

---

## CDP commands (console / network / HAR / eval)

These use `chrome.debugger`. Attaching shows an "is being debugged" bar in the
browser; it is opt-in. Attach once, act, then read the buffers.

### `cdp_attach`
Attach the debugger to the active tab and start buffering console + network
events. No params. Result: `{ attached: true, tabId }`.

### `cdp_detach`
Detach and stop capturing. Result: `{ attached: false, tabId }`.

### `get_console_logs`
`params: { limit?, clear? }` - return buffered console messages
(`{ type, text, source?, url?, ts }`), newest `limit` (default 200). `clear: true`
empties the buffer after reading. Requires attach.

### `get_network_requests`
`params: { urlContains? }` - return captured requests
(`{ method, url, resourceType, status, mimeType, size, failed }`), optionally
filtered by URL substring. Requires attach.

### `export_har`
Export captured traffic as a HAR 1.2 object: `{ log: { version, creator, entries } }`.
Requires attach. (Bodies are not captured yet; headers/status/timing are.)

### `eval_js`
`params: { expression }` - evaluate a JS expression in the page, return its
JSON-serializable value. If attached, runs via `Runtime.evaluate` (bypasses page
CSP); otherwise in the page MAIN world (subject to CSP).

---

## Added in v0.2

### More DOM interaction (active tab, content script)
- `hover { index }` - dispatch mouseover/enter/move on the element.
- `select_option { index, value?, label? }` - choose a `<select>` option by value or visible text.
- `press_key { key, index? }` - dispatch a key (e.g. `Enter`, `Escape`, `ArrowDown`) to an element or the focused element.
- `wait_for { selector?, text?, gone?, timeoutMs? }` - wait until a selector/text appears (or disappears with `gone:true`); with neither, waits `timeoutMs` (default 1000). Selector/text waits poll in the page up to `timeoutMs` (default 8000).
- `get_page_content { maxChars? }` - extract the main readable text: `{ title, url, text }` (default 8000 chars).

Element robustness: `snapshot` now stamps `data-aibc-ref="<index>"` on each indexed
element, so `click`/`type`/etc. still resolve after minor DOM churn.

### Navigation history & windows
- `go_back` / `go_forward` - history navigation in the active tab.
- `reload { bypassCache? }` - reload (hard reload with `bypassCache:true`).
- `list_windows` - all windows with their tabs.
- `focus_window { id }` - bring a window to the foreground.

### Light network capture (chrome.webRequest - NO debugger banner)
Lighter alternative to the CDP network capture: no "is being debugged" bar, but no
response bodies. Per active tab.
- `net_start` - begin capturing (clears the buffer).
- `net_stop` - stop capturing.
- `net_get { urlContains?, limit? }` - return captured requests
  (`{ method, url, type, status, fromCache, ip, error, timeMs }`); sensitive headers stripped.
- `net_clear` - empty the buffer.

### CDP extras
- `get_response_body { requestId }` - fetch a captured response's body (best-effort; requires attach).
- `export_har { bodies? }` - HAR now redacts sensitive headers; `bodies:true` includes response bodies.
- `capture_screenshot { fullPage?, format? }` - full-page screenshot beyond the viewport (requires attach).

Privacy: `get_network_requests`, `net_get`, and `export_har` redact
Cookie / Set-Cookie / Authorization and similar headers before returning.

---

## Added in v0.3

### Selector-based interaction & web storage (content script)
- `click_selector { selector }` / `fill_selector { selector, value }` - act by CSS selector (no snapshot needed; used by replay).
- `storage_get { area?, key? }` / `storage_set { area?, key, value }` / `storage_remove { area?, key }` / `storage_clear { area? }` - localStorage (`area:"local"`, default) or sessionStorage (`area:"session"`).

### Record & replay
- `record_start` / `record_stop` - record clicks and field changes in the active tab.
- `record_get` - return the recorded steps (`{ type, selector, value?, url? }`).
- `replay { steps?, startUrl? }` - replay recorded (or supplied) steps; navigates to `startUrl` first if given.

### Network idle
- `wait_network_idle { idleMs?, timeoutMs? }` - resolve once no requests are in flight for `idleMs` (default 500), up to `timeoutMs` (default 10000). In-flight requests are pruned after 15s so a hung request can't block idle forever.

### CDP power tools (require `cdp_attach`)
- `coordinate_click { x, y, button? }` / `coordinate_drag { fromX, fromY, toX, toY }` - real mouse input by pixel (canvas/WebGL/maps).
- `a11y_snapshot { max? }` - accessibility tree (role/name/value).
- `element_screenshot { index, format? }` - screenshot one element by snapshot index.
- `print_pdf` - render the page to a PDF (`{ base64 }`).
- `audit` - performance metrics + count of interactive elements missing an accessible name.
- `get_cookies { urlContains? }` / `set_cookie { name, value, url|domain, ... }` / `delete_cookies { name, url? }`.

### Operations
- `reload_extension` - reload the extension from disk (programmatic; the bridge connection drops and reconnects within ~2s). Enables hot-reload during development without touching `edge://extensions`.

---

## Roadmap

- [x] MCP server wrapper (`mcp/`) so Claude Code / Desktop use these as native tools.
- [x] Console-log / network capture + HAR + JS eval (CDP module).
- [x] Capture response bodies in HAR (`Network.getResponseBody`) + `get_response_body`.
- [x] `wait_for` (selector / text / time).
- [x] Light network capture via `chrome.webRequest` (no debugger banner).
- [x] Secret stripping (cookies/auth) on network/HAR output.
- [x] More interaction: hover, select_option, press_key; nav history; windows; full-page screenshot.
- [x] `wait_network_idle` (with stale-request pruning).
- [x] CDP coordinate clicks + drag; accessibility-tree snapshot; element screenshot; PDF; audit; cookies.
- [x] Record & replay; localStorage/sessionStorage; selector-based interaction.
- [x] `reload_extension` for programmatic hot-reload.
- [ ] Streaming WebSocket endpoint for agents (push DOM-change/console events live).
- [ ] Hard tab-group scoping (restrict the agent to an allowed set of tabs).
- [ ] Persistent injected-script channel (cf. mcp-chrome inject_script).
- [ ] Cross-origin iframe / file-dialog handling.
- [ ] Multi-browser / multi-tab sessions addressed by id.
- [ ] Optional API token on the bridge (only needed if it leaves a trusted machine).
