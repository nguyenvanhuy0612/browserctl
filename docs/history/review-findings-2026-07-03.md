# Code review findings — 2026-07-03

Multi-agent review of browserctl (extension + bridge + MCP + tests/docs).
This file is the fix backlog. Security-only findings are intentionally **not** fixed
(documented as accepted risk in `README.md#security` — single-user internal tool, no
function impact). Everything below is a correctness / robustness / clarity fix.

Grouped by owning file-set so fixes don't collide.

## Cross-cutting decisions (all agents follow these)

- **`net_get` / network headers = include verbatim, no redaction.** The tool is a local
  debug aid; returning `Cookie` / `Authorization` is intended. Fix = make the code match
  that promise (extension currently strips headers from `net_get`), and make every
  doc/description consistent. The roadmap checkbox "Secret stripping (cookies/auth) done"
  is wrong — flip it to not-done with a "verbatim by design" note.
- **Do not edit `tests/e2e/run.mjs` from the extension/mcp agents.** If a behavior change
  would break an existing e2e assertion, note it in your final report instead. The
  bridge/tests agent owns e2e + testpage changes.
- Keep changes surgical and in the existing code style. No new deps unless noted.

---

## Group A — bridge + tests  (owns: `bridge/server.js`, `bridge/package.json`, `tests/e2e/*`, new `tests/unit/*`)

Robustness:
- **Reject pending requests on extension disconnect** (`server.js:54-57` socket replacement, `:77-80` close). On close/replace, iterate the `pending` map, `clearTimeout`, reject each with an `{ok:false, error:"extension disconnected"}` reply to the waiting HTTP caller, then clear the map. Today callers hang the full timeout.
- **Add HTTP server error handling** (`server.js:171`). `server.on("error", ...)` for `EADDRINUSE` with a clear message ("port 8765 in use — another bridge running?"). Add top-level `process.on("uncaughtException")` and `process.on("unhandledRejection")` that log to stderr and don't silently die.
- **Timeout coherence** (`server.js:18-22`). Bridge caps every command at 30s (except `replay` 120s), but `wait_for` / `wait_network_idle` accept a caller `timeoutMs` that can exceed 30s, and `export_har {bodies:true}` can be slow. Make the per-command timeout aware of the action: for `wait_for` / `wait_network_idle` use `params.timeoutMs + buffer` (e.g. +5s), and give `export_har` a higher cap (e.g. 120s). Clamp to a sane max (e.g. 300s). Goal: the schema's `timeoutMs` is actually honored end-to-end.
- **Bound inbound WS payload + friendly error** (`server.js:51`). Set an explicit `maxPayload` on the `WebSocketServer` and surface a "payload too large" message instead of a bare 1009 close, so huge `export_har`/`print_pdf`/full-page screenshots fail gracefully.
- **Version** in `bridge/package.json`: bump 0.2.0 → 0.4.0. Add `"engines": {"node": ">=18"}` (code uses global `fetch`, top-level await).

Tests:
- **Add `tests/unit/bridge.test.mjs`** using `node:test` + a fake WS client (no Chrome). Cover: request/response correlation by id, per-request timeout fires, 503/"disconnected" when no extension, late/unknown reply id is ignored, oversized/malformed JSON body handled, socket replacement bookkeeping. Add an `npm test` script to `bridge/package.json`.
- **Make the shadow-DOM click test assert something** (`tests/e2e/run.mjs:148` + `tests/e2e/testpage.html`): give `#shadowbtn` a click side effect (e.g. set `window.__shadowClicked`) and assert it, mirroring the light-DOM click at `:142-147`.
- **De-flake the iframe wait** (`run.mjs:113`): replace the fixed `wait_for {timeoutMs:900}` with a poll on `find("Iframe Button")` until match-or-deadline. Remove the dead `sleep` helper (`run.mjs:57`) if still unused after.
- Optional if cheap: rename the misleading test "press_key Enter on input" (`run.mjs:178`) — it presses Escape.

---

## Group B — MCP server  (owns: `mcp/index.js`, `mcp/package.json`)

- **`net_get` description**: keep/confirm it states headers are returned verbatim (extension side is being fixed to actually include them). No redaction claim.
- **`browser_screenshot_fullpage` default mismatch** (`index.js:542`): description says "default png" but the handler defaults to jpeg. Fix the description to say jpeg (quality 55, `format:"png"` for lossless) to match `cdp.js`.
- **`get_cookies` filter doc** (`index.js:644`): says "domain/url substring" but extension filters on cookie *domain* only. Either soften the description to "domain substring" or (nicer) note it matches the cookie domain. Pick the doc fix; do not change filter semantics here.
- **zod refine on ref-or-index tools** (`click`/`type`/`hover`/`select_option`/`press_key`, e.g. `index.js:133-138,147-157,354-359`): add a `.refine()` requiring at least one of `ref`/`index` so a call with neither fails early with a clear message instead of a low-level extension error.
- **Screenshot data-URL fallback** (`index.js:187-188,548-549,615-616`): `m ? m[2] : dataUrl` hands a non-matching string to the client as base64. Treat a regex miss as an error (return isError) instead of emitting a corrupt image.
- **Version**: `McpServer({version})` (`index.js:69`) 0.2.0 → 0.4.0; bump `mcp/package.json` to 0.4.0; add `"engines": {"node": ">=18"}`.

---

## Group C — extension  (owns: `extension/*.js`, `extension/manifest.json`)

Correctness (higher priority):
- **`element_screenshot` clips wrong region on scrolled pages** (`cdp.js:569-585`, uses `content.js:434-439` `element_rect`). `element_rect` returns viewport-relative rect, but `Page.captureScreenshot` with `captureBeyondViewport:true` treats `clip.x/y` as page-absolute. Add page scroll offset: include `scrollX/scrollY` from the frame and add them to `clip.x/y` (both the ref path and the raw-index fallback at `cdp.js:571-577`). Reference: Puppeteer adds `layoutViewport.pageX/pageY`.
- **Coordinate remap scale only set by `captureViewport`** (`cdp.js:56,163,452-468`, `background.js:384-407`). On Retina, a foreground un-attached `screenshot` uses `chrome.tabs.captureVisibleTab` (2x device pixels) and never sets `lastCapture`, so `coordinate_click` computes scale 1 and clicks land at 2x offset. Set `lastCapture`/scale for *all* screenshot paths (captureVisibleTab and full-page `capture_screenshot`), recording the correct scale for each, so coordinate remap is right regardless of which screenshot was last.
- **`requireSession` conflates attached vs domains-enabled** (`cdp.js:176-180` with `:128-134`). After a lazy screenshot-attach (`domainsEnabled:false`), `get_console_logs`/`get_network_requests` return empty success. Make the log/network read paths require domains enabled (auto-enable them, or error with "call cdp_attach first to enable capture") instead of silently returning `count:0`.
- **`press_key` modifiers dropped when not attached** (`background.js:180-183`, `content.js:371-383`). If `modifiers` are present and the debugger isn't attached, don't fall through to the content handler (which ignores modifiers and reports success). Either auto-attach and route to `press_key_cdp`, or return a clear error ("modifiers require cdp_attach"). Prefer the clear error to avoid surprise attach/banner.
- **`read_page` with frame-qualified `ref_id` returns empty success** (`background.js:522-556`). `frameRoute` (`:522-526`) rewrites only `params.ref`, not `params.ref_id`; a `f3:ref_5` ref_id fails in every frame and `mergeFrameResults` returns a fake empty snapshot. Fix `frameRoute` to also strip/route `params.ref_id` to the owning frame.
- **`crossFrame` empty-parts fallback returns snapshot shape for all actions** (`background.js:556`). When every frame errors (e.g. restricted page, or the ref_id bug above), it returns `{url,title,elements,text}` with `ok:true` regardless of action — so `find`/`read_page` look like a real empty page. Return an error (`ok:false`, e.g. "no frame could handle this / page not accessible") when all parts failed, instead of a fabricated empty success.

Robustness:
- **Capture state lost silently on SW recycle** (`cdp.js:14`, `netlog.js:14-27`, `background.js:32`). Only `targetTabId` survives via `storage.session`. After the service worker recycles, `net_get`/`record_get`/`get_console_logs` return empty success even though the user started capture. Persist the "capturing"/"recording" intent flags to `storage.session`; when a read finds the flag set but the in-memory buffer/session gone, return a clear error ("capture state was reset by a service-worker restart — restart capture") instead of empty success. (Live CDP buffers can't be restored; the goal is an honest error, not silent zero.)
- **WebSocket reconnect shared-variable races** (`background.js:100-151`, `:591-599`). Handlers act on the module-level `socket`, and `connect()` has an async gap between the readyState guard and the socket assignment, allowing duplicate live sockets or closing the wrong one. Bind each handler to the local `ws` it was created for (ignore events if `ws !== socket`), and add a `connecting` guard flag set before the `await bridgeWsUrl()` so a second `connect()` during that await is a no-op. Be conservative — don't rewrite the state machine, just close the race.

Lower / clarity:
- **`net_get` must actually include headers** (`netlog.js:197-212` `briefRecord`, `cdp.js:352-363` `briefRequest`). Headers are captured (`netlog.js:141,153`) but stripped from the output. Add request/response headers to the returned records (verbatim, per cross-cutting decision).
- **`eval_js` MAIN-world `undefined` result throws** (`cdp.js:477-489`). `JSON.parse(JSON.stringify(undefined))` throws for expressions returning undefined (assignments, void, DOM calls), surfacing a misleading error for a successful eval. Handle undefined → return `{result: null}` or `{result: "undefined"}` rather than throwing.
- **`wait_for {selector}` doesn't pierce shadow DOM** (`content.js:393-395`) while `click_selector`/`fill_selector` do. Use `deepQuery` so `wait_for` sees open-shadow elements.
- **`isVisible` uses `&&`** (`content.js:31`): a zero-width nonzero-height (or vice versa) element counts visible. Change to `||` so a truly collapsed element is excluded.
- **Snapshot stamp clearing is light-DOM-only** (`content.js:99-100` vs `:94`): clearing uses `document.querySelectorAll` but stamping uses `deepQueryAll`, so stale `data-bctl-ref` accumulate on shadow elements. Clear with the shadow-piercing query too.
- **`select_option` error string / `type` on checkbox** (`content.js:352-368`): error prints "in select undefined" when addressed by `ref`; `type()` on checkbox/radio sets `.value` (no visible effect) and reports success. Fix the message; for checkbox/radio, set `.checked` (or return a clear error).
- **`chrome.alarms` period below minimum** (`background.js:604`): `periodInMinutes:0.4` (24s) is under Chrome's 30s floor for packed extensions and gets clamped. Set to `0.5` (30s).
- **Version strings**: `manifest.json:4` and the HAR `creator.version` (`cdp.js:330`) say 0.2.0 while the tool is v0.4 — bump to 0.4.0 for clean HAR triage.

---

## Group D — protocol doc  (owns: `PROTOCOL.md`)

Reconcile the spec with v0.4 code (do not touch README — already updated):
- Fix the **secret-stripping contradiction**: roadmap `:256` says "[x] Secret stripping done" but `:169-171` and the code return headers verbatim. Flip the checkbox to `[ ]` (or remove) and state headers are verbatim by design (internal tool).
- Fix the **HAR bodies contradiction**: `:128` "Bodies are not captured yet" vs `:166` and code (`export_har {bodies:true}` works). Remove the stale line.
- Fix the **Mac editor commands contradiction**: listed both as "Deferred" (`:243-245`) and "[x] done" (`:269`). Remove the stale "Deferred" mention; they're implemented (`press_key` modifiers, `press_key_cdp`).
- **Add missing commands**: `group_tab` / `ungroup_tab` (implemented, tested) are absent entirely.
- **Add missing params**: `switch_tab { id, focus? }` (doc omits `focus`); `press_key { key, index?, ref?, modifiers? }` (doc `:142` omits ref/modifiers); `element_screenshot { index?, ref? }` (doc `:192` omits ref).
- **`record_get` step shape** (`:183`): documented as `{type, selector, value?, url?}` but the recorder only emits `click {type,selector,text}` and `input {type,selector,value}`, and never emits navigate steps. Document the real shapes (note the `text` field, and that navigate steps aren't recorded — only accepted in a manually supplied `replay`). If the extension agent adds navigate-step recording, reflect that instead.
- **"active tab" wording** (`:63,110-111,139,150,158,182`): the model is a pinned target, not the active tab. Update these per-command lines to match the doc's own header and the `targetTab()` implementation.
- **Document the WS frames**: `{id, action, params}` request / `{id, ok, result|error}` reply, and app-level `{type:"ping"}`/`{type:"pong"}`. Currently undocumented.
- **Version**: note the protocol/version is 0.4.
