# Tool surface as it actually is — generated 2026-11-12, browserctl 0.9.8

Generated from the running server (`server._registeredTools`), not written by hand — the last
hand-written version of this list claimed `all` on a tool that did not have it.

`*` = required. `tabId`/`tab_id` accepted on every tab-scoped tool, omitted from the tables.


### core (20)

| Tool | Parameters | Description |
|---|---|---|
| `status` | format | [SESSION] Check bridge daemon status, connection state, and Chrome extension connectivity. |
| `start` | (none) | [SESSION] Start the local bridge daemon if stopped. The bridge auto-starts on demand, so manual start is rarely required. |
| `stop` | (none) | [SESSION] Stop the local bridge daemon. DO NOT call this to tidy up when a task is finished — |
| `snapshot` | scope, target, maxDepth, maxText, limit, cursor, format | [READ] Capture structured W3C Accessibility Tree with interactive @e tokens in reading order. |
| `extract` | *selector, fields, max, format | [READ] Extract structured rows from repeating containers without writing JavaScript. |
| `get_property` | target, property, attr, format | [READ] Read an element's text, value, HTML, box, an attribute, or how many match. |
| `click` | *target, doubleClick, button, waitFor, autoSettle, settleMs, format | [ACT] Click an element by target (@e token like '@e1', CSS selector, visible text, or index). |
| `type` | *target, *text, method, submit, clearBefore, waitFor, autoSettle, settleMs, format | [ACT] Enter text into an input, textarea, contenteditable, or rich text editor. |
| `fill_form` | *fields, submitTarget, format | [ACT] Fill multiple form inputs, checkboxes, radios, and selects in a single batch. |
| `scroll` | mode, direction, amount, target, x, y, deltaX, deltaY, modifiers, format | [ACT] Scroll the window or a specific scrollable container (modal, table, overflow div), or dispatch hardware wheel events (mode: 'wheel') for Canvas/WebGL/maps. |
| `file_upload` | target, files, file, format | [ACT] Attach local files to an <input type=file> and trigger input/change events. |
| `wait_for` | for, selector, text, gone, idleMs, maxInFlight, timeoutMs, format | [WAIT] Wait for element, text, settle, or network-idle condition. |
| `take_screenshot` | fullPage, target, format, quality | [WAIT] Capture viewport or element image without activating the window. Default format: JPEG (or 'png' for lossless). |
| `navigate` | url, reload, history, format | [NAV] Navigate session target tab to a URL, reload it, or step history. |
| `tabs` | *action, id, url, browser, query, activate, force, title, color | [NAV] List, new, select, close, release, yield, inspect current, or group/ungroup tabs across connected browsers. |
| `make_request` | url, method, headers, body, json, query, credentials, timeout_ms, pointer, requestId, format | [NET] Execute an HTTP request directly inside the target tab context inheriting session cookies, or replay a captured request by requestId. Generates executable minimal curl command. |
| `monitor_requests` | action, url_pattern, method, status, resource_type, limit, since_id, include_body, requestId, pointer, timeout_ms, format | [NET] Inspect, filter, or wait for captured network requests. Supports filtering by url_pattern, method, status, type, inline response bodies, inspecting single request details, or waiting for request to finish. |
| `evaluate` | *expression, format | [EXTEND] Evaluate a JavaScript expression in the page context and return serialized result. |
| `action` | action, params, format | [EXTEND] Dispatch any protocol action by name without loading its profile: browser_action({action, params}). |
| `load_tools` | profile, tools, format | [EXTEND] Load additional tool profile into session (profiles: 'network' [capture every request], 'cookies', 'storage' [localStorage], 'console' [console messages], 'cdp', 'record', 'tabs', 'advanced', 'system', 'all'). |

### system (1)

| Tool | Parameters | Description |
|---|---|---|
| `exec_system_cmd` | *command, cwd, env, timeoutMs | [SESSION] Execute a shell/system command on the host running the bridge server. Returns exitCode, stdout, stderr, all (combined output), failed, timedOut, and signal. |

### network (3)

| Tool | Parameters | Description |
|---|---|---|
| `mock_route` | *action, ruleId, match, effect, format | Add, remove, list, or clear declarative network interception rules via CDP Fetch domain. Allows mocking response body/status or blocking URLs. |
| `export_har` | bodies, format | Export captured network traffic as a HAR 1.2 object (headers, status, timing). Headers are included verbatim (local tool, no redaction). Set bodies=true to also include response bodies (best-effort, slower). Requires browser_cdp({action:'attach'}). |
| `net_capture` | *action, urlContains, limit, format | Start, stop, read, or clear lightweight webRequest network capture on the target tab (no debugger banner, no response bodies; headers are included verbatim). |

### cdp (4)

| Tool | Parameters | Description |
|---|---|---|
| `handle_dialog` | action, promptText, format | Answer an alert/confirm/prompt that is ALREADY open and suspending the page. Call it bare, or action: 'peek', to read one without answering. |
| `cdp` | *action, method, params, format | Attach/detach the CDP debugger or send a raw CDP method on the target tab. |
| `coordinate_click` | *x, *y, button, clickCount, format | Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp({action:'attach'}). REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead. |
| `audit` | format | Lightweight audit: performance metrics (DOM nodes, JS heap, layout/script timing) plus an accessibility count of interactive elements missing a name. Requires browser_cdp({action:'attach'}). |

### cookies (1)

| Tool | Parameters | Description |
|---|---|---|
| `cookies` | action, urlContains, url, allDomains, limit, name, value, domain, path, secure, httpOnly, expires, format | Read, set, or delete browser cookies (requires browser_cdp({action:'attach'})). |

### storage (1)

| Tool | Parameters | Description |
|---|---|---|
| `storage` | action, area, key, value, format | Read, write, remove, or clear localStorage or sessionStorage on the target tab. |

### console (1)

| Tool | Parameters | Description |
|---|---|---|
| `get_console_logs` | limit, clear, format | Return buffered console messages (log/warn/error/exceptions) captured since attach. Requires browser_cdp({action:'attach'}). |

### record (1)

| Tool | Parameters | Description |
|---|---|---|
| `record` | *action, startUrl, steps, format | Record user interactions on the target tab or replay recorded/supplied steps. |

### tabs (2)

| Tool | Parameters | Description |
|---|---|---|
| `windows` | action, id, url, width, height | List or focus browser windows, or manage the dedicated agent window. |
| `spoof_visibility` | restore, format | Make the target tab's page JS believe it's visible/focused (document.hidden=false, document.visibilityState='visible', fires a visibilitychange event), WITHOUT actually foregrounding the tab or stealing the user's focus. Use this when scrolling a backgrounded tab isn't loading new content — many sites (e.g. infinite-scroll feeds) deliberately pause lazy-loading via the Page Visibility API while a tab is hidden, as a resource-saving pattern. This is explicit and opt-in on purpose: call it once before scrolling a background tab that needs to lazy-load, not automatically on every scroll — visibility state is also used for other things a site might not want spoofed unconditionally (video autoplay, polling/websocket resume, analytics time-on-page). Attaches the CDP debugger if not already attached (shows the 'is being debugged' bar). KNOWN LIMITATION: this patches JS-visible state only — it does not lift Chrome's renderer-level throttling of a backgrounded tab (requestAnimationFrame doesn't fire, IntersectionObserver rides the same throttled pipeline). If a site's lazy-load is driven by rAF/IO rather than a visibilitychange or scroll listener, this may not help; there is no further automatic fallback (foregrounding the tab, even briefly, is a deliberate manual decision this tool will never make for you). The spoof lasts until the page navigates or reloads; call it again on the new page, or pass restore: true to undo it. |

### advanced (14)

| Tool | Parameters | Description |
|---|---|---|
| `find` | query, selector, in, regex, contextChars, max, format | Find things on the page and get a ref back for each. in: 'controls' (default) matches interactive elements by accessible name, text, placeholder, aria-label or title, and 'matchedBy' says which of those hit; in: 'text' searches the page's prose instead and each match carries 'nearestInteractive'. |
| `get_content` | maxChars, format | The page's main readable prose — title, url, cleaned article text. For documentation, articles and postings. |
| `select_option` | *target, values, value, option, label, format | Select one or more options in a <select> element. Values are matched by value first, then by visible label. |
| `press_key` | *key, target, modifiers, allowSynthetic, format | Send a key, or a chord with modifiers, to an element or to whatever has focus. |
| `hover` | *target, format | Send the pointer and mouse events of hovering an element, to open a flyout menu or raise a tooltip. A menu shown by CSS :hover alone does not open this way; its items are usually already in browser_snapshot, tagged [hidden until hover/focus]. |
| `list_available_tools` | format | Every capability this server has, loaded or not, with its parameters. |
| `unload_tools` | profile, tools, format | [EXTEND] Unload specific tool categories or reset active tools back to the lightweight 'core' profile. Frees system prompt tokens when specialized tools are no longer needed. |
| `describe_element` | *target, format | Given a 'target' (ref '@e1', CSS selector, visible text, or snapshot index), return everything useful for debugging it: tag, full attribute dump, bounding rect, visibility verdict WITH the specific reason ('visible' \| 'display:none' \| 'visibility:hidden' \| 'zero-size rect' \| 'opacity:0' \| 'disabled'), and whether it matches the interactive selector. Pierces open Shadow DOM. |
| `read_pdf` | format | Call this when the target tab is showing a PDF (browser_get_content/browser_find/browser_snapshot/browser_click all fail on a PDF tab with 'no readable DOM' — Chrome's built-in PDF viewer isn't a real DOM, so those tools cannot see its text). Returns the tab's URL and an isPdf verdict; this extension does NOT extract PDF text itself (a hand-rolled parser silently mis-reads subset/CID-font PDFs — dangerous for numeric data like a rate sheet). Fetch the returned URL yourself and read it with your own PDF-reading capability instead of retrying the DOM-based tools. |
| `print_pdf` | format | Render the page to a PDF; returns base64 (save it to a .pdf file). Requires browser_cdp({action:'attach'}). |
| `download` | target, url, filename, timeoutMs, format | Click an element to trigger a file download or download directly from a URL, waiting until the file finishes saving to disk. Returns filename, filePath, and fileSize. |
| `request_help` | target, *reason, timeoutMs, waitForUrl, waitForSelector, format | Requests human assistance (e.g. solving CAPTCHA, 2FA, biometric auth). Focuses the browser, displays an in-page banner, and waits until the user clicks 'Done', or until a URL pattern or selector is matched. |
| `emulate` | device, viewport, colorScheme, geolocation, offline, clear, format | Emulate device metrics, mobile user-agent, touch events, dark/light color scheme, or geolocation. Use clear: true to restore defaults. |
| `drag` | source, target, fromX, fromY, toX, toY, format | Drag an element from source to target, or between coordinates. Dispatches native CDP mouse and drag events. |
