# Command protocol

Current version: **0.5** (extension, bridge, and MCP server are versioned together).

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

HTTP status codes (they distinguish *your* problem from *the transport's*):

| Status | Meaning |
|---|---|
| 200 | `ok:true` — command ran |
| 400 | The command ran and failed, or the request was malformed. Read `error`: bad params, wrong state ("not attached", "tab not found", "needs foreground"). |
| 503 | No extension connected — start Chrome / press Connect in the popup. |
| 502 | The bridge could not hand the command to the extension. |
| 504 | The extension never replied within the command's timeout. |

A failed command is a **400, not a 500** — so a generic HTTP client (`requests` with
`raise_for_status`, axios defaults) surfaces the actionable `error` instead of turning it
into a transport exception and discarding the body. Only 5xx means "the bridge/extension
link itself is the problem".

All actions operate on the **target tab** unless noted. The target is **pinned on
first touch**: the agent's first command pins the focused active tab, and it stays
pinned even if the user switches or opens other tabs — so the agent keeps acting on
its tab while the user works elsewhere, and a snapshot can't silently land on another
(possibly sensitive) tab. `navigate` / `new_tab` / `switch_tab` re-pin explicitly;
`switch_tab` is the way to retarget onto a different (e.g. user) tab. Closing the
target tab unpins it (the next command re-pins the active tab). Use `current_tab` to
check. DOM actions and screenshots act on the target even when it is NOT the visible
tab — no activation, no focus steal. **Exception:** CDP *synthetic input*
(`coordinate_click`, `coordinate_drag`, `press_key` with modifiers) requires the tab to be
in the foreground; Chrome silently drops it otherwise, so those commands error instead.
See "Synthetic input requires a FOREGROUND tab" under v0.5 below.

**Per-command tab override (`params.tabId`).** Any tab-scoped action may carry a
`tabId` (from `list_tabs`) to run *that one command* against *that specific tab*,
ignoring — and not changing — the pinned target. This lets multiple agents drive
different tabs concurrently: each passes its own `tabId` and they never race on the
single global pin. Omit `tabId` to use the pinned target (unchanged default behavior).
`navigate` with an explicit `tabId` loads that tab without re-pinning; an unknown
`tabId` returns `tab <id> not found` rather than silently falling back to the pin.
Tab/window-management actions (`list_tabs`, `new_tab`, `switch_tab`, `close_tab`,
`group_tab`, `ungroup_tab`, `list_windows`, `focus_window`) do not take `tabId` — they
already take their own `id` or none.

### `current_tab`
No params. Result: `{ id, url, title, active, pinned }` - which tab commands act
on now. `pinned` is true once a target is pinned (i.e. after the first command).

## Bridge <-> extension WebSocket frames

The HTTP `/command` protocol above is what agents use. Internally, the bridge
relays each command to the extension over a WebSocket (`ws://.../extension`)
using its own small frame protocol:

- Request (bridge -> extension): `{ "id", "action", "params" }` - same
  `action`/`params` as the HTTP body, plus a `id` (UUID) the bridge generates to
  match the reply.
- Reply (extension -> bridge): `{ "id", "ok", "result" }` on success or
  `{ "id", "ok": false, "error" }` on failure - `id` echoes the request. The
  bridge un-wraps this into the HTTP response (dropping `id`).
- Heartbeat (bridge -> extension -> bridge): `{ "type": "ping" }` every 20s,
  answered with `{ "type": "pong" }`. This is an application-level message (not
  a WS protocol ping/pong frame) because only a message wakes the extension's
  MV3 service worker; it both resets the SW idle timer and lets the bridge
  detect a dead extension.

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
`params: { url }` - load `url` in the target tab (re-pins it as the target).
Returns `{ url }` once loaded.

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

### `group_tab`
`params: { id?, title?, color? }` - put a tab into a labeled tab group (defaults
to the target tab, `title:"bctl"`, `color:"blue"`) so the user can see which tab
the agent drives. Does not activate the tab; also pins it as the target. Result:
`{ groupId, tabId, title, color }` (or a `titled:false` note if the `tabGroups`
permission is unavailable and only the grouping succeeded).

### `ungroup_tab`
`params: { id? }` - remove a tab from its tab group (defaults to the target
tab). Result: `{ ungrouped: id }`.

### `switch_tab`
`params: { id, focus? }` - activate that tab (making it the target). `focus:
true` also raises its window to the foreground (steals OS focus); default
`false` just activates the tab within its window.

### `close_tab`
`params: { id }` - close that tab. Unpins the target if it was the closed tab.

---

## CDP commands (console / network / HAR / eval)

These use `chrome.debugger`. Attaching shows an "is being debugged" bar in the
browser; it is opt-in. Attach once, act, then read the buffers.

### `cdp_attach`
Attach the debugger to the target tab and start buffering console + network
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
Requires attach. Headers/status/timing are always included; pass `bodies: true`
to also include response bodies (see `export_har { bodies? }` under "CDP extras" below).

### `eval_js`
`params: { expression }` - evaluate a JS expression in the page, return its
JSON-serializable value. If attached, runs via `Runtime.evaluate` (bypasses page
CSP); otherwise in the page MAIN world (subject to CSP).

---

## Added in v0.2

### More DOM interaction (target tab, content script)
- `hover { index }` - dispatch mouseover/enter/move on the element.
- `select_option { index, value?, label? }` - choose a `<select>` option by value or visible text.
- `press_key { key, index?, ref?, modifiers? }` - dispatch a key (e.g. `Enter`, `Escape`, `ArrowDown`) to
  an element (by `index` or `ref`) or the focused element (neither given). If `modifiers` (e.g.
  `["Meta","Shift"]`) are given AND the debugger is already attached (`cdp_attach`), the press is
  internally routed through CDP instead of the DOM, and on Mac drives real editor commands for
  Cmd+A/Z/C/V/X (select-all/undo/redo/copy/paste/cut). Call `cdp_attach` first if you need modifiers:
  without a prior attach, a `press_key` with `modifiers` returns an error (`"modifiers require cdp_attach"`)
  rather than silently sending an unmodified key.
- `wait_for { selector?, text?, gone?, timeoutMs? }` - wait until a selector/text appears (or disappears with `gone:true`); with neither, waits `timeoutMs` (default 1000). Selector/text waits poll in the page up to `timeoutMs` (default 8000).
- `get_page_content { maxChars? }` - extract the main readable text: `{ title, url, text }` (default 8000 chars).

Element robustness: `snapshot` now stamps `data-bctl-ref="<index>"` on each indexed
element, so `click`/`type`/etc. still resolve after minor DOM churn.

### Navigation history & windows
- `go_back` / `go_forward` - history navigation in the target tab.
- `reload { bypassCache? }` - reload (hard reload with `bypassCache:true`).
- `list_windows` - all windows with their tabs.
- `focus_window { id }` - bring a window to the foreground.

### Light network capture (chrome.webRequest - NO debugger banner)
Lighter alternative to the CDP network capture: no "is being debugged" bar, but no
response bodies. Per target tab.
- `net_start` - begin capturing (clears the buffer).
- `net_stop` - stop capturing.
- `net_get { urlContains?, limit? }` - return captured requests
  (`{ method, url, type, status, fromCache, ip, error, timeMs }`); headers verbatim.
- `net_clear` - empty the buffer.

### CDP extras
- `get_response_body { requestId }` - fetch a captured response's body (best-effort; requires attach).
- `export_har { bodies? }` - HAR export; `bodies:true` includes response bodies.
- `capture_screenshot { fullPage?, format?, quality? }` - full-page screenshot beyond the viewport (requires attach). Defaults to `jpeg` quality 55 (auto-degrades to 30 if large); `format:"png"` for lossless. Also: `cdp_attach` now forces `deviceScaleFactor:1` so screenshots are in CSS-pixel space and `coordinate_click`/`coordinate_drag` line up on HiDPI/Retina (e.g. Apple Silicon).

Headers: `get_network_requests`, `net_get`, and `export_har` return request/response
headers verbatim (including Cookie / Authorization) — this is a local, internal-only
tool. Add a redaction pass in `util.js` if pointing it at a shared/untrusted context.

---

## Added in v0.3

### Selector-based interaction & web storage (content script)
- `click_selector { selector }` / `fill_selector { selector, value }` - act by CSS selector (no snapshot needed; used by replay).
- `storage_get { area?, key? }` / `storage_set { area?, key, value }` / `storage_remove { area?, key }` / `storage_clear { area? }` - localStorage (`area:"local"`, default) or sessionStorage (`area:"session"`).

### Record & replay
- `record_start` / `record_stop` - record clicks and field changes in the target tab.
- `record_get` - return the recorded steps: `{ count, steps }`. Each step is either
  `{ type: "click", selector, text }` (element's visible text, truncated to 40 chars) or
  `{ type: "input", selector, value }` (a field's new value on `change`). Selectors are
  CSS, built to be replay-stable (id if unique, else an `nth-of-type` path). Navigation is
  **not** recorded - `replay` accepts a `{ type: "navigate", url }` step, but the recorder
  itself never emits one; add navigate steps by hand if a replay needs to change pages.
- `replay { steps?, startUrl? }` - replay recorded (or supplied) steps; navigates to `startUrl` first if given.

### Network idle
- `wait_network_idle { idleMs?, timeoutMs? }` - resolve once no requests are in flight for `idleMs` (default 500), up to `timeoutMs` (default 10000). In-flight requests are pruned after 15s so a hung request can't block idle forever.

### CDP power tools (require `cdp_attach`)
- `coordinate_click { x, y, button? }` / `coordinate_drag { fromX, fromY, toX, toY }` - real mouse input by pixel (canvas/WebGL/maps).
- `a11y_snapshot { max? }` - accessibility tree (role/name/value).
- `element_screenshot { index?, ref?, format? }` - screenshot one element, addressed by
  snapshot `index` or a stable `ref` (from `read_page`/`find`/`snapshot`); resolved by the
  content script (so shadow-DOM elements work too), then clipped via CDP.
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
capture, and CSP-bypass eval. See `docs/design/claude-for-chrome-open-design.md`.

### Background tab control
- Target is **pinned on first touch** and held across user tab switches (see the target-tab
  note up top). `screenshot` captures a background target via CDP without activating it.
- CDP `send` **auto-reattaches once** on "debugger is not attached" (survives tab reloads /
  service-worker recycles).
- `cdp_attach` forces `deviceScaleFactor:1` so screenshots are CSS-pixel and coordinate
  input lines up on HiDPI/Retina.
- `spoof_visibility` - many sites deliberately pause lazy-load/infinite-scroll while
  `document.hidden` is true (a resource-saving pattern gated on the Page Visibility API), so
  scrolling a genuinely backgrounded tab can load zero new content even though scrolling
  itself and reading already-loaded DOM both work fine in the background. This action
  patches `document.hidden`/`visibilityState` to report visible and fires a
  `visibilitychange` event, WITHOUT activating the tab — confirmed to unstick Facebook's
  feed lazy-load in exactly this scenario. Explicit and opt-in (call once before scrolling a
  background tab that needs to lazy-load); not automatic on every scroll, since visibility
  state is also used for things a site may not want spoofed unconditionally (video autoplay,
  polling/websocket resume, analytics time-on-page). Attaches CDP if not already attached.
  **Known limitation:** patches JS-visible state only, not Chrome's renderer-level
  throttling of a backgrounded tab (`requestAnimationFrame` doesn't fire; `IntersectionObserver`
  rides the same throttled pipeline) — a site whose lazy-load depends on rAF/IO rather than a
  visibilitychange/scroll listener may still not budge. No automatic fallback is built for
  that case; briefly foregrounding the tab and restoring focus afterward is a deliberate
  manual decision this action will never make on its own.

### Accessibility-tree read & stable refs (content script, no banner)
- `read_page { mode?: "interactive"|"all", depth?, ref_id?, maxChars? }` - the page as compact
  indented text with roles, accessible names, and a stable `ref` on each interactive element
  (`textbox "Email" [ref_5] type="email"`). Cheaper than a screenshot. Depth cap 15, output
  cap ~50k chars with an actionable over-limit note. Pierces open shadow DOM, and covers
  iframes (including cross-origin) via all_frames injection — sub-frame content is appended
  under an `iframe [f<id>] <url>` header with frame-qualified refs (e.g. `f3:ref_5`).
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

Deferred (low marginal value for the external-agent model): mid-action domain re-check
(needs an expected-domain the external agent doesn't supply).

---

## Roadmap

- [x] MCP server wrapper (`mcp/`) so Claude Code / Desktop use these as native tools.
- [x] Console-log / network capture + HAR + JS eval (CDP module).
- [x] Capture response bodies in HAR (`Network.getResponseBody`) + `get_response_body`.
- [x] `wait_for` (selector / text / time).
- [x] Light network capture via `chrome.webRequest` (no debugger banner).
- [ ] Secret stripping (cookies/auth) on network/HAR output - **not planned**: headers are
  returned verbatim by design (see "Headers" note under "Added in v0.2"); this is a local,
  single-user, internal tool, not a shared/untrusted service.
- [x] More interaction: hover, select_option, press_key; nav history; windows; full-page screenshot.
- [x] `wait_network_idle` (with stale-request pruning).
- [x] CDP coordinate clicks + drag; accessibility-tree snapshot; element screenshot; PDF; audit; cookies.
- [x] Record & replay; localStorage/sessionStorage; selector-based interaction.
- [x] `reload_extension` for programmatic hot-reload.
- [x] Background tab control (pin-on-first-touch + CDP background screenshot, no focus steal).
- [x] Accessibility-tree read (`read_page`) + WeakRef refs + `find`; ref-based interaction.
- [x] Coordinate remap (screenshot→viewport) + real click sequence + `insert_text`.
- [x] `wait_settle` (readyState + getAnimations).
- [x] `group_tab` / `ungroup_tab` (labeled tab group as a visual "which tab is the agent driving" marker).
- [ ] Streaming WebSocket endpoint for agents (push DOM-change/console events live).
- [ ] Persistent injected-script channel (cf. mcp-chrome inject_script).
- [x] Cross-origin iframe support (all_frames injection + frame-qualified refs; DOM read + interaction routed per frame). Sub-frame `element_screenshot` offset and file-dialog handling still open.
- [x] CDP Mac editor commands (`Cmd+A`/`Cmd+Z`/copy/paste/cut) via `press_key` modifiers.
- [x] Multi-tab addressing: per-command `params.tabId` runs a command against a specific
  tab without changing the pinned target, so multiple agents can drive different tabs
  concurrently. (Multi-*browser* sessions — separate cookie jars — still open.)
- [ ] Optional API token on the bridge (only needed if it leaves a trusted machine).

---

## Added in v0.5

### Synthetic input requires a FOREGROUND tab (important constraint)

Verified 2026-08-04 on Chrome/macOS. Chrome delivers CDP **synthetic input** only to the
tab that is active in a focused window. On a background tab, `Input.dispatchMouseEvent`
and `Input.dispatchKeyEvent` are accepted and report success **while doing nothing at
all** — no keydown reaches the page, no click handler fires.

Affected commands, which now **fail loudly** instead of silently no-op'ing:

- `coordinate_click`
- `coordinate_drag`
- `press_key` **with** `modifiers` (the CDP path, incl. the Mac editor commands)

Not affected — these work on a background tab:

- `insert_text` (`Input.insertText` targets the focused editable directly)
- `screenshot` / `capture_screenshot` / `element_screenshot` (`Page.captureScreenshot`)
- every DOM-level action: `click`, `click_selector`, `type`, `fill_selector`, `hover`,
  `select_option`, `scroll`, `press_key` **without** modifiers
- console / network / HAR capture, `eval_js`, cookies, storage

The error names both remedies: foreground the tab (`switch_tab { id, focus: true }` —
steals focus), or use a DOM-level equivalent.

This is the single most important limitation of the background-control model. Everything
else in the project genuinely works on a hidden tab; **pixel-level input does not**.

### `press_key { allowSynthetic? }`

With `modifiers` on a background tab, `allowSynthetic: true` dispatches a synthetic DOM
`KeyboardEvent` (with `metaKey`/`ctrlKey`/`shiftKey`/`altKey` set) via the content script
instead of erroring. A page's own shortcut handler fires; **native editing does not** —
`Cmd+A` will not select text this way.

The result always reports which path ran:

```jsonc
{ "pressed": "a", "modifiers": ["Meta"], "commands": ["selectAll"], "via": "cdp" }
{ "pressed": "a", "modifiers": ["Meta"], "via": "dom" }
```

The content-script path previously **dropped modifiers silently**; it now reflects them
on the event.

### Zero is honoured on numeric params

`snapshot { maxText: 0 }` (elements only, no page text — useful for saving context),
`get_console_logs { limit: 0 }`, `net_get { limit: 0 }`, `a11y_snapshot { max: 0 }` and
`wait_for { timeoutMs: 0 }` now mean what they say. They were previously coerced to their
defaults by `||`.

### Previously undocumented commands

- `describe_element { index? | ref? }` — full detail on one element:
  `{ tag, text, attributes, rect: {x,y,width,height}, visible, visibilityReason }`.
  `visibilityReason` is one of `visible`, `zero-size rect`, `visibility:hidden`,
  `display:none`, `opacity:0`, `disabled` — use it to explain *why* a click did nothing.
- `find_text { query, regex?, max?, contextChars? }` — search the page's visible **text**
  (not elements) and return matches with surrounding context. `regex: true` treats
  `query` as a JS regex; literal mode is whitespace-tolerant so a phrase matches across
  the raw HTML's newlines. A miss returns `{ matches: [] }`, not an error.
- `read_pdf` — `{ isPdf, url?, note? }`. Chrome's built-in PDF viewer has no readable
  DOM, so every content action fast-fails on such a tab; call this to confirm and get the
  URL. `open_and_read` probes it before attempting any DOM read.

### `cdp_send { method, params? }` — raw CDP escape hatch

Requires `cdp_attach`. Sends any method in Chrome's `chrome.debugger` domain allowlist to
the target tab and returns `{ method, result }` verbatim (`result: null` for methods that
return nothing). Exists so a capability with no first-class command yet can be used or
prototyped without shipping a command per method — and so answering a CDP question does
not require editing the extension and reloading it.

Reachable this way today, with no new code: `Fetch.*` (request interception, mocking,
`continueWithAuth` for HTTP basic-auth), `DOM.setFileInputFiles` (file upload),
`Page.setInterceptFileChooserDialog` / `Page.handleJavaScriptDialog` (dialogs),
`Emulation.*` (device metrics, CPU/network throttling, timezone, locale, geolocation,
`prefers-color-scheme`), `Storage.*`, `Tracing.*`.

`DOMStorage` and `IndexedDB` are **not** in the allowlist — those calls come back with
Chrome's own `wasn't found` error, which `cdp_send` surfaces rather than swallowing.

Two footguns, both deliberate (power tool, single-user bridge): enabling an interception
domain without handling its events (e.g. `Fetch.enable`) pauses page traffic until you
disable it, and `Emulation.setDeviceMetricsOverride` changes the screenshot scale that
`coordinate_click` remaps against.

### Actionability warnings on DOM actions

`click`, `type`, `hover`, `select_option`, `click_selector`, `fill_selector` now check the
target before acting:

- **`disabled` → hard error.** Browsers suppress input to a disabled control, so acting and
  reporting success would be a lie. Verified: the handler does not fire.
- **Any other non-visible reason** (`display:none`, `visibility:hidden`, `opacity:0`,
  `zero-size rect`) → the action still runs and the result carries
  `warning: "element is not visible (<reason>) — ..."`. These handlers act via `el.click()`
  and the native value setter, which *do* fire handlers on a hidden element, so refusing
  would remove working capability (a 0-size input behind a styled label is a real case).

`visibilityReason` now reports the most specific cause first, so a `display:none` element
says `display:none` rather than the symptom `zero-size rect`.

### Fresh-pin guard on content-returning commands

If the pin has been lost — the target tab was closed, the browser session ended, or the
extension was reloaded — the pin-on-first-touch rule would adopt whatever tab the user is
looking at *and hand back its content*. That is how a read once landed on a personal chat
tab.

A content-returning command in that state now **refuses once**, naming the tab it would
have read, and pins it as a side effect. Re-issue the same command to proceed, or retarget
first with `switch_tab` / `navigate` / `new_tab` / an explicit `tabId`. Guarded commands:
`snapshot`, `read_page`, `find`, `find_text`, `get_page_content`, `describe_element`,
`a11y_snapshot`, `screenshot`, `capture_screenshot`, `element_screenshot`, `print_pdf`,
`eval_js`, `read_pdf`, `get_cookies`, `storage_get`, `export_har`, `get_console_logs`,
`get_network_requests`, `get_response_body`, `net_get`, `audit`.

Not guarded: navigation and tab/window management (they leak nothing), and any command
carrying an explicit `tabId` (that is a deliberate choice).

### `GET /status`, exposed as `browser_status`

`browser_status` reports `{ bridgeReachable, extensionConnected, ready, hint }` **without
running a browser command** — every other tool needs the extension, so they could only
report its absence by failing. Deliberately does not go through `/command`.
