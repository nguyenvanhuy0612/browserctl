# Extension UI: toolbar popup

Status: verified
Depends on: `interface.md`, `sessions.md`, `architecture.md` (extension error handling)

## Purpose

Let the user see at a glance whether this browser is connected to the daemon, under which alias,
and why Chrome's debugging bar is showing; and fix the port or reconnect without opening DevTools.

## Popup contents

| Row | Source | Shown as |
| --- | --- | --- |
| Connection | the service worker's link state | `Connected`, `Connecting…`, or `Daemon not running on 127.0.0.1:<port>` with the hint "start an agent, or run `browserctl daemon start`" |
| Alias | the daemon's `welcome` event | `chrome-1`; `—` while not connected |
| Daemon | `welcome` | daemon version and `127.0.0.1:<port>` |
| Allow User Scripts | `chrome.userScripts` availability | `On`, or `Off` with "turn it on in this extension's Details so evaluate works without the debugging bar" |
| Debugger | the service worker's attachment list | `Not attached`, or `Attached to N tab(s)` with "this is what shows Chrome's debugging bar" |
| Extension | manifest | version |

Controls: **Reconnect** (closes the socket and connects again), **Port** field with **Save**
(stores `daemonPort` in `chrome.storage.local`, then reconnects).

The popup asks the service worker with `chrome.runtime.sendMessage({type: "bctl.status"})` and
re-reads every second while open. It follows the extension error rules: every call is caught and
nothing is logged to the console.

The toolbar icon's title (`chrome.action.setTitle`) carries the same connection line, so hovering
the icon answers the question without opening the popup.

## Wire addition

After registering a browser, the daemon sends `{event: "welcome", data: {alias, version}}` to its
extension (`interface.md`).

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| UI-E01 | live | popup page with the daemon running | shows `Connected`, the alias, user scripts `On` |
| UI-E02 | live | after earlier attachments idle out, a trusted click, popup | `Attached to 1 tab` |
| UI-E03 | live | Errors page after opening the popup | empty |
| UI-S01 | manual | owner opens the popup on Chrome | connection and alias visible |
