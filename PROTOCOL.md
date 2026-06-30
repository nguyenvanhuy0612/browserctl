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

All actions operate on the **target tab** unless noted. The target is **pinned on
first touch**: the agent's first command pins the focused active tab, and it stays
pinned even if the user switches or opens other tabs — so the agent keeps acting on
its tab while the user works elsewhere, and a snapshot can't silently land on another
(possibly sensitive) tab. `navigate` / `new_tab` / `switch_tab` re-pin explicitly;
`switch_tab` is the way to retarget onto a different (e.g. user) tab. Closing the
target tab unpins it (the next command re-pins the active tab). Use `current_tab` to
check. Because control of a background tab uses CDP (`Page.captureScreenshot`,
`Input.*`), DOM actions and screenshots act on the target even when it is NOT the
visible tab — no activation, no focus steal.

### `current_tab`
No params. Result: `{ id, url, title, active, pinned }` - which tab commands act
on now. `pinned` is true once a target is pinned (i.e. after the first command).

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
Captures the visible viewport of the **target** tab. If the target is the foreground
tab and the debugger isn't attached, uses `chrome.tabs.captureVisibleTab` (no banner).
Otherwise (background tab, or already attached) captures via CDP `Page.captureScreenshot`
so a background tab is captured **without activating it** (no focus steal); this attaches
the debugger and shows the "is being debugged" bar on the target tab. The CDP path
downscales to the vision-token budget (longest side ≤ 1568px) via `clip.scale`.
`params: { format?: "jpeg"|"png", quality? }` - defaults to `jpeg` quality 55; auto-
degrades to quality 30 if still large. Pass `format: "png"` for a lossless image (e.g.
pixel-diff QA). Result: `{ dataUrl: "data:image/<jpeg|png>;base64,..." }`. Restricted
pages (`chrome://`, Web Store) reject the debugger and surface that error.

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
- `capture_screenshot { fullPage?, format?, quality? }` - full-page screenshot beyond the viewport (requires attach). Defaults to `jpeg` quality 55 (auto-degrades to 30 if large); `format:"png"` for lossless. Also: `cdp_attach` now forces `deviceScaleFactor:1` so screenshots are in CSS-pixel space and `coordinate_click`/`coordinate_drag` line up on HiDPI/Retina (e.g. Apple Silicon).

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

## Added in v0.4 ("claude-for-chrome, open" control parity)

Direction: match the official extension's control model, openly (no blocklist / org-lock /
gating), agent stays external. Principle: **DOM-first, CDP-fallback** — structured work via
the content script (no banner), CDP only for pixel input, background-tab capture, protocol
capture, and CSP-bypass eval. See `docs/superpowers/specs/2026-06-30-claude-for-chrome-open-design.md`.

### Background tab control
- Target is **pinned on first touch** and held across user tab switches (see the target-tab
  note up top). `screenshot` captures a background target via CDP without activating it.
- CDP `send` **auto-reattaches once** on "debugger is not attached" (survives tab reloads /
  service-worker recycles).
- `cdp_attach` forces `deviceScaleFactor:1` so screenshots are CSS-pixel and coordinate
  input lines up on HiDPI/Retina.

### Accessibility-tree read & stable refs (content script, no banner)
- `read_page { mode?: "interactive"|"all", depth?, ref_id?, maxChars? }` - the page as compact
  indented text with roles, accessible names, and a stable `ref` on each interactive element
  (`textbox "Email" [ref_5] type="email"`). Cheaper than a screenshot. Depth cap 15, output
  cap ~50k chars with an actionable over-limit note. Does not pierce shadow DOM / iframes.
- `find { query, max? }` - interactive elements whose name/text/placeholder/aria-label contains
  `query`; returns up to `max` `{ ref, role, name, tag }`.
- Stable `ref`s are WeakRef-backed (survive re-snapshots, don't mutate the DOM). `snapshot`
  items now also carry a `ref`. `click` / `type` / `hover` / `select_option` / `press_key`
  accept `ref` in addition to `index`.

### Coordinate input upgrade (CDP)
- `coordinate_click { x, y, button?, clickCount? }` / `coordinate_drag { fromX, fromY, toX, toY }`
  now map coordinates from **screenshot-pixel space to the viewport** automatically (using the
  scale of the last CDP screenshot), and use a real move → press → hold → release sequence with
  the proper button bitmask. Pair with a screenshot first.
- `insert_text { text }` - type into the focused element via `Input.insertText` (robust for
  emoji/IME/multibyte). Requires attach.

### Settle
- `wait_settle { timeoutMs? }` - resolve once `document.readyState === "complete"` AND
  `document.getAnimations().length === 0`. Catches CSS/JS animations that `wait_for` /
  `wait_network_idle` miss. Use before a screenshot/read after navigation.

Deferred (low marginal value for the external-agent model): CDP Mac editor commands
(`Cmd+A`/`Cmd+Z`); mid-action domain re-check (needs an expected-domain the external agent
doesn't supply).

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
- [x] Background tab control (pin-on-first-touch + CDP background screenshot, no focus steal).
- [x] Accessibility-tree read (`read_page`) + WeakRef refs + `find`; ref-based interaction.
- [x] Coordinate remap (screenshot→viewport) + real click sequence + `insert_text`.
- [x] `wait_settle` (readyState + getAnimations).
- [ ] Streaming WebSocket endpoint for agents (push DOM-change/console events live).
- [ ] Persistent injected-script channel (cf. mcp-chrome inject_script).
- [ ] Cross-origin iframe / file-dialog handling.
- [ ] CDP Mac editor commands (`Cmd+A`/`Cmd+Z`) for in-canvas editing.
- [ ] Multi-browser / multi-tab sessions addressed by id.
- [ ] Optional API token on the bridge (only needed if it leaves a trusted machine).
