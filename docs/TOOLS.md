# Tool surface as it actually is — generated 2026-09-14, browserctl 0.8.0

Generated from the running server (`server._registeredTools`), not written by hand — the last
hand-written version of this list claimed `all` on a tool that did not have it.

`*` = required. `tabId`/`tab_id` accepted on every tab-scoped tool, omitted from the tables.


### core (25)

| Tool | Parameters | Description |
|---|---|---|
| `status` | format | [SESSION] Whether the bridge is reachable, the daemon's state, and whether the Chrome extension is connected. |
| `start` | (none) | [SESSION] Start the bridge daemon if it is not running. It starts itself on demand, so this is rarely needed. |
| `stop` | (none) | [SESSION] Stop the local browserctl bridge daemon. DO NOT call this to tidy up when a task is finished — |
| `snapshot` | scope, compact, format, maxText, limit, cursor | [READ] A text census of the page's controls: one line per element with a stable 'ref' to act on, in reading order. Start here to see what is on a page. |
| `read_page` | mode, depth, target, maxChars, format | [READ] The accessibility tree as indented text — which control sits inside which group, form or region — with a ref on each interactive element. Structure, not prose. |
| `find` | query, selector, in, regex, contextChars, max, format | [READ] Find things on the page and get a ref back for each. in: 'controls' (default) matches interactive elements by accessible name, text, placeholder, aria-label or title, and 'matchedBy' says which of those hit; in: 'text' searches the page's prose instead and each match carries 'nearestInteractive'. |
| `extract` | *selector, fields, max, format | [READ] Extract structured rows from repeating containers without writing JavaScript. |
| `get_content` | maxChars, format | [READ] The page's main readable prose — title, url, cleaned article text. For documentation, articles and postings. |
| `get_property` | target, property, attr, format | [READ] Read an element's text, value, HTML, box, an attribute, or how many match. |
| `click` | *target, doubleClick, button, waitFor, autoSettle, settleMs, format | [ACT] Click an element by 'target' (ref '@ref_1', CSS selector, visible text, or snapshot index). |
| `type` | *target, *text, method, submit, waitFor, autoSettle, settleMs, format | [ACT] Put text into any editable target — input, textarea, contenteditable, or rich-text editor. |
| `fill_form` | *fields, submitTarget, format | [ACT] Fill several form fields in one round-trip. On failure, stops and reports the failed index and which fields were already written. |
| `select_option` | *target, values, value, option, label, format | [ACT] Select one or more options in a <select> element. Values are matched by value first, then by visible label. |
| `press_key` | *key, target, modifiers, allowSynthetic, format | [ACT] Send a key, or a chord with modifiers, to an element or to whatever has focus. |
| `scroll` | direction, amount, target, format | [ACT] Scroll the page, or a specific container when the window itself does not move — a drawer, a table, an overflow:auto div. |
| `hover` | *target, format | [ACT] Move the pointer onto an element, to open a flyout menu or raise a tooltip. |
| `file_upload` | target, files, file, format | [ACT] Attach one or more local files to an <input type=file> and fire the page's change/input handlers, the way a human's file picker does. |
| `wait_for` | for, selector, text, gone, timeoutMs, format | [WAIT] Wait for a selector or page text to appear, or to disappear with gone: true. |
| `take_screenshot` | fullPage, target, format, quality | [WAIT] Capture the target tab as an image, without activating it. JPEG by default; format: 'png' for a lossless one. |
| `navigate` | url, reload, format | [NAV] Navigate the pinned tab to a URL, or reload it. |
| `tabs` | *action, url | [NAV] Manage browser tabs: list all tabs, open a new tab, select/re-pin a tab, or close a tab. |
| `evaluate` | *expression, format | [EXTEND] Run a JavaScript expression in the target page and return its value. The value must be JSON-serializable. |
| `action` | action, params, format | [EXTEND] Dispatch any protocol action by name, including ones whose tool is not loaded: browser_action({action, params}). |
| `load_tools` | profile, tools, format | [EXTEND] Load a profile of tools that are not currently visible: network (capture every request, read response bodies, export a HAR, wait for network idle), cookies (read, set, delete), storage (localStorage, sessionStorage, IndexedDB), console (console messages and page errors), cdp (raw CDP, coordinate input, audit), record (record and replay), tabs (windows, groups, visibility), advanced (a11y tree, PDF, history, element screenshots, hover), system (a shell command on the bridge host, not the page), or all. |
| `list_available_tools` | format | [EXTEND] Every capability this server has, loaded or not, with its parameters. |

### system (1)

| Tool | Parameters | Description |
|---|---|---|
| `exec_system_cmd` | *command, cwd, env, timeoutMs | [SESSION] Execute a shell/system command on the host running the bridge server. Returns exitCode, stdout, stderr, all (combined output), failed, timedOut, and signal. |

### network (8)

| Tool | Parameters | Description |
|---|---|---|
| `get_network_requests` | urlContains, format | Return network requests captured since attach (method, url, status, type, size). Requires browser_cdp_attach. |
| `get_response_body` | *requestId, format | Fetch the response body of a captured request by its requestId (from get_network_requests). Best-effort; bodies may be evicted. Requires browser_cdp_attach. |
| `export_har` | bodies, format | Export captured network traffic as a HAR 1.2 object (headers, status, timing). Headers are included verbatim (local tool, no redaction). Set bodies=true to also include response bodies (best-effort, slower). Requires browser_cdp_attach. |
| `net_start` | format | Start capturing network requests for the target tab via webRequest. No debugger banner, but no response bodies. Clears the previous buffer. |
| `net_stop` | format | Stop the webRequest capture for the target tab. |
| `net_get` | urlContains, limit, format | Return network requests captured by the light webRequest capture (method, url, type, status, timing). Headers are included verbatim (local tool, no redaction). |
| `net_clear` | format | Clear the light network capture buffer for the target tab. |
| `wait_network_idle` | idleMs, timeoutMs, maxInFlight, format | Wait until the target tab has had no in-flight requests for idleMs (default 500), up to timeoutMs (default 10000). For modern SPAs with persistent WebSockets, telemetry, or long-polling (YouTube, Algolia, Twitter, Azure Portal), network-idle may time out waiting for 0 requests; use browser_wait_for({for:'settle'}) instead or set maxInFlight to tolerate background connections. |

### cdp (8)

| Tool | Parameters | Description |
|---|---|---|
| `handle_dialog` | action, promptText, format | Answer an alert/confirm/prompt that is ALREADY open and suspending the page. Call it bare, or action: 'peek', to read one without answering. |
| `cdp_attach` | format | Attach the debugger to the target tab to start capturing console logs and network traffic. Shows an 'is being debugged' bar in the browser. Call this before get_console_logs / get_network_requests / export_har. |
| `cdp_detach` | format | Detach the debugger from the target tab and stop capturing. Removes the debugging bar. |
| `cdp_send` | *method, params, format | POWER TOOL. Send any Chrome DevTools Protocol method to the target tab and get its result verbatim. Requires browser_cdp_attach first. Use it for capabilities that have no dedicated tool yet — Fetch.* (request interception / mocking / HTTP auth), DOM.setFileInputFiles (file upload), Page.handleJavaScriptDialog (alert/confirm), Emulation.* (device metrics, throttling, timezone, locale, geolocation, prefers-color-scheme), Storage.*, Tracing.*. Only domains in Chrome's chrome.debugger allowlist work; notably DOMStorage and IndexedDB are NOT available. Two footguns: enabling an interception domain without handling its events (e.g. Fetch.enable) pauses page traffic until you disable it, and Emulation.setDeviceMetricsOverride changes the screenshot scale that browser_coordinate_click depends on. |
| `coordinate_click` | *x, *y, button, clickCount, format | Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead. |
| `coordinate_drag` | *fromX, *fromY, *toX, *toY, format | Press at (fromX,fromY), move to (toX,toY), release. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead. |
| `insert_text` | *text, format | Type text into the focused element via CDP Input.insertText — robust for emoji/IME/multibyte that key-by-key typing can't represent. Click/focus the field first. Requires browser_cdp_attach. |
| `audit` | format | Lightweight audit: performance metrics (DOM nodes, JS heap, layout/script timing) plus an accessibility count of interactive elements missing a name. Requires browser_cdp_attach. |

### cookies (3)

| Tool | Parameters | Description |
|---|---|---|
| `get_cookies` | urlContains, url, allDomains, limit, format | Return the cookies that apply to the TARGET TAB's current page (this is the default scope, and the answer to "what cookies did this page set"). Pass allDomains:true to read every cookie in the browser profile instead — that returns the user's whole session jar across all sites, so ask for it only when the task really needs it. Capped at 200 cookies; the response says when it truncated. Requires browser_cdp_attach. |
| `set_cookie` | *name, *value, url, domain, path, secure, httpOnly, expires, format | Set a cookie (provide url or domain). Useful for test setup. Requires browser_cdp_attach. |
| `delete_cookies` | *name, url, format | Delete cookies by name (optionally scoped to a url). Requires browser_cdp_attach. |

### storage (4)

| Tool | Parameters | Description |
|---|---|---|
| `storage_get` | area, key, format | Read localStorage or sessionStorage. With a key returns its value; without, returns all items. |
| `storage_set` | area, *key, *value, format | Set a key in localStorage or sessionStorage (test fixtures, feature flags). |
| `storage_remove` | area, *key, format | Remove a key from localStorage or sessionStorage. |
| `storage_clear` | area, format | Clear all of localStorage or sessionStorage. |

### console (1)

| Tool | Parameters | Description |
|---|---|---|
| `get_console_logs` | limit, clear, format | Return buffered console messages (log/warn/error/exceptions) captured since attach. Requires browser_cdp_attach. |

### record (4)

| Tool | Parameters | Description |
|---|---|---|
| `record_start` | format | Start recording user interactions (clicks, field changes) in the target tab. Replay later with browser_replay. |
| `record_stop` | format | Stop recording interactions. |
| `record_get` | (none) | Return the recorded interaction steps. |
| `replay` | startUrl, steps, format | Replay recorded steps (or supplied steps) against the target tab. Optionally navigate to startUrl first. |

### tabs (6)

| Tool | Parameters | Description |
|---|---|---|
| `list_windows` | (none) | List all browser windows with their tabs. |
| `focus_window` | *id | Bring the window with the given id to the foreground. Steals the user's OS focus — use only when the user explicitly asks to surface a window, not as part of background work. |
| `group_tab` | id, title, color | Put a tab into a labeled, colored tab group so you (and the user) can see which tab the agent drives. Defaults to the target tab; pass id to group a specific tab. Does NOT activate the tab (no focus steal) and pins the grouped tab as the target. |
| `ungroup_tab` | id | Remove a tab from its tab group. Defaults to the target tab. |
| `spoof_visibility` | format | Make the target tab's page JS believe it's visible/focused (document.hidden=false, document.visibilityState='visible', fires a visibilitychange event), WITHOUT actually foregrounding the tab or stealing the user's focus. Use this when scrolling a backgrounded tab isn't loading new content — many sites (e.g. infinite-scroll feeds) deliberately pause lazy-loading via the Page Visibility API while a tab is hidden, as a resource-saving pattern. This is explicit and opt-in on purpose: call it once before scrolling a background tab that needs to lazy-load, not automatically on every scroll — visibility state is also used for other things a site might not want spoofed unconditionally (video autoplay, polling/websocket resume, analytics time-on-page). Attaches the CDP debugger if not already attached (shows the 'is being debugged' bar). KNOWN LIMITATION: this patches JS-visible state only — it does not lift Chrome's renderer-level throttling of a backgrounded tab (requestAnimationFrame doesn't fire, IntersectionObserver rides the same throttled pipeline). If a site's lazy-load is driven by rAF/IO rather than a visibilitychange or scroll listener, this may not help; there is no further automatic fallback (foregrounding the tab, even briefly, is a deliberate manual decision this tool will never make for you). |
| `current_tab` | format | Report which tab commands currently act on (id, url, title, and whether a target is pinned). The target is pinned on your first command and held across user tab switches. Call this to confirm you're on the right page before snapshotting or reading sensitive content. |

### advanced (9)

| Tool | Parameters | Description |
|---|---|---|
| `unload_tools` | profile, tools, format | [EXTEND] Unload specific tool categories or reset active tools back to the lightweight 'core' profile. Frees system prompt tokens when specialized tools are no longer needed. |
| `describe_element` | selector, ref, index, placeholder, format | Given a CSS 'selector', 'ref', or 'index', return everything useful for debugging it: tag, full attribute dump, bounding rect, visibility verdict WITH the specific reason ('visible' \| 'display:none' \| 'visibility:hidden' \| 'zero-size rect' \| 'opacity:0' \| 'disabled'), and whether it matches the interactive selector. Pierces open Shadow DOM. |
| `a11y_snapshot` | max, format | SECOND OPINION on the page, from Chrome itself. Returns Chrome's own accessibility tree — the role, name and state it computes for every control by the HTML-AAM spec — not browserctl's census. Each node carries a 'ref' where the census has the same control, so results are directly actionable. |
| `read_pdf` | format | Call this when the target tab is showing a PDF (browser_get_content/browser_find/browser_snapshot/browser_click all fail on a PDF tab with 'no readable DOM' — Chrome's built-in PDF viewer isn't a real DOM, so those tools cannot see its text). Returns the tab's URL and an isPdf verdict; this extension does NOT extract PDF text itself (a hand-rolled parser silently mis-reads subset/CID-font PDFs — dangerous for numeric data like a rate sheet). Fetch the returned URL yourself and read it with your own PDF-reading capability instead of retrying the DOM-based tools. |
| `element_screenshot` | index, ref, format | Capture just one element as an image, identified by 'ref' (from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref. Requires browser_cdp_attach. |
| `print_pdf` | format | Render the page to a PDF; returns base64 (save it to a .pdf file). Requires browser_cdp_attach. |
| `go_back` | format | Navigate back in the target tab's history. |
| `go_forward` | format | Navigate forward in the target tab's history. |
| `reload_extension` | (none) | Reload the browser extension itself from disk (dev convenience; picks up edited extension code). The connection drops briefly and reconnects. |
