# Backlog: capability gaps

Captured 2026-08-04. Five gaps identified by the function-level comparison in
`prior-art.md` (Update 2026-08-04). All five are feasible. Every CDP surface below
was verified on 2026-08-04 against the DevTools Protocol reference and the
`chrome.debugger` domain allowlist — re-verify if this looks stale.

Supersedes the `browser_emulate` / `browser_throttle` entries at the end of
`backlog-chrome-devtools-parity.md` (item 5 here).

## Shared constraint: blocking events do not fit the current architecture

Items 1 and 3 both hang on a CDP **event that blocks the page** until it is answered
(`Fetch.requestPaused`, `Page.javascriptDialogOpening`). Our bridge is HTTP
request/response and the agent pulls; there is no push channel to the agent (roadmap:
"Streaming WebSocket endpoint for agents" is still open).

Three consequences, none of them optional:

- **The policy must live in the extension, not in the agent.** A round-trip to the
  model is seconds; the page would time out first. The agent registers declarative
  rules and reads a buffer afterwards. This is a new pattern for this codebase, where
  every existing tool is "agent issues one command, gets one result".
- **An MV3 service-worker recycle while a request is paused or a dialog is open hangs
  the page indefinitely.** The 20s heartbeat plus the `chrome.alarms` keepalive
  reduces this but does not eliminate it.
- **Both features need an auto-continue watchdog** as the safety valve: after N ms
  with no rule decision, call `continueRequest` / `handleJavaScriptDialog`
  unconditionally rather than leaving the page wedged.

Closing the streaming endpoint would let the agent observe paused requests and
dialogs live instead of reading a buffer after the fact. Not a prerequisite, but
these two items are the strongest argument for it so far.

## 1. Network mocking / route interception

**Feasible.** `Fetch` is in the `chrome.debugger` domain allowlist.

Surface:

- `Fetch.enable { patterns, handleAuthRequests }` -> event `Fetch.requestPaused`
- `Fetch.fulfillRequest` — synthesise a response, body included
- `Fetch.failRequest` — simulate a network error
- `Fetch.continueRequest` — rewrite URL / method / postData / headers
- `Fetch.continueResponse` (experimental) — rewrite status and headers
- `Fetch.getResponseBody` / `Fetch.takeResponseBodyAsStream` — response-stage
  interception (`RequestStage: Request | Response`; mutually exclusive)
- `Fetch.continueWithAuth` + event `Fetch.authRequired` — **handles 401/407 HTTP
  basic-auth prompts**, one of the native dialogs a content script cannot reach.
  Unplanned bonus; worth exposing as its own tool.

Offline on its own does not need `Fetch`:
`Network.emulateNetworkConditions { offline: true }`.

Rejected alternative — `declarativeNetRequest` (no banner): cannot synthesise a
response body, cannot modify response bodies, cannot redirect to `data:` URLs (only
http / https / ftp / chrome-extension), and redirecting to an extension file requires
a `web_accessible_resources` declaration. It also needs a `declarativeNetRequest`
permission the manifest does not currently hold. Keep DNR in reserve as an optional
no-banner path for plain block/redirect only.

Design sketch: rule list held in the extension, each
`{ urlPattern, stage, action: fulfill | fail | continue, response?: { status, headers, body }, reason? }`.
Tools: `browser_route_add`, `browser_route_list`, `browser_route_clear`, plus
`browser_network_state_set` for offline. Highest value of the five, highest cost,
highest risk — schedule it last and build the watchdog first.

## 2. File upload

**Feasible via two paths; implement both, they cover different flows.**

- **Input element is present:** `DOM.setFileInputFiles { files, objectId }`. Obtain
  `objectId` from an existing WeakRef ref via `Runtime.evaluate` rather than dealing
  with `nodeId` churn. `files` are paths on the machine running Chrome, which is the
  same machine as the bridge.
- **A click opens the picker:** `Page.setInterceptFileChooserDialog { enabled, cancel? }`
  plus event `Page.fileChooserOpened { frameId, mode, backendNodeId }`, where `mode`
  is `selectSingle` | `selectMultiple`. This is the path Playwright uses and the only
  one that handles "click a button, a picker appears" without first locating the input
  element. The event's `backendNodeId` feeds straight into `setFileInputFiles`, and
  `cancel: true` dismisses the picker outright.

Validate the file count against `mode` before calling `setFileInputFiles`.

This closes the "file-dialog handling still open" half of the cross-origin-iframe
roadmap line in `PROTOCOL.md`.

## 3. Dialog handling

**Feasible, cheapest of the five, and currently a hang rather than a missing feature.**

- Event `Page.javascriptDialogOpening { url, frameId, message, type, hasBrowserHandler, defaultPrompt }`,
  where `type` is `alert` | `confirm` | `prompt` | `beforeunload`
- `Page.handleJavaScriptDialog { accept, promptText? }`
- Event `Page.javascriptDialogClosed { result, userInput }`

Why this is a bug and not just a gap: a JS dialog blocks the renderer, which freezes
the content script, which hangs **every** DOM command — not only the step that
triggered it. An unexpected `confirm()` is currently a dead end for the whole session.

Design: extension-side policy `auto_accept` | `auto_dismiss` | `hold`, plus a buffer
the agent reads later (same shape as the existing console buffer). Skip handling
entirely when `hasBrowserHandler` is true — the browser deals with those. Do this
first.

## 4. storage_state export/import

**Feasible but structurally limited, and lower value than it looks.**

Hard limit found: **`DOMStorage` and `IndexedDB` are not in the `chrome.debugger`
domain allowlist.** We therefore cannot read localStorage for an origin we do not
have a tab open on. Playwright can, because it drives the browser from outside.
Reading localStorage stays a per-origin content-script operation.

Cookies are unconstrained: `Network.getAllCookies` / `Network.setCookies`, or the
`Storage` domain, which is allowlisted.

Playwright's `storageState()` shape, worth matching so the files interoperate:

```
{ cookies: [{ name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey? }],
  origins: [{ origin, localStorage: [{ name, value }] }] }
```

Playwright omits `sessionStorage`; IndexedDB and WebAuthn credentials are opt-in
there. Excluding both matches Playwright *and* matches our domain limits, so there is
no fidelity decision to make.

**Value caveat.** The primary use of `storageState` in Playwright is reusing login
state, because Playwright starts from a clean profile. We already run inside the
user's real, logged-in profile — the core advantage of this project — so that use
case is largely moot for us. What remains is resetting state and moving state between
machines: real, but secondary. Lowest priority of the five.

If implemented: emit Playwright's exact shape, and document explicitly that
`origins[]` is only populated for origins that currently have a tab open. On import,
set cookies directly, but navigate to each origin before writing its localStorage.

## 5. Emulate / resize / throttle

**Feasible, easiest of the five, but it will break coordinate input if done naively.**

`Emulation` is allowlisted:

- `Emulation.setDeviceMetricsOverride { width, height, deviceScaleFactor, mobile }`
- `Emulation.clearDeviceMetricsOverride`
- `Emulation.setUserAgentOverride`
- `Emulation.setTouchEmulationEnabled` / `Emulation.setEmitTouchEventsForMouse`
- `Emulation.setCPUThrottlingRate { rate }`
- `Network.emulateNetworkConditions { offline, latency, downloadThroughput, uploadThroughput }`

Near-free additions that fit the general-purpose positioning:
`Emulation.setTimezoneOverride`, `Emulation.setLocaleOverride`,
`Emulation.setGeolocationOverride`, `Emulation.setEmulatedMedia`
(`prefers-color-scheme`, `print`).

**Trap.** `cdp_attach()` currently forces `deviceScaleFactor: 1` with
`width: 0, height: 0` so that `coordinate_click` / `coordinate_drag` line up on
HiDPI/Retina (PROTOCOL.md, v0.3 "CDP extras" and v0.4 background-tab notes). A
`browser_emulate` that calls `setDeviceMetricsOverride` with real width/height
**overwrites that override** and desynchronises every coordinate action. Either pin
`deviceScaleFactor: 1` inside emulate, or re-read and store the new scale after each
emulate call. Add a regression test asserting coordinate accuracy after an emulate.

Keep two separate tools: `browser_emulate` (CDP override, shows the banner) and a
real window resize via `chrome.windows.update { width, height }` (extension API, no
banner, no attach).

## Order

| # | Item | Cost | Rationale |
|---|---|---|---|
| 1 | Dialog handling | Low | Currently a hang, not a gap |
| 2 | File upload | Low | Opens a whole class of flows; `backendNodeId` is handed to us |
| 3 | Emulate / throttle | Low | Cheap, but fix the scale trap first |
| 4 | Network mocking | High | Highest value; needs a new pattern plus the watchdog |
| 5 | storage_state | Low | Weakest value — we already run in a logged-in profile |
