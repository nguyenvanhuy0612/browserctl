# Architecture

Status: verified
Depends on: none

## Goal

Give an agent the strongest possible control of web pages in the user's real Chrome: foreground
or background tabs, with the user's logins. Prefer working without Chrome's "started debugging
this browser" bar; use it only when a task cannot be done otherwise. `evaluate` is always there
when a tool does not fit.

## Components

```
Agent (MCP)  ─┐
CLI          ─┼─ HTTP/JSON ─> Daemon (Node) ── WebSocket ──> Extension (MV3)
Scripts      ─┘               tool registry                  DOM lane runtime (no debugger)
                              sessions, tabs, leases          CDP relay (chrome.debugger)
                              Playwright (CDP lane)           tabs, dialogs shim
                              call log
```

| Component | Owns |
| --- | --- |
| Daemon | the tool registry (one source for MCP schema, CLI, HTTP); sessions, tab ownership, leases; choosing a lane per call; the CDP attach lifecycle; the call log |
| Extension | executing DOM-lane operations in pages; relaying CDP; tab primitives; the dialog shim. It keeps no session state |
| MCP server, CLI | thin clients of the daemon's HTTP API |

## Two lanes

| | DOM lane (default) | CDP lane (on demand) |
| --- | --- | --- |
| Banner | never | shown while attached, gone about 5 s after detach |
| How | Playwright's injected script (selector engines, aria snapshot with refs, actionability and hit-target checks) loaded into the extension's isolated world through `chrome.scripting` | `chrome.debugger` relayed to the daemon; `playwright-core` drives it with `connectOverCDP` |
| Input | synthetic DOM events (`isTrusted: false`) | real input (`isTrusted: true`) |
| Background tab | snapshot, click, fill, select, scroll, evaluate work; rendering-driven work (IntersectionObserver lazy load, animations) does not run | everything works under focus emulation |
| Uses | `snapshot`, `read`, `click`, `hover` (script-driven menus), `type`, `fill_form`, `press_key` (synthetic), `scroll`, `wait_for`, `evaluate`, `file_upload`, dialogs, `network_requests` metadata (`webRequest`), screenshot of a rendered tab | `trusted: true` on an action, background screenshot, background lazy load, response bodies, `run` |

Lane choice rules:

1. A tool runs in the DOM lane unless its spec says otherwise.
2. An action takes `trusted: true` to run in the CDP lane: sites that check `isTrusted`, menus
   opened by CSS `:hover`, popups opened with `window.open` (blocked without a user gesture;
   `target=_blank` links do open, spike), clipboard, fullscreen, file pickers.
3. Every result says which lane ran (`lane: "dom" | "cdp"`), so a banner always has a visible cause.
4. The daemon never escalates silently. A DOM-lane failure that the CDP lane could fix returns an
   error whose `hint` names `trusted: true` or the CDP-lane tool.

## Reuse policy

- Code: Playwright's injected script (DOM lane) and `playwright-core` (CDP lane) are used as
  libraries, not copied. They are pinned to one version and extracted by a build script.
- Tests: Playwright's own test cases carry IDs (`CL-001` for click). A spec adopts the ones that
  apply by ID and notes why the others do not.
- Ideas from other projects (BrowserMCP focus emulation, BrowserSkill idle detach) are cited in
  the spec that uses them.

## Invariants

1. The user's active tab and window focus never change unless a call asks for it.
2. A tab belongs to one session; another session cannot act on it.
3. No debugger attachment outlives its need: idle detach, detach on session end, and on extension
   connect every attachment the daemon does not know is dropped.
4. The relay never forwards `Browser.close`; the browser is the user's.
5. A ref resolves only to the element it was given to, while that element is in the document; a
   stale ref is an error, never a guess.
6. Tool names carry no prefix: `click`, `snapshot`. The MCP client already namespaces them.
7. The extension never puts an entry on its `chrome://extensions` Errors page (see below).

## Extension error handling

Chrome lists on the extension's Errors page anything the extension logs as an error: a failed
WebSocket connection, `console.error`, an uncaught exception, an unhandled promise rejection.
Measured (`temp/spike/errors-check.mjs`, daemon stopped for 8 s):

| Way of reaching a stopped daemon | Entries on the Errors page |
| --- | --- |
| open the WebSocket directly | 1 |
| `fetch` the daemon's `/health` first, failure caught silently, open the WebSocket only when it answers | 0 |
| `console.error` on failure | 1 |
| promise rejection nobody catches | 1 |

Rules for extension code:

1. Reach the daemon with a caught `fetch` probe; open the WebSocket only after the probe answers.
2. No `console.error` or `console.warn`. Diagnostics go to the daemon as events, and to a small
   in-memory ring the daemon can read after a reconnect.
3. Every listener and handler body is wrapped; every promise is awaited inside a `try` or ends in
   a `catch`. A test loads the extension with the daemon stopped and running, exercises it, and
   asserts the Errors page (read through `chrome.developerPrivate`) stays empty.
4. Errors from page operations are results (`{ok: false, code, message}`), never throws that
   escape to the extension's context.

## Evidence

Spike code in `temp/spike/`.

- `run.mjs`: CDP lane on Chrome for Testing 158 and the owner's Chrome 157.
- `run-dom.mjs`: DOM lane fixture checks, 16 of 16 pass, no debugging bar at any point.
- `run-real-dom.mjs`: DOM lane on the owner's Chrome 157, no debugger: Facebook snapshot 119 ms
  (24 KB, 351 refs), filling the React search box, a synthetic click on the Marketplace link
  navigates, scrolling a background tab works but the feed does not load more (no rendering in
  background tabs). `evaluate` through `chrome.scripting` is blocked by CSP on Facebook and
  GitHub; through `chrome.userScripts` it works on both.
- `errors-check.mjs`: the Errors page table above.
- `frames-check.mjs`: the iframe handshake pairs same-origin, cross-origin and nested frames with
  their iframe elements without the debugger (`targets.md`).
- `popup-dialog-check.mjs`: a synthetic click opens a `target=_blank` link but `window.open` is
  blocked; CSS `:hover` is not set by synthetic events; `alert` did not block on Chrome for Testing
  (to recheck on a focused real Chrome).
- CDP-lane results also live in the legacy archive, in `rebuild-architecture.md`.

## Not covered by a tool

Downloads (`chrome.downloads` can serve them later, without the debugger; until then `run`),
PDF printing (Playwright's `page.pdf` is headless-only), performance tracing.

## Setup requirement

`evaluate` without the debugging bar needs `chrome.userScripts`, which Chrome enables only after the
user turns on "Allow User Scripts" in the extension's details. Install instructions include it;
`status` reports whether it is on. Without it, `evaluate` returns `USER_SCRIPTS_OFF` and the agent
may retry with `trusted: true` (CDP lane); the daemon does not switch lanes on its own.

## Open questions

None for the owner.
