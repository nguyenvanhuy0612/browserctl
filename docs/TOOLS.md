# Tool surface as it actually is — generated 2026-09-10, browserctl 0.7.0

Generated from the running server (`server._registeredTools`), not written by hand — the last
hand-written version of this list claimed `all` on a tool that did not have it.

`*` = required. `tabId`/`tab_id` accepted on every tab-scoped tool, omitted from the tables.


### core (23)

| Tool | Parameters | Description |
|---|---|---|
| `status` | format | Report whether the bridge is reachable, current daemon state (running/stopped), and whether the Chrome extension is connected to it. Call this first if a command failed, or to check readiness after starting/stopping the bridge. |
| `start` | (none) | Start the local browserctl bridge server daemon in the background if stopped. |
| `stop` | (none) | Stop the local browserctl bridge daemon. DO NOT call this to tidy up when a task is finished — the daemon is shared with the user and with any other agent driving a tab, it starts and maintains itself, and stopping it interrupts their work and records an explicit stopped state that blocks auto-restart. Call it only when the user asks you to shut the bridge down. |
| `snapshot` | scope, compact, format, maxText, limit, cursor | NOT an image — despite the name, this returns TEXT. It is the primary tool to inspect ANY page state, UI controls, navigation headers, notifications, badges, form fields, and interactive layout (includes aria-labels, buttons, links, inputs). Returns the TARGET tab's interactive elements (each with an 'index' and a stable 'ref'), the page URL/title, visible text, viewport state, and every open dialog. Elements are listed in reading order. Call this first, then act by ref/index, and re-call after any action that changes the page. |
| `read_page` | mode, depth, ref_id, maxChars | SPECIALISED reader — reach for browser_snapshot first unless you specifically need NESTING (which control sits inside which group, form or region). Returns the accessibility tree as indented text — roles, accessible names, ARIA state, and a stable 'ref' on each interactive element (e.g. textbox "Email" [ref_5]). Unlike snapshot it has a depth limit, and it does NOT report open dialogs, what it left out, or content that loads on demand — so it cannot tell you when your answer is incomplete. |
| `find` | query, selector, in, regex, contextChars, max | Find things on the page. in='controls' (default) searches interactive elements by accessible name / text / placeholder / aria-label / title, e.g. query='Notifications', and each match carries a stable 'ref' to act on. in='text' searches the page's whole TEXT instead — a price, rating or status string sitting in plain prose that the control index cannot see, e.g. query='Total: $50'; those matches carry 'visible' and 'nearestInteractive' ({ref, tag, text}), so a text hit becomes an action in one follow-up call. |
| `click` | index, ref, selector, text, waitFor, autoSettle, settleMs | Click an element identified by 'ref' (e.g. '@ref_5', 'ref_5', '@e1'), 'index', CSS 'selector', or visible 'text'. Resolves across standard buttons/links, ARIA controls (menuitem, option, tab, treeitem, switch), and custom Web Components (tags containing '-'). Automatically waits for DOM mutations to settle. |
| `fill` | index, ref, selector, placeholder, text, option, method, submit, waitFor, autoSettle, settleMs | The one text-entry verb: put text into ANY editable target — <input>, <textarea>, contenteditable, and rich-text editors (ProseMirror/Tiptap/Quill) — or pick an option in a <select>. Clears the existing value and sets the new one via native prototype setters and bubbling events, so Vue/React v-model see it. If an uneditable element is targeted by mistake, returns candidate editable input refs in the viewport. |
| `scroll` | direction, amount, ref, selector, index | Scroll the page or a specific container (e.g. div with overflow:auto, iframe, table, drawer) up or down. Automatically detects nested scrollable containers if the root window is locked. |
| `press_key` | *key, index, ref, modifiers, allowSynthetic | Dispatch a keyboard key (e.g. Enter, Escape, ArrowDown) to an element or the focused element. Note: 'Enter' on a form field can submit the form. WITHOUT modifiers this is a synthetic DOM event and works on a background tab. WITH modifiers (e.g. ['Meta','Shift'] for Cmd+A / Cmd+Z) it runs via CDP, which needs browser_cdp_attach first AND the tab in the foreground — Chrome silently drops CDP key input for background tabs, so this errors instead of pretending to succeed. On Mac the CDP path drives real editor commands (Cmd+A/Z/C/V/X). Pass allowSynthetic:true to use the DOM path for a modified key on a background tab: the page's own shortcut handler fires, but native editing does not. The result reports via:'cdp' or via:'dom' so you always know which semantics you got. |
| `wait_for` | for, selector, text, gone, timeoutMs | Wait until a CSS selector or page text appears (or disappears with gone=true). With neither, waits a fixed time. Use after actions that trigger async page changes. |
| `get_page_content` | maxChars | Extract the main readable prose/article text of the page (title, url, cleaned text). Good for reading articles and documentation. NOTE: Only extracts article prose. For web app UI — headers, icon buttons, badges, unread counts, notifications — use browser_snapshot. For the full text of ONE region of an app (an email thread, a chat log, a message body), use browser_get_property on that region's container or ref; that is the read this tool declines, and it is not a reason to fall back to eval_js. |
| `get_property` | selector, ref, index, placeholder, property, attr, all, max, fields | THE element read. One element, a whole region, or every match — identified by CSS 'selector' (e.g. '.price', '#status', 'h1'), 'ref' (e.g. '@ref_1'), 'index' or 'placeholder'. Pierces open Shadow DOM and works on custom Web Components. Prefer this over eval_js for every one of them. |
| `screenshot` | fullPage, format, quality | Capture the TARGET tab as an image. Works on a background tab without activating it (so the user can keep using other tabs); attaching the debugger for that shows the 'is being debugged' bar on the target tab. JPEG by default (smaller); pass format='png' for a lossless image (e.g. pixel-diff QA). |
| `list_tabs` | (none) | List all open tabs with their id, url, title, whether active, and which one is the pinned target ('pinned'). Reads the pin WITHOUT setting it — this is the safe way to ask what you are driving. |
| `open_url` | *url, target, wait, timeoutMs, read, maxChars | Put a URL somewhere and wait for it to be usable. Returns the tabId it drove, so you can keep driving that tab with tabId-scoped calls. |
| `switch_tab` | id, focus | Make the tab with the given id active and the target for subsequent commands. Activates the tab within its window but does NOT raise the window (no focus steal) unless focus=true. Prefer browser_open_url to work a new page; use this (especially focus=true) only when the user asks to bring a tab forward. |
| `close_tab` | id | Close the tab with the given id. |
| `reload` | bypassCache | Reload the target tab. Set bypassCache=true for a hard reload. |
| `eval_js` | *expression, format | Run a JavaScript expression in the target page and return its value. The value must be JSON-serializable. Automatically falls back to CDP Runtime.evaluate if page Content Security Policy (CSP) or Trusted Types block standard script execution. For reading text or attributes without writing JS, prefer 'browser_get_property' — it reads text, value, html, box, attributes and counts, one match or every match. |
| `action` | action, params | Execute any browserctl protocol action by name, with no need to load that action's own MCP tool. Call it with NO arguments to get the catalogue of every available action name. Parameters are the same as the matching browser_<action> tool takes. |
| `load_tools` | profile, tools | Unlock capabilities that are NOT currently loaded. The tools you can see are a subset; these profiles exist and are one call away: |
| `list_available_tools` | format | List all tool categories (profiles) and check which tools are currently active (loaded in prompt) vs inactive (available for dynamic loading). |

### system (1)

| Tool | Parameters | Description |
|---|---|---|
| `exec_system_cmd` | *command, cwd, env, timeoutMs | Execute a shell/system command on the host running the bridge server. Returns exitCode, stdout, stderr, all (combined output), failed, timedOut, and signal. |

### network (8)

| Tool | Parameters | Description |
|---|---|---|
| `get_network_requests` | urlContains | Return network requests captured since attach (method, url, status, type, size). Requires browser_cdp_attach. |
| `get_response_body` | *requestId | Fetch the response body of a captured request by its requestId (from get_network_requests). Best-effort; bodies may be evicted. Requires browser_cdp_attach. |
| `export_har` | bodies | Export captured network traffic as a HAR 1.2 object (headers, status, timing). Headers are included verbatim (local tool, no redaction). Set bodies=true to also include response bodies (best-effort, slower). Requires browser_cdp_attach. |
| `net_start` | (none) | Start capturing network requests for the target tab via webRequest. No debugger banner, but no response bodies. Clears the previous buffer. |
| `net_stop` | (none) | Stop the webRequest capture for the target tab. |
| `net_get` | urlContains, limit | Return network requests captured by the light webRequest capture (method, url, type, status, timing). Headers are included verbatim (local tool, no redaction). |
| `net_clear` | (none) | Clear the light network capture buffer for the target tab. |
| `wait_network_idle` | idleMs, timeoutMs, maxInFlight | Wait until the target tab has had no in-flight requests for idleMs (default 500), up to timeoutMs (default 10000). For modern SPAs with persistent WebSockets, telemetry, or long-polling (YouTube, Algolia, Twitter, Azure Portal), network-idle may time out waiting for 0 requests; use browser_wait_for({for:'settle'}) instead or set maxInFlight to tolerate background connections. |

### cdp (7)

| Tool | Parameters | Description |
|---|---|---|
| `cdp_attach` | (none) | Attach the debugger to the target tab to start capturing console logs and network traffic. Shows an 'is being debugged' bar in the browser. Call this before get_console_logs / get_network_requests / export_har. |
| `cdp_detach` | (none) | Detach the debugger from the target tab and stop capturing. Removes the debugging bar. |
| `cdp_send` | *method, params | POWER TOOL. Send any Chrome DevTools Protocol method to the target tab and get its result verbatim. Requires browser_cdp_attach first. Use it for capabilities that have no dedicated tool yet — Fetch.* (request interception / mocking / HTTP auth), DOM.setFileInputFiles (file upload), Page.handleJavaScriptDialog (alert/confirm), Emulation.* (device metrics, throttling, timezone, locale, geolocation, prefers-color-scheme), Storage.*, Tracing.*. Only domains in Chrome's chrome.debugger allowlist work; notably DOMStorage and IndexedDB are NOT available. Two footguns: enabling an interception domain without handling its events (e.g. Fetch.enable) pauses page traffic until you disable it, and Emulation.setDeviceMetricsOverride changes the screenshot scale that browser_coordinate_click depends on. |
| `coordinate_click` | *x, *y, button, clickCount | Click at pixel coordinates measured against the most recent screenshot of the target tab (for canvas/WebGL/maps where DOM clicks fail). Coordinates are auto-mapped from screenshot pixels to the viewport, so pass the x/y you read off the screenshot. Pair with a screenshot first. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead. |
| `coordinate_drag` | *fromX, *fromY, *toX, *toY | Press at (fromX,fromY), move to (toX,toY), release. Requires browser_cdp_attach. REQUIRES the target tab in the FOREGROUND: Chrome silently drops CDP synthetic mouse input for background tabs, so this errors rather than pretending to click. For background work use browser_click (ref, selector or text) instead. |
| `insert_text` | *text | Type text into the focused element via CDP Input.insertText — robust for emoji/IME/multibyte that key-by-key typing can't represent. Click/focus the field first. Requires browser_cdp_attach. |
| `audit` | (none) | Lightweight audit: performance metrics (DOM nodes, JS heap, layout/script timing) plus an accessibility count of interactive elements missing a name. Requires browser_cdp_attach. |

### cookies (3)

| Tool | Parameters | Description |
|---|---|---|
| `get_cookies` | urlContains, url, allDomains, limit | Return the cookies that apply to the TARGET TAB's current page (this is the default scope, and the answer to "what cookies did this page set"). Pass allDomains:true to read every cookie in the browser profile instead — that returns the user's whole session jar across all sites, so ask for it only when the task really needs it. Capped at 200 cookies; the response says when it truncated. Requires browser_cdp_attach. |
| `set_cookie` | *name, *value, url, domain, path, secure, httpOnly, expires | Set a cookie (provide url or domain). Useful for test setup. Requires browser_cdp_attach. |
| `delete_cookies` | *name, url | Delete cookies by name (optionally scoped to a url). Requires browser_cdp_attach. |

### storage (4)

| Tool | Parameters | Description |
|---|---|---|
| `storage_get` | area, key | Read localStorage or sessionStorage. With a key returns its value; without, returns all items. |
| `storage_set` | area, *key, *value | Set a key in localStorage or sessionStorage (test fixtures, feature flags). |
| `storage_remove` | area, *key | Remove a key from localStorage or sessionStorage. |
| `storage_clear` | area | Clear all of localStorage or sessionStorage. |

### console (1)

| Tool | Parameters | Description |
|---|---|---|
| `get_console_logs` | limit, clear | Return buffered console messages (log/warn/error/exceptions) captured since attach. Requires browser_cdp_attach. |

### record (4)

| Tool | Parameters | Description |
|---|---|---|
| `record_start` | (none) | Start recording user interactions (clicks, field changes) in the target tab. Replay later with browser_replay. |
| `record_stop` | (none) | Stop recording interactions. |
| `record_get` | (none) | Return the recorded interaction steps. |
| `replay` | startUrl, steps | Replay recorded steps (or supplied steps) against the target tab. Optionally navigate to startUrl first. |

### tabs (6)

| Tool | Parameters | Description |
|---|---|---|
| `list_windows` | (none) | List all browser windows with their tabs. |
| `focus_window` | *id | Bring the window with the given id to the foreground. Steals the user's OS focus — use only when the user explicitly asks to surface a window, not as part of background work. |
| `group_tab` | id, title, color | Put a tab into a labeled, colored tab group so you (and the user) can see which tab the agent drives. Defaults to the target tab; pass id to group a specific tab. Does NOT activate the tab (no focus steal) and pins the grouped tab as the target. |
| `ungroup_tab` | id | Remove a tab from its tab group. Defaults to the target tab. |
| `spoof_visibility` | (none) | Make the target tab's page JS believe it's visible/focused (document.hidden=false, document.visibilityState='visible', fires a visibilitychange event), WITHOUT actually foregrounding the tab or stealing the user's focus. Use this when scrolling a backgrounded tab isn't loading new content — many sites (e.g. infinite-scroll feeds) deliberately pause lazy-loading via the Page Visibility API while a tab is hidden, as a resource-saving pattern. This is explicit and opt-in on purpose: call it once before scrolling a background tab that needs to lazy-load, not automatically on every scroll — visibility state is also used for other things a site might not want spoofed unconditionally (video autoplay, polling/websocket resume, analytics time-on-page). Attaches the CDP debugger if not already attached (shows the 'is being debugged' bar). KNOWN LIMITATION: this patches JS-visible state only — it does not lift Chrome's renderer-level throttling of a backgrounded tab (requestAnimationFrame doesn't fire, IntersectionObserver rides the same throttled pipeline). If a site's lazy-load is driven by rAF/IO rather than a visibilitychange or scroll listener, this may not help; there is no further automatic fallback (foregrounding the tab, even briefly, is a deliberate manual decision this tool will never make for you). |
| `current_tab` | (none) | Report which tab commands currently act on (id, url, title, and whether a target is pinned). The target is pinned on your first command and held across user tab switches. Call this to confirm you're on the right page before snapshotting or reading sensitive content. |

### advanced (10)

| Tool | Parameters | Description |
|---|---|---|
| `hover` | index, ref | Hover the pointer over an element identified by 'ref' (from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref. |
| `unload_tools` | profile, tools | Unload specific tool categories or reset active tools back to the lightweight 'core' profile. Frees system prompt tokens when specialized tools are no longer needed. |
| `describe_element` | selector, ref, index, placeholder | Given a CSS 'selector', 'ref', or 'index', return everything useful for debugging it: tag, full attribute dump, bounding rect, visibility verdict WITH the specific reason ('visible' \| 'display:none' \| 'visibility:hidden' \| 'zero-size rect' \| 'opacity:0' \| 'disabled'), and whether it matches the interactive selector. Pierces open Shadow DOM. |
| `a11y_snapshot` | max | SECOND OPINION on the page, from Chrome itself. Returns Chrome's own accessibility tree — the role, name and state it computes for every control by the HTML-AAM spec — not browserctl's census. Each node carries a 'ref' where the census has the same control, so results are directly actionable. |
| `read_pdf` | (none) | Call this when the target tab is showing a PDF (browser_get_page_content/browser_find/browser_snapshot/browser_click all fail on a PDF tab with 'no readable DOM' — Chrome's built-in PDF viewer isn't a real DOM, so those tools cannot see its text). Returns the tab's URL and an isPdf verdict; this extension does NOT extract PDF text itself (a hand-rolled parser silently mis-reads subset/CID-font PDFs — dangerous for numeric data like a rate sheet). Fetch the returned URL yourself and read it with your own PDF-reading capability instead of retrying the DOM-based tools. |
| `element_screenshot` | index, ref, format | Capture just one element as an image, identified by 'ref' (from browser_read_page/browser_find/browser_snapshot) or 'index' (from the latest browser_snapshot). Prefer ref. Requires browser_cdp_attach. |
| `print_pdf` | (none) | Render the page to a PDF; returns base64 (save it to a .pdf file). Requires browser_cdp_attach. |
| `go_back` | (none) | Navigate back in the target tab's history. |
| `go_forward` | (none) | Navigate forward in the target tab's history. |
| `reload_extension` | (none) | Reload the browser extension itself from disk (dev convenience; picks up edited extension code). The connection drops briefly and reconnects. |
